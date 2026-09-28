"""分析ロジック。

プラットフォームごとに規模が大きく違うため、横断比較には
「パフォーマンス指数」＝ 投稿のエンゲージメント ÷ そのSNSの期間中央値 × 100 を使う。
100 がそのSNSでの“普通の投稿”、200 なら普段の2倍反応があった投稿。
"""
from __future__ import annotations

import bisect
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from .models import MEDIA_LABELS, PLATFORM_LABELS, PLATFORMS, Post

WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]
SLOT_HOURS = 3
SLOTS = [f"{h}〜{h + SLOT_HOURS}時" for h in range(0, 24, SLOT_HOURS)]
HASHTAG_RE = re.compile(r"[#＃](\w+)")
MIN_SAMPLES = 3  # 傾向を語るのに必要な最低投稿数


@dataclass
class Row:
    post: Post
    local: datetime
    engagements: int
    followers: Optional[int]
    er_followers: Optional[float]   # エンゲージメント ÷ 投稿時フォロワー
    er_views: Optional[float]       # エンゲージメント ÷ 表示回数
    score: float = 100.0            # パフォーマンス指数


def _follower_at(series: list[tuple[date, int]], d: date) -> Optional[int]:
    if not series:
        return None
    dates = [s[0] for s in series]
    i = bisect.bisect_right(dates, d) - 1
    return series[max(i, 0)][1]


def _pct_change(cur: Optional[float], prev: Optional[float]) -> Optional[float]:
    if cur is None or not prev:
        return None
    return (cur - prev) / prev


def _mean(values) -> Optional[float]:
    vals = [v for v in values if v is not None]
    return statistics.fmean(vals) if vals else None


def build_rows(posts: list[Post], followers: dict, tz: ZoneInfo) -> list[Row]:
    rows = []
    for p in posts:
        local = p.created_at.astimezone(tz)
        eng = p.metrics.engagements
        f = _follower_at(followers.get(p.platform, []), local.date())
        rows.append(Row(
            post=p, local=local, engagements=eng, followers=f,
            er_followers=eng / f if f else None,
            er_views=eng / p.metrics.views if p.metrics.views else None,
        ))
    return rows


def _apply_scores(rows: list[Row]) -> None:
    by_platform: dict[str, list[Row]] = defaultdict(list)
    for r in rows:
        by_platform[r.post.platform].append(r)
    for items in by_platform.values():
        med = statistics.median(r.engagements for r in items) or _mean(
            r.engagements for r in items) or 1
        for r in items:
            r.score = r.engagements / med * 100


def _period_stats(rows: list[Row]) -> dict:
    return {
        "posts": len(rows),
        "engagements": sum(r.engagements for r in rows),
        "views": sum(r.post.metrics.views or 0 for r in rows) or None,
        "avg_engagements": _mean(r.engagements for r in rows),
        "er_followers": _mean(r.er_followers for r in rows),
        "er_views": _mean(r.er_views for r in rows),
    }


