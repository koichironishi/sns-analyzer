import base64
import contextlib
import hashlib
import hmac
import json
import sys
import tempfile
import threading
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

from snsanalyzer import ai, cli, privacy, sample_data
from snsanalyzer.auth import UserStore
from snsanalyzer.collectors.x import XCollector
from snsanalyzer.config import ConfigError, create_client, list_clients, load_config, save_settings
from snsanalyzer.db import Store
from snsanalyzer.models import AccountSnapshot, Metrics, Post

TZ = ZoneInfo("Asia/Tokyo")


def workspace(tmp):
    d = Path(tmp)
    root = d / "config.json"
    root.write_text(json.dumps({"clients_dir": str(d / "clients"), "app_db": str(d / "app.db"),
                                "meta_app": {"app_id": "1", "app_secret": "meta-secret"},
                                "threads_app": {"app_id": "2", "app_secret": "th-secret", "redirect_uri": "https://x"}}))
    create_client(load_config(root), "acme", "ACME")
    cfg = load_config(root, "acme")
    with Store(cfg["database"]) as s:
        sample_data.generate(s, days=60)
    return root, cfg


def signed(payload: dict, secret: str) -> str:
    b = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), b.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{sig}.{b}"


class StoreDeletionTest(unittest.TestCase):
    def test_delete_scopes_and_purge(self):
        with tempfile.TemporaryDirectory() as d, Store(Path(d) / "t.db") as s:
            sample_data.generate(s, days=60)
            own_x = len([p for p in s.load_posts() if p.platform == "x"])
            comp_x = len([p for p in s.load_posts(scope="competitor") if p.platform == "x"])
            c = s.delete_platform("x", "own")
            self.assertEqual(c["posts"], own_x)
            self.assertEqual(len([p for p in s.load_posts(scope="competitor") if p.platform == "x"]), comp_x)
            s.delete_competitor("競合A社")
            self.assertNotIn("競合A社", set(s.competitor_map().values()))
            before = len(s.load_posts())
            s.purge_before(date.today() - timedelta(days=10))
            after = s.load_posts()
            self.assertLess(len(after), before)
            self.assertTrue(all(p.created_at.date() >= date.today() - timedelta(days=11) for p in after))

    def test_reconcile_removes_posts_deleted_on_sns(self):
        with tempfile.TemporaryDirectory() as d, Store(Path(d) / "t.db") as s:
            now = datetime.now(timezone.utc)
            mk = lambda pid, days: Post("x", pid, "me", now - timedelta(days=days), metrics=Metrics())  # noqa: E731
            s.save_posts([mk("keep", 1), mk("gone", 2), mk("old", 90)], date.today())
            n = s.reconcile("x", "me", now - timedelta(days=30), {"keep"})
            self.assertEqual(n, 1)
            self.assertEqual(sorted(p.post_id for p in s.load_posts()), ["keep", "old"])  # 範囲外は残す


