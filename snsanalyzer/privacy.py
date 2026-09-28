"""データ削除とAI分析の同意管理（CLI と Web の両方から使う）。

- 保存期間（retention_days）を過ぎたデータの削除
- SNS別・競合別・クライアント単位のデータ削除
- SNS上で削除された投稿の同期削除
- Meta / Threads のデータ削除リクエスト（signed_request）の処理
- AI分析（Anthropic への送信）の同意の記録・撤回
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import shutil
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from .config import ConfigError, client_dir, list_clients, load_config, save_settings
from .db import Store
from .models import PLATFORM_LABELS

# ---- AI分析の同意 -------------------------------------------------------------
# 説明文を変えたら版を上げる。版が変わると再同意が必要になる。
CONSENT_VERSION = "2026-09-28.2"


def consent_text(include_post_text: bool = True) -> list[str]:
    sent = "集計した指標と投稿本文" if include_post_text else "集計した指標（投稿本文は含まない）"
    return [
        f"AI分析では、{sent}を Anthropic, PBC（米国）が提供する Claude API に送信します。",
        "Anthropic の商用APIでは、送信データは既定でAIの学習に使われません。"
        "送信データは原則30日以内に Anthropic 側で削除されます（利用ポリシー違反と判定された場合は最長2年保存されるなど、一部例外があります）。",
        "競合アカウントの公開投稿が含まれる場合があります。",
        "同意はいつでも撤回できます。撤回すると、保存済みのAI分析結果を削除します。",
    ]


def get_consent(cfg: dict) -> dict:
    c = dict(cfg.get("ai_consent") or {})
    c.setdefault("status", "unset")
    c["valid"] = c["status"] == "granted" and c.get("version") == CONSENT_VERSION
    c["outdated"] = c["status"] == "granted" and c.get("version") != CONSENT_VERSION
    return c


def grant_consent(cfg: dict, by: str, include_post_text: bool = True, note: str = "",
                  recorded_by: str = "") -> dict:
    by = by.strip()
    if not by:
        raise ConfigError("同意した方の氏名・所属を入力してください")
    consent = {
        "status": "granted", "version": CONSENT_VERSION, "granted_by": by,
        "granted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "recorded_by": recorded_by, "include_post_text": bool(include_post_text), "note": note.strip(),
    }
    save_settings(cfg, {"ai_consent": consent})
    return consent


def revoke_consent(cfg: dict, recorded_by: str = "") -> int:
    """同意を撤回し、保存済みのAI分析結果とそれを含むレポートを削除する。"""
    save_settings(cfg, {"ai_consent": {
        "status": "revoked", "version": CONSENT_VERSION,
        "revoked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "recorded_by": recorded_by,
        "granted_by": "", "granted_at": "", "include_post_text": False, "note": ""}})
    return invalidate_reports(cfg, ai_only=False)


def require_consent(cfg: dict) -> dict:
    c = get_consent(cfg)
    if c["valid"]:
        return c
    who = f"[{cfg.get('name')}] " if cfg.get("client") else ""
    if c["outdated"]:
        raise ConfigError(f"{who}AI分析の説明内容が更新されています。改めて同意を記録してください（consent grant）")
    raise ConfigError(f"{who}AI分析の同意が記録されていません。クライアントの同意を得てから "
                      "`consent grant --by 氏名` で記録してください")


# ---- レポート（生成物）の削除 -----------------------------------------------------
def invalidate_reports(cfg: dict, ai_only: bool = False) -> int:
    """削除したデータを含む生成物を消す。ai_only=True なら AI 分析結果のみ。"""
    d = Path(cfg["report_dir"])
    if not d.exists():
        return 0
    patterns = ["ai_*.json"] if ai_only else ["ai_*.json", "report_*.html", "report_*.zip", "latest.html"]
    n = 0
    for pat in patterns:
        for f in d.glob(pat):
            f.unlink()
            n += 1
    return n


# ---- データ削除 ---------------------------------------------------------------
def _fmt(counts: dict) -> str:
    return f"投稿 {counts.get('posts', 0):,}件・指標 {counts.get('metrics', 0):,}件・フォロワー記録 {counts.get('snapshots', 0):,}件"


def delete_platform_data(cfg: dict, platform: str, scope: str = "own", disconnect: bool = False) -> str:
    with Store(cfg["database"]) as store:
        counts = store.delete_platform(platform, scope)
    if disconnect:
        key = "bearer_token" if platform == "x" else "access_token"
        save_settings(cfg, {platform: {"enabled": False, key: "", "token_expires_at": "", "connected_user_id": ""}})
    invalidate_reports(cfg)
    target = {"own": "自社", "competitor": "競合", "all": "自社・競合"}[scope]
    return f"{PLATFORM_LABELS[platform]}（{target}）のデータを削除しました：{_fmt(counts)}"


def delete_competitor_data(cfg: dict, name: str) -> str:
    with Store(cfg["database"]) as store:
        counts = store.delete_competitor(name)
    invalidate_reports(cfg)
    return f"競合「{name}」のデータを削除しました：{_fmt(counts)}"


def retention_days(cfg: dict) -> int:
    try:
        return max(0, int(cfg.get("retention_days") or 0))
    except (TypeError, ValueError):
        return 0


def purge_expired(cfg: dict, days: Optional[int] = None) -> Optional[str]:
    """保存期間（日）を過ぎたデータを削除。0 または未設定なら何もしない。"""
    days = retention_days(cfg) if days is None else days
    if days <= 0:
        return None
    cutoff = date.today() - timedelta(days=days)
    with Store(cfg["database"]) as store:
        counts = store.purge_before(cutoff)
    # 期限切れのレポートファイルも削除
    d = Path(cfg["report_dir"])
    removed = 0
    if d.exists():
        for f in list(d.glob("report_*")) + list(d.glob("ai_*.json")):
            if datetime.fromtimestamp(f.stat().st_mtime).date() < cutoff:
                f.unlink()
                removed += 1
    return f"{cutoff.isoformat().replace('-', '/')}より前のデータを削除しました：{_fmt(counts)}・レポート {removed}件"


def delete_client(root_cfg: dict, cid: str, users=None) -> str:
    """クライアントの設定・データベース・レポートをすべて削除し、ユーザーの担当割り当ても外す。"""
    if cid not in list_clients(root_cfg):
        raise ConfigError(f"クライアント {cid} は存在しません")
    d = client_dir(root_cfg, cid).resolve()
    base = Path(root_cfg.get("clients_dir", "clients")).resolve()
    if d.parent != base:  # 念のため clients/ 直下以外は消さない
        raise ConfigError("削除対象のパスが不正です")
    shutil.rmtree(d)
    if users is not None:
        with users.lock:
            users.conn.execute("DELETE FROM user_clients WHERE client_id = ?", (cid,))
            users.conn.commit()
    return f"クライアント {cid} のデータをすべて削除しました"


# ---- Meta / Threads のデータ削除リクエスト ---------------------------------------------
def _b64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def parse_signed_request(signed_request: str, app_secret: str) -> dict:
    """Meta の signed_request を検証して中身を返す。署名が合わなければ ValueError。"""
    try:
        sig_b64, payload_b64 = signed_request.split(".", 1)
        sig = _b64url(sig_b64)
        data = json.loads(_b64url(payload_b64))
    except (ValueError, json.JSONDecodeError) as e:
        raise ValueError("signed_request の形式が不正です") from e
    if str(data.get("algorithm", "")).upper() != "HMAC-SHA256":
        raise ValueError("未対応の署名方式です")
    expected = hmac.new(app_secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
    if not app_secret or not hmac.compare_digest(sig, expected):
        raise ValueError("署名を検証できません")
    return data


def handle_deletion_request(config_path: str, service: str, user_id: str) -> list[str]:
    """アプリの連携を解除・削除依頼した利用者に紐づくデータを、全クライアントから削除する。

    service: "meta"（Facebook / Instagram）または "threads"
    """
    platforms = ("facebook", "instagram") if service == "meta" else ("threads",)
    root = load_config(config_path)
    targets = [None] + list_clients(root)
    done = []
    for cid in targets:
        cfg = load_config(config_path, cid) if cid else root
        for p in platforms:
            sec = cfg.get(p, {})
            owner = str(sec.get("connected_user_id") or (sec.get("user_id") if p == "threads" else "") or "")
            if owner and owner == str(user_id):
                delete_platform_data(cfg, p, scope="all", disconnect=True)
                done.append(f"{cid or '(既定)'}:{p}")
    return done


def new_confirmation_code() -> str:
    return secrets.token_hex(8)
