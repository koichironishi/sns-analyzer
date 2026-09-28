"""各SNSとの接続（トークン取得・長期化・更新・接続確認）。

Meta（Facebook / Instagram）：
  Graph API エクスプローラー等で発行した「短期ユーザートークン」を長期トークン（約60日）へ交換し、
  そこから取得したページアクセストークン（期限なし）を Facebook / Instagram の両方で使う。
Threads:
  OAuth 認可 → 認可コードを短期トークンへ交換 → 長期トークン（60日）へ交換。期限前に refresh で延長。
X:
  開発者ポータルの Bearer Token を検証して保存する。
"""
from __future__ import annotations

import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse

from .collectors.base import ApiError, HttpClient
from .config import ConfigError

META_SCOPES = ["pages_show_list", "pages_read_engagement", "read_insights",
               "instagram_basic", "instagram_manage_insights"]
# ページの権限がビジネスマネージャ経由で付与されている場合は ads_read（または ads_management）も追加する
THREADS_SCOPES = ["threads_basic", "threads_manage_insights"]
REFRESH_BEFORE_DAYS = 10


def _expires_at(seconds: Optional[int]) -> str:
    if not seconds:
        return ""
    return (datetime.now(timezone.utc) + timedelta(seconds=int(seconds))).isoformat(timespec="seconds")


def days_left(expires_at: str) -> Optional[float]:
    if not expires_at:
        return None
    dt = datetime.fromisoformat(expires_at)
    return (dt - datetime.now(timezone.utc)).total_seconds() / 86400


# ---- Meta（Facebook / Instagram）-----------------------------------------
def _meta_app(cfg: dict) -> tuple[str, str]:
    app = cfg.get("meta_app", {})
    if not app.get("app_id") or not app.get("app_secret"):
        raise ConfigError("共通の config.json に meta_app.app_id / app_secret を設定してください")
    return app["app_id"], app["app_secret"]


def meta_token_url(cfg: dict) -> str:
    return "https://developers.facebook.com/tools/explorer/?" + urlencode(
        {"app_id": _meta_app(cfg)[0]})


def meta_exchange(cfg: dict, short_token: str, http: Optional[HttpClient] = None) -> dict:
    """短期ユーザートークン → 長期ユーザートークン。"""
    app_id, secret = _meta_app(cfg)
    http = http or HttpClient(f"https://graph.facebook.com/{cfg['graph_api_version']}")
    return http.get("oauth/access_token", {
        "grant_type": "fb_exchange_token", "client_id": app_id,
        "client_secret": secret, "fb_exchange_token": short_token,
    })


def meta_pages(cfg: dict, user_token: str, http: Optional[HttpClient] = None) -> list[dict]:
    """ユーザーが管理するページと、紐づく Instagram ビジネスアカウント。"""
    http = http or HttpClient(f"https://graph.facebook.com/{cfg['graph_api_version']}")
    resp = http.get("me/accounts", {
        "fields": "id,name,access_token,instagram_business_account{id,username}",
        "limit": 100, "access_token": user_token,
    })
    pages = resp.get("data", [])
    return [{
        "page_id": p["id"], "name": p.get("name", ""), "access_token": p.get("access_token", ""),
        "ig_user_id": (p.get("instagram_business_account") or {}).get("id", ""),
        "ig_username": (p.get("instagram_business_account") or {}).get("username", ""),
    } for p in pages]


def meta_user_id(cfg: dict, user_token: str, http: Optional[HttpClient] = None) -> str:
    """接続した Facebook 利用者のID（アプリスコープ）。データ削除リクエストの照合に使う。"""
    http = http or HttpClient(f"https://graph.facebook.com/{cfg['graph_api_version']}")
    return str(http.get("me", {"fields": "id", "access_token": user_token}).get("id", ""))


def meta_settings_for_page(page: dict, user_id: str = "") -> dict:
    """選んだページから Facebook / Instagram の設定を作る。"""
    out = {"facebook": {"enabled": True, "page_id": page["page_id"],
                        "access_token": page["access_token"], "token_expires_at": "",
                        "account_name": page["name"], "connected_user_id": user_id}}
    if page["ig_user_id"]:
        out["instagram"] = {"enabled": True, "user_id": page["ig_user_id"],
                            "access_token": page["access_token"], "token_expires_at": "",
                            "account_name": page["ig_username"], "connected_user_id": user_id}
    return out


def meta_debug_token(cfg: dict, token: str) -> dict:
    app_id, secret = _meta_app(cfg)
    http = HttpClient(f"https://graph.facebook.com/{cfg['graph_api_version']}")
    return http.get("debug_token", {"input_token": token,
                                    "access_token": f"{app_id}|{secret}"}).get("data", {})


# ---- Threads -------------------------------------------------------------
def _threads_app(cfg: dict) -> dict:
    app = cfg.get("threads_app", {})
    missing = [k for k in ("app_id", "app_secret", "redirect_uri") if not app.get(k)]
    if missing:
        raise ConfigError(f"共通の config.json に threads_app.{', threads_app.'.join(missing)} を設定してください")
    return app


def threads_authorize_url(cfg: dict, state: Optional[str] = None) -> tuple[str, str]:
    app = _threads_app(cfg)
    state = state or secrets.token_urlsafe(16)
    url = "https://threads.com/oauth/authorize?" + urlencode({
        "client_id": app["app_id"], "redirect_uri": app["redirect_uri"],
        "scope": ",".join(THREADS_SCOPES), "response_type": "code", "state": state,
    })
    return url, state


