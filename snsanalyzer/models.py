"""共通データモデル。各SNSの値はここで定義した共通形式に正規化して保存する。"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

PLATFORMS = ("instagram", "facebook", "threads", "x")

PLATFORM_LABELS = {
    "instagram": "Instagram",
    "facebook": "Facebook",
    "threads": "Threads",
    "x": "X",
}

MEDIA_LABELS = {
    "image": "画像",
    "video": "動画",
    "reel": "リール",
    "carousel": "カルーセル",
    "text": "テキスト",
    "link": "リンク",
    "other": "その他",
}


@dataclass
class Metrics:
    """投稿の反応指標。取得できない値は None（views/reach/clicks）または 0。"""

    views: Optional[int] = None      # 表示回数（インプレッション／閲覧数）
    reach: Optional[int] = None      # リーチ（ユニーク）
    likes: int = 0                   # いいね・リアクション
    comments: int = 0                # コメント・返信
    shares: int = 0                  # シェア・リポスト・リツイート
    saves: int = 0                   # 保存・ブックマーク
    quotes: int = 0                  # 引用
    clicks: Optional[int] = None     # リンククリック（エンゲージメントには含めない）

    @property
    def engagements(self) -> int:
        """プラットフォーム横断で比較できるエンゲージメント合計。"""
        return self.likes + self.comments + self.shares + self.saves + self.quotes


@dataclass
class Post:
    platform: str
    post_id: str
    account_id: str
    created_at: datetime             # タイムゾーン付き（UTCで保存）
    text: str = ""
    media_type: str = "other"
    permalink: str = ""
    metrics: Metrics = field(default_factory=Metrics)


@dataclass
class AccountSnapshot:
    platform: str
    account_id: str
    username: str
    date: date
    followers: Optional[int] = None
    following: Optional[int] = None
    posts_count: Optional[int] = None


@dataclass
class CollectResult:
    account: AccountSnapshot
    posts: list[Post]
