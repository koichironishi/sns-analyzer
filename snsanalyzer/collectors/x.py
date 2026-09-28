"""X API v2。

Bearer Token（アプリ認証）で公開指標 public_metrics を取得する。
X API は従量課金／プラン制のため、max_posts_per_run で取得件数を抑えること。
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from ..models import AccountSnapshot, CollectResult, Metrics, Post
from .base import BaseCollector, HttpClient, parse_time


def _media_type(tweet: dict, media_index: dict) -> str:
    keys = (tweet.get("attachments") or {}).get("media_keys") or []
    types = [media_index.get(k, "") for k in keys]
    if len(types) > 1:
        return "carousel"
    if types:
        return {"photo": "image", "video": "video", "animated_gif": "video"}.get(types[0], "other")
    if (tweet.get("entities") or {}).get("urls"):
        return "link"
    return "text"


class XCollector(BaseCollector):
    platform = "x"
    required = ("bearer_token",)

    def __init__(self, cfg: dict, graph_version: str = "v26.0"):
        super().__init__(cfg, graph_version)
        if not (cfg.get("username") or cfg.get("user_id")):
            from ..config import ConfigError
            raise ConfigError("username か user_id を設定してください")
        self.http = HttpClient("https://api.x.com/2",
                               headers={"Authorization": f"Bearer {cfg['bearer_token']}"})

    def collect(self, since: datetime, max_posts: int = 300) -> CollectResult:
        params = {"user.fields": "public_metrics,username"}
        if self.cfg.get("user_id"):
            user = self.http.get(f"users/{self.cfg['user_id']}", params)["data"]
        else:
            user = self.http.get(f"users/by/username/{self.cfg['username']}", params)["data"]
        pm = user.get("public_metrics", {})
        account = AccountSnapshot(
            platform=self.platform, account_id=user["id"], username=user.get("username", ""),
            date=date.today(), followers=pm.get("followers_count"),
            following=pm.get("following_count"), posts_count=pm.get("post_count", pm.get("tweet_count")),
        )
        posts: list[Post] = []
        query = {
            "max_results": 100,
            "start_time": since.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "exclude": "retweets,replies",
            "tweet.fields": "created_at,public_metrics,entities,attachments",
            "expansions": "attachments.media_keys",
            "media.fields": "type",
        }
        while len(posts) < max_posts:
            resp = self.http.get(f"users/{user['id']}/tweets", query)
            media_index = {m["media_key"]: m.get("type", "")
                           for m in (resp.get("includes") or {}).get("media", [])}
            for t in resp.get("data", []):
                m = t.get("public_metrics", {})
                posts.append(Post(
                    platform=self.platform, post_id=t["id"], account_id=user["id"],
                    created_at=parse_time(t["created_at"]), text=t.get("text", ""),
                    media_type=_media_type(t, media_index),
                    permalink=f"https://x.com/{account.username}/status/{t['id']}",
                    metrics=Metrics(
                        views=m.get("impression_count"), likes=m.get("like_count", 0),
                        comments=m.get("reply_count", 0), shares=m.get("retweet_count", 0),
                        quotes=m.get("quote_count", 0), saves=m.get("bookmark_count", 0),
                    ),
                ))
            token = (resp.get("meta") or {}).get("next_token")
            if not token:
                break
            query["pagination_token"] = token
        return CollectResult(account, posts[:max_posts])

    def collect_competitor(self, handle: str, since: datetime, max_posts: int = 100) -> CollectResult:
        other = XCollector({**self.cfg, "username": handle.lstrip("@"), "user_id": ""})
        other.http = self.http
        return other.collect(since, max_posts)

    def missing_ids(self, post_ids: list[str]) -> set[str]:
        """保存済みの投稿IDのうち、X上で削除・非公開化されて取得できないものを返す（100件ずつ照会）。

        X の開発者ポリシーでは、削除・非公開化されたコンテンツは保存データからも削除する必要がある。
        照会は X API の利用量（従量課金）を消費する。
        """
        missing: set[str] = set()
        for i in range(0, len(post_ids), 100):
            batch = post_ids[i:i + 100]
            resp = self.http.get("tweets", {"ids": ",".join(batch), "tweet.fields": "id"})
            found = {t["id"] for t in resp.get("data", [])}
            reported = {str(e.get("resource_id") or e.get("value") or "") for e in resp.get("errors", [])}
            missing |= {pid for pid in batch if pid not in found and pid in reported}
        return missing
