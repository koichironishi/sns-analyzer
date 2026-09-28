"""Facebook ページ（Graph API）。

必要な権限：pages_read_engagement, read_insights（ページアクセストークンを使用）
Meta はページ指標の廃止・改名を定期的に行うため、insight_metrics は設定で差し替え可能。
"""
from __future__ import annotations

from datetime import date, datetime

from ..models import AccountSnapshot, CollectResult, Metrics, Post
from .base import ApiError, BaseCollector, HttpClient, InsightsFetcher, graph_paginate, parse_time

POST_FIELDS = (
    "id,message,created_time,permalink_url,shares,"
    "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),"
    "attachments{media_type}"
)
# post_impressions / post_impressions_unique は Graph API v25 以降で提供終了（2025-11-15 廃止告知）
DEFAULT_METRICS = ["post_media_view", "post_total_media_view_unique", "post_clicks"]

# 取得した指標名 → 共通指標（先に見つかったものを優先）
METRIC_MAP = {
    "views": ("post_media_view", "post_impressions"),
    "reach": ("post_total_media_view_unique", "post_impressions_unique"),
    "clicks": ("post_clicks",),
}


def _media_type(p: dict) -> str:
    att = (p.get("attachments") or {}).get("data") or []
    if not att:
        return "text"
    return {"photo": "image", "video": "video", "album": "carousel", "link": "link",
            "share": "link"}.get(str(att[0].get("media_type", "")).lower(), "other")


def _first(ins: dict, names: tuple[str, ...]):
    for n in names:
        if n in ins:
            return ins[n]
    return None


class FacebookCollector(BaseCollector):
    platform = "facebook"
    required = ("page_id", "access_token")

    def __init__(self, cfg: dict, graph_version: str = "v26.0"):
        super().__init__(cfg, graph_version)
        self.http = HttpClient(f"https://graph.facebook.com/{graph_version}",
                               query_auth={"access_token": cfg["access_token"]})
        self.insights = InsightsFetcher(self.http, cfg.get("insight_metrics") or DEFAULT_METRICS)

    def collect(self, since: datetime, max_posts: int = 300) -> CollectResult:
        pid = self.cfg["page_id"]
        page = self.http.get(pid, {"fields": "id,name,followers_count,fan_count"})
        account = AccountSnapshot(
            platform=self.platform, account_id=page["id"], username=page.get("name", ""),
            date=date.today(), followers=page.get("followers_count") or page.get("fan_count"),
        )
        posts: list[Post] = []
        params = {"fields": POST_FIELDS, "limit": 50, "since": int(since.timestamp())}
        for p in graph_paginate(self.http, f"{pid}/posts", params):
            created = parse_time(p["created_time"])
            if created < since:
                break
            kind = _media_type(p)
            ins = self.insights.fetch(p["id"], kind)
            posts.append(Post(
                platform=self.platform, post_id=p["id"], account_id=account.account_id,
                created_at=created, text=p.get("message", "") or "", media_type=kind,
                permalink=p.get("permalink_url", ""),
                metrics=Metrics(
                    views=_first(ins, METRIC_MAP["views"]),
                    reach=_first(ins, METRIC_MAP["reach"]),
                    clicks=_first(ins, METRIC_MAP["clicks"]),
                    likes=((p.get("reactions") or {}).get("summary") or {}).get("total_count", 0),
                    comments=((p.get("comments") or {}).get("summary") or {}).get("total_count", 0),
                    shares=(p.get("shares") or {}).get("count", 0),
                ),
            ))
            if len(posts) >= max_posts:
                break
        return CollectResult(account, posts)

    def collect_competitor(self, handle: str, since: datetime, max_posts: int = 100) -> CollectResult:
        """他社ページのデータは「Page Public Content Access」の審査が必要。
        審査未通過の場合はエラーになるため、CSV 取り込み／手動記録で補う。"""
        try:
            page = self.http.get(handle, {"fields": "id,name,followers_count,fan_count"})
        except ApiError as e:
            raise ApiError(f"{e}（他社ページの取得には Page Public Content Access の審査が必要です。"
                           "import-csv --competitor / followers --competitor で登録してください）",
                           e.status, e.payload) from None
        account = AccountSnapshot(platform=self.platform, account_id=page["id"],
                                  username=page.get("name", handle), date=date.today(),
                                  followers=page.get("followers_count") or page.get("fan_count"))
        return CollectResult(account, [])
