"""Threads API（graph.threads.net）。

必要な権限：threads_basic, threads_manage_insights
"""
from __future__ import annotations

import logging
from datetime import date, datetime

from ..models import AccountSnapshot, CollectResult, Metrics, Post
from .base import (ApiError, BaseCollector, HttpClient, InsightsFetcher, graph_paginate,
                   parse_insights, parse_time)

log = logging.getLogger(__name__)

POST_FIELDS = "id,text,media_type,permalink,timestamp"
DEFAULT_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"]
MEDIA_MAP = {"TEXT_POST": "text", "IMAGE": "image", "VIDEO": "video",
             "CAROUSEL_ALBUM": "carousel", "AUDIO": "other"}


class ThreadsCollector(BaseCollector):
    platform = "threads"
    required = ("access_token",)

    def __init__(self, cfg: dict, graph_version: str = "v26.0"):
        super().__init__(cfg, graph_version)
        self.http = HttpClient("https://graph.threads.net/v1.0",
                               query_auth={"access_token": cfg["access_token"]})
        self.insights = InsightsFetcher(self.http, cfg.get("insight_metrics") or DEFAULT_METRICS)

    def collect(self, since: datetime, max_posts: int = 300) -> CollectResult:
        uid = self.cfg.get("user_id") or "me"
        prof = self.http.get(uid, {"fields": "id,username"})
        followers = None
        try:
            ins = parse_insights(self.http.get(f"{prof['id']}/threads_insights",
                                               {"metric": "followers_count"}))
            followers = ins.get("followers_count")
        except ApiError as e:
            log.warning("Threads のフォロワー数を取得できませんでした：%s", e)
        account = AccountSnapshot(platform=self.platform, account_id=prof["id"],
                                  username=prof.get("username", ""), date=date.today(),
                                  followers=followers)
        posts: list[Post] = []
        params = {"fields": POST_FIELDS, "limit": 50, "since": int(since.timestamp())}
        for t in graph_paginate(self.http, f"{prof['id']}/threads", params):
            if t.get("media_type") == "REPOST_FACADE":
                continue  # 他人の投稿のリポストは分析対象外
            created = parse_time(t["timestamp"])
            if created < since:
                break
            kind = MEDIA_MAP.get(t.get("media_type", ""), "other")
            ins = self.insights.fetch(t["id"], kind)
            posts.append(Post(
                platform=self.platform, post_id=t["id"], account_id=account.account_id,
                created_at=created, text=t.get("text", "") or "", media_type=kind,
                permalink=t.get("permalink", ""),
                metrics=Metrics(
                    views=ins.get("views"), likes=ins.get("likes", 0),
                    comments=ins.get("replies", 0),
                    shares=ins.get("reposts", 0) + ins.get("shares", 0),
                    quotes=ins.get("quotes", 0),
                ),
            ))
            if len(posts) >= max_posts:
                break
        return CollectResult(account, posts)

    def collect_competitor(self, handle: str, since: datetime, max_posts: int = 100) -> CollectResult:
        """profile_lookup（threads_profile_discovery 権限が必要）。
        公式 API では他アカウントの投稿単位のデータは取れないため、フォロワー数のみ記録する。"""
        prof = self.http.get("profile_lookup", {
            "username": handle.lstrip("@"),
            "fields": "id,username,follower_count,likes_count,views_count"})
        account = AccountSnapshot(platform=self.platform,
                                  account_id=str(prof.get("id") or f"th_{handle.lstrip('@')}"),
                                  username=prof.get("username", handle.lstrip("@")), date=date.today(),
                                  followers=prof.get("follower_count"))
        return CollectResult(account, [])
