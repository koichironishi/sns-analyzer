"""ユーザーアカウント・認証・セッション管理（Webダッシュボード用）。

- ロール：admin（全クライアント・ユーザー管理・収集/AI実行） / user（割り当てられたクライアントの閲覧のみ）
- パスワード：scrypt（ソルト付き）でハッシュ化して保存。平文は保存しない
- セッション：ランダムトークンを Cookie に渡し、DB には SHA-256 ハッシュのみ保存
- CSRF: セッションごとのトークンをフォームに埋め込み、POST で照合
- ログイン試行制限：同じユーザー名かIPで連続失敗すると一定時間ロック
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ROLES = ("admin", "user")
MIN_PASSWORD = 10
SESSION_IDLE = 8 * 3600          # 最終操作から8時間でログアウト
SESSION_ABSOLUTE = 7 * 24 * 3600  # ログインから最長7日
MAX_FAILURES = 5
LOCK_SECONDS = 15 * 60

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    must_change   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_login    TEXT
);
CREATE TABLE IF NOT EXISTS user_clients (
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    PRIMARY KEY (user_id, client_id)
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf       TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_seen  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS deletion_requests (
    code       TEXT PRIMARY KEY,
    service    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    status     TEXT NOT NULL,
    detail     TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    ts       TEXT NOT NULL,
    username TEXT,
    ip       TEXT,
    action   TEXT NOT NULL,
    detail   TEXT
);
"""


class AuthError(RuntimeError):
    pass


@dataclass
class User:
    id: int
    username: str
    display_name: str
    role: str
    active: bool
    must_change: bool
    created_at: str
    last_login: Optional[str]
    clients: list[str]

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    def can_access(self, client_id: str) -> bool:
        return self.is_admin or client_id in self.clients


@dataclass
class Session:
    user: User
    csrf: str


# ---- パスワード -------------------------------------------------------------
_N, _R, _P = 2 ** 14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r),
                            p=int(p), dklen=len(digest) // 2)
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def check_password_policy(password: str, username: str = "") -> None:
    if len(password) < MIN_PASSWORD:
        raise AuthError(f"パスワードは{MIN_PASSWORD}文字以上にしてください")
    if username and username.lower() in password.lower():
        raise AuthError("パスワードにユーザー名を含めないでください")
    if len(set(password)) < 4:
        raise AuthError("パスワードが単純すぎます")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---- ストア -----------------------------------------------------------------
class UserStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.lock = threading.RLock()
        self._failures: dict[str, list[float]] = {}
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    def close(self) -> None:
        self.conn.close()

    # ---- ユーザー --------------------------------------------------------
    def _user(self, row) -> Optional[User]:
        if row is None:
            return None
        clients = [r["client_id"] for r in self.conn.execute(
            "SELECT client_id FROM user_clients WHERE user_id = ? ORDER BY client_id", (row["id"],))]
        return User(id=row["id"], username=row["username"], display_name=row["display_name"],
                    role=row["role"], active=bool(row["active"]), must_change=bool(row["must_change"]),
                    created_at=row["created_at"], last_login=row["last_login"], clients=clients)

    def get(self, username: str) -> Optional[User]:
        with self.lock:
            return self._user(self.conn.execute(
                "SELECT * FROM users WHERE username = ?", (username,)).fetchone())

    def get_by_id(self, user_id: int) -> Optional[User]:
        with self.lock:
            return self._user(self.conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    def list(self) -> list[User]:
        with self.lock:
            rows = self.conn.execute("SELECT * FROM users ORDER BY role, username").fetchall()
            return [self._user(r) for r in rows]

    def count_admins(self, active_only: bool = True) -> int:
        sql = "SELECT COUNT(*) FROM users WHERE role = 'admin'" + (" AND active = 1" if active_only else "")
        with self.lock:
            return self.conn.execute(sql).fetchone()[0]

    def create(self, username: str, password: str, role: str = "user", display_name: str = "",
               clients: Optional[list[str]] = None, must_change: bool = False) -> User:
        username = username.strip()
        if not username or len(username) > 64 or not all(c.isalnum() or c in "._-@" for c in username):
            raise AuthError("ユーザー名は英数字と . _ - @ で64文字以内にしてください")
        if role not in ROLES:
            raise AuthError(f"ロールは {' / '.join(ROLES)} のいずれかです")
        check_password_policy(password, username)
        with self.lock:
            try:
                cur = self.conn.execute(
                    "INSERT INTO users (username, display_name, role, password_hash, must_change, created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (username, display_name.strip(), role, hash_password(password), int(must_change), _now()))
            except sqlite3.IntegrityError:
                raise AuthError(f"ユーザー名 {username} は既に使われています") from None
            self._set_clients(cur.lastrowid, clients or [])
            self.conn.commit()
            return self.get_by_id(cur.lastrowid)

    def _set_clients(self, user_id: int, clients: list[str]) -> None:
        self.conn.execute("DELETE FROM user_clients WHERE user_id = ?", (user_id,))
        self.conn.executemany("INSERT INTO user_clients VALUES (?,?)",
                              [(user_id, c) for c in sorted(set(clients))])

    def update(self, user_id: int, *, role: Optional[str] = None, display_name: Optional[str] = None,
               clients: Optional[list[str]] = None, active: Optional[bool] = None) -> User:
        user = self.get_by_id(user_id)
        if not user:
            raise AuthError("ユーザーが見つかりません")
        demoting = (role and role != "admin") or active is False
        if user.is_admin and user.active and demoting and self.count_admins() <= 1:
            raise AuthError("有効な管理者が1人もいなくなるため変更できません")
        if role is not None and role not in ROLES:
            raise AuthError("ロールが不正です")
        with self.lock:
            if role is not None:
                self.conn.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
            if display_name is not None:
                self.conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name.strip(), user_id))
            if active is not None:
                self.conn.execute("UPDATE users SET active = ? WHERE id = ?", (int(active), user_id))
                if not active:
                    self.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            if clients is not None:
                self._set_clients(user_id, clients)
            self.conn.commit()
        return self.get_by_id(user_id)

    def set_password(self, user_id: int, password: str, must_change: bool = False,
                     keep_session: Optional[str] = None) -> None:
        user = self.get_by_id(user_id)
        if not user:
            raise AuthError("ユーザーが見つかりません")
        check_password_policy(password, user.username)
        with self.lock:
            self.conn.execute("UPDATE users SET password_hash = ?, must_change = ? WHERE id = ?",
                              (hash_password(password), int(must_change), user_id))
            # パスワード変更時は他のセッションをすべて無効化
            self.conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                              (user_id, _token_hash(keep_session) if keep_session else ""))
            self.conn.commit()

    def delete(self, user_id: int) -> None:
        user = self.get_by_id(user_id)
        if not user:
            raise AuthError("ユーザーが見つかりません")
        if user.is_admin and user.active and self.count_admins() <= 1:
            raise AuthError("最後の管理者は削除できません")
        with self.lock:
            self.conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            self.conn.commit()

    # ---- ログイン --------------------------------------------------------
    def _locked(self, key: str) -> bool:
        now = time.time()
        recent = [t for t in self._failures.get(key, []) if now - t < LOCK_SECONDS]
        self._failures[key] = recent
        return len(recent) >= MAX_FAILURES

    def authenticate(self, username: str, password: str, ip: str = "") -> User:
        keys = [f"u:{username.lower()}", f"ip:{ip}"]
        with self.lock:
            if any(self._locked(k) for k in keys):
                self.log(username, ip, "login_locked")
                raise AuthError("ログイン失敗が続いたため一時的にロックしています。15分後に再度お試しください")
            row = self.conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
            # ユーザーが存在しない場合もハッシュ計算を行い、応答時間で存在を推測されないようにする
            ok = verify_password(password, row["password_hash"] if row else _DUMMY_HASH)
            if not row or not ok or not row["active"]:
                for k in keys:
                    self._failures.setdefault(k, []).append(time.time())
                self.log(username, ip, "login_failed")
                raise AuthError("ユーザー名またはパスワードが正しくありません")
            for k in keys:
                self._failures.pop(k, None)
            self.conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (_now(), row["id"]))
            self.conn.commit()
            self.log(row["username"], ip, "login")
            return self._user(row)

    def create_session(self, user: User) -> tuple[str, str]:
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        now = time.time()
        with self.lock:
            self.conn.execute("DELETE FROM sessions WHERE last_seen < ? OR created_at < ?",
                              (now - SESSION_IDLE, now - SESSION_ABSOLUTE))
            self.conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?)",
                              (_token_hash(token), user.id, csrf, now, now))
            self.conn.commit()
        return token, csrf

    def get_session(self, token: str) -> Optional[Session]:
        if not token:
            return None
        now = time.time()
        with self.lock:
            row = self.conn.execute("SELECT * FROM sessions WHERE token_hash = ?",
                                    (_token_hash(token),)).fetchone()
            if not row:
                return None
            if row["last_seen"] < now - SESSION_IDLE or row["created_at"] < now - SESSION_ABSOLUTE:
                self.conn.execute("DELETE FROM sessions WHERE token_hash = ?", (row["token_hash"],))
                self.conn.commit()
                return None
            user = self.get_by_id(row["user_id"])
            if not user or not user.active:
                return None
            self.conn.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", (now, row["token_hash"]))
            self.conn.commit()
            return Session(user=user, csrf=row["csrf"])

    def delete_session(self, token: str) -> None:
        with self.lock:
            self.conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
            self.conn.commit()

    # ---- データ削除リクエスト（Meta / Threads） ------------------------------
    def add_deletion_request(self, code: str, service: str, user_id: str, status: str, detail: str) -> None:
        with self.lock:
            self.conn.execute("INSERT INTO deletion_requests VALUES (?,?,?,?,?,?)",
                              (code, service, user_id, status, detail, _now()))
            self.conn.commit()

    def get_deletion_request(self, code: str) -> Optional[dict]:
        with self.lock:
            r = self.conn.execute("SELECT * FROM deletion_requests WHERE code = ?", (code,)).fetchone()
            return dict(r) if r else None

    # ---- 監査ログ --------------------------------------------------------
    def log(self, username: str, ip: str, action: str, detail: str = "") -> None:
        with self.lock:
            self.conn.execute("INSERT INTO audit VALUES (?,?,?,?,?)", (_now(), username, ip, action, detail))
            self.conn.commit()

    def recent_audit(self, limit: int = 50) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(
                "SELECT * FROM audit ORDER BY rowid DESC LIMIT ?", (limit,))]


_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))