class ConsentTest(unittest.TestCase):
    def test_grant_revoke_and_isolation(self):
        with tempfile.TemporaryDirectory() as d:
            root, cfg = workspace(d)
            self.assertFalse(privacy.get_consent(cfg)["valid"])
            with self.assertRaises(ConfigError):
                privacy.require_consent(cfg)
            with self.assertRaises(ConfigError):
                cli.build(cfg, 30, ai=True)  # 同意なしでは API を呼ばない
            with self.assertRaises(ConfigError):
                privacy.grant_consent(cfg, "  ")
            privacy.grant_consent(cfg, "山田（ACME広報）", include_post_text=False)
            cfg = load_config(root, "acme")
            self.assertTrue(privacy.require_consent(cfg)["valid"])
            # 共通設定の同意はクライアントに引き継がない
            save_settings(load_config(root), {"ai_consent": {"status": "granted", "version": privacy.CONSENT_VERSION}})
            create_client(load_config(root), "beta")
            self.assertFalse(privacy.get_consent(load_config(root, "beta"))["valid"])
            # 説明文の版が変わると再同意が必要
            with mock.patch.object(privacy, "CONSENT_VERSION", "2099-01-01"):
                self.assertTrue(privacy.get_consent(cfg)["outdated"])
            rd = Path(cfg["report_dir"]); rd.mkdir(parents=True)
            (rd / "ai_2026-09-28_30d.json").write_text("{}")
            (rd / "latest.html").write_text("x")
            self.assertEqual(privacy.revoke_consent(cfg), 2)
            self.assertEqual(load_config(root, "acme")["ai_consent"]["status"], "revoked")

    def test_post_text_not_sent_without_consent_scope(self):
        with tempfile.TemporaryDirectory() as d:
            root, cfg = workspace(d)
            with Store(cfg["database"]) as s:
                posts, fol = s.load_posts(), s.load_follower_series()
            from snsanalyzer import analysis
            data = analysis.analyze(posts, fol, TZ, days=30)
            captured = {}
            msg = types.SimpleNamespace(stop_reason="end_turn", model="m",
                                        content=[types.SimpleNamespace(type="text", text=json.dumps({"headline": "h"}))],
                                        usage=types.SimpleNamespace(input_tokens=1, output_tokens=1))
            mod = types.ModuleType("anthropic")
            for n in ("AuthenticationError", "PermissionDeniedError", "RateLimitError", "BadRequestError",
                      "APIStatusError", "APIConnectionError"):
                setattr(mod, n, type(n, (Exception,), {}))

            class Client:
                def __init__(self):
                    self.beta = types.SimpleNamespace(messages=types.SimpleNamespace(stream=self.stream))

                def stream(self, **kw):
                    captured.update(kw)
                    return contextlib.nullcontext(types.SimpleNamespace(get_final_message=lambda: msg))
            mod.Anthropic = Client
            with mock.patch.dict(sys.modules, {"anthropic": mod}):
                res = ai.run_ai_analysis(data, posts, fol, TZ, {}, consent={"include_post_text": False, "granted_by": "山田"})
            prompt = captured["messages"][0]["content"]
            self.assertNotIn("制作実績を公開しました", prompt)
            self.assertIn("同意の範囲外のため送信しない", prompt)
            self.assertFalse(res["_meta"]["post_text_sent"])
            self.assertEqual(res["_meta"]["consent_by"], "山田")


class DeletionRequestTest(unittest.TestCase):
    def test_signed_request(self):
        sr = signed({"algorithm": "HMAC-SHA256", "user_id": "123"}, "s3cret")
        self.assertEqual(privacy.parse_signed_request(sr, "s3cret")["user_id"], "123")
        for bad in (sr + "x", "abc", signed({"algorithm": "HMAC-SHA256", "user_id": "1"}, "other")):
            with self.assertRaises(ValueError):
                privacy.parse_signed_request(bad, "s3cret")

    def test_handle_request_deletes_only_matching_user(self):
        with tempfile.TemporaryDirectory() as d:
            root, cfg = workspace(d)
            save_settings(cfg, {"instagram": {"enabled": True, "access_token": "t", "connected_user_id": "999"},
                                "facebook": {"enabled": True, "access_token": "t", "connected_user_id": "999"}})
            self.assertEqual(privacy.handle_deletion_request(str(root), "meta", "111"), [])
            done = privacy.handle_deletion_request(str(root), "meta", "999")
            self.assertEqual(sorted(done), ["acme:facebook", "acme:instagram"])
            cfg = load_config(root, "acme")
            self.assertFalse(cfg["instagram"]["enabled"])
            self.assertEqual(cfg["instagram"]["access_token"], "")
            with Store(cfg["database"]) as s:
                self.assertFalse([p for p in s.load_posts(scope="all") if p.platform in ("instagram", "facebook")])
                self.assertTrue([p for p in s.load_posts() if p.platform == "x"])

    def test_delete_client(self):
        with tempfile.TemporaryDirectory() as d:
            root, cfg = workspace(d)
            users = UserStore(Path(d) / "app.db")
            users.create("u1", "correct-horse-42", clients=["acme"])
            privacy.delete_client(load_config(root), "acme", users)
            self.assertEqual(list_clients(load_config(root)), [])
            self.assertEqual(users.get("u1").clients, [])
            with self.assertRaises(ConfigError):
                privacy.delete_client(load_config(root), "acme", users)
            users.close()