def analyze(posts: list[Post], followers: dict[str, list[tuple[date, int]]],
            tz: ZoneInfo, days: int = 30, end: Optional[date] = None,
            account_names: Optional[dict] = None) -> dict:
    end = end or datetime.now(tz).date()
    start = end - timedelta(days=days - 1)
    prev_start = start - timedelta(days=days)

    rows_all = build_rows(posts, followers, tz)
    cur = [r for r in rows_all if start <= r.local.date() <= end]
    prev = [r for r in rows_all if prev_start <= r.local.date() < start]
    _apply_scores(cur)

    platforms = [p for p in PLATFORMS if any(r.post.platform == p for r in cur)
                 or followers.get(p)]

    # ---- サマリー（KPIカード）------------------------------------------
    summary = {}
    for p in platforms:
        c = _period_stats([r for r in cur if r.post.platform == p])
        pv = _period_stats([r for r in prev if r.post.platform == p])
        f_series = followers.get(p, [])
        f_end = _follower_at(f_series, end)
        f_start = _follower_at(f_series, start - timedelta(days=1))
        summary[p] = {
            "label": PLATFORM_LABELS[p],
            "account": (account_names or {}).get(p, ""),
            "followers": f_end,
            "followers_delta": (f_end - f_start) if f_end is not None and f_start is not None else None,
            "followers_growth": _pct_change(f_end, f_start),
            **c,
            "prev": pv,
            "change": {k: _pct_change(c[k], pv[k])
                       for k in ("posts", "engagements", "views", "er_followers", "er_views")},
        }
    total_cur = _period_stats(cur)
    total_prev = _period_stats(prev)

    # ---- 日次推移 --------------------------------------------------------
    dates = [start + timedelta(days=i) for i in range(days)]
    daily = {"dates": [d.isoformat() for d in dates]}
    for p in platforms:
        eng = defaultdict(int)
        cnt = defaultdict(int)
        for r in cur:
            if r.post.platform == p:
                eng[r.local.date()] += r.engagements
                cnt[r.local.date()] += 1
        daily[p] = {
            "engagements": [eng[d] for d in dates],
            "posts": [cnt[d] for d in dates],
            "followers": [_follower_at(followers.get(p, []), d)
                          if followers.get(p) and followers[p][0][0] <= d else None
                          for d in dates],
        }

    # ---- 投稿形式別 ------------------------------------------------------
    media = []
    for p in platforms:
        groups: dict[str, list[Row]] = defaultdict(list)
        for r in cur:
            if r.post.platform == p:
                groups[r.post.media_type].append(r)
        for mt, items in sorted(groups.items(), key=lambda kv: -_mean(x.score for x in kv[1])):
            media.append({
                "platform": p, "media_type": mt, "label": MEDIA_LABELS.get(mt, mt),
                "count": len(items),
                "avg_engagements": _mean(x.engagements for x in items),
                "er_views": _mean(x.er_views for x in items),
                "score": _mean(x.score for x in items),
            })

    # ---- 曜日×時間帯ヒートマップ ---------------------------------------
    def heat(items: list[Row]) -> dict:
        cells: dict[tuple[int, int], list[float]] = defaultdict(list)
        for r in items:
            cells[(r.local.weekday(), r.local.hour // SLOT_HOURS)].append(r.score)
        return {
            "score": [[_mean(cells.get((w, s), [])) for s in range(len(SLOTS))] for w in range(7)],
            "count": [[len(cells.get((w, s), [])) for s in range(len(SLOTS))] for w in range(7)],
        }

    heatmap = {"all": heat(cur)}
    for p in platforms:
        heatmap[p] = heat([r for r in cur if r.post.platform == p])

    # ---- ハッシュタグ ----------------------------------------------------
    tag_rows: dict[str, list[Row]] = defaultdict(list)
    for r in cur:
        for tag in {t.lower() for t in HASHTAG_RE.findall(r.post.text)}:
            tag_rows[tag].append(r)
    hashtags = sorted(
        ({"tag": t, "count": len(items), "score": _mean(x.score for x in items),
          "platforms": sorted({x.post.platform for x in items}, key=PLATFORMS.index)}
         for t, items in tag_rows.items() if len(items) >= 2),
        key=lambda h: -h["score"])[:15]

    # ---- 上位投稿 --------------------------------------------------------
    top = sorted(cur, key=lambda r: -r.score)[:10]
    top_posts = [{
        "platform": r.post.platform, "date": r.local.strftime("%Y-%m-%d %H:%M"),
        "text": r.post.text, "media": MEDIA_LABELS.get(r.post.media_type, r.post.media_type),
        "permalink": r.post.permalink, "engagements": r.engagements,
        "views": r.post.metrics.views, "er_views": r.er_views, "score": r.score,
    } for r in top]

    result = {
        "generated_at": datetime.now(tz).strftime("%Y-%m-%d %H:%M"),
        "period": {"start": start.isoformat(), "end": end.isoformat(), "days": days,
                   "prev_start": prev_start.isoformat()},
        "platforms": platforms,
        "summary": summary,
        "total": {**total_cur, "prev": total_prev,
                  "change": {k: _pct_change(total_cur[k], total_prev[k])
                             for k in ("posts", "engagements", "views")}},
        "daily": daily,
        "media": media,
        "heatmap": heatmap,
        "weekdays": WEEKDAYS,
        "slots": SLOTS,
        "hashtags": hashtags,
        "top_posts": top_posts,
    }
    result["insights"] = generate_insights(result)
    return result


# ---- 自動コメント ---------------------------------------------------------
def _fmt_pct(v: float) -> str:
    return f"{v * 100:+.1f}%"


def generate_insights(d: dict) -> list[dict]:
    """数値から読み取れる示唆を文章化する。kind: good / warn / info"""
    out: list[dict] = []
    s = d["summary"]
    days = d["period"]["days"]
    tc = d["total"]["change"]

    ranked = sorted((p for p in s if s[p]["er_followers"] is not None),
                    key=lambda p: -s[p]["er_followers"])
    if len(ranked) >= 2:
        best = ranked[0]
        out.append({"kind": "good", "text":
                    f"フォロワーあたりの反応が最も高いのは{s[best]['label']}"
                    f"（1投稿平均 {s[best]['er_followers'] * 100:.2f}%）。"
                    f"最も低い{s[ranked[-1]]['label']}（{s[ranked[-1]]['er_followers'] * 100:.2f}%）"
                    "とは投稿の役割を分けて考えるのが有効です。"})

    growth = [(p, s[p]["followers_growth"]) for p in s if s[p]["followers_growth"] is not None]
    if growth:
        p, g = max(growth, key=lambda x: x[1])
        out.append({"kind": "good" if g > 0 else "warn", "text":
                    f"フォロワーの伸びが最も大きいのは{s[p]['label']}"
                    f"（{s[p]['followers_delta']:+,}人、{_fmt_pct(g)}）。"})

    for p in s:
        ch = s[p]["change"]
        if ch.get("er_followers") is not None and ch["er_followers"] <= -0.2 and s[p]["posts"] >= MIN_SAMPLES:
            out.append({"kind": "warn", "text":
                        f"{s[p]['label']}のエンゲージメント率が前期間から{_fmt_pct(ch['er_followers'])}と"
                        "大きく低下しています。投稿形式・時間帯・内容の変化を確認してください。"})
        if ch.get("posts") is not None and ch["posts"] <= -0.3:
            out.append({"kind": "warn", "text":
                        f"{s[p]['label']}の投稿数が前期間の{s[p]['prev']['posts']}件から"
                        f"{s[p]['posts']}件に減っています。"})

    for p in d["platforms"]:
        h = d["heatmap"].get(p)
        if not h:
            continue
        best = None
        for w in range(7):
            for sl in range(len(d["slots"])):
                sc, n = h["score"][w][sl], h["count"][w][sl]
                if sc is not None and n >= MIN_SAMPLES and (best is None or sc > best[0]):
                    best = (sc, w, sl, n)
        if best and best[0] >= 120:
            out.append({"kind": "info", "text":
                        f"{PLATFORM_LABELS[p]}は{d['weekdays'][best[1]]}曜 {d['slots'][best[2]]}の投稿が"
                        f"普段の{best[0] / 100:.1f}倍の反応（{best[3]}件）。この枠を優先すると効果的です。"})

    for p in d["platforms"]:
        items = [m for m in d["media"] if m["platform"] == p and m["count"] >= MIN_SAMPLES]
        if len(items) >= 2:
            top, low = items[0], items[-1]
            if top["score"] and low["score"] and top["score"] / low["score"] >= 1.3:
                out.append({"kind": "info", "text":
                            f"{PLATFORM_LABELS[p]}では「{top['label']}」が「{low['label']}」の"
                            f"{top['score'] / low['score']:.1f}倍の反応。形式の配分を見直す余地があります。"})

    if d["hashtags"]:
        h = d["hashtags"][0]
        if h["score"] >= 110 and h["count"] >= MIN_SAMPLES:
            out.append({"kind": "info", "text":
                        f"ハッシュタグ「#{h['tag']}」付きの投稿は平均指数 {h['score']:.0f}"
                        f"（{h['count']}件）と反応が良好です。"})
    return out
