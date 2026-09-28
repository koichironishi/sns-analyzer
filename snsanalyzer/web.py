"""ログイン付き Webダッシュボード（標準ライブラリのみ）。

  python3 -m snsanalyzer serve            # http://127.0.0.1:8000

外部公開する場合は必ず HTTPS のリバースプロキシ（Caddy / nginx 等）の背後で動かし、
--secure-cookies を付けること。
"""
from __future__ import annotations

import hmac
import html
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, quote, urlparse

from .auth import ROLES, AuthError, Session, User, UserStore
from . import policy, privacy, terms
from .config import ConfigError, create_client, list_clients, load_config
from .models import PLATFORM_LABELS, PLATFORMS
from .ui import BASE, TOKENS

log = logging.getLogger(__name__)

MAX_BODY = 64 * 1024
FILE_RE = re.compile(r"^[A-Za-z0-9_.-]+\.(html|zip)$")
CLIENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
ACTIONS = {
    # action: (ラベル, 管理者のみ, CLI 引数)
    "report": ("レポート更新", False, ["report"]),
    "export": ("ZIP作成", False, ["export"]),
    "collect": ("データ収集", True, ["collect"]),
    "ai": ("AI分析", True, ["ai"]),
}
COOKIE = "sid"
e = html.escape

APP_CSS = """
.wrap { max-width: 1120px; margin: 0 auto; padding: var(--s6) var(--s5) var(--s7); }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; margin-bottom: var(--s5); }
.head h1 { font-size: var(--fs-2xl); margin: 0; }
.head p { margin: 4px 0 0; color: var(--text-2); }
h2 { font-size: var(--fs-lg); margin: var(--s6) 0 var(--s3); }
.cgrid { display: grid; gap: var(--s4); grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
.ccard { display: grid; gap: var(--s3); align-content: start; }
.ccard h2 { margin: 0; font-size: var(--fs-lg); }
.ccard h2 a { color: var(--text); text-decoration: underline; text-decoration-thickness: 1px;
  text-underline-offset: 4px; display: inline-block; padding: 4px 0; }
.ccard h2 a:hover { color: var(--accent); text-decoration-thickness: 2px; }
.ccard .id { font-size: var(--fs-xs); color: var(--muted); }
.ccard .meta { display: flex; gap: var(--s4); font-size: var(--fs-sm); color: var(--text-2); flex-wrap: wrap; }
.ccard .chips { display: flex; flex-wrap: wrap; gap: 4px 12px; min-height: 24px; }
.ccard .actions { display: flex; gap: var(--s2); flex-wrap: wrap; margin-top: var(--s2); }
details.panel { margin-top: var(--s5); }
details.panel > summary { cursor: pointer; list-style: none; }
details.panel > summary::-webkit-details-marker { display: none; }
details.panel[open] > summary { margin-bottom: var(--s4); }
.form-grid { display: grid; gap: 0 var(--s6); grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); }
.form-actions { margin-top: var(--s5); display: flex; gap: var(--s2); flex-wrap: wrap; }
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: var(--s5); }
.login { width: 100%; max-width: 400px; }
.login .app-brand { margin-bottom: var(--s5); font-size: var(--fs-base); }
.login h1 { font-size: var(--fs-xl); margin: 0 0 var(--s2); }
.login input { max-width: none; }
.login .btn { width: 100%; margin-top: var(--s5); min-height: 48px; }
.edit { display: grid; gap: var(--s4); padding: var(--s4) 0 var(--s2); }
.edit form { border-top: 1px solid var(--grid); padding-top: var(--s2); }
.edit form:first-child { border-top: 0; padding-top: 0; }
td details > summary { white-space: nowrap; cursor: pointer; color: var(--accent); font-weight: 600; font-size: var(--fs-sm); min-height: 44px; padding: 0 8px;
  display: inline-flex; align-items: center; }
pre.log { white-space: pre-wrap; font: 12px/1.6 ui-monospace, Menlo, monospace; margin: 0; }
fieldset.fs { border: 0; padding: 0; margin: var(--s4) 0 0; min-width: 0; }
fieldset.fs legend { padding: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.status { display: inline-flex; gap: 6px; align-items: center; font-size: var(--fs-sm); color: var(--text-2); }
.foot { max-width: 1120px; margin: 0 auto; padding: 0 var(--s5) var(--s6); font-size: var(--fs-sm); color: var(--text-2); }
.foot { display: flex; flex-wrap: wrap; gap: 0 var(--s5); }
.foot a { color: var(--text-2); display: inline-flex; align-items: center; min-height: 44px; }
"""
CSS = TOKENS + BASE + APP_CSS + policy.POLICY_CSS


# ---- アプリ本体 --------------------------------------------------------------
class App:
    def __init__(self, config_path: str = "config.json", secure_cookies: bool = False,
                 trust_proxy: bool = False):
        self.config_path = config_path
        self.trust_proxy = trust_proxy
        self.root = load_config(config_path)
        self.users = UserStore(self.root.get("app_db", "data/app.db"))
        self.secure = secure_cookies
        self.jobs: dict[str, dict] = {}
        self.jobs_lock = threading.Lock()

    def client_cfg(self, cid: str) -> dict:
        return load_config(self.config_path, cid)

    def clients(self) -> list[str]:
        return list_clients(load_config(self.config_path))

    def run_job(self, cid: str, action: str, user: User, question: str = "") -> bool:
        with self.jobs_lock:
            cur = self.jobs.get(cid)
            if cur and cur["status"] == "running":
                return False
            job = {"action": action, "label": ACTIONS[action][0], "status": "running", "by": user.username,
                   "started": datetime.now().strftime("%m/%d %H:%M"), "output": ""}
            self.jobs[cid] = job
        args = [sys.executable, "-m", "snsanalyzer", "--config", self.config_path, "-c", cid,
                *ACTIONS[action][2]]
        if action == "ai" and question:
            args += ["--question", question]

        def work():
            try:
                r = subprocess.run(args, capture_output=True, text=True, timeout=1800, cwd=os.getcwd())
                job["status"] = "done" if r.returncode == 0 else "failed"
                job["output"] = (r.stdout + r.stderr)[-4000:]
            except subprocess.TimeoutExpired:
                job["status"], job["output"] = "failed", "タイムアウトしました（30分）"
            job["finished"] = datetime.now().strftime("%m/%d %H:%M")
        threading.Thread(target=work, daemon=True).start()
        return True


