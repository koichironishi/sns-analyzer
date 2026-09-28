"""CSV 取り込み。API を使わない場合や、Meta Business Suite / X アナリティクスの
エクスポートを取り込む場合に使う。列名は日本語・英語の代表的な表記を自動判別する。
"""
from __future__ import annotations

import csv
import hashlib
import io
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from .models import Metrics, Post

ALIASES: dict[str, tuple[str, ...]] = {
    "post_id": ("post_id", "id", "post id", "tweet id", "投稿id", "メディアid", "ポストid"),
    "created_at": ("created_at", "publish time", "published", "time", "date", "timestamp",
                   "公開日時", "投稿日時", "日時", "日付"),
    "text": ("text", "description", "tweet text", "post text", "caption", "message",
             "説明", "本文", "投稿内容", "キャプション"),
    "media_type": ("media_type", "post type", "type", "投稿タイプ", "種類"),
    "permalink": ("permalink", "tweet permalink", "url", "link", "パーマリンク", "リンク"),
    "views": ("views", "impressions", "impression_count", "閲覧数", "インプレッション",
              "インプレッション数", "表示回数", "ビュー"),
    "reach": ("reach", "リーチ", "リーチ数"),
    "likes": ("likes", "reactions", "like_count", "いいね", "いいね！", "いいね数", "リアクション"),
    "comments": ("comments", "replies", "reply_count", "コメント", "コメント数", "返信", "返信数"),
    "shares": ("shares", "retweets", "reposts", "シェア", "シェア数", "リポスト", "リツイート"),
    "saves": ("saves", "saved", "bookmarks", "保存", "保存数", "ブックマーク"),
    "quotes": ("quotes", "quote_count", "引用"),
    "clicks": ("clicks", "link clicks", "url clicks", "クリック数", "リンクのクリック"),
}

MEDIA_ALIASES = {
    "image": "image", "photo": "image", "画像": "image", "写真": "image", "ig image": "image",
    "video": "video", "動画": "video", "ig video": "video",
    "reel": "reel", "reels": "reel", "ig reel": "reel", "リール": "reel",
    "carousel": "carousel", "carousel_album": "carousel", "album": "carousel",
    "ig carousel": "carousel", "カルーセル": "carousel",
    "text": "text", "status": "text", "テキスト": "text",
    "link": "link", "links": "link", "リンク": "link",
}

DATE_FORMATS = (
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M",
    "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%Y-%m-%d %H:%M %z", "%a %b %d %Y",
    "%Y-%m-%d", "%Y/%m/%d",
)


def _norm(s: str) -> str:
    return s.strip().lstrip("﻿").lower()


def _resolve_columns(header: list[str]) -> dict[str, str]:
    lookup = {_norm(h): h for h in header}
    cols = {}
    for field, names in ALIASES.items():
        for n in names:
            if n in lookup:
                cols[field] = lookup[n]
                break
    return cols


def parse_datetime(value: str, tz: ZoneInfo) -> datetime:
    v = value.strip()
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        for fmt in DATE_FORMATS:
            try:
                dt = datetime.strptime(v, fmt)
                break
            except ValueError:
                continue
        else:
            raise ValueError(f"日時を解釈できません：{value!r}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)  # タイムゾーンなしは設定のローカル時刻とみなす
    return dt.astimezone(timezone.utc)


def _num(value) -> int | None:
    if value is None:
        return None
    s = str(value).strip().replace(",", "")
    if s in ("", "-", "--", "N/A"):
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def read_csv(path: str | Path, platform: str, account_id: str, tz: ZoneInfo) -> list[Post]:
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp932"):  # Excel 保存の Shift_JIS にも対応
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("文字コードを判別できません（UTF-8 か Shift_JIS で保存してください）")

    reader = csv.DictReader(io.StringIO(text))
    cols = _resolve_columns(reader.fieldnames or [])
    if "created_at" not in cols:
        raise ValueError(f"日時の列が見つかりません。列名：{reader.fieldnames}")

    posts = []
    for row in reader:
        get = lambda f: row.get(cols[f], "") if f in cols else ""  # noqa: E731
        if not get("created_at").strip():
            continue
        created = parse_datetime(get("created_at"), tz)
        text_ = get("text") or ""
        post_id = get("post_id").strip() or hashlib.sha1(
            f"{created.isoformat()}|{text_}".encode()).hexdigest()[:16]
        media = MEDIA_ALIASES.get(_norm(get("media_type")), "other" if get("media_type") else "text")
        posts.append(Post(
            platform=platform, post_id=post_id, account_id=account_id, created_at=created,
            text=text_, media_type=media, permalink=get("permalink"),
            metrics=Metrics(
                views=_num(get("views")), reach=_num(get("reach")), clicks=_num(get("clicks")),
                likes=_num(get("likes")) or 0, comments=_num(get("comments")) or 0,
                shares=_num(get("shares")) or 0, saves=_num(get("saves")) or 0,
                quotes=_num(get("quotes")) or 0,
            ),
        ))
    return posts
