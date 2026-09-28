import contextlib
import json
import sys
import tempfile
import types
import unittest
from datetime import date
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

from snsanalyzer import ai, analysis, connect, export, report, sample_data
from snsanalyzer.config import (ConfigError, create_client, list_clients, load_config,
                                save_settings)
from snsanalyzer.db import Store

TZ = ZoneInfo("Asia/Tokyo")

AI_RESULT = {
    "headline": "リールと制作実績の組み合わせが伸びの中心",
    "summary": "Instagram のリールが全体を牽引。",
    "question_answer": "",
    "platforms": [{"platform": "instagram", "assessment": "好調", "strengths": ["リール"],
                   "issues": ["画像の反応が弱い"]}],
    "competitor_insights": [{"competitor": "競合A社", "observation": "リール週7本",
                             "takeaway": "制作の裏側リールを増やす"}],
    "content_insights": [{"title": "実績紹介が強い", "detail": "…", "evidence": "#制作実績 指数155"}],
    "recommendations": [{"priority": "high", "platform": "instagram", "action": "リールを週3本に",
                         "reason": "指数が画像の2.5倍", "expected_effect": "反応+20%"}],
    "post_ideas": [{"platform": "x", "format": "動画", "idea": "制作の裏側", "sample_copy": "本文<b>",
                    "suggested_timing": "金曜20時"}],
    "kpi_targets": [{"platform": "all", "metric": "ER", "current": "3%", "target": "3.5%",
                     "rationale": "…"}],
}


def demo_data(tmp):
    with Store(Path(tmp) / "d.db") as store:
        sample_data.generate(store, days=70)
        posts, followers = store.load_posts(), store.load_follower_series()
        data = analysis.analyze(posts, followers, TZ, days=30)
    return data, posts, followers


class FakeHttp:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def get(self, path, params=None):
        self.calls.append(("GET", path, params or {}))
        return self.routes[("GET", path)]

    def post(self, path, form=None):
        self.calls.append(("POST", path, form or {}))
        return self.routes[("POST", path)]


class AITest(unittest.TestCase):
    def _fake_anthropic(self, text, stop_reason="end_turn"):
        captured = {}
        msg = types.SimpleNamespace(
            stop_reason=stop_reason, model="claude-opus-5",
            content=[types.SimpleNamespace(type="thinking"), types.SimpleNamespace(type="text", text=text)],
            usage=types.SimpleNamespace(input_tokens=1000, output_tokens=500))

        class Stream:
            def get_final_message(self):
                return msg

        class Client:
            def __init__(self):
                self.beta = types.SimpleNamespace(messages=types.SimpleNamespace(stream=self.stream))

            def stream(self, **kw):
                captured.update(kw)
                return contextlib.nullcontext(Stream())

        mod = types.ModuleType("anthropic")
        mod.Anthropic = Client
        for name in ("AuthenticationError", "PermissionDeniedError", "RateLimitError",
                     "BadRequestError", "APIStatusError", "APIConnectionError"):
            setattr(mod, name, type(name, (Exception,), {}))
        return mod, captured

    def test_request_shape_and_result(self):
        with tempfile.TemporaryDirectory() as d:
            data, posts, followers = demo_data(d)
        mod, captured = self._fake_anthropic(json.dumps(AI_RESULT, ensure_ascii=False))
        with mock.patch.dict(sys.modules, {"anthropic": mod}):
            res = ai.run_ai_analysis(data, posts, followers, TZ,
                                     {"brand_context": "制作会社"}, question="リールを増やすべき？")
        self.assertEqual(captured["model"], "claude-opus-5")
        self.assertEqual(captured["fallbacks"], "default")
        self.assertEqual(captured["output_config"]["format"]["type"], "json_schema")
        prompt = captured["messages"][0]["content"]
        self.assertIn("<brand>", prompt)
        self.assertIn("リールを増やすべき？", prompt)
        self.assertIn("投稿一覧_指数順", prompt)
        self.assertEqual(res["headline"], AI_RESULT["headline"])
        self.assertEqual(res["_meta"]["output_tokens"], 500)

    def test_refusal_raises(self):
        with tempfile.TemporaryDirectory() as d:
            data, posts, followers = demo_data(d)
        mod, _ = self._fake_anthropic("", stop_reason="refusal")
        with mock.patch.dict(sys.modules, {"anthropic": mod}):
            with self.assertRaises(ai.AIError):
                ai.run_ai_analysis(data, posts, followers, TZ)

    def test_schema_objects_are_strict(self):
        def walk(s):
            if s.get("type") == "object":
                self.assertFalse(s["additionalProperties"])
                self.assertEqual(sorted(s["required"]), sorted(s["properties"]))
                for v in s["properties"].values():
                    walk(v)
            if s.get("type") == "array":
                walk(s["items"])
        walk(ai.OUTPUT_SCHEMA)