# ---- レイアウト ---------------------------------------------------------------
def app_bar(s: Session, active: str = "", extra: str = "") -> str:
    u = s.user
    items = [("clients", "/", "クライアント")]
    if u.is_admin:
        items += [("users", "/admin/users", "ユーザー管理"), ("audit", "/admin/audit", "操作ログ")]
    nav = "".join(f'<a href="{href}"{" aria-current=\"page\"" if key == active else ""}>{label}</a>'
                  for key, href, label in items)
    return f"""<header class="app-bar no-print"><div class="app-bar-in">
      <a class="app-brand" href="/">SNS Analyzer</a><nav class="app-nav" aria-label="メイン">{nav}</nav>
      <div class="app-right">{extra}
        <a class="btn ghost sm" href="/account"{' aria-current="page"' if active == 'account' else ''}><span class="acct-name">{e(u.display_name or u.username)}</span>
          <span class="badge{' warn' if u.is_admin else ''}">{'管理者' if u.is_admin else 'ユーザー'}</span></a>
        <form method="post" action="/logout">{csrf_field(s)}<button class="btn ghost sm">ログアウト</button></form>
      </div></div></header>"""


def layout(title: str, body: str, s: Optional[Session], msg: str = "", kind: str = "", active: str = "") -> str:
    role = "alert" if kind == "error" else "status"
    note = f'<div class="msg {kind}" role="{role}">{e(msg)}</div>' if msg else ""
    bar = app_bar(s, active) if s else ""
    main = (f'<main class="wrap" id="main" tabindex="-1">{note}{body}</main>' if s
            else f'<main id="main" tabindex="-1">{body}</main>')
    return f"""<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(title)}｜SNS Analyzer</title>
<style>{CSS}</style></head><body><a class="skip" href="#main">本文へスキップ</a>{bar}{main}
<footer class="foot"><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a></footer></body></html>"""


def local_time(iso: Optional[str], tz_name: str = "Asia/Tokyo") -> str:
    """UTC の ISO 文字列を設定タイムゾーンの「YYYY/MM/DD HH:MM」に。"""
    if not iso:
        return "—"
    from zoneinfo import ZoneInfo
    try:
        return datetime.fromisoformat(iso).astimezone(ZoneInfo(tz_name)).strftime("%Y/%m/%d %H:%M")
    except ValueError:
        return iso


def csrf_field(s: Session) -> str:
    return f'<input type="hidden" name="csrf" value="{e(s.csrf)}">'


def chips(cfg: dict) -> str:
    on = [p for p in PLATFORMS if cfg.get(p, {}).get("enabled")]
    return "".join(f'<span class="chip"><i class="dot" style="background:var(--c-{p})"></i>{PLATFORM_LABELS[p]}</span>'
                   for p in on) or '<span class="muted">未接続</span>'


