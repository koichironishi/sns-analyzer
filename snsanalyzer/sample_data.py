"""デモ用のサンプルデータ生成（API キーなしで動作確認するため）。"""
from __future__ import annotations

import math
import random
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .db import Store
from .models import AccountSnapshot, Metrics, Post

PROFILES = {
    # followers0, 日次成長率, 週あたり投稿数, 閲覧/フォロワー, 反応率/閲覧, 形式別倍率
    "instagram": dict(user="rhythmos_demo", f0=12400, growth=0.0028, per_week=5, view=0.45,
                      er=0.055, types={"reel": 1.8, "carousel": 1.3, "image": 1.0}),
    "facebook": dict(user="Rhythmos Demo", f0=8600, growth=0.0006, per_week=4, view=0.18,
                     er=0.03, types={"video": 1.4, "image": 1.0, "link": 0.6, "text": 0.7}),
    "threads": dict(user="rhythmos_demo", f0=2100, growth=0.0045, per_week=9, view=0.9,
                    er=0.045, types={"text": 1.0, "image": 1.2, "carousel": 1.1}),
    "x": dict(user="rhythmos_demo", f0=5300, growth=0.0012, per_week=10, view=0.35,
              er=0.025, types={"text": 0.9, "image": 1.3, "video": 1.5, "link": 0.7}),
}

# 曜日×時間帯の効き（JST）。平日夜・週末昼が強い想定
HOUR_WEIGHT = {7: 0.9, 8: 1.0, 12: 1.15, 13: 1.0, 18: 1.2, 19: 1.35, 20: 1.4, 21: 1.3, 22: 1.05}
HASHTAGS = {"デザイン": 1.3, "ブランディング": 1.2, "採用": 0.9, "Web制作": 1.1,
            "制作実績": 1.4, "イベント": 0.8, "お知らせ": 0.6, "コピーライティング": 1.15}
TOPICS = ["制作実績を公開しました", "チームの日常を紹介", "採用情報のお知らせ",
          "デザインの考え方", "イベント登壇レポート", "新サービスのご案内", "コラムを更新しました"]


def _generate_account(store: Store, rng: random.Random, tz: ZoneInfo, platform: str,
                      account_id: str, prof: dict, days: int, with_posts: bool = True,
                      public_only: bool = False) -> int:
    today = date.today()
    start = today - timedelta(days=days - 1)
    followers = float(prof["f0"])
    posts: list[Post] = []
    for i in range(days):
        d = start + timedelta(days=i)
        # 成長率は後半にかけて少し変化させる
        followers *= 1 + prof["growth"] * (1 + 0.5 * math.sin(i / 17)) + rng.gauss(0, 0.0006)
        store.save_snapshot(AccountSnapshot(platform, account_id, prof["user"], d,
                                            followers=int(followers)))
        if not with_posts:
            continue
        per_day = prof["per_week"] / 7
        n = int(per_day) + (rng.random() < per_day - int(per_day))
        for _ in range(n):
            hour = rng.choice(list(HOUR_WEIGHT))
            local = datetime.combine(d, time(hour, rng.randint(0, 59)), tzinfo=tz)
            if local > datetime.now(tz):
                continue
            kind = rng.choice(list(prof["types"]))
            tags = rng.sample(list(HASHTAGS), k=rng.randint(0, 3))
            mult = prof["types"][kind] * HOUR_WEIGHT[hour]
            mult *= 1.15 if local.weekday() >= 5 and hour in (12, 13) else 1.0
            mult *= math.prod(HASHTAGS[t] ** 0.5 for t in tags)
            views = int(followers * prof["view"] * mult * rng.lognormvariate(0, 0.35))
            eng = views * prof["er"] * (mult ** 0.5) * rng.lognormvariate(0, 0.3)
            likes = int(eng * 0.72)
            comments = int(eng * 0.08)
            shares = int(eng * 0.1)
            saves = int(eng * 0.1) if platform in ("instagram", "x") else 0
            quotes = int(eng * 0.03) if platform in ("threads", "x") else 0
            if public_only and platform == "instagram":  # 競合の IG はシェア・保存・表示が非公開
                views, shares, saves = None, 0, 0
            text = rng.choice(prof.get("topics", TOPICS)) + " " + " ".join(f"#{t}" for t in tags)
            pid = f"{account_id}_{d:%Y%m%d}_{hour}_{rng.randint(1000, 9999)}"
            posts.append(Post(
                platform=platform, post_id=pid, account_id=account_id,
                created_at=local.astimezone(timezone.utc), text=text, media_type=kind,
                permalink="", metrics=Metrics(
                    views=views,
                    reach=int(views * 0.78) if views and platform in ("instagram", "facebook") else None,
                    likes=likes, comments=comments, shares=shares, saves=saves, quotes=quotes,
                    clicks=int(views * 0.01) if views and platform == "facebook" else None,
                ),
            ))
    return store.save_posts(posts, today)


# デモ用の競合: 名前 → {platform: (プロフィール, 投稿データあり?)}
COMPETITORS = {
    "競合A社": {
        "instagram": (dict(user="rival_a", f0=21000, growth=0.0035, per_week=9, view=0.4, er=0.05,
                           types={"reel": 2.0, "carousel": 1.2}, topics=["新作ビジュアル公開", "制作の裏側を公開",
                                                                         "お客様インタビュー"]), True),
        "x": (dict(user="rival_a", f0=8800, growth=0.0015, per_week=14, view=0.3, er=0.02,
                   types={"text": 0.9, "image": 1.2, "video": 1.6}), True),
        "threads": (dict(user="rival_a", f0=4100, growth=0.006, per_week=0, view=0, er=0,
                         types={"text": 1.0}), False),
    },
    "競合B社": {
        "instagram": (dict(user="rival_b", f0=7600, growth=0.0012, per_week=3, view=0.5, er=0.07,
                           types={"image": 1.0, "carousel": 1.6}, topics=["デザインのコツ", "よくある質問に回答"]), True),
        "facebook": (dict(user="Rival B", f0=12000, growth=0.0004, per_week=0, view=0, er=0,
                          types={"text": 1.0}), False),
        "x": (dict(user="rival_b", f0=3900, growth=0.0009, per_week=5, view=0.4, er=0.03,
                   types={"text": 1.0, "link": 0.8, "image": 1.3}), True),
    },
}


def generate(store: Store, days: int = 120, seed: int = 42, tz_name: str = "Asia/Tokyo",
             competitors: bool = True) -> int:
    rng = random.Random(seed)
    tz = ZoneInfo(tz_name)
    total = 0
    for platform, prof in PROFILES.items():
        total += _generate_account(store, rng, tz, platform, f"demo_{platform}", prof, days)
    if competitors:
        for i, (name, accounts) in enumerate(COMPETITORS.items()):
            for platform, (prof, with_posts) in accounts.items():
                acct = f"demo_comp{i}_{platform}"
                store.mark_competitor(platform, acct, name)
                total += _generate_account(store, rng, tz, platform, acct, prof, days,
                                           with_posts=with_posts, public_only=True)
    return total