class ReportAndExportTest(unittest.TestCase):
    def test_ai_section_downloads_and_escaping(self):
        with tempfile.TemporaryDirectory() as d:
            data, posts, followers = demo_data(d)
            data["ai"] = {**AI_RESULT, "_meta": {"model": "claude-opus-5", "generated_at": "x",
                                                 "posts_sent": 10, "question": ""}}
            data["client_name"] = "ACME"
            data["downloads"] = export.downloads(data, posts, followers, TZ)
            html = report.render_html(data)
            self.assertIn("AI分析", html)
            self.assertIn("本文&lt;b&gt;", html)
            self.assertIn('data-download="posts.csv"', html)
            self.assertIn("SNS分析レポート｜ACME", html)
            self.assertIn("ai_analysis.md", data["downloads"])
            header = data["downloads"]["posts.csv"].splitlines()[0]
            self.assertTrue(header.startswith("SNS,投稿日時"))
            z = export.write_bundle(Path(d) / "r.zip", html, data, data["downloads"])
            import zipfile
            names = zipfile.ZipFile(z).namelist()
            self.assertIn("summary.csv", names)
            self.assertTrue(zipfile.ZipFile(z).read("posts.csv").startswith("﻿".encode()))


class ClientConfigTest(unittest.TestCase):
    def test_clients_are_isolated(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "config.json"
            root.write_text(json.dumps({"clients_dir": str(Path(d) / "clients"),
                                        "meta_app": {"app_id": "1", "app_secret": "s"}}))
            base = load_config(root)
            create_client(base, "acme", "ACME")
            create_client(base, "b-2")
            self.assertEqual(list_clients(base), ["acme", "b-2"])
            with self.assertRaises(ConfigError):
                create_client(base, "acme")
            with self.assertRaises(ConfigError):
                create_client(base, "../x")
            cfg = load_config(root, "acme")
            self.assertEqual(cfg["meta_app"]["app_id"], "1")  # 共通設定を継承
            self.assertTrue(cfg["database"].endswith("clients/acme/sns.db"))
            save_settings(cfg, {"x": {"enabled": True, "bearer_token": "t"}})
            self.assertTrue(load_config(root, "acme")["x"]["enabled"])
            self.assertFalse(load_config(root, "b-2")["x"]["enabled"])
            self.assertEqual(oct((Path(d) / "clients/acme/config.json").stat().st_mode & 0o777), "0o600")

    def test_env_not_applied_to_clients(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "config.json"
            root.write_text(json.dumps({"clients_dir": str(Path(d) / "clients")}))
            create_client(load_config(root), "acme")
            with mock.patch.dict("os.environ", {"SNS_X_BEARER_TOKEN": "env"}):
                self.assertEqual(load_config(root)["x"]["bearer_token"], "env")
                self.assertEqual(load_config(root, "acme")["x"]["bearer_token"], "")


class ConnectTest(unittest.TestCase):
    cfg = {"graph_api_version": "v26.0", "meta_app": {"app_id": "1", "app_secret": "s"},
           "threads_app": {"app_id": "9", "app_secret": "ts", "redirect_uri": "https://localhost/cb"}}

    def test_meta_exchange_and_pages(self):
        http = FakeHttp({
            ("GET", "oauth/access_token"): {"access_token": "LONG", "expires_in": 5184000},
            ("GET", "me/accounts"): {"data": [
                {"id": "p1", "name": "ACME", "access_token": "PAGE",
                 "instagram_business_account": {"id": "ig1", "username": "acme_ig"}},
                {"id": "p2", "name": "No IG", "access_token": "PAGE2"}]},
        })
        long = connect.meta_exchange(self.cfg, "SHORT", http)
        self.assertEqual(http.calls[0][2]["fb_exchange_token"], "SHORT")
        pages = connect.meta_pages(self.cfg, long["access_token"], http)
        s = connect.meta_settings_for_page(pages[0])
        self.assertEqual(s["instagram"]["user_id"], "ig1")
        self.assertEqual(s["facebook"]["access_token"], "PAGE")
        self.assertNotIn("instagram", connect.meta_settings_for_page(pages[1]))

    def test_threads_oauth_flow(self):
        url, state = connect.threads_authorize_url(self.cfg)
        self.assertIn("threads_manage_insights", url)
        code = connect.parse_code(f"https://localhost/cb?code=ABC#_&state={state}")
        self.assertEqual(code, "ABC")
        code = connect.parse_code(f"https://localhost/cb?code=ABC&state={state}#_", state)
        self.assertEqual(code, "ABC")
        with self.assertRaises(ConfigError):
            connect.parse_code("https://localhost/cb?code=ABC&state=zzz", state)
        http = FakeHttp({
            ("POST", "https://graph.threads.com/oauth/access_token"): {"access_token": "S", "user_id": 42},
            ("GET", "access_token"): {"access_token": "L", "expires_in": 5184000},
            ("GET", "v1.0/me"): {"id": "42", "username": "acme"},
        })
        s = connect.threads_exchange(self.cfg, "ABC", http)["threads"]
        self.assertEqual((s["access_token"], s["user_id"]), ("L", "42"))
        self.assertGreater(connect.days_left(s["token_expires_at"]), 59)

    def test_needs_refresh(self):
        from datetime import datetime, timedelta, timezone
        soon = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
        later = (datetime.now(timezone.utc) + timedelta(days=40)).isoformat()
        self.assertTrue(connect.needs_refresh({"threads": {"token_expires_at": soon}}))
        self.assertFalse(connect.needs_refresh({"threads": {"token_expires_at": later}}))


if __name__ == "__main__":
    unittest.main()
