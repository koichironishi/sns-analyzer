import json
import re
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from snsanalyzer import policy, terms
from snsanalyzer.config import load_config

sys.path.insert(0, str(Path(__file__).parent))
from test_web import PW, Browser  # noqa: E402


def filled():
    root = load_config("/nonexistent/config.json")
    root["privacy_policy"].update(operator_name="株式会社テスト", contact="https://example.jp/contact")
    root["terms"].update(court="東京地方裁判所", established="2026年10月1日")
    root["retention_days"] = 400
    return root


class TermsContentTest(unittest.TestCase):
    def test_unfilled_marked(self):
        root = load_config("/nonexistent/config.json")
        self.assertIn("【要記入：管轄裁判所】", terms.render_terms(root))
        self.assertIn('role="alert"', terms.terms_page_body(root))
        self.assertEqual(len(terms.missing_fields(root)), 4)

    def test_filled_terms_match_features(self):
        root = filled()
        html = terms.render_terms(root)
        self.assertEqual(terms.missing_fields(root), [])
        self.assertNotIn("要記入", html)
        self.assertIn("東京地方裁判所を第一審の専属的合意管轄裁判所", html)
        self.assertIn("投稿日または記録日から400日", html)
        self.assertIn('href="https://example.jp/contact"', html)
        for must in ("同意が本サービスに記録されている場合に限り", "参考情報", "民法第548条の4", "反社会的勢力",
                     "個別の契約の定めが優先", "すべて削除", "AIモデルを学習させる行為",
                     "管理者の権限は、当社の役職員その他当社が指定する者にのみ付与", "一般利用者"):
            self.assertIn(must, html)
        self.assertEqual(len(re.findall(r'<h2 id="t\d+">', html)), len(terms.TOC))

    def test_standalone_links_do_not_break(self):
        root = filled()
        self.assertIn('href="privacy.html', terms.standalone_html(root))
        self.assertIn('href="terms.html"', policy.standalone_html(root))
        root["public_url"] = "https://sns.example.jp"
        self.assertIn('href="https://sns.example.jp/privacy', terms.standalone_html(root))
        self.assertIn('href="https://sns.example.jp/terms"', policy.standalone_html(root))


class TermsWebTest(unittest.TestCase):
    def test_public_and_linked(self):
        from snsanalyzer.web import App, Handler
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            cfgp = d / "config.json"
            cfgp.write_text(json.dumps({"clients_dir": str(d / "clients"), "app_db": str(d / "app.db"),
                                        "terms": {"court": "大阪地方裁判所"}}))
            app = App(str(cfgp))
            app.users.create("admin", PW, role="admin")
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), type("H", (Handler,), {"app": app}))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                anon = Browser(httpd.server_address[1])
                st, _, body = anon.req("GET", "/terms")
                self.assertEqual(st, 200)
                self.assertIn("大阪地方裁判所", body)
                self.assertIn('href="/terms"', anon.req("GET", "/login")[2])
                self.assertIn('href="/terms"', anon.req("GET", "/privacy")[2])
            finally:
                httpd.shutdown(); httpd.server_close(); app.users.close()


if __name__ == "__main__":
    unittest.main()