# ---- リクエストハンドラ --------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "SNSAnalyzer"
    sys_version = ""

    # -- 共通 --
    def log_message(self, fmt, *args):  # アクセスログ（トークンを含まない）
        log.info("%s %s", self.client_address[0], fmt % args)

    @property
    def ip(self) -> str:
        # リバースプロキシ（Caddy 等）経由では接続元がプロキシになるため、
        # --trust-proxy 指定時のみ、プロキシが付けた X-Forwarded-For の末尾を使う
        xff = self.headers.get("X-Forwarded-For")
        if self.app.trust_proxy and xff:
            return xff.split(",")[-1].strip()
        return self.client_address[0]

    def _cookie_token(self) -> str:
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c[COOKIE].value if COOKIE in c else ""

    def session(self) -> Optional[Session]:
        return self.app.users.get_session(self._cookie_token())

    def send(self, body: str | bytes, status: int = 200, ctype: str = "text/html; charset=utf-8",
             headers: Optional[dict] = None, csp: Optional[str] = None) -> None:
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", csp or
                         "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
        if self.app.secure:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, to: str, cookie: Optional[str] = None) -> None:
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def set_cookie(self, token: str, max_age: Optional[int] = None) -> str:
        parts = [f"{COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Lax"]
        if self.app.secure:
            parts.append("Secure")
        if max_age is not None:
            parts.append(f"Max-Age={max_age}")
        return "; ".join(parts)

    def error(self, status: int, message: str, s: Optional[Session] = None) -> None:
        body = (f'<div class="card" style="max-width:560px"><p class="eyebrow muted">エラー {status}</p>'
                f'<h1 style="font-size:var(--fs-xl)">{e(message)}</h1><a class="btn" href="/">クライアント一覧へ</a></div>')
        self.send(layout("エラー", body, s) if s else layout("エラー", f'<div class="login-wrap">{body}</div>', None), status)

    def form(self) -> dict[str, list[str]]:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("リクエストが大きすぎます")
        return parse_qs(self.rfile.read(n).decode("utf-8", errors="replace"), keep_blank_values=True)

    def same_origin(self) -> bool:
        """POST の Origin / Referer がこのホストと一致するか（CSRF 対策の多層防御）。"""
        src = self.headers.get("Origin") or self.headers.get("Referer")
        if not src:
            return True  # 一部ブラウザ・CLI は送らない。CSRF トークンで防御する
        return urlparse(src).netloc == self.headers.get("Host", "")

    # -- ルーティング --
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method: str) -> None:
        try:
            path = urlparse(self.path).path
            if path == "/login":
                return self.login_get() if method == "GET" else self.login_post()
            # Meta / Threads からのデータ削除リクエスト（署名で検証。ログイン・CSRF対象外）
            if method == "POST" and path in ("/meta/data-deletion", "/threads/data-deletion"):
                return self.deletion_callback("meta" if path.startswith("/meta") else "threads")
            if method == "GET" and path == "/data-deletion/status":
                return self.deletion_status()
            if method == "GET" and path == "/privacy":
                return self.privacy_policy()
            if method == "GET" and path == "/terms":
                return self.terms_page()
            s = self.session()
            if not s:
                if method == "GET":
                    return self.redirect("/login?next=" + quote(self.path, safe=""))
                return self.error(401, "ログインしてください")
            f: dict = {}
            if method == "POST":
                f = self.form()
                if not self.same_origin() or not hmac.compare_digest(
                        (f.get("csrf") or [""])[0], s.csrf):
                    return self.error(403, "不正なリクエストです（ページを再読み込みしてやり直してください）", s)
            if s.user.must_change and path not in ("/account", "/account/password", "/logout"):
                return self.redirect("/account")
            routes = [
                ("GET", r"/", self.home), ("POST", r"/logout", self.logout),
                ("GET", r"/account", self.account), ("POST", r"/account/password", self.account_password),
                ("GET", r"/c/([^/]+)", self.client_report), ("GET", r"/c/([^/]+)/files", self.client_files),
                ("GET", r"/c/([^/]+)/file/([^/]+)", self.client_file), ("POST", r"/c/([^/]+)/run", self.client_run),
                ("POST", r"/admin/clients", self.admin_client_create),
                ("GET", r"/c/([^/]+)/settings", self.client_settings),
                ("POST", r"/c/([^/]+)/consent", self.client_consent),
                ("POST", r"/c/([^/]+)/data/delete", self.client_data_delete),
                ("POST", r"/c/([^/]+)/data/purge", self.client_data_purge),
                ("POST", r"/c/([^/]+)/delete", self.client_delete),
                ("GET", r"/admin/users", self.admin_users), ("POST", r"/admin/users", self.admin_user_create),
                ("POST", r"/admin/users/(\d+)", self.admin_user_update),
                ("POST", r"/admin/users/(\d+)/password", self.admin_user_password),
                ("POST", r"/admin/users/(\d+)/delete", self.admin_user_delete),
                ("GET", r"/admin/audit", self.admin_audit),
            ]
            for m, pattern, fn in routes:
                match = re.fullmatch(pattern, path)
                if m == method and match:
                    return fn(s, f, *match.groups()) if method == "POST" else fn(s, *match.groups())
            self.error(404, "ページが見つかりません", s)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:  # 詳細は画面に出さずログへ
            log.exception("request failed")
            try:
                self.error(500, "サーバーエラーが発生しました")
            except OSError:
                pass

    # -- 認証 --
    def login_get(self, msg: str = "", status: int = 200) -> None:
        nxt = parse_qs(urlparse(self.path).query).get("next", ["/"])[0]
        note = f'<div class="msg error" role="alert">{e(msg)}</div>' if msg else ""
        body = f"""<div class="login-wrap"><div class="login card">
          <span class="app-brand">SNS Analyzer</span>
          <h1>ログイン</h1><p class="sub">アカウントは管理者が発行します。</p>{note}
          <form method="post" action="/login"><input type="hidden" name="next" value="{e(nxt)}">
          <label for="u">ユーザー名<span class="req">必須</span></label><input id="u" type="text" name="username" autocomplete="username" required autofocus>
          <label for="p">パスワード<span class="req">必須</span></label><input id="p" type="password" name="password" autocomplete="current-password" required>
          <button class="btn primary">ログイン</button></form>
          <p class="hint" style="margin-top:var(--s5)">本ツールは Meta Platforms, Inc. および X Corp. が提供・承認するものではありません。
          <a href="/terms">利用規約</a>・<a href="/privacy">プライバシーポリシー</a></p></div></div>"""
        self.send(layout("ログイン", body, None), status)

    def login_post(self) -> None:
        if not self.same_origin():
            return self.error(403, "不正なリクエストです")
        f = self.form()
        username, password = (f.get("username") or [""])[0], (f.get("password") or [""])[0]
        try:
            user = self.app.users.authenticate(username, password, self.ip)
        except AuthError as ex:
            return self.login_get(str(ex), 401)
        token, _ = self.app.users.create_session(user)
        nxt = (f.get("next") or ["/"])[0]
        if not nxt.startswith("/") or nxt.startswith("//"):  # オープンリダイレクト対策
            nxt = "/"
        self.redirect("/account" if user.must_change else nxt, self.set_cookie(token))

    def logout(self, s: Session, f: dict) -> None:
        self.app.users.delete_session(self._cookie_token())
        self.app.users.log(s.user.username, self.ip, "logout")
        self.redirect("/login", self.set_cookie("", 0))

    # -- アカウント --
    def account(self, s: Session, msg: str = "", kind: str = "") -> None:
        u = s.user
        if u.must_change and not msg:
            msg, kind = "初回ログインのため、パスワードを変更してください。", ""
        body = f"""<div class="head"><div><h1>アカウント</h1><p>ログイン情報とパスワードの変更</p></div></div>
          <div class="card flush"><table><tbody>
            <tr><th scope="row">ユーザー名</th><td>{e(u.username)}</td></tr>
            <tr><th scope="row">表示名</th><td>{e(u.display_name or '—')}</td></tr>
            <tr><th scope="row">権限</th><td>{'管理者（すべての操作）' if u.is_admin else 'ユーザー（担当クライアントの閲覧）'}</td></tr>
            <tr><th scope="row">担当クライアント</th><td>{'すべて' if u.is_admin else e(', '.join(u.clients) or 'なし')}</td></tr>
          </tbody></table></div>
          <h2>パスワード変更</h2>
          <form class="card" method="post" action="/account/password">{csrf_field(s)}
            <label for="c">現在のパスワード<span class="req">必須</span></label><input id="c" type="password" name="current" autocomplete="current-password" required>
            <label for="n">新しいパスワード<span class="req">必須</span></label><input id="n" type="password" name="new" autocomplete="new-password" required minlength="10" aria-describedby="n-hint">
            <p class="hint" id="n-hint">10文字以上。ユーザー名を含めないでください。</p>
            <label for="n2">新しいパスワード（確認）<span class="req">必須</span></label><input id="n2" type="password" name="new2" autocomplete="new-password" required>
            <div class="form-actions"><button class="btn primary">変更する</button></div></form>"""
        self.send(layout("アカウント", body, s, msg, kind, active="account"))

    def account_password(self, s: Session, f: dict) -> None:
        get = lambda k: (f.get(k) or [""])[0]  # noqa: E731
        users = self.app.users
        row_hash = users.conn.execute("SELECT password_hash FROM users WHERE id = ?", (s.user.id,)).fetchone()[0]
        from .auth import verify_password
        if not verify_password(get("current"), row_hash):
            return self.account(s, "現在のパスワードが正しくありません", "error")
        if get("new") != get("new2"):
            return self.account(s, "確認用のパスワードが一致しません", "error")
        if get("new") == get("current"):
            return self.account(s, "現在と異なるパスワードを設定してください", "error")
        try:
            users.set_password(s.user.id, get("new"), keep_session=self._cookie_token())
        except AuthError as ex:
            return self.account(s, str(ex), "error")
        users.log(s.user.username, self.ip, "password_changed")
        s.user.must_change = False
        self.account(s, "パスワードを変更しました", "ok")

    # -- クライアント --
    def _visible_clients(self, u: User) -> list[str]:
        return [c for c in self.app.clients() if u.can_access(c)]

    def home(self, s: Session, msg: str = "", kind: str = "") -> None:
        cards = []
        for cid in self._visible_clients(s.user):
            try:
                cfg = self.app.client_cfg(cid)
            except ConfigError:
                continue
            latest = Path(cfg["report_dir"]) / "latest.html"
            updated = datetime.fromtimestamp(latest.stat().st_mtime).strftime("%Y/%m/%d %H:%M") if latest.exists() else "未作成"
            comps = len(cfg.get("competitors") or [])
            job = self.app.jobs.get(cid)
            running = '<span class="badge info">処理中</span>' if job and job["status"] == "running" else ""
            cards.append(f"""<article class="card ccard">
              <div><h2><a href="/c/{e(cid)}">{e(cfg['name'])}</a> {running}</h2><div class="id">{e(cid)}</div></div>
              <div class="chips">{chips(cfg)}</div>
              <div class="meta"><span>レポート更新：{updated}</span><span>競合：{comps or 'なし'}</span>
                <span>AI分析：{'<span class="badge good">同意済み</span>' if privacy.get_consent(cfg)['valid'] else '<span class="badge">同意なし</span>'}</span></div>
              <div class="actions"><a class="btn primary sm" href="/c/{e(cid)}">レポートを見る</a>
                <a class="btn sm" href="/c/{e(cid)}/files">ファイル</a>
                {f'<a class="btn sm" href="/c/{e(cid)}/settings">設定</a>' if s.user.is_admin else ''}</div></article>""")
        grid = (f'<div class="cgrid">{"".join(cards)}</div>' if cards else
                '<div class="card"><p>表示できるクライアントがありません。'
                + ('「クライアントを追加」から登録してください。' if s.user.is_admin else '管理者に担当クライアントの割り当てを依頼してください。')
                + '</p></div>')
        add = ""
        if s.user.is_admin:
            add = f"""<details class="panel"{' open' if kind == 'error' else ''}><summary class="btn">＋ クライアントを追加</summary>
              <form class="card" method="post" action="/admin/clients">{csrf_field(s)}
                <div class="form-grid"><div>
                  <label for="cid">ID<span class="req">必須</span></label><input id="cid" type="text" name="id" required pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*" aria-describedby="cid-hint">
                  <p class="hint" id="cid-hint">英数字・ハイフン・アンダースコア（例：acme）</p>
                  <label for="cn">表示名</label><input id="cn" type="text" name="name" placeholder="株式会社ACME">
                </div><div>
                  <label for="cb">事業内容・SNSの目的</label><textarea id="cb" name="brand" aria-describedby="cb-hint"></textarea>
                  <p class="hint" id="cb-hint">AI分析の前提として使います。</p>
                </div></div>
                <div class="form-actions"><button class="btn primary">追加する</button></div>
                <p class="hint">SNSの接続・競合の登録はサーバー上のコマンド（connect / competitor）で行います。</p></form></details>"""
        n = len(cards)
        body = f"""<div class="head"><div><h1>クライアント</h1><p>{n}件{'（すべて）' if s.user.is_admin else '（担当分）'}</p></div></div>{grid}{add}"""
        self.send(layout("クライアント", body, s, msg, kind, active="clients"))

    def _client(self, s: Session, cid: str) -> Optional[dict]:
        if not CLIENT_RE.match(cid) or not s.user.can_access(cid):
            self.error(404, "クライアントが見つかりません", s)  # 権限がない場合も存在を明かさない
            return None
        try:
            return self.app.client_cfg(cid)
        except ConfigError:
            self.error(404, "クライアントが見つかりません", s)
            return None

    def _toolbar(self, s: Session, cid: str, cfg: dict) -> str:
        job = self.app.jobs.get(cid)
        status = ""
        if job:
            label = {"running": "実行中…", "done": "完了", "failed": "失敗"}[job["status"]]
            cls = {"running": "info", "done": "good", "failed": "warn"}[job["status"]]
            status = (f'<a class="status" href="/c/{e(cid)}/files"><span class="badge {cls}">{e(job["label"])}：{label}</span>'
                      f'{e(job["started"])}</a>')
        btns = "".join(
            f'<form method="post" action="/c/{e(cid)}/run">{csrf_field(s)}'
            f'<input type="hidden" name="action" value="{a}"><button class="btn sm">{label}</button></form>'
            for a, (label, admin_only, _) in ACTIONS.items() if s.user.is_admin or not admin_only)
        ops = (f'<details class="menu"><summary class="btn sm">操作</summary><div class="menu-panel" '
               f'style="right:0">{btns}<a class="btn sm" href="/c/{e(cid)}/files">ファイル一覧</a>'
               + (f'<a class="btn sm" href="/c/{e(cid)}/settings">設定（AI同意・データ削除）</a>' if s.user.is_admin else '')
               + '</div></details>')
        return app_bar(s, "clients", status + ops)

    def client_report(self, s: Session, cid: str) -> None:
        cfg = self._client(s, cid)
        if cfg is None:
            return
        latest = Path(cfg["report_dir"]) / "latest.html"
        if not latest.exists():
            body = f"""<div class="head"><div><h1>{e(cfg['name'])}</h1><p>まだレポートがありません。</p></div></div>
              <div class="card"><p>収集済みのデータからレポートを作成します。データがない場合は、先に管理者がデータ収集を実行してください。</p>
              <form method="post" action="/c/{e(cid)}/run">{csrf_field(s)}<input type="hidden" name="action" value="report">
              <button class="btn primary">レポートを作成</button></form></div>"""
            return self.send(layout(cfg["name"], body, s, active="clients"))
        page = latest.read_text(encoding="utf-8")
        skip = '<a class="skip" href="#main">本文へスキップ</a>'
        if skip in page:  # スキップリンクを先頭に保ったまま、その直後にアプリバーを差し込む
            page = page.replace(skip, skip + self._toolbar(s, cid, cfg), 1)
        else:
            page = page.replace("<body>", "<body>" + self._toolbar(s, cid, cfg), 1)
        self.send(page, csp="default-src 'self'; style-src 'self' 'unsafe-inline'; "
                            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data:; "
                            "frame-ancestors 'none'; form-action 'self'; base-uri 'none'")

    def client_files(self, s: Session, cid: str) -> None:
        cfg = self._client(s, cid)
        if cfg is None:
            return
        d = Path(cfg["report_dir"])
        files = sorted((p for p in d.glob("*") if FILE_RE.match(p.name)),
                       key=lambda p: p.stat().st_mtime, reverse=True) if d.exists() else []
        rows = "".join(f"""<tr><td><a href="/c/{e(cid)}/file/{e(p.name)}">{e(p.name)}</a></td>
          <td class="muted">{'ZIP（HTML・CSV・AI分析）' if p.suffix == '.zip' else 'レポート'}</td>
          <td class="num muted">{p.stat().st_size / 1024:,.0f} KB</td>
          <td class="muted">{datetime.fromtimestamp(p.stat().st_mtime):%Y-%m-%d %H:%M}</td></tr>""" for p in files)
        job = self.app.jobs.get(cid)
        joblog = ""
        if job and job.get("output"):
            joblog = (f'<h2>直近の実行結果（{e(job["label"])}・{e(job["started"])}）</h2>'
                      f'<div class="card"><pre class="log">{e(job["output"])}</pre></div>')
        body = f"""<div class="head"><div><p class="sub" style="margin:0"><a href="/">クライアント</a> / {e(cfg['name'])}</p>
          <h1>ファイル</h1><p>レポートとダウンロード用ZIP（HTML・CSV・AI分析）</p></div>
          <a class="btn primary" href="/c/{e(cid)}">レポートを見る</a></div>
          <div class="card flush scroll"><table><thead><tr><th>ファイル</th><th>種類</th><th class="num">サイズ</th><th>更新</th></tr></thead>
          <tbody>{rows or '<tr><td colspan="4" class="muted">ファイルはまだありません</td></tr>'}</tbody></table></div>{joblog}"""
        if job and job["status"] == "running":
            body += '<meta http-equiv="refresh" content="5">'
        self.send(layout(cfg["name"], body, s, active="clients"))

    def client_file(self, s: Session, cid: str, name: str) -> None:
        cfg = self._client(s, cid)
        if cfg is None:
            return
        base = Path(cfg["report_dir"]).resolve()
        target = (base / name).resolve()
        if not FILE_RE.match(name) or target.parent != base or not target.is_file():
            return self.error(404, "ファイルが見つかりません", s)
        self.app.users.log(s.user.username, self.ip, "download", f"{cid}/{name}")
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        disp = "attachment" if name.endswith(".zip") else "inline"
        self.send(target.read_bytes(), ctype=ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""),
                  headers={"Content-Disposition": f"{disp}; filename=\"{name}\""},
                  csp="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' "
                      "https://cdnjs.cloudflare.com; img-src 'self' data:; frame-ancestors 'none'")

    def client_run(self, s: Session, f: dict, cid: str) -> None:
        cfg = self._client(s, cid)
        if cfg is None:
            return
        action = (f.get("action") or [""])[0]
        if action not in ACTIONS or (ACTIONS[action][1] and not s.user.is_admin):
            return self.error(403, "この操作は実行できません", s)
        if action == "ai" and not privacy.get_consent(cfg)["valid"]:
            return self.client_settings(s, cid, "AI分析を実行するには、先にクライアントの同意を記録してください。", "error")
        started = self.app.run_job(cid, action, s.user)
        if started:
            self.app.users.log(s.user.username, self.ip, f"run_{action}", cid)
        self.redirect(f"/c/{quote(cid)}/files")


    # -- クライアント設定（AI同意・データ削除） --
    def _busy(self, cid: str) -> bool:
        job = self.app.jobs.get(cid)
        return bool(job and job["status"] == "running")

    def client_settings(self, s: Session, cid: str, msg: str = "", kind: str = "") -> None:
        if not self._require_admin(s):
            return
        cfg = self._client(s, cid)
        if cfg is None:
            return
        c = privacy.get_consent(cfg)
        status = ('<span class="badge good">同意済み</span>' if c["valid"] else
                  '<span class="badge warn">再同意が必要</span>' if c["outdated"] else
                  '<span class="badge">撤回済み</span>' if c["status"] == "revoked" else '<span class="badge">未登録</span>')
        detail = ""
        if c["status"] == "granted":
            detail = (f'<p>同意者：{e(c.get("granted_by", ""))}／記録日時：{e(local_time(c.get("granted_at"), self.app.root["timezone"]))}'
                      f'／投稿本文の送信：{"あり" if c.get("include_post_text") else "なし（集計値のみ）"}</p>')
        text = "".join(f"<li>{e(t)}</li>" for t in privacy.consent_text(True))
        grant_form = f"""<form method="post" action="/c/{e(cid)}/consent">{csrf_field(s)}<input type="hidden" name="action" value="grant">
            <label for="by">同意した方の氏名・所属<span class="req">必須</span></label>
            <input id="by" type="text" name="by" required placeholder="山田 花子（株式会社ACME 広報部）">
            <label class="check" style="margin-top:12px"><input type="checkbox" name="include_text" value="1" checked> 投稿本文の送信にも同意を得た（外すと集計値のみ送信）</label>
            <label class="check"><input type="checkbox" name="explained" value="1" required> 上記の説明を相手に示し、同意を得た<span class="req">必須</span></label>
            <label for="note">メモ（同意の取得方法・書面の保管場所など）</label><input id="note" type="text" name="note">
            <div class="form-actions"><button class="btn primary">同意を記録する</button></div></form>"""
        revoke_form = (f"""<form method="post" action="/c/{e(cid)}/consent" onsubmit="return confirm('同意を撤回し、AI分析結果を削除します。よろしいですか？')">
            {csrf_field(s)}<input type="hidden" name="action" value="revoke">
            <div class="form-actions"><button class="btn danger">同意を撤回する（AI分析結果を削除）</button></div></form>"""
                       if c["status"] == "granted" else "")
        comps = [x["name"] for x in cfg.get("competitors") or []]
        opts = "".join(f'<option value="p:{p}">{PLATFORM_LABELS[p]}（自社・競合）</option>' for p in PLATFORMS)
        opts += "".join(f'<option value="c:{e(n)}">競合：{e(n)}</option>' for n in comps)
        days = privacy.retention_days(cfg)
        confirm_field = (f'<label for="{{id}}">確認のため、クライアントID「{e(cid)}」を入力<span class="req">必須</span></label>'
                         f'<input id="{{id}}" type="text" name="confirm" required autocomplete="off">')
        body = f"""<div class="head"><div><p class="sub" style="margin:0"><a href="/">クライアント</a> / {e(cfg['name'])}</p>
          <h1>設定</h1><p>AI分析の同意と、収集データの削除</p></div><a class="btn" href="/c/{e(cid)}">レポートを見る</a></div>

          <h2>AI分析の同意 {status}</h2>
          <div class="card">
            <p>AI分析を実行する前に、次の内容をクライアントに説明し、同意を得てください（説明文の版：{privacy.CONSENT_VERSION}）。</p>
            <ul>{text}</ul>{detail}
            {grant_form if not c["valid"] else revoke_form}
          </div>

          <h2>データの削除</h2>
          <div class="card">
            <p>保存期間：{f'{days}日（データ収集のたびに、これより古いデータを自動削除）' if days else '無期限（config.json の retention_days で設定）'}</p>
            {f"""<form method="post" action="/c/{e(cid)}/data/purge">{csrf_field(s)}<div class="form-actions" style="margin-top:0">
              <button class="btn sm">今すぐ保存期間を適用する</button></div></form>""" if days else ''}
            <form method="post" action="/c/{e(cid)}/data/delete">{csrf_field(s)}
              <label for="tg">削除する対象<span class="req">必須</span></label>
              <select id="tg" name="target" required>{opts}</select>
              <label class="check" style="margin-top:12px"><input type="checkbox" name="disconnect" value="1"> あわせてSNSの接続も解除する</label>
              {confirm_field.format(id="cf1")}
              <p class="hint">削除したデータを含むレポート・ZIP・AI分析結果も削除されます。元に戻せません。</p>
              <div class="form-actions"><button class="btn danger">データを削除する</button></div></form>
          </div>

          <h2>クライアントの削除</h2>
          <div class="card">
            <p>設定・接続情報・収集データ・レポート・AI分析結果をすべて削除し、ユーザーの担当割り当ても外します。契約終了時に使います。</p>
            <form method="post" action="/c/{e(cid)}/delete">{csrf_field(s)}
              {confirm_field.format(id="cf2")}
              <div class="form-actions"><button class="btn danger">クライアントを削除する</button></div></form>
          </div>"""
        self.send(layout("設定", body, s, msg, kind, active="clients"))

    def _confirmed(self, f: dict, cid: str) -> bool:
        return hmac.compare_digest((f.get("confirm") or [""])[0].strip(), cid)

    def client_consent(self, s: Session, f: dict, cid: str) -> None:
        if not self._require_admin(s):
            return
        cfg = self._client(s, cid)
        if cfg is None:
            return
        get = lambda k: (f.get(k) or [""])[0]  # noqa: E731
        if get("action") == "revoke":
            n = privacy.revoke_consent(cfg, recorded_by=s.user.username)
            self.app.users.log(s.user.username, self.ip, "ai_consent_revoked", cid)
            return self.client_settings(s, cid, f"同意を撤回し、AI分析結果を含むファイル {n}件を削除しました。", "ok")
        if get("explained") != "1":
            return self.client_settings(s, cid, "説明を示して同意を得たことを確認してください。", "error")
        try:
            c = privacy.grant_consent(cfg, get("by"), include_post_text=get("include_text") == "1",
                                      note=get("note"), recorded_by=s.user.username)
        except ConfigError as ex:
            return self.client_settings(s, cid, str(ex), "error")
        self.app.users.log(s.user.username, self.ip, "ai_consent_granted",
                           f"{cid} by={c['granted_by']} text={c['include_post_text']}")
        self.client_settings(s, cid, "AI分析の同意を記録しました。", "ok")

    def client_data_delete(self, s: Session, f: dict, cid: str) -> None:
        if not self._require_admin(s):
            return
        cfg = self._client(s, cid)
        if cfg is None:
            return
        if not self._confirmed(f, cid):
            return self.client_settings(s, cid, "確認用のクライアントIDが一致しません。削除していません。", "error")
        if self._busy(cid):
            return self.client_settings(s, cid, "処理の実行中です。完了してから削除してください。", "error")
        target = (f.get("target") or [""])[0]
        kind_, _, value = target.partition(":")
        if kind_ == "p" and value in PLATFORMS:
            msg = privacy.delete_platform_data(cfg, value, "all", disconnect=(f.get("disconnect") or [""])[0] == "1")
        elif kind_ == "c" and value in [x["name"] for x in cfg.get("competitors") or []]:
            msg = privacy.delete_competitor_data(cfg, value)
        else:
            return self.client_settings(s, cid, "削除する対象を選んでください。", "error")
        self.app.users.log(s.user.username, self.ip, "data_deleted", f"{cid} {target}")
        self.client_settings(s, cid, msg, "ok")

    def client_data_purge(self, s: Session, f: dict, cid: str) -> None:
        if not self._require_admin(s):
            return
        cfg = self._client(s, cid)
        if cfg is None:
            return
        msg = privacy.purge_expired(cfg) or "保存期間が設定されていません。"
        self.app.users.log(s.user.username, self.ip, "data_purged", cid)
        self.client_settings(s, cid, msg, "ok")

    def client_delete(self, s: Session, f: dict, cid: str) -> None:
        if not self._require_admin(s):
            return
        cfg = self._client(s, cid)
        if cfg is None:
            return
        if not self._confirmed(f, cid):
            return self.client_settings(s, cid, "確認用のクライアントIDが一致しません。削除していません。", "error")
        if self._busy(cid):
            return self.client_settings(s, cid, "処理の実行中です。完了してから削除してください。", "error")
        msg = privacy.delete_client(load_config(self.app.config_path), cid, self.app.users)
        self.app.jobs.pop(cid, None)
        self.app.users.log(s.user.username, self.ip, "client_deleted", cid)
        self.home(s, msg, "ok")

    # -- プライバシーポリシー（公開ページ） --
    def privacy_policy(self) -> None:
        s = self.session()
        root = load_config(self.app.config_path)
        body = policy.policy_page_body(root)
        self.send(layout("プライバシーポリシー", body if s else f'<div class="wrap">{body}</div>', s))

    def terms_page(self) -> None:
        s = self.session()
        body = terms.terms_page_body(load_config(self.app.config_path))
        self.send(layout("利用規約", body if s else f'<div class="wrap">{body}</div>', s))

    # -- Meta / Threads のデータ削除リクエスト --
    def deletion_callback(self, service: str) -> None:
        try:
            f = self.form()
        except ValueError:
            return self.send(json.dumps({"error": "too large"}), 413, "application/json")
        root = load_config(self.app.config_path)
        secret = (root.get("meta_app") if service == "meta" else root.get("threads_app") or {}).get("app_secret", "")
        try:
            data = privacy.parse_signed_request((f.get("signed_request") or [""])[0], secret)
        except ValueError:
            return self.send(json.dumps({"error": "invalid signed_request"}), 400, "application/json")
        user_id = str(data.get("user_id", ""))
        done = privacy.handle_deletion_request(self.app.config_path, service, user_id) if user_id else []
        code = privacy.new_confirmation_code()
        self.app.users.add_deletion_request(code, service, user_id, "completed", ", ".join(done) or "該当データなし")
        self.app.users.log(f"({service})", self.ip, "deletion_request", f"code={code} targets={len(done)}")
        base = root.get("public_url") or f"https://{self.headers.get('Host', '')}"
        self.send(json.dumps({"url": f"{base.rstrip('/')}/data-deletion/status?code={code}",
                              "confirmation_code": code}), 200, "application/json")

    def deletion_status(self) -> None:
        code = parse_qs(urlparse(self.path).query).get("code", [""])[0]
        r = self.app.users.get_deletion_request(code) if re.fullmatch(r"[0-9a-f]{16}", code) else None
        if r:
            body = (f'<h1>データ削除リクエスト</h1><p>確認コード：<code>{e(code)}</code></p>'
                    f'<p>受付日時：{e(local_time(r["created_at"], self.app.root["timezone"]))}</p>'
                    '<p>状況：<strong>削除が完了しました</strong>。連携により取得したデータは、当システムから削除されています。</p>')
        else:
            body = '<h1>データ削除リクエスト</h1><p>確認コードが見つかりません。</p>'
        body += '<p><a href="/privacy#delete">データの削除について（プライバシーポリシー）</a></p>'
        self.send(layout("データ削除リクエスト", f'<div class="login-wrap"><div class="card" style="max-width:560px">{body}</div></div>', None))

    # -- 管理者 --
    def _require_admin(self, s: Session) -> bool:
        if not s.user.is_admin:
            self.error(403, "管理者のみ利用できます", s)
            return False
        return True

    def admin_client_create(self, s: Session, f: dict) -> None:
        if not self._require_admin(s):
            return
        get = lambda k: (f.get(k) or [""])[0].strip()  # noqa: E731
        try:
            create_client(load_config(self.app.config_path), get("id"), get("name"), get("brand"))
        except ConfigError as ex:
            return self.home(s, str(ex), "error")
        self.app.users.log(s.user.username, self.ip, "client_created", get("id"))
        self.home(s, f"クライアント {get('id')} を追加しました", "ok")

    def _client_checks(self, selected: list[str]) -> str:
        cs = self.app.clients()
        if not cs:
            return '<span class="muted">クライアントがありません</span>'
        return '<div class="checks">' + "".join(
            f'<label><input type="checkbox" name="clients" value="{e(c)}"{" checked" if c in selected else ""}>{e(c)}</label>'
            for c in cs) + "</div>"

    def admin_users(self, s: Session, msg: str = "", kind: str = "") -> None:
        if not self._require_admin(s):
            return
        rows = []
        for u in self.app.users.list():
            badges = (f'<span class="badge {"warn" if u.is_admin else "info"}">{"管理者" if u.is_admin else "ユーザー"}</span> '
                      + ('' if u.active else '<span class="badge">無効</span>'))
            me = u.id == s.user.id
            rows.append(f"""<tr><td class="nowrap"><strong>{e(u.username)}</strong><div class="muted">{e(u.display_name)}</div></td>
              <td>{badges}</td><td class="muted">{'すべて' if u.is_admin else e(', '.join(u.clients) or 'なし')}</td>
              <td class="muted nowrap">{e(local_time(u.last_login, self.app.root["timezone"]))}</td>
              <td><details><summary aria-label="{e(u.username)} を編集">編集</summary><div class="edit">
                <form method="post" action="/admin/users/{u.id}">{csrf_field(s)}
                  <label for="dn{u.id}">表示名</label><input id="dn{u.id}" type="text" name="display_name" value="{e(u.display_name)}">
                  <label for="ro{u.id}">権限</label><select id="ro{u.id}" name="role">{''.join(f'<option value="{r}"{" selected" if r == u.role else ""}>{"管理者" if r == "admin" else "ユーザー"}</option>' for r in ROLES)}</select>
                  <fieldset class="fs"><legend>担当クライアント（ユーザー権限の場合）</legend>{self._client_checks(u.clients)}</fieldset>
                  <label class="check" style="margin-top:12px"><input type="checkbox" name="active" value="1"{" checked" if u.active else ""}> ログインを許可する（有効）</label>
                  <div class="form-actions"><button class="btn primary sm">保存</button></div></form>
                <form method="post" action="/admin/users/{u.id}/password">{csrf_field(s)}
                  <label for="pw{u.id}">新しいパスワード（10文字以上）<span class="req">必須</span></label><input id="pw{u.id}" type="password" name="password" autocomplete="new-password" minlength="10" required>
                  <label class="check" style="margin-top:8px"><input type="checkbox" name="must_change" value="1" checked> 次回ログイン時に変更させる</label>
                  <div class="form-actions"><button class="btn sm">パスワードを再設定</button></div></form>
                {'' if me else f'''<form method="post" action="/admin/users/{u.id}/delete" onsubmit="return confirm('{e(u.username)} を削除します。よろしいですか？')">{csrf_field(s)}
                  <button class="btn danger sm">ユーザーを削除</button></form>'''}
              </div></details></td></tr>""")
        body = f"""<div class="head"><div><h1>ユーザー管理</h1>
          <p>管理者はすべての操作、ユーザーは担当クライアントの閲覧・ダウンロードができます。</p></div></div>
          <details class="panel" style="margin:0 0 var(--s5)"{' open' if kind == 'error' else ''}><summary class="btn primary">＋ ユーザーを追加</summary>
          <form class="card" method="post" action="/admin/users">{csrf_field(s)}
            <div class="form-grid"><div>
              <label for="nu">ユーザー名<span class="req">必須</span></label><input id="nu" type="text" name="username" required autocomplete="off">
              <label for="nd">表示名</label><input id="nd" type="text" name="display_name">
              <label for="np">初期パスワード<span class="req">必須</span></label><input id="np" type="password" name="password" required minlength="10" autocomplete="new-password" aria-describedby="np-hint">
              <p class="hint" id="np-hint">10文字以上。本人は初回ログイン時に変更します。</p>
              <label for="nr">権限</label><select id="nr" name="role"><option value="user">ユーザー（担当クライアントの閲覧のみ）</option><option value="admin">管理者（すべての操作）</option></select>
              <p class="hint">管理者はすべてのクライアントの情報を閲覧・操作できます。クライアント企業の方には付与しないでください。</p>
            </div><div><fieldset class="fs"><legend>担当クライアント</legend>{self._client_checks([])}
              <p class="hint">ユーザー権限の場合に閲覧できるクライアントです。</p></fieldset></div></div>
            <div class="form-actions"><button class="btn primary">追加する</button></div></form></details>
          <div class="card flush scroll"><table><thead><tr><th>ユーザー</th><th>権限</th><th>担当クライアント</th>
          <th>最終ログイン</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>"""
        self.send(layout("ユーザー管理", body, s, msg, kind, active="users"))

    def admin_user_create(self, s: Session, f: dict) -> None:
        if not self._require_admin(s):
            return
        get = lambda k: (f.get(k) or [""])[0]  # noqa: E731
        clients = [c for c in f.get("clients", []) if c in self.app.clients()]
        try:
            u = self.app.users.create(get("username"), get("password"), get("role") or "user",
                                      get("display_name"), clients, must_change=True)
        except AuthError as ex:
            return self.admin_users(s, str(ex), "error")
        self.app.users.log(s.user.username, self.ip, "user_created", f"{u.username} ({u.role})")
        self.admin_users(s, f"{u.username} を追加しました。初期パスワードを本人に安全な方法で伝えてください。", "ok")

    def admin_user_update(self, s: Session, f: dict, uid: str) -> None:
        if not self._require_admin(s):
            return
        get = lambda k: (f.get(k) or [""])[0]  # noqa: E731
        clients = [c for c in f.get("clients", []) if c in self.app.clients()]
        try:
            u = self.app.users.update(int(uid), role=get("role"), display_name=get("display_name"),
                                      clients=clients, active=get("active") == "1")
        except AuthError as ex:
            return self.admin_users(s, str(ex), "error")
        self.app.users.log(s.user.username, self.ip, "user_updated",
                           f"{u.username} role={u.role} active={u.active} clients={','.join(u.clients)}")
        self.admin_users(s, f"{u.username} を更新しました", "ok")

    def admin_user_password(self, s: Session, f: dict, uid: str) -> None:
        if not self._require_admin(s):
            return
        u = self.app.users.get_by_id(int(uid))
        try:
            self.app.users.set_password(int(uid), (f.get("password") or [""])[0],
                                        must_change=(f.get("must_change") or [""])[0] == "1",
                                        keep_session=self._cookie_token() if u and u.id == s.user.id else None)
        except AuthError as ex:
            return self.admin_users(s, str(ex), "error")
        self.app.users.log(s.user.username, self.ip, "password_reset", u.username if u else uid)
        self.admin_users(s, f"{u.username if u else uid} のパスワードを再設定しました（ログイン中のセッションは無効化されました）", "ok")

    def admin_user_delete(self, s: Session, f: dict, uid: str) -> None:
        if not self._require_admin(s):
            return
        if int(uid) == s.user.id:
            return self.admin_users(s, "自分自身は削除できません", "error")
        u = self.app.users.get_by_id(int(uid))
        try:
            self.app.users.delete(int(uid))
        except AuthError as ex:
            return self.admin_users(s, str(ex), "error")
        self.app.users.log(s.user.username, self.ip, "user_deleted", u.username if u else uid)
        self.admin_users(s, "ユーザーを削除しました", "ok")

    def admin_audit(self, s: Session) -> None:
        if not self._require_admin(s):
            return
        rows = "".join(f"""<tr><td class="muted nowrap">{e(local_time(a['ts'], self.app.root["timezone"]))}</td><td>{e(a['username'] or '')}</td>
          <td>{e(a['action'])}</td><td class="muted">{e(a['detail'] or '')}</td><td class="muted">{e(a['ip'] or '')}</td></tr>"""
                       for a in self.app.users.recent_audit(200))
        body = f"""<div class="head"><div><h1>操作ログ</h1><p>ログイン・ユーザー変更・ダウンロード・実行の記録（直近200件）</p></div></div>
          <div class="card flush scroll"><table><thead><tr><th>日時</th><th>ユーザー</th>
          <th>操作</th><th>内容</th><th>IP</th></tr></thead><tbody>{rows}</tbody></table></div>"""
        self.send(layout("操作ログ", body, s, active="audit"))


def serve(config_path: str = "config.json", host: str = "127.0.0.1", port: int = 8000,
          secure_cookies: bool = False, trust_proxy: bool = False) -> None:
    app = App(config_path, secure_cookies, trust_proxy)
    if app.users.count_admins() == 0:
        raise ConfigError("管理者アカウントがありません。先に `user add <名前> --role admin` で作成してください")
    handler = type("BoundHandler", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer((host, port), handler)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(f"SNS Analyzer: http://{host}:{port}/ で起動しました（Ctrl+C で停止）")
    missing = policy.missing_fields(app.root)
    if missing:
        print(f"⚠ プライバシーポリシーの未記入項目：{'、'.join(missing)}（config.json の privacy_policy）")
    missing = terms.missing_fields(app.root)
    if missing:
        print(f"⚠ 利用規約の未記入項目：{'、'.join(missing)}（config.json の privacy_policy / terms）")
    if host not in ("127.0.0.1", "localhost", "::1") and not secure_cookies:
        print("⚠ 外部から接続できるアドレスで起動しています。HTTPS のリバースプロキシの背後で "
              "--secure-cookies を付けて運用してください。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
