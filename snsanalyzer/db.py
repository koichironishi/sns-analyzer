"""SQLite ストレージ。投稿の指標は取得日ごとに履歴として残す。"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Iterable, Optional

from .models import AccountSnapshot, Metrics, Post

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    platform   TEXT NOT NULL,
    account_id TEXT NOT NULL,
    username   TEXT,
    updated_at TEXT,
    PRIMARY KEY (platform, account_id)
);
CREATE TABLE IF NOT EXISTS account_snapshots (
    platform    TEXT NOT NULL,
    account_id  TEXT NOT NULL,
    date        TEXT NOT NULL,
    followers   INTEGER,
    following   INTEGER,
    posts_count INTEGER,
    PRIMARY KEY (platform, account_id, date)
);
CREATE TABLE IF NOT EXISTS posts (
    platform   TEXT NOT NULL,
    post_id    TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    text       TEXT,
    media_type TEXT,
    permalink  TEXT,
    PRIMARY KEY (platform, post_id)
);
CREATE TABLE IF NOT EXISTS post_metrics (
    platform     TEXT NOT NULL,
    post_id      TEXT NOT NULL,
    fetched_date TEXT NOT NULL,
    views    INTEGER,
    reach    INTEGER,
    likes    INTEGER,
    comments INTEGER,
    shares   INTEGER,
    saves    INTEGER,
    quotes   INTEGER,
    clicks   INTEGER,
    PRIMARY KEY (platform, post_id, fetched_date)
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at);
CREATE TABLE IF NOT EXISTS competitor_accounts (
    platform   TEXT NOT NULL,
    account_id TEXT NOT NULL,
    competitor TEXT NOT NULL,
    PRIMARY KEY (platform, account_id)
);
"""

