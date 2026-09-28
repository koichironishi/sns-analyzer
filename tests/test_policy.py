import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from snsanalyzer import policy
from snsanalyzer.config import create_client, load_config

sys.path.insert(0, str(Path(__file__).parent))
from test_web import PW, Browser  # noqa: E402


class PolicyContentTest(unittest.TestCase):
    def test_missing_fields_are_marked_not_invented(self):
        root = load_config("/nonexistent/config.json")
        html = policy.render_policy(root)
        self.assertIn("【要記入：事業者名】", html)
        self.assertIn('role="alert"', policy.policy_page_body(root))
        self.assertEqual(len(policy.missing_fields(root)), 7)  # サービス名以外は未設定

    def test_filled_policy_reflects_config(self):
        root = load_config("/nonexistent/config.json")
        root["privacy_policy"].update(operator_name="株式会社テスト", operator_address="東京都",
                                      representative="代表 太郎", contact="privacy@example.jp",
                                      established="2026年10月1日", server_location="日本",
                                      org_measures="取扱規程の整備、従業者への研修")
        root["retention_days"] = 365
        root["public_url"] = "https://sns.example.jp"
        html = policy.render_policy(root)
        self.assertEqual(policy.missing_fields(root), [])
        self.assertNotIn("要記入", html)
        self.assertIn('href="mailto:privacy@example.jp"', html)
        self.assertIn("<strong>365日</strong>", html)
        self.assertIn("https://sns.example.jp/data-deletion/status", html)
        # 法令・規約上必要な記載
        for must in ("アメリカ合衆国", "Anthropic, PBC", "ppc.go.jp", "開示", "安全管理措置", "Cookie",
                     "利用停止・消去", "苦情", "外的環境の把握", "データは日本に所在するサーバー", "個人データを本人の同意なく",
                     "利用ポリシー違反", "取扱規程の整備",
                     "同意を得て", "本サービスはこれらの会社が提供・承認するものではありません"):
            self.assertIn(must, html)

    def test_escapes_config_values(self):
        root = load_config("/nonexistent/config.json")
        root["privacy_policy"]["operator_name"] = "<script>x</script>"
        self.assertNotIn("<script>x", policy.render_policy(root))

    def test_headings_do_not_skip_levels(self):
        import re
        html = policy.policy_page_body(load_config("/nonexistent/config.json"))
        levels = [int(h) for h in re.findall(r"<h([1-6])", html)]
        for a, b in zip(levels, levels[1:]):
            self.assertLessEqual(b - a, 1)


class PolicyWebTest(unittest.TestCase):
    def test_public_page_links_and_job_runner(self):
        from snsanalyzer.web import App, Handler
        from snsanalyzer import sample_data
        from snsanalyzer.db import Store
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            cfgp = d / "config.json"
            cfgp.write_text(json.dumps({"clients_dir": str(d / "clients"), "app_db": str(d / "app.db"),
                                        "privacy_policy": {"operator_name": "株式会社テスト"}}))
            create_client(load_config(cfgp), "acme", "ACME")
            with Store(load_config(cfgp, "acme")["database"]) as s:
                sample_data.generate(s, days=40)
            app = App(str(cfgp))
            app.users.create("admin", PW, role="admin")
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), type("H", (Handler,), {"app": app}))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            port = httpd.server_address[1]
            try:
                anon = Browser(port)
                st, _, body = anon.req("GET", "/privacy")  # ログイン不要
                self.assertEqual(st, 200)
                self.assertIn("株式会社テスト", body)
                self.assertIn('href="/privacy"', anon.req("GET", "/login")[2])
                b = Browser(port)
                b.login("admin")
                self.assertIn('href="/privacy"', b.req("GET", "/")[2])
                # 復元した実行処理（サブプロセスでレポート作成）が動くこと
                self.assertEqual(b.req("POST", "/c/acme/run", {"csrf": b.csrf(), "action": "report"})[0], 303)
                for _ in range(60):
                    if app.jobs["acme"]["status"] != "running":
                        break
                    time.sleep(0.5)
                self.assertEqual(app.jobs["acme"]["status"], "done", app.jobs["acme"]["output"])
                self.assertTrue((d / "clients/acme/reports/latest.html").exists())
            finally:
                httpd.shutdown(); httpd.server_close(); app.users.close()


if __name__ == "__main__":
    unittest.main()
