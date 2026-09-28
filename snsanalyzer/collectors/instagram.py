"""Instagram Graph API（ビジネス／クリエイターアカウント）。

必要な権限：instagram_basic, instagram_manage_insights, pages_read_engagement
user_id は Facebook ページに紐づく Instagram ビジネスアカウント ID。
"""
from __future__ import annotations

from datetime import date, datetime

from ..models import AccountSnapshot, CollectResult, Metrics, Post
from .base import BaseCollector, HttpClient, InsightsFetcher, graph_paginate, parse_time

MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count"
DEFAULT_METRICS = ["views", "reach", "saved", "shares", "total_interactions"]
BD_MEDIA_FIELDS = "id,caption,like_count,comments_count,timestamp,media_type,media_product_type,permalink"


def _media_type(m: dict) -> str:
    if m.get("media_product_type") == "REELS":
        return "reel"
    return {"IMAGE": "image", "VIDEO": "video", "CAROUSEL_ALBUM": "carousel"}.get(
        m.get("media_type", ""), "other")


class InstagramCollector(BaseCollector):
    platform = "instagram"
    required = ("user_id", "access_token")

    def __init__(self, cfg: dict, graph_version: str = "v26.0"):
        super().__init__(cfg, graph_version)
        self.http = HttpClient(f"https://graph.facebook.com/{graph_version}",
                               query_auth={"access_token": cfg["access_token"]})
        self.insights = InsightsFetcher(self.http, cfg.get("insight_metrics") or DEFAULT_METRICS)

    def collect(self, since: datetime, max_posts: int = 300) -> CollectResult:
        uid = self.cfg["user_id"]
        prof = self.http.get(uid, {"fields": "id,username,followers_count,follows_count,media_count"})
        account = AccountSnapshot(
            platform=self.platform, account_id=prof["id"], username=prof.get("username", ""),
            date=date.today(), followers=prof.get("followers_count"),
            following=prof.get("follows_count"), posts_count=prof.get("media_count"),
        )
        posts: list[Post] = []
        for m in graph_paginate(self.http, f"{uid}/media", {"fields": MEDIA_FIELDS, "limit": 50}):
            created = parse_time(m["timestamp"])
            if created < since:
                break  # 新しい順に返るので、期間外に達したら終了
            kind = _media_type(m)
            ins = self.insights.fetch(m["id"], kind)
            posts.append(Post(
                platform=self.platform, post_id=m["id"], account_id=account.account_id,
                created_at=created, text=m.get("caption", "") or "", media_type=kind,
                permalink=m.get("permalink", ""),
                metrics=Metrics(
                    views=ins.get("views"), reach=ins.get("reach"),
                    likes=m.get("like_count") or 0, comments=m.get("comments_count") or 0,
                    shares=ins.get("shares", 0), saves=ins.get("saved", 0),
                ),
            ))
            if len(posts) >= max_posts:
                break
        return CollectResult(account, posts)

    def collect_competitor(self, handle: str, since: datetime, max_posts: int = 100) -> CollectResult:
        """Business Discovery API。相手がビジネス／クリエイターアカウントである必要がある。
        相手が「いいね数を非表示」にしている投稿は like_count が返らない（0として扱う）。"""
        uid = self.cfg["user_id"]
        username = handle.lstrip("@")
        posts: list[Post] = []
        after = None
        account = None
        while True:
            media = f"media.after({after}).limit(50)" if after else "media.limit(50)"
            fields = (f"business_discovery.username({username})"
                      f"{{id,username,followers_count,follows_count,media_count,{media}{{{BD_MEDIA_FIELDS}}}}}")
            bd = self.http.get(uid, {"fields": fields})["business_discovery"]
            if account is None:
                account = AccountSnapshot(
                    platform=self.platform, account_id=bd["id"], username=bd.get("username", username),
                    date=date.today(), followers=bd.get("followers_count"),
                    following=bd.get("follows_count"), posts_count=bd.get("media_count"))
            items = (bd.get("media") or {}).get("data", [])
            done = False
            for m in items:
                created = parse_time(m["timestamp"])
                if created < since or len(posts) >= max_posts:
                    done = True
                    break
                posts.append(Post(
                    platform=self.platform, post_id=m["id"], account_id=account.account_id,
                    created_at=created, text=m.get("caption", "") or "", media_type=_media_type(m),
                    permalink=m.get("permalink", ""),
                    metrics=Metrics(likes=m.get("like_count") or 0, comments=m.get("comments_count") or 0),
                ))
            after = ((bd.get("media") or {}).get("paging") or {}).get("cursors", {}).get("after")
            if done or not after or not items:
                break
        return CollectResult(account, posts)
