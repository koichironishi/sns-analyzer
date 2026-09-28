"""競合アカウントとの比較分析。

競合については公開されている数値しか取れないため、自社も同じ条件
（=「公開エンゲージメント」）にそろえて比較する。
  Instagram : いいね + コメント（シェア・保存は非公開）
  Facebook  : リアクション + コメント + シェア
  Threads   : いいね + 返信 + リポスト + 引用
  X         : いいね + 返信 + リポスト + 引用
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from .analysis import HASHTAG_RE, SLOT_HOURS, WEEKDAYS, _follower_at
from .models import MEDIA_LABELS, PLATFORM_LABELS, PLATFORMS, Post

PUBLIC_FIELDS = {
    "instagram": ("likes", "comments"),
    "facebook": ("likes", "comments", "shares"),
    "threads": ("likes", "comments", "shares", "quotes"),
    "x": ("likes", "comments", "shares", "quotes"),
}
PUBLIC_LABEL = {
    "instagram": "いいね＋コメント",
    "facebook": "リアクション＋コメント＋シェア",
    "threads": "いいね＋返信＋リポスト＋引用",
    "x": "いいね＋返信＋リポスト＋引用",
}
OWN = "自社"


def public_eng(p: Post) -> int:
    return sum(getattr(p.metrics, f) for f in PUBLIC_FIELDS[p.platform])


def _mean(vals):
    vals = [v for v in vals if v is not None]
    return statistics.fmean(vals) if vals else None


def _account_stats(name: str, is_own: bool, username: str, posts: list[Post],
                   series: list[tuple[date, int]], tz: ZoneInfo, start: date, end: date,
                   days: int) -> dict:
    cur = [p for p in posts if start <= p.created_at.astimezone(tz).date() <= end]
    f_end = _follower_at(series, end) if series else None
    f_start = _follower_at(series, start - timedelta(days=1)) \
        if series and series[0][0] <= start - timedelta(days=1) else None
    engs = [public_eng(p) for p in cur]
    avg = _mean(engs)
    types = Counter(p.media_type for p in cur)
    by_type: dict[str, list[int]] = defaultdict(list)
    for p in cur:
        by_type[p.media_type].append(public_eng(p))
    best_type = max(((t, _mean(v)) for t, v in by_type.items() if len(v) >= 2),
                    key=lambda x: x[1], default=(None, None))[0]
    tags = Counter(t.lower() for p in cur for t in set(HASHTAG_RE.findall(p.text)))
    slots = Counter()
    for p in cur:
        lt = p.created_at.astimezone(tz)
        slots[f"{WEEKDAYS[lt.weekday()]}曜 {lt.hour // SLOT_HOURS * SLOT_HOURS}時台"] += 1
    return {
        "name": name, "is_own": is_own, "username": username,
        "followers": f_end,
        "followers_delta": (f_end - f_start) if f_end is not None and f_start is not None else None,
        "followers_growth": ((f_end - f_start) / f_start) if f_end and f_start else None,
        "posts": len(cur),
        "has_posts": bool(posts),
        "posts_per_week": len(cur) / days * 7 if posts else None,
        "avg_eng": avg,
        "median_eng": statistics.median(engs) if engs else None,
        "avg_likes": _mean(p.metrics.likes for p in cur),
        "avg_comments": _mean(p.metrics.comments for p in cur),
        "er_followers": (avg / f_end) if avg is not None and f_end else None,
        "media_mix": {MEDIA_LABELS.get(t, t): n / len(cur) for t, n in types.most_common()} if cur else {},
        "best_type": MEDIA_LABELS.get(best_type, best_type) if best_type else None,
        "top_tags": [t for t, _ in tags.most_common(3)],
        "top_slot": slots.most_common(1)[0][0] if slots else None,
    }


def compare(own_posts: list[Post], own_followers: dict, comp_posts: list[Post],
            comp_series: dict, comp_map: dict, usernames: dict, own_names: dict,
            tz: ZoneInfo, days: int = 30, end: Optional[date] = None,
            competitors: Optional[list[str]] = None) -> dict:
    """competitors: 比較に含める競合名（設定に残っているもの）。None ならすべて。"""
    end = end or datetime.now(tz).date()
    start = end - timedelta(days=days - 1)
    allowed = set(competitors) if competitors is not None else None

    # 競合アカウントを (platform, 競合名) 単位にまとめる
    comp_accounts: dict[tuple[str, str], list[str]] = defaultdict(list)
    for (platform, acct), name in comp_map.items():
        if allowed is None or name in allowed:
            comp_accounts[(platform, name)].append(acct)

    platforms = {}
    for platform in PLATFORMS:
        rows = []
        own_p = [p for p in own_posts if p.platform == platform]
        if own_p or own_followers.get(platform):
            rows.append(_account_stats(OWN, True, own_names.get(platform, ""), own_p,
                                       own_followers.get(platform, []), tz, start, end, days))
        for (pf, name), accts in sorted(comp_accounts.items()):
            if pf != platform:
                continue
            posts = [p for p in comp_posts if p.platform == pf and p.account_id in accts]
            series = comp_series.get((pf, accts[0]), [])
            if not posts and not series:
                continue
            rows.append(_account_stats(name, False, usernames.get((pf, accts[0]), ""),
                                       posts, series, tz, start, end, days))
        if len(rows) < 2 or not any(not r["is_own"] for r in rows):
            continue
        # 順位（フォロワー比反応率・フォロワー数・投稿頻度）
        for key in ("er_followers", "followers", "posts_per_week", "followers_growth"):
            ranked = sorted((r for r in rows if r[key] is not None), key=lambda r: -r[key])
            for i, r in enumerate(ranked, 1):
                r.setdefault("rank", {})[key] = (i, len(ranked))
        platforms[platform] = {"label": PLATFORM_LABELS[platform],
                               "metric_label": PUBLIC_LABEL[platform], "rows": rows}

    # 競合の反応が良かった投稿（フォロワー規模で補正）
    comp_top = []
    for p in comp_posts:
        name = comp_map.get((p.platform, p.account_id))
        if name is None or (allowed is not None and name not in allowed):
            continue
        local = p.created_at.astimezone(tz)
        if not start <= local.date() <= end:
            continue
        f = _follower_at(comp_series.get((p.platform, p.account_id), []), local.date())
        eng = public_eng(p)
        comp_top.append({
            "competitor": name, "platform": p.platform, "date": local.strftime("%Y-%m-%d %H:%M"),
            "media": MEDIA_LABELS.get(p.media_type, p.media_type), "text": p.text,
            "permalink": p.permalink, "engagements": eng,
            "er_followers": eng / f if f else None,
        })
    comp_top.sort(key=lambda x: -(x["er_followers"] or 0))

    result = {"period": {"start": start.isoformat(), "end": end.isoformat(), "days": days},
              "platforms": platforms, "top_posts": comp_top[:10], "all_posts": comp_top}
    result["insights"] = compare_insights(result)
    return result


def compare_insights(c: dict) -> list[dict]:
    out = []
    for platform, blk in c["platforms"].items():
        rows = blk["rows"]
        own = next((r for r in rows if r["is_own"]), None)
        comps = [r for r in rows if not r["is_own"]]
        if not own or not comps:
            continue
        label = blk["label"]
        comp_er = [r["er_followers"] for r in comps if r["er_followers"] is not None]
        if own["er_followers"] is not None and comp_er:
            ratio = own["er_followers"] / statistics.fmean(comp_er)
            rank, n = own["rank"]["er_followers"]
            kind = "good" if ratio >= 1.1 else "warn" if ratio <= 0.9 else "info"
            out.append({"kind": kind, "text":
                        f"{label}のフォロワーあたり反応は競合平均の{ratio:.1f}倍（{n}アカウント中{rank}位）。"})
        freq = [r for r in comps if r["posts_per_week"] is not None]
        if own["posts_per_week"] is not None and freq:
            top = max(freq, key=lambda r: r["posts_per_week"])
            if top["posts_per_week"] >= own["posts_per_week"] * 1.5 and top["posts_per_week"] >= 1:
                out.append({"kind": "info", "text":
                            f"{label}では{top['name']}が週{top['posts_per_week']:.1f}本投稿"
                            f"（自社は週{own['posts_per_week']:.1f}本）。投稿量の差が露出差につながっている可能性があります。"})
        grow = [r for r in comps if r["followers_growth"] is not None]
        if own["followers_growth"] is not None and grow:
            top = max(grow, key=lambda r: r["followers_growth"])
            if top["followers_growth"] > own["followers_growth"]:
                out.append({"kind": "warn", "text":
                            f"{label}のフォロワー増加率は{top['name']}（{top['followers_growth'] * 100:+.1f}%）が"
                            f"自社（{own['followers_growth'] * 100:+.1f}%）を上回っています。"})
        for r in comps:
            if r["best_type"] and r["media_mix"]:
                share = r["media_mix"].get(r["best_type"], 0)
                if share >= 0.5 and r["best_type"] != own.get("best_type"):
                    out.append({"kind": "info", "text":
                                f"{r['name']}（{label}）は「{r['best_type']}」が投稿の{share * 100:.0f}%を占め、"
                                "反応も最も高い形式です。"})
    return out
