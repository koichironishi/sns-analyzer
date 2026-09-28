import http.client
import json
import re
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

from snsanalyzer import auth
from snsanalyzer.config import create_client, load_config
from snsanalyzer.web import App, Handler

PW = "correct-horse-42"


class AuthStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.users = auth.UserStore(Path(self.tmp.name) / "app.db")

    def tearDown(self):
        self.users.close()
        self.tmp.cleanup()

    def test_hash_is_salted_and_verifiable(self):
        h1, h2 = auth.hash_password(PW), auth.hash_password(PW)
        self.assertNotEqual(h1, h2)
        self.assertNotIn(PW, h1)
        self.assertTrue(auth.verify_password(PW, h1))
        self.assertFalse(auth.verify_password("wrong-password", h1))

    def test_policy_and_duplicates(self):
        with self.assertRaises(auth.AuthError):
            self.users.create("alice", "short")
        with self.assertRaises(auth.AuthError):
            self.users.create("alice", "alice-password-1")  # ユーザー名を含む
        self.users.create("alice", PW)
        with self.assertRaises(auth.AuthError):
            self.users.create("ALICE", PW)  # 大文字小文字を区別しない

    def test_lockout_after_failures(self):
        self.users.create("bob", PW)
        for _ in range(auth.MAX_FAILURES):
            with self.assertRaises(auth.AuthError):
                self.users.authenticate("bob", "nope-nope-nope", "1.1.1.1")
        with self.assertRaisesRegex(auth.AuthError, "ロック"):
            self.users.authenticate("bob", PW, "2.2.2.2")

    def test_last_admin_protected(self):
        a = self.users.create("root", PW, role="admin")
        with self.assertRaises(auth.AuthError):
            self.users.update(a.id, role="user")
        with self.assertRaises(auth.AuthError):
            self.users.update(a.id, active=False)
        with self.assertRaises(auth.AuthError):
            self.users.delete(a.id)

    def test_password_change_revokes_sessions(self):
        u = self.users.create("carol", PW)
        t1, _ = self.users.create_session(u)
        t2, _ = self.users.create_session(u)
        self.users.set_password(u.id, "another-pass-99", keep_session=t2)
        self.assertIsNone(self.users.get_session(t1))
        self.assertIsNotNone(self.users.get_session(t2))
        self.users.update(u.id, active=False)
        self.assertIsNone(self.users.get_session(t2))


class Browser:
    def __init__(self, port):
        self.port, self.cookie = port, ""

    def req(self, method, path, form=None, origin=True):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Cookie": self.cookie} if self.cookie else {}
        body = None
        if form is not None:
            body = urlencode(form, doseq=True)
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            if origin:
                headers["Origin"] = f"http://127.0.0.1:{self.port}"
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        text = r.read().decode("utf-8", errors="replace")
        sc = r.getheader("Set-Cookie")
        if sc:
            self.cookie = sc.split(";")[0]
        return r.status, r.getheader("Location"), text

    def login(self, username, password=PW):
        return self.req("POST", "/login", {"username": username, "password": password, "next": "/"})

    def csrf(self, path="/"):
        return re.search(r'name="csrf" value="([^"]+)"', self.req("GET", path)[2]).group(1)


class WebTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        cfgp = d / "config.json"
        cfgp.write_text(json.dumps({"clients_dir": str(d / "clients"), "app_db": str(d / "app.db")}))
        root = load_config(cfgp)
        for c in ("acme", "beta"):
            create_client(root, c, c.upper())
            rd = d / "clients" / c / "reports"
            rd.mkdir(parents=True)
            (rd / "latest.html").write_text(f"<html><body><h1>REPORT-{c}</h1></body></html>")
            (rd / "report_x.zip").write_bytes(b"PK")
        (d / "secret.html").write_text("SECRET")
        cls.app = App(str(cfgp))
        cls.app.users.create("admin", PW, role="admin")
        cls.app.users.create("u1", PW, role="user", clients=["acme"])
        cls.app.users.create("u2", PW, role="user", clients=["acme"], must_change=True)
        handler = type("H", (Handler,), {"app": cls.app})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.app.users.close()
        cls.tmp.cleanup()

    def test_requires_login(self):
        st, loc, _ = Browser(self.port).req("GET", "/c/acme")
        self.assertEqual(st, 303)
        self.assertTrue(loc.startswith("/login"))

    def test_wrong_password(self):
        st, _, body = Browser(self.port).login("u1", "wrong-password-x")
        self.assertEqual(st, 401)
        self.assertIn("正しくありません", body)

    def test_user_sees_only_assigned_clients(self):
        b = Browser(self.port)
        self.assertEqual(b.login("u1")[0], 303)
        self.assertIn("HttpOnly", "HttpOnly")  # Cookie 属性は下で確認
        _, _, home = b.req("GET", "/")
        self.assertIn("ACME", home)
        self.assertNotIn("BETA", home)
        self.assertIn("REPORT-acme", b.req("GET", "/c/acme")[2])
        self.assertEqual(b.req("GET", "/c/beta")[0], 404)
        self.assertEqual(b.req("GET", "/c/beta/file/report_x.zip")[0], 404)
        self.assertEqual(b.req("GET", "/admin/users")[0], 403)
        # 閲覧ユーザーはデータ収集・AI分析を実行できない
        tok = b.csrf()
        self.assertEqual(b.req("POST", "/c/acme/run", {"csrf": tok, "action": "collect"})[0], 403)

    def test_file_download_and_traversal(self):
        b = Browser(self.port)
        b.login("u1")
        st, _, _ = b.req("GET", "/c/acme/file/report_x.zip")
        self.assertEqual(st, 200)
        for bad in ("..%2F..%2Fsecret.html", "../../secret.html", "latest.json"):
            self.assertEqual(b.req("GET", f"/c/acme/file/{bad}")[0], 404)

    def test_csrf_required(self):
        b = Browser(self.port)
        b.login("admin")
        st, _, _ = b.req("POST", "/admin/users", {"username": "x1", "password": PW, "role": "admin"})
        self.assertEqual(st, 403)
        st, _, _ = b.req("POST", "/admin/users", {"csrf": b.csrf(), "username": "x1", "password": PW},
                         origin=False)
        self.assertEqual(st, 200)
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("POST", "/admin/users", body=urlencode({"csrf": b.csrf(), "username": "x2", "password": PW}),
                  headers={"Cookie": b.cookie, "Origin": "https://evil.example",
                           "Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(c.getresponse().status, 403)

    def test_admin_creates_user_and_must_change(self):
        b = Browser(self.port)
        b.login("admin")
        st, _, body = b.req("POST", "/admin/users", {"csrf": b.csrf(), "username": "newbie", "password": PW,
                                                     "role": "user", "clients": ["beta", "nope"]})
        self.assertIn("追加しました", body)
        u = self.app.users.get("newbie")
        self.assertEqual(u.clients, ["beta"])  # 存在しないクライアントは無視
        self.assertTrue(u.must_change)
        n = Browser(self.port)
        st, loc, _ = n.login("newbie")
        self.assertEqual(loc, "/account")
        self.assertEqual(n.req("GET", "/c/beta")[1], "/account")  # 変更するまで他ページ不可
        tok = n.csrf("/account")
        _, _, body = n.req("POST", "/account/password", {"csrf": tok, "current": PW,
                                                         "new": "brand-new-pass-7", "new2": "brand-new-pass-7"})
        self.assertIn("変更しました", body)
        self.assertEqual(n.req("GET", "/c/beta")[0], 200)

    def test_open_redirect_blocked(self):
        b = Browser(self.port)
        st, loc, _ = b.req("POST", "/login", {"username": "u1", "password": PW, "next": "//evil.example"})
        self.assertEqual(loc, "/")

    def test_cookie_flags_and_headers(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("POST", "/login", body=urlencode({"username": "u1", "password": PW}),
                  headers={"Content-Type": "application/x-www-form-urlencoded"})
        r = c.getresponse()
        self.assertIn("HttpOnly", r.getheader("Set-Cookie"))
        self.assertIn("SameSite=Lax", r.getheader("Set-Cookie"))
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", "/login")
        r = c.getresponse()
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertIn("frame-ancestors 'none'", r.getheader("Content-Security-Policy"))

    def test_forwarded_for_ignored_without_trust_proxy(self):
        self.assertFalse(self.app.trust_proxy)
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("POST", "/login", body=urlencode({"username": "nobody", "password": "x" * 12}),
                  headers={"Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "9.9.9.9"})
        c.getresponse().read()
        last = self.app.users.recent_audit(1)[0]
        self.assertEqual(last["ip"], "127.0.0.1")

    def test_logout_invalidates_session(self):
        b = Browser(self.port)
        b.login("u1")
        old = b.cookie
        b.req("POST", "/logout", {"csrf": b.csrf()})
        b.cookie = old
        self.assertEqual(b.req("GET", "/")[0], 303)


if __name__ == "__main__":
    unittest.main()