class XDeletionSyncTest(unittest.TestCase):
    def test_missing_ids(self):
        class Http:
            def get(self, path, params):
                ids = params["ids"].split(",")
                return {"data": [{"id": i} for i in ids if i != "2" and i != "3"],
                        "errors": [{"resource_id": "2", "title": "Not Found Error"}]}
        c = XCollector({"bearer_token": "t", "username": "me"})
        c.http = Http()
        self.assertEqual(c.missing_ids(["1", "2", "3"]), {"2"})  # 3 は判定不能なので消さない


class WebPrivacyTest(unittest.TestCase):
    def test_settings_consent_delete_and_callback(self):
        sys.path.insert(0, str(Path(__file__).parent))
        from test_web import PW, Browser
        from snsanalyzer.web import App, Handler
        with tempfile.TemporaryDirectory() as d:
            root, cfg = workspace(d)
            app = App(str(root))
            app.users.create("admin", PW, role="admin")
            app.users.create("viewer", PW, role="user", clients=["acme"])
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), type("H", (Handler,), {"app": app}))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            port = httpd.server_address[1]
            try:
                v = Browser(port); v.login("viewer")
                self.assertEqual(v.req("GET", "/c/acme/settings")[0], 403)
                b = Browser(port); b.login("admin")
                tok = b.csrf("/c/acme/settings")
                # AI 実行は同意がないと止まる
                _, _, body = b.req("POST", "/c/acme/run", {"csrf": tok, "action": "ai"})
                self.assertIn("同意を記録してください", body)
                _, _, body = b.req("POST", "/c/acme/consent", {"csrf": tok, "action": "grant", "by": "山田",
                                                             "include_text": "1"})
                self.assertIn("説明を示して同意を得たこと", body)
                _, _, body = b.req("POST", "/c/acme/consent", {"csrf": tok, "action": "grant", "by": "山田",
                                                             "include_text": "1", "explained": "1"})
                self.assertIn("同意を記録しました", body)
                self.assertTrue(privacy.get_consent(load_config(root, "acme"))["valid"])
                # 確認IDが違えば削除しない
                _, _, body = b.req("POST", "/c/acme/data/delete", {"csrf": tok, "target": "p:x", "confirm": "nope"})
                self.assertIn("一致しません", body)
                _, _, body = b.req("POST", "/c/acme/data/delete", {"csrf": tok, "target": "p:x", "confirm": "acme"})
                self.assertIn("データを削除しました", body)
                # Meta のデータ削除コールバック（ログイン不要・署名必須）
                save_settings(load_config(root, "acme"), {"facebook": {"enabled": True, "connected_user_id": "42"}})
                anon = Browser(port)
                st, _, body = anon.req("POST", "/meta/data-deletion", {"signed_request": "bad.sig"})
                self.assertEqual(st, 400)
                st, _, body = anon.req("POST", "/meta/data-deletion",
                                       {"signed_request": signed({"algorithm": "HMAC-SHA256", "user_id": "42"}, "meta-secret")})
                self.assertEqual(st, 200)
                resp = json.loads(body)
                self.assertIn("/data-deletion/status?code=", resp["url"])
                _, _, page = anon.req("GET", "/data-deletion/status?code=" + resp["confirmation_code"])
                self.assertIn("削除が完了しました", page)
                self.assertFalse(load_config(root, "acme")["facebook"]["enabled"])
                # クライアント削除
                _, _, body = b.req("POST", "/c/acme/delete", {"csrf": tok, "confirm": "acme"})
                self.assertIn("すべて削除しました", body)
                self.assertEqual(list_clients(load_config(root)), [])
            finally:
                httpd.shutdown(); httpd.server_close(); app.users.close()


if __name__ == "__main__":
    unittest.main()
