"""分析データのエクスポート（CSV / Markdown / ZIP）。

CSV は Excel でそのまま開けるよう UTF-8（BOM付き）で出力する。
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from .analysis import build_rows
from .models import MEDIA_LABELS, PLATFORM_LABELS, Post

BOM = "﻿"


def _csv(header: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(header)
    for r in rows:
        w.writerow(["" if v is None else v for v in r])
    return buf.getvalue()


def _pct(v: Optional[float]) -> str:
    return "" if v is None else f"{v * 100:.2f}%"


def posts_csv(data: dict, posts: list[Post], followers: dict, tz: ZoneInfo) -> str:
    start, end = data["period"]["start"], data["period"]["end"]
    rows = [r for r in build_rows(posts, followers, tz)
            if start <= r.local.date().isoformat() <= end]
    med = {}
    for p in {r.post.platform for r in rows}:
        vals = sorted(r.engagements for r in rows if r.post.platform == p)
        n = len(vals)
        med[p] = (vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2) or 1
    rows.sort(key=lambda r: r.local, reverse=True)
    return _csv(
        ["SNS", "投稿日時", "曜日", "形式", "本文", "URL", "表示回数", "リーチ", "いいね", "コメント",
         "シェア", "保存", "引用", "クリック", "エンゲージメント", "ER（表示比）", "ER（フォロワー比）",
         "パフォーマンス指数", "投稿ID"],
        [[PLATFORM_LABELS[r.post.platform], r.local.strftime("%Y-%m-%d %H:%M"),
          "月火水木金土日"[r.local.weekday()], MEDIA_LABELS.get(r.post.media_type, r.post.media_type),
          r.post.text, r.post.permalink, r.post.metrics.views, r.post.metrics.reach,
          r.post.metrics.likes, r.post.metrics.comments, r.post.metrics.shares, r.post.metrics.saves,
          r.post.metrics.quotes, r.post.metrics.clicks, r.engagements, _pct(r.er_views),
          _pct(r.er_followers), round(r.engagements / med[r.post.platform] * 100), r.post.post_id]
         for r in rows])


def summary_csv(data: dict) -> str:
    rows = []
    for p in data["platforms"]:
        s = data["summary"][p]
        ch = s["change"]
        rows.append([
            s["label"], s["account"], s["followers"], s["followers_delta"], _pct(s["followers_growth"]),
            s["posts"], s["prev"]["posts"], s["engagements"], s["prev"]["engagements"], _pct(ch["engagements"]),
            s["views"], _pct(s["er_followers"]), _pct(s["prev"]["er_followers"]), _pct(s["er_views"]),
        ])
    return _csv(["SNS", "アカウント", "フォロワー", "フォロワー増減", "フォロワー増加率", "投稿数",
                 "投稿数（前期間）", "エンゲージメント", "エンゲージメント（前期間）", "エンゲージメント前期間比",
                 "表示回数", "ER（フォロワー比）", "ER（フォロワー比・前期間）", "ER（表示比）"], rows)


def media_csv(data: dict) -> str:
    return _csv(["SNS", "形式", "件数", "平均エンゲージメント", "ER（表示比）", "平均パフォーマンス指数"],
                [[PLATFORM_LABELS[m["platform"]], m["label"], m["count"],
                  round(m["avg_engagements"] or 0, 1), _pct(m["er_views"]), round(m["score"] or 0)]
                 for m in data["media"]])


def hashtags_csv(data: dict) -> str:
    return _csv(["ハッシュタグ", "使用数", "SNS", "平均パフォーマンス指数"],
                [[f"#{h['tag']}", h["count"], " / ".join(PLATFORM_LABELS[p] for p in h["platforms"]),
                  round(h["score"])] for h in data["hashtags"]])


def competitors_csv(data: dict) -> str:
    rows = []
    for platform, blk in data["competitors"]["platforms"].items():
        for r in blk["rows"]:
            rows.append([blk["label"], r["name"], r["username"], r["followers"], r["followers_delta"],
                         _pct(r["followers_growth"]), r["posts"],
                         None if r["posts_per_week"] is None else round(r["posts_per_week"], 1),
                         None if r["avg_eng"] is None else round(r["avg_eng"], 1), _pct(r["er_followers"]),
                         " / ".join(f"{k} {v * 100:.0f}%" for k, v in r["media_mix"].items()),
                         r["best_type"], r["top_slot"], " ".join("#" + t for t in r["top_tags"]),
                         blk["metric_label"]])
    return _csv(["SNS", "アカウント", "ユーザー名", "フォロワー", "期間増減", "増加率", "投稿数", "投稿/週",
                 "平均反応", "反応率（フォロワー比）", "形式の内訳", "最も反応の良い形式", "よく投稿する枠",
                 "よく使うタグ", "反応の定義"], rows)


def competitor_posts_csv(data: dict) -> str:
    return _csv(["競合", "SNS", "投稿日時", "形式", "本文", "URL", "反応", "反応率（フォロワー比）"],
                [[t["competitor"], PLATFORM_LABELS[t["platform"]], t["date"], t["media"], t["text"],
                  t["permalink"], t["engagements"], _pct(t["er_followers"])]
                 for t in data["competitors"].get("all_posts", data["competitors"]["top_posts"])])


def ai_markdown(data: dict) -> str:
    ai = data.get("ai")
    if not ai:
        return ""
    lab = lambda p: "全体" if p == "all" else PLATFORM_LABELS.get(p, p)  # noqa: E731
    pr = {"high": "高", "medium": "中", "low": "低"}
    per = data["period"]
    out = [f"# AI分析レポート{('：' + data['client_name']) if data.get('client_name') else ''}",
           f"対象期間：{per['start'].replace('-', '/')}〜{per['end'].replace('-', '/')}（{per['days']}日間）／ モデル：{ai['_meta']['model']}", "",
           f"## {ai['headline']}", "", ai["summary"], ""]
    if ai.get("question_answer"):
        out += ["## ご質問への回答", f"> {ai['_meta'].get('question', '')}", "", ai["question_answer"], ""]
    out.append("## SNS別の評価")
    for p in ai["platforms"]:
        out += [f"### {lab(p['platform'])}", p["assessment"], ""]
        out += [f"- 👍 {s}" for s in p["strengths"]] + [f"- ⚠️ {s}" for s in p["issues"]] + [""]
    out.append("## 投稿内容から見えたこと")
    for c in ai["content_insights"]:
        out += [f"### {c['title']}", c["detail"], f"*根拠：{c['evidence']}*", ""]
    if ai.get("competitor_insights"):
        out.append("## 競合から学べること")
        for c in ai["competitor_insights"]:
            out += [f"### {c['competitor']}：{c['observation']}", f"→ {c['takeaway']}", ""]
    out += ["## 改善提案", "| 優先度 | SNS | アクション | 理由 | 期待効果 |", "|---|---|---|---|---|"]
    out += [f"| {pr[r['priority']]} | {lab(r['platform'])} | {r['action']} | {r['reason']} | {r['expected_effect']} |"
            for r in ai["recommendations"]]
    out += ["", "## 投稿アイデア"]
    for i in ai["post_ideas"]:
        out += [f"### [{lab(i['platform'])} / {i['format']}] {i['idea']}",
                f"推奨タイミング：{i['suggested_timing']}", "", "```", i["sample_copy"], "```", ""]
    out += ["## 来期のKPI目標", "| SNS | 指標 | 現状 | 目標 | 根拠 |", "|---|---|---|---|---|"]
    out += [f"| {lab(k['platform'])} | {k['metric']} | {k['current']} | {k['target']} | {k['rationale']} |"
            for k in ai["kpi_targets"]]
    return "\n".join(out).replace("\r", "") + "\n"


def downloads(data: dict, posts: list[Post], followers: dict, tz: ZoneInfo) -> dict[str, str]:
    """レポートに埋め込む／ZIPに入れるファイル群（ファイル名 → 内容）。"""
    files = {
        "posts.csv": posts_csv(data, posts, followers, tz),
        "summary.csv": summary_csv(data),
        "media_types.csv": media_csv(data),
        "hashtags.csv": hashtags_csv(data),
    }
    if data.get("competitors") and data["competitors"]["platforms"]:
        files["competitors.csv"] = competitors_csv(data)
        files["competitor_posts.csv"] = competitor_posts_csv(data)
    md = ai_markdown(data)
    if md:
        files["ai_analysis.md"] = md
    return files


def write_bundle(out: Path, html: str, data: dict, files: dict[str, str]) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("report.html", html)
        for name, content in files.items():
            z.writestr(name, (BOM + content) if name.endswith(".csv") else content)
        z.writestr("data.json", json.dumps({k: v for k, v in data.items() if k != "downloads"},
                                           ensure_ascii=False, indent=1, default=str))
    return out
