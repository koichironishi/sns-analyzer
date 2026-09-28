"""Claude による AI分析。

集計結果（KPI・形式別・時間帯・ハッシュタグ）と期間内の投稿本文を Claude に渡し、
投稿内容まで踏み込んだ示唆・改善提案・投稿アイデアを構造化 JSON で受け取る。

必要：pip install anthropic、および ANTHROPIC_API_KEY（または `ant auth login`）。
注意：投稿本文と数値が Anthropic API に送信される。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from .analysis import build_rows
from .models import MEDIA_LABELS, PLATFORM_LABELS, Post

DEFAULT_MODEL = "claude-opus-5"
MAX_POSTS_IN_PROMPT = 200
MAX_TEXT_CHARS = 280

SYSTEM_PROMPT = """あなたは日本の企業・ブランドの SNS 運用を支援するシニアアナリストです。
Instagram / Facebook / Threads / X の運用データを読み、担当者が次の1か月で実行できる具体的な改善策を提案します。

分析の前提：
- 「パフォーマンス指数」は投稿のエンゲージメント ÷ 同じSNSの期間中央値 × 100。SNS間の規模差を補正した値で、100が普段の投稿。
- エンゲージメント = いいね + コメント + シェア/リポスト + 保存 + 引用。ER（表示比）= エンゲージメント ÷ 表示回数。
- 件数が少ない区分（目安3件未満）の差は偶然の可能性が高い。断定せず、根拠の件数を添えて「仮説」として扱うこと。
- 数値の傾向だけでなく、投稿本文の内容・切り口・言葉づかい・CTA の違いまで読み取ること。反応の良い投稿と悪い投稿を比べて、何が効いているかを言語化する。
- 各SNSの特性（Instagram=ビジュアルと保存、Threads=会話と共感、X=速報性と拡散、Facebook=既存顧客・地域・長文）を踏まえる。
- 提案は「誰が読んでもそのまま実行できる」粒度で書く。抽象論（「質の高い投稿を」等）は避ける。
- データから言えないことは言わない。数値を引用するときは与えられたデータの値を使う。
- 出力はすべて日本語。"""

_STR = {"type": "string"}
_PLATFORM = {"type": "string", "enum": ["instagram", "facebook", "threads", "x", "all"]}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props),
            "additionalProperties": False}


OUTPUT_SCHEMA = _obj({
    "headline": _STR,
    "summary": _STR,
    "question_answer": _STR,
    "platforms": {"type": "array", "items": _obj({
        "platform": _PLATFORM,
        "assessment": _STR,
        "strengths": {"type": "array", "items": _STR},
        "issues": {"type": "array", "items": _STR},
    })},
    "competitor_insights": {"type": "array", "items": _obj({
        "competitor": _STR, "observation": _STR, "takeaway": _STR,
    })},
    "content_insights": {"type": "array", "items": _obj({
        "title": _STR, "detail": _STR, "evidence": _STR,
    })},
    "recommendations": {"type": "array", "items": _obj({
        "priority": {"type": "string", "enum": ["high", "medium", "low"]},
        "platform": _PLATFORM,
        "action": _STR, "reason": _STR, "expected_effect": _STR,
    })},
    "post_ideas": {"type": "array", "items": _obj({
        "platform": _PLATFORM, "format": _STR, "idea": _STR,
        "sample_copy": _STR, "suggested_timing": _STR,
    })},
    "kpi_targets": {"type": "array", "items": _obj({
        "platform": _PLATFORM, "metric": _STR, "current": _STR, "target": _STR, "rationale": _STR,
    })},
})


class AIError(RuntimeError):
    pass


def _round(v, digits=4):
    return round(v, digits) if isinstance(v, float) else v


def build_context(data: dict, posts: list[Post], followers: dict, tz: ZoneInfo,
                  include_post_text: bool = True) -> dict:
    """Claude に渡すデータ。集計値 + 期間内の投稿一覧（指数順）。"""
    per = data["period"]
    start, end = per["start"], per["end"]
    rows = [r for r in build_rows(posts, followers, tz)
            if start <= r.local.date().isoformat() <= end]
    # 指数は analysis と同じ定義（SNS別中央値比）で付け直す
    med: dict[str, float] = {}
    for p in {r.post.platform for r in rows}:
        vals = sorted(r.engagements for r in rows if r.post.platform == p)
        med[p] = vals[len(vals) // 2] if len(vals) % 2 else (vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2
    rows.sort(key=lambda r: -(r.engagements / (med[r.post.platform] or 1)))
    if len(rows) > MAX_POSTS_IN_PROMPT:  # 上位と下位を優先して残す
        half = MAX_POSTS_IN_PROMPT // 2
        rows = rows[:half] + rows[-half:]

    summary = {}
    for p, s in data["summary"].items():
        summary[p] = {k: _round(v) for k, v in s.items()
                      if k not in ("label", "prev", "change", "account")}
        summary[p]["前期間"] = {k: _round(v) for k, v in s["prev"].items()}
        summary[p]["前期間比"] = {k: _round(v) for k, v in s["change"].items()}

    best_slots = {}
    for p, h in data["heatmap"].items():
        cells = [(h["score"][w][sl], h["count"][w][sl], f"{data['weekdays'][w]}曜 {data['slots'][sl]}")
                 for w in range(7) for sl in range(len(data["slots"])) if h["score"][w][sl] is not None]
        cells.sort(key=lambda c: -c[0])
        best_slots[p] = [{"枠": c[2], "平均指数": round(c[0]), "件数": c[1]} for c in cells[:5]]
        best_slots[p + "_下位"] = [{"枠": c[2], "平均指数": round(c[0]), "件数": c[1]}
                                  for c in cells[-3:]]

    ctx = {
        "期間": f"{start}〜{end}（{per['days']}日間、比較対象は直前の同日数）",
        "SNS別サマリー": summary,
        "投稿形式別": [{**m, "score": _round(m["score"], 1), "er_views": _round(m["er_views"]),
                   "avg_engagements": _round(m["avg_engagements"], 1)} for m in data["media"]],
        "曜日時間帯_上位下位": best_slots,
        "ハッシュタグ": [{**h, "score": round(h["score"], 1)} for h in data["hashtags"]],
        "投稿一覧_指数順": [{
            "sns": r.post.platform,
            "日時": r.local.strftime("%Y-%m-%d(%a) %H:%M"),
            "形式": MEDIA_LABELS.get(r.post.media_type, r.post.media_type),
            "本文": r.post.text[:MAX_TEXT_CHARS] if include_post_text else "（同意の範囲外のため送信しない）",
            "指数": round(r.engagements / (med[r.post.platform] or 1) * 100),
            "反応": r.engagements, "表示": r.post.metrics.views,
            "いいね": r.post.metrics.likes, "コメント": r.post.metrics.comments,
            "シェア": r.post.metrics.shares, "保存": r.post.metrics.saves,
        } for r in rows],
    }
    comp = data.get("competitors")
    if comp and comp["platforms"]:
        ctx["競合比較"] = {
            "注記": "競合は公開値のみ取得可能なため、反応は各SNSの公開指標（反応の定義）で自社・競合をそろえて算出。"
                    "has_posts=false のアカウントはフォロワー数のみ。",
            "SNS別": {p: {"反応の定義": b["metric_label"],
                         "アカウント": [{k: _round(v) for k, v in r.items() if k != "rank"} for r in b["rows"]]}
                     for p, b in comp["platforms"].items()},
            "競合の反応上位投稿": [{**t, "text": t["text"][:MAX_TEXT_CHARS] if include_post_text else "",
                                    "permalink": "",
                                    "er_followers": _round(t["er_followers"])} for t in comp["top_posts"][:15]],
        }
    return ctx


def run_ai_analysis(data: dict, posts: list[Post], followers: dict, tz: ZoneInfo,
                    ai_cfg: Optional[dict] = None, question: str = "",
                    consent: Optional[dict] = None) -> dict:
    """consent: privacy.get_consent() の結果。include_post_text=False なら本文を送らない。"""
    try:
        import anthropic
    except ImportError:
        raise AIError("AI分析には anthropic パッケージが必要です。"
                      "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt を実行し、"
                      ".venv/bin/python -m snsanalyzer で実行してください") from None

    ai_cfg = ai_cfg or {}
    model = ai_cfg.get("model") or DEFAULT_MODEL
    include_text = bool((consent or {}).get("include_post_text", True))
    context = build_context(data, posts, followers, tz, include_text)
    if not include_text:  # 本文なしでは内容の分析ができないことを前提として伝える
        ai_cfg = {**ai_cfg, "brand_context": (ai_cfg.get("brand_context") or "")
                  + "\n（注：今回は同意の範囲により投稿本文を含まない。本文に基づく分析は行わず、数値・形式・時間帯から分析すること）"}

    parts = []
    if ai_cfg.get("brand_context"):
        parts.append(f"<brand>\n{ai_cfg['brand_context']}\n</brand>")
    parts.append("<data>\n" + json.dumps(context, ensure_ascii=False, indent=1) + "\n</data>")
    parts.append(
        "上のデータを分析してください。\n"
        "- platforms はデータにある各SNSについて1件ずつ。\n"
        "- content_insights は投稿本文の比較から読み取れる「何が効いているか」を3〜5件。evidence には根拠となる投稿や数値を具体的に。\n"
        "- competitor_insights は「競合比較」がある場合に、競合ごとの特徴的な打ち手と自社が取り入れるべき点を2〜5件。"
        "競合データがなければ空配列。\n"
        "- recommendations は優先度順に5〜8件。\n"
        "- post_ideas は来月すぐ使える投稿案を4〜6件（sample_copy は実際に投稿できる文面）。\n"
        "- kpi_targets は来期の現実的な目標を各SNS1〜2件。\n"
        + (f"- 次の質問に question_answer で答えてください：{question}\n" if question
           else "- question_answer は空文字にしてください。\n"))

    client = anthropic.Anthropic()
    try:
        with client.beta.messages.stream(
            model=model,
            max_tokens=32000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": "\n\n".join(parts)}],
            thinking={"type": "adaptive"},
            output_config={
                "effort": ai_cfg.get("effort") or "high",
                "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA},
            },
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            message = stream.get_final_message()
    except TypeError as e:  # 認証情報が見つからない場合、SDK はリクエスト時に TypeError を送出する
        if "authentication" not in str(e).lower():
            raise
        raise AIError("Anthropic API の認証情報がありません。環境変数 ANTHROPIC_API_KEY を設定してください。") from None
    except anthropic.AuthenticationError:
        raise AIError("Anthropic API の認証に失敗しました。ANTHROPIC_API_KEY を確認してください。") from None
    except anthropic.PermissionDeniedError as e:
        raise AIError(f"APIキーに権限がありません：{e.message}") from None
    except anthropic.RateLimitError:
        raise AIError("Anthropic API のレート制限に達しました。しばらく待って再実行してください。") from None
    except anthropic.BadRequestError as e:
        raise AIError(f"リクエストエラー：{e.message}") from None
    except anthropic.APIStatusError as e:
        raise AIError(f"Anthropic API エラー（{e.status_code}）：{e.message}") from None
    except anthropic.APIConnectionError:
        raise AIError("Anthropic API に接続できません。ネットワークを確認してください。") from None

    if message.stop_reason == "refusal":
        raise AIError("Claude が応答を控えました。投稿データの内容を確認してください。")
    if message.stop_reason == "max_tokens":
        raise AIError("出力が上限に達して途中で切れました。分析期間を短くして再実行してください。")
    text = next((b.text for b in message.content if b.type == "text"), "")
    try:
        result = json.loads(text)
    except ValueError:
        raise AIError("AIの応答を解釈できませんでした。") from None

    result["_meta"] = {
        "model": message.model,
        "generated_at": datetime.now(tz).strftime("%Y-%m-%d %H:%M"),
        "question": question,
        "posts_sent": len(context["投稿一覧_指数順"]),
        "post_text_sent": include_text,
        "consent_by": (consent or {}).get("granted_by", ""),
        "consent_at": (consent or {}).get("granted_at", ""),
        "input_tokens": message.usage.input_tokens,
        "output_tokens": message.usage.output_tokens,
    }
    return result


def format_text(ai: dict) -> str:
    """ターミナル表示用。"""
    pr = {"high": "高", "medium": "中", "low": "低"}
    lab = lambda p: "全体" if p == "all" else PLATFORM_LABELS.get(p, p)  # noqa: E731
    lines = [f"■ {ai['headline']}", "", ai["summary"], ""]
    if ai.get("question_answer"):
        lines += ["■ ご質問への回答", ai["question_answer"], ""]
    if ai.get("competitor_insights"):
        lines.append("■ 競合から学べること")
        for c in ai["competitor_insights"]:
            lines.append(f"  [{c['competitor']}] {c['observation']} → {c['takeaway']}")
        lines.append("")
    lines.append("■ 改善提案")
    for r in ai["recommendations"]:
        lines.append(f"  [{pr[r['priority']]}][{lab(r['platform'])}] {r['action']}")
        lines.append(f"      理由：{r['reason']} / 期待効果：{r['expected_effect']}")
    lines += ["", "■ 投稿アイデア"]
    for i in ai["post_ideas"]:
        lines.append(f"  [{lab(i['platform'])}/{i['format']}] {i['idea']}（{i['suggested_timing']}）")
    return "\n".join(lines)
