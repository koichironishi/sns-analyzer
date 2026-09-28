"""設定の読み込み・保存とクライアント（案件）管理。

構成：
  config.json                  共通設定（タイムゾーン、Meta/Threads アプリ情報、AIモデル等）
  clients/<id>/config.json     クライアント別設定（各SNSの接続情報、ブランド情報）
  clients/<id>/sns.db          クライアント別データベース
  clients/<id>/reports/        クライアント別レポート

--client を指定しない場合は従来どおり config.json / data/sns.db を使う。
クライアント未指定時のみ、環境変数 SNS_<PLATFORM>_<KEY> で接続情報を上書きできる
（例：SNS_INSTAGRAM_ACCESS_TOKEN, SNS_X_BEARER_TOKEN）。
"""
from __future__ import annotations

import copy
import json
import os
import re
from datetime import date
from pathlib import Path
from typing import Optional

DEFAULTS: dict = {
    "timezone": "Asia/Tokyo",
    "database": "data/sns.db",
    "report_dir": "reports",
    "clients_dir": "clients",
    "app_db": "data/app.db",
    "graph_api_version": "v26.0",
    "max_posts_per_run": 300,
    "retention_days": 400,   # この日数を過ぎたデータは collect 時に自動削除（0 で無効）
    "public_url": "",        # Web公開時のURL（データ削除リクエストの確認ページに使用）
    "meta_app": {"app_id": "", "app_secret": ""},
    # プライバシーポリシー（/privacy）に表示する事業者情報。未設定は【要記入】と表示される
    "privacy_policy": {"service_name": "SNS Analyzer", "operator_name": "", "operator_address": "",
                       "representative": "", "contact": "", "established": "", "revised": "",
                       "server_location": "", "org_measures": ""},
    # 利用規約（/terms）固有の項目。事業者名などは privacy_policy と共通
    "terms": {"court": "", "established": "", "revised": ""},
    "threads_app": {"app_id": "", "app_secret": "", "redirect_uri": ""},
    "ai": {"model": "claude-opus-5", "effort": "high", "brand_context": ""},
    "instagram": {"enabled": False, "user_id": "", "access_token": ""},
    "facebook": {"enabled": False, "page_id": "", "access_token": ""},
    "threads": {"enabled": False, "user_id": "me", "access_token": ""},
    "x": {"enabled": False, "username": "", "user_id": "", "bearer_token": ""},
}

PLATFORM_KEYS = ("instagram", "facebook", "threads", "x")
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class ConfigError(RuntimeError):
    pass


def _merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)  # アクセストークンを含むため本人のみ読み書き可
    tmp.replace(path)


def _apply_env(cfg: dict) -> None:
    for platform in PLATFORM_KEYS:
        section = cfg.setdefault(platform, {})
        prefix = f"SNS_{platform.upper()}_"
        for env_key, value in os.environ.items():
            if not env_key.startswith(prefix):
                continue
            key = env_key[len(prefix):].lower()
            if key == "enabled":
                section[key] = value.lower() in ("1", "true", "yes")
                continue
            section[key] = value
            if key in ("access_token", "bearer_token") and value \
                    and f"{prefix}ENABLED" not in os.environ:
                section["enabled"] = True


def client_dir(root_cfg: dict, client: str) -> Path:
    return Path(root_cfg.get("clients_dir", "clients")) / client


def load_config(path: str | Path = "config.json", client: Optional[str] = None) -> dict:
    root_path = Path(path)
    cfg = _merge(DEFAULTS, _read_json(root_path))
    if client:
        if not CLIENT_ID_RE.match(client):
            raise ConfigError(f"クライアントID {client!r} は英数字・-・_ で指定してください")
        cdir = client_dir(cfg, client)
        cpath = cdir / "config.json"
        if not cpath.exists():
            raise ConfigError(f"クライアント {client!r} がありません。`client add {client}` で作成してください")
        own = _read_json(cpath)
        cfg = _merge(cfg, own)
        # 同意・競合はクライアントごとの設定。共通設定から引き継がない
        cfg["ai_consent"] = own.get("ai_consent", {})
        cfg["competitors"] = own.get("competitors", [])
        cfg["database"] = str(cdir / "sns.db")
        cfg["report_dir"] = str(cdir / "reports")
        cfg["_config_path"] = str(cpath)
    else:
        _apply_env(cfg)
        cfg["_config_path"] = str(root_path)
    cfg["client"] = client
    cfg.setdefault("name", client or "")
    return cfg


def save_settings(cfg: dict, updates: dict) -> Path:
    """接続情報などを設定ファイルへ書き戻す（クライアント指定時はクライアントの config.json）。"""
    path = Path(cfg["_config_path"])
    data = _merge(_read_json(path), updates)
    _write_json(path, data)
    for k, v in updates.items():
        cfg[k] = _merge(cfg.get(k, {}), v) if isinstance(v, dict) else v
    return path


# ---- クライアント管理 ----------------------------------------------------
def create_client(root_cfg: dict, client: str, name: str = "", brand_context: str = "") -> Path:
    if not CLIENT_ID_RE.match(client):
        raise ConfigError("クライアントIDは英数字・-・_ で指定してください（例：acme, shop-a）")
    cpath = client_dir(root_cfg, client) / "config.json"
    if cpath.exists():
        raise ConfigError(f"クライアント {client!r} は既に存在します")
    _write_json(cpath, {
        "name": name or client,
        "created_at": date.today().isoformat(),
        "ai": {"brand_context": brand_context},
        "instagram": {"enabled": False, "user_id": "", "access_token": ""},
        "facebook": {"enabled": False, "page_id": "", "access_token": ""},
        "threads": {"enabled": False, "user_id": "me", "access_token": ""},
        "x": {"enabled": False, "username": "", "bearer_token": ""},
    })
    return cpath


def list_clients(root_cfg: dict) -> list[str]:
    base = Path(root_cfg.get("clients_dir", "clients"))
    if not base.exists():
        return []
    return sorted(p.name for p in base.iterdir() if (p / "config.json").exists())
