"""API クライアントの共通部品（標準ライブラリのみ）。"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Callable, Iterator, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..config import ConfigError
from ..models import CollectResult

log = logging.getLogger(__name__)

RETRY_STATUS = (429, 500, 502, 503, 504)


class ApiError(RuntimeError):
    def __init__(self, message: str, status: Optional[int] = None, payload: object = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class HttpClient:
    """GET 専用の小さな JSON クライアント。

    エラーメッセージには URL を含めない（アクセストークンがクエリに入るため）。
    """

    def __init__(self, base_url: str, *, query_auth: Optional[dict] = None,
                 headers: Optional[dict] = None, timeout: int = 30, max_retries: int = 3,
                 sleep: Callable[[float], None] = time.sleep):
        self.base_url = base_url.rstrip("/")
        self.query_auth = query_auth or {}
        self.headers = {"User-Agent": "sns-analyzer/1.0", **(headers or {})}
        self.timeout = timeout
        self.max_retries = max_retries
        self.sleep = sleep

    def get(self, path: str, params: Optional[dict] = None) -> dict:
        return self._request("GET", path, params)

    def post(self, path: str, form: Optional[dict] = None) -> dict:
        """application/x-www-form-urlencoded で POST（トークン交換用）。"""
        return self._request("POST", path, None, form or {})

    def _request(self, method: str, path: str, params: Optional[dict],
                 form: Optional[dict] = None) -> dict:
        if path.startswith("http"):
            url = path  # ページングの next URL（認証情報を含む）など
            query = urlencode(params or {})
        else:
            url = f"{self.base_url}/{path.lstrip('/')}"
            query = urlencode({**(params or {}), **self.query_auth})
        if query:
            url += ("&" if "?" in url else "?") + query
        body = urlencode(form).encode() if form is not None else None

        for attempt in range(self.max_retries + 1):
            try:
                req = Request(url, data=body, headers=self.headers, method=method)
                with urlopen(req, timeout=self.timeout) as r:
                    return json.loads(r.read().decode("utf-8"))
            except HTTPError as e:
                raw = e.read().decode("utf-8", errors="replace")
                try:
                    payload = json.loads(raw)
                except ValueError:
                    payload = raw
                if e.code in RETRY_STATUS and attempt < self.max_retries:
                    wait = _retry_wait(e.headers, attempt)
                    log.warning("HTTP %s。%.0f秒後に再試行します", e.code, wait)
                    self.sleep(wait)
                    continue
                raise ApiError(_error_message(payload, e.code), e.code, payload) from None
            except URLError as e:
                if attempt < self.max_retries:
                    self.sleep(2 ** attempt)
                    continue
                raise ApiError(f"接続エラー：{e.reason}") from None
        raise ApiError("再試行回数の上限に達しました")


def _retry_wait(headers, attempt: int) -> float:
    retry_after = headers.get("Retry-After") if headers else None
    if retry_after and retry_after.isdigit():
        return min(float(retry_after), 120)
    reset = headers.get("x-rate-limit-reset") if headers else None  # X API
    if reset and reset.isdigit():
        return max(1.0, min(float(reset) - time.time(), 900))
    return float(2 ** (attempt + 1))


def _error_message(payload: object, status: int) -> str:
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict) and err.get("message"):
            return f"HTTP {status}: {err['message']}"
        for key in ("detail", "title", "message"):
            if payload.get(key):
                return f"HTTP {status}: {payload[key]}"
    return f"HTTP {status}"


def parse_time(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def graph_paginate(http: HttpClient, path: str, params: dict) -> Iterator[dict]:
    """Meta Graph API（Instagram / Facebook / Threads）のカーソルページング。"""
    resp = http.get(path, params)
    while True:
        yield from resp.get("data", [])
        nxt = resp.get("paging", {}).get("next")
        if not nxt:
            return
        resp = http.get(nxt)


def parse_insights(resp: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for item in resp.get("data", []):
        name = item.get("name")
        val = None
        if isinstance(item.get("total_value"), dict):
            val = item["total_value"].get("value")
        elif item.get("values"):
            val = item["values"][-1].get("value")
        if isinstance(val, dict):  # 内訳付きの値は合計する
            val = sum(v for v in val.values() if isinstance(v, (int, float)))
        if name and isinstance(val, (int, float)):
            out[name] = int(val)
    return out


class InsightsFetcher:
    """Graph API のインサイト取得。

    指標の対応状況は投稿種別や API バージョンで変わるため、まとめて要求して
    400 が返ったら1指標ずつ再試行し、非対応の指標は種別ごとに記憶して以後スキップする。
    """

    def __init__(self, http: HttpClient, metrics: list[str]):
        self.http = http
        self.metrics = metrics
        self.unsupported: dict[str, set[str]] = {}

    def fetch(self, object_id: str, kind: str = "default") -> dict[str, int]:
        skip = self.unsupported.setdefault(kind, set())
        wanted = [m for m in self.metrics if m not in skip]
        if not wanted:
            return {}
        try:
            return parse_insights(self.http.get(f"{object_id}/insights", {"metric": ",".join(wanted)}))
        except ApiError as e:
            if e.status != 400:
                raise
        result: dict[str, int] = {}
        for m in wanted:
            try:
                result.update(parse_insights(self.http.get(f"{object_id}/insights", {"metric": m})))
            except ApiError as e:
                if e.status != 400:
                    raise
                skip.add(m)
                log.warning("指標 %s は %s で取得できません（%s）。以後スキップします", m, kind, e)
        return result


class BaseCollector:
    platform = ""
    required: tuple[str, ...] = ()

    def __init__(self, cfg: dict, graph_version: str = "v26.0"):
        self.cfg = cfg
        self.graph_version = graph_version
        missing = [k for k in self.required if not cfg.get(k)]
        if missing:
            raise ConfigError(f"設定 {', '.join(missing)} がありません")

    def collect(self, since: datetime, max_posts: int = 300) -> CollectResult:
        raise NotImplementedError

    def collect_competitor(self, handle: str, since: datetime, max_posts: int = 100) -> CollectResult:
        """自社の接続情報を使って、競合の公開データを取得する。"""
        raise ApiError(f"{self.platform} の競合データは API で取得できません。"
                       "import-csv --competitor または followers --competitor で登録してください")