def parse_code(redirected: str, expected_state: Optional[str] = None) -> str:
    """リダイレクト先URL（またはコード文字列そのもの）から認可コードを取り出す。"""
    s = redirected.strip()
    if not s.startswith("http"):
        return s.split("#")[0]
    qs = parse_qs(urlparse(s).query)
    if "error" in qs:
        raise ConfigError(f"認可が拒否されました：{qs.get('error_description', qs['error'])[0]}")
    if expected_state and qs.get("state", [""])[0] != expected_state:
        raise ConfigError("state が一致しません。もう一度 connect threads からやり直してください")
    if "code" not in qs:
        raise ConfigError("URLに code が含まれていません")
    return qs["code"][0].split("#")[0]  # Threads は末尾に #_ が付くことがある


def threads_exchange(cfg: dict, code: str, http: Optional[HttpClient] = None) -> dict:
    """認可コード → 短期トークン → 長期トークン。Threads 設定を返す。"""
    app = _threads_app(cfg)
    http = http or HttpClient("https://graph.threads.net")
    short = http.post("https://graph.threads.com/oauth/access_token", {
        "client_id": app["app_id"], "client_secret": app["app_secret"],
        "grant_type": "authorization_code", "redirect_uri": app["redirect_uri"], "code": code,
    })
    long = http.get("access_token", {"grant_type": "th_exchange_token",
                                     "client_secret": app["app_secret"],
                                     "access_token": short["access_token"]})
    prof = http.get("v1.0/me", {"fields": "id,username", "access_token": long["access_token"]})
    uid = str(prof.get("id") or short.get("user_id"))
    return {"threads": {"enabled": True, "user_id": uid, "connected_user_id": uid,
                        "access_token": long["access_token"],
                        "token_expires_at": _expires_at(long.get("expires_in")),
                        "account_name": prof.get("username", "")}}


def threads_refresh(cfg: dict, http: Optional[HttpClient] = None) -> dict:
    """長期トークンを延長（発行から24時間以上・期限切れ前のみ可能）。"""
    token = cfg["threads"].get("access_token")
    if not token:
        raise ConfigError("Threads が未接続です")
    http = http or HttpClient("https://graph.threads.net")
    resp = http.get("refresh_access_token", {"grant_type": "th_refresh_token", "access_token": token})
    return {"threads": {"access_token": resp["access_token"],
                        "token_expires_at": _expires_at(resp.get("expires_in"))}}


def needs_refresh(cfg: dict) -> bool:
    left = days_left(cfg.get("threads", {}).get("token_expires_at", ""))
    return left is not None and 0 < left < REFRESH_BEFORE_DAYS


# ---- X -------------------------------------------------------------------
def x_settings(bearer_token: str, username: str, http: Optional[HttpClient] = None) -> dict:
    http = http or HttpClient("https://api.x.com/2",
                              headers={"Authorization": f"Bearer {bearer_token}"})
    user = http.get(f"users/by/username/{username.lstrip('@')}",
                    {"user.fields": "public_metrics"})["data"]
    return {"x": {"enabled": True, "username": user["username"], "user_id": user["id"],
                  "bearer_token": bearer_token, "account_name": user["username"]}}


# ---- 接続確認 -------------------------------------------------------------
def _is_token_error(e: Exception) -> bool:
    if not isinstance(e, ApiError):
        return False
    if e.status == 401:
        return True
    err = e.payload.get("error") if isinstance(e.payload, dict) else None
    return isinstance(err, dict) and err.get("code") in (190, 102, 463, 467)  # Meta のトークン失効系
def check(platform: str, cfg: dict) -> dict:
    """軽量なプロフィール取得で接続を確認する。投稿は取得しない。"""
    from .collectors import COLLECTORS

    sec = cfg.get(platform, {})
    result = {"platform": platform, "enabled": bool(sec.get("enabled")), "ok": False,
              "account": sec.get("account_name", ""), "followers": None, "message": "",
              "expires_at": sec.get("token_expires_at", "")}
    if not sec.get("enabled"):
        result["message"] = "未接続"
        return result
    started = time.time()
    try:
        c = COLLECTORS[platform](sec, cfg["graph_api_version"])
        if platform == "instagram":
            r = c.http.get(sec["user_id"], {"fields": "username,followers_count"})
            result.update(account=r.get("username", ""), followers=r.get("followers_count"))
        elif platform == "facebook":
            r = c.http.get(sec["page_id"], {"fields": "name,followers_count,fan_count"})
            result.update(account=r.get("name", ""),
                          followers=r.get("followers_count") or r.get("fan_count"))
        elif platform == "threads":
            r = c.http.get(sec.get("user_id") or "me", {"fields": "username"})
            result.update(account=r.get("username", ""))
        elif platform == "x":
            key = f"users/{sec['user_id']}" if sec.get("user_id") else f"users/by/username/{sec['username']}"
            r = c.http.get(key, {"user.fields": "public_metrics"})["data"]
            result.update(account=r.get("username", ""),
                          followers=r.get("public_metrics", {}).get("followers_count"))
        result["ok"] = True
        left = days_left(result["expires_at"])
        result["message"] = "OK" if left is None else f"OK（トークン残り{left:.0f}日）"
        if left is not None and left < REFRESH_BEFORE_DAYS:
            result["message"] += " ※まもなく期限切れ。refresh を実行してください"
    except (ApiError, ConfigError) as e:
        result["message"] = str(e)
        if _is_token_error(e):
            result["message"] += "（トークンの再発行が必要です。connect をやり直してください）"
    result["elapsed"] = round(time.time() - started, 1)
    return result