# scope: own=自社のみ / competitor=競合のみ / all=すべて
_SCOPE_SQL = {
    "own": "NOT EXISTS (SELECT 1 FROM competitor_accounts c WHERE c.platform = {t}.platform "
           "AND c.account_id = {t}.account_id)",
    "competitor": "EXISTS (SELECT 1 FROM competitor_accounts c WHERE c.platform = {t}.platform "
                  "AND c.account_id = {t}.account_id)",
    "all": "1 = 1",
}


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.conn.commit()
        self.close()

    # ---- 書き込み -------------------------------------------------------
    def save_snapshot(self, snap: AccountSnapshot) -> None:
        self.conn.execute(
            "INSERT INTO accounts (platform, account_id, username, updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(platform, account_id) DO UPDATE SET username=excluded.username, "
            "updated_at=excluded.updated_at",
            (snap.platform, snap.account_id, snap.username, snap.date.isoformat()),
        )
        if snap.followers is None:
            return
        self.conn.execute(
            "INSERT OR REPLACE INTO account_snapshots VALUES (?,?,?,?,?,?)",
            (snap.platform, snap.account_id, snap.date.isoformat(),
             snap.followers, snap.following, snap.posts_count),
        )

    def mark_competitor(self, platform: str, account_id: str, competitor: str) -> None:
        self.conn.execute("INSERT OR REPLACE INTO competitor_accounts VALUES (?,?,?)",
                          (platform, account_id, competitor))
        self.conn.commit()

    def competitor_map(self) -> dict[tuple[str, str], str]:
        """(platform, account_id) → 競合名"""
        rows = self.conn.execute("SELECT * FROM competitor_accounts").fetchall()
        return {(r["platform"], r["account_id"]): r["competitor"] for r in rows}

    def save_posts(self, posts: Iterable[Post], fetched: date) -> int:
        n = 0
        for p in posts:
            self.conn.execute(
                "INSERT INTO posts VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(platform, post_id) DO UPDATE SET text=excluded.text, "
                "media_type=excluded.media_type, permalink=excluded.permalink",
                (p.platform, p.post_id, p.account_id, p.created_at.isoformat(),
                 p.text, p.media_type, p.permalink),
            )
            m = p.metrics
            self.conn.execute(
                "INSERT OR REPLACE INTO post_metrics VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (p.platform, p.post_id, fetched.isoformat(), m.views, m.reach, m.likes,
                 m.comments, m.shares, m.saves, m.quotes, m.clicks),
            )
            n += 1
        self.conn.commit()
        return n

    # ---- 読み込み -------------------------------------------------------
    def load_posts(self, since: Optional[datetime] = None, scope: str = "own") -> list[Post]:
        """各投稿の最新取得日の指標を付けて返す。既定は自社アカウントのみ。"""
        sql = """
            SELECT p.*, m.views, m.reach, m.likes, m.comments, m.shares, m.saves,
                   m.quotes, m.clicks
            FROM posts p
            JOIN post_metrics m ON m.platform = p.platform AND m.post_id = p.post_id
            WHERE m.fetched_date = (
                SELECT MAX(fetched_date) FROM post_metrics m2
                WHERE m2.platform = p.platform AND m2.post_id = p.post_id)
              AND """ + _SCOPE_SQL[scope].format(t="p")
        rows = self.conn.execute(sql).fetchall()
        out = []
        for r in rows:
            created = datetime.fromisoformat(r["created_at"])
            if since and created < since:
                continue
            out.append(Post(
                platform=r["platform"], post_id=r["post_id"], account_id=r["account_id"],
                created_at=created, text=r["text"] or "", media_type=r["media_type"] or "other",
                permalink=r["permalink"] or "",
                metrics=Metrics(
                    views=r["views"], reach=r["reach"], likes=r["likes"] or 0,
                    comments=r["comments"] or 0, shares=r["shares"] or 0,
                    saves=r["saves"] or 0, quotes=r["quotes"] or 0, clicks=r["clicks"],
                ),
            ))
        return out

    def load_follower_series(self) -> dict[str, list[tuple[date, int]]]:
        """自社のプラットフォームごとの日次フォロワー数（同一SNSに複数アカウントがあれば合算）。"""
        rows = self.conn.execute(
            "SELECT platform, date, SUM(followers) AS f FROM account_snapshots s WHERE "
            + _SCOPE_SQL["own"].format(t="s") + " GROUP BY platform, date ORDER BY date"
        ).fetchall()
        series: dict[str, list[tuple[date, int]]] = {}
        for r in rows:
            series.setdefault(r["platform"], []).append((date.fromisoformat(r["date"]), r["f"]))
        return series

    def account_follower_series(self, scope: str = "competitor") -> dict[tuple[str, str], list[tuple[date, int]]]:
        """アカウント単位の日次フォロワー数。(platform, account_id) → [(date, followers)]"""
        rows = self.conn.execute(
            "SELECT platform, account_id, date, followers FROM account_snapshots s WHERE "
            + _SCOPE_SQL[scope].format(t="s") + " ORDER BY date").fetchall()
        out: dict[tuple[str, str], list[tuple[date, int]]] = {}
        for r in rows:
            out.setdefault((r["platform"], r["account_id"]), []).append(
                (date.fromisoformat(r["date"]), r["followers"]))
        return out

    def usernames(self) -> dict[tuple[str, str], str]:
        rows = self.conn.execute("SELECT platform, account_id, username FROM accounts").fetchall()
        return {(r["platform"], r["account_id"]): r["username"] or "" for r in rows}

    def account_names(self) -> dict[str, str]:
        rows = self.conn.execute("SELECT platform, username FROM accounts a WHERE "
                                 + _SCOPE_SQL["own"].format(t="a")).fetchall()
        names: dict[str, list[str]] = {}
        for r in rows:
            names.setdefault(r["platform"], []).append(r["username"] or "")
        return {k: ", ".join(v) for k, v in names.items()}

    # ---- 削除 ---------------------------------------------------------------
    def _delete_where(self, platform: str, account_ids: list[str]) -> dict[str, int]:
        """指定アカウントの投稿・指標・フォロワー記録・アカウント情報を削除する。"""
        counts = {"posts": 0, "metrics": 0, "snapshots": 0}
        for acct in account_ids:
            counts["metrics"] += self.conn.execute(
                "DELETE FROM post_metrics WHERE platform = ? AND post_id IN "
                "(SELECT post_id FROM posts WHERE platform = ? AND account_id = ?)",
                (platform, platform, acct)).rowcount
            counts["posts"] += self.conn.execute(
                "DELETE FROM posts WHERE platform = ? AND account_id = ?", (platform, acct)).rowcount
            counts["snapshots"] += self.conn.execute(
                "DELETE FROM account_snapshots WHERE platform = ? AND account_id = ?", (platform, acct)).rowcount
            self.conn.execute("DELETE FROM accounts WHERE platform = ? AND account_id = ?", (platform, acct))
            self.conn.execute("DELETE FROM competitor_accounts WHERE platform = ? AND account_id = ?", (platform, acct))
        self.vacuum()
        return counts

    def _account_ids(self, platform: str, scope: str) -> list[str]:
        sql = ("SELECT DISTINCT account_id FROM (SELECT platform, account_id FROM accounts UNION "
               "SELECT platform, account_id FROM posts UNION SELECT platform, account_id FROM account_snapshots) t "
               "WHERE platform = ? AND " + _SCOPE_SQL[scope].format(t="t"))
        return [r[0] for r in self.conn.execute(sql, (platform,))]

    def delete_platform(self, platform: str, scope: str = "own") -> dict[str, int]:
        """あるSNSのデータを削除（scope=own:自社 / competitor:競合 / all:両方）。"""
        return self._delete_where(platform, self._account_ids(platform, scope))

    def delete_competitor(self, name: str) -> dict[str, int]:
        total = {"posts": 0, "metrics": 0, "snapshots": 0}
        rows = self.conn.execute("SELECT platform, account_id FROM competitor_accounts WHERE competitor = ?",
                                 (name,)).fetchall()
        for r in rows:
            for k, v in self._delete_where(r["platform"], [r["account_id"]]).items():
                total[k] += v
        return total

    def delete_posts(self, platform: str, post_ids: Iterable[str]) -> int:
        n = 0
        for pid in post_ids:
            self.conn.execute("DELETE FROM post_metrics WHERE platform = ? AND post_id = ?", (platform, pid))
            n += self.conn.execute("DELETE FROM posts WHERE platform = ? AND post_id = ?", (platform, pid)).rowcount
        self.conn.commit()
        return n

    def reconcile(self, platform: str, account_id: str, since: datetime, present_ids: set[str]) -> int:
        """取得範囲（since 以降）にあるはずなのに API から返らなかった投稿＝SNS上で削除された投稿を消す。"""
        rows = self.conn.execute(
            "SELECT post_id, created_at FROM posts WHERE platform = ? AND account_id = ?",
            (platform, account_id)).fetchall()
        gone = [r["post_id"] for r in rows
                if datetime.fromisoformat(r["created_at"]) >= since and r["post_id"] not in present_ids]
        return self.delete_posts(platform, gone)

    def post_ids(self, platform: str, scope: str = "own") -> list[str]:
        return [r[0] for r in self.conn.execute(
            "SELECT post_id FROM posts p WHERE platform = ? AND " + _SCOPE_SQL[scope].format(t="p"), (platform,))]

    def purge_before(self, cutoff: date) -> dict[str, int]:
        """保存期間を過ぎたデータ（投稿日・記録日が cutoff より前）を削除する。"""
        counts = {
            "metrics": self.conn.execute(
                "DELETE FROM post_metrics WHERE (platform, post_id) IN "
                "(SELECT platform, post_id FROM posts WHERE substr(created_at, 1, 10) < ?)",
                (cutoff.isoformat(),)).rowcount,
            "posts": self.conn.execute("DELETE FROM posts WHERE substr(created_at, 1, 10) < ?",
                                       (cutoff.isoformat(),)).rowcount,
            "snapshots": self.conn.execute("DELETE FROM account_snapshots WHERE date < ?",
                                           (cutoff.isoformat(),)).rowcount,
        }
        self.vacuum()  # 削除した行がファイル上に残らないよう領域を再構成
        return counts

    def vacuum(self) -> None:
        self.conn.commit()
        self.conn.execute("VACUUM")
