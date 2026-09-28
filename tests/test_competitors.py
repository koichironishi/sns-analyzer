import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from snsanalyzer import compare, report, sample_data
from snsanalyzer.cli import build, main
from snsanalyzer.collectors.instagram import InstagramCollector
from snsanalyzer.config import load_config
from snsanalyzer.db import Store
from snsanalyzer.models import AccountSnapshot, Metrics, Post

TZ = ZoneInfo("Asia/Tokyo")


class FakeHttp:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get(self, path, params=None):
        self.calls.append(params["fields"])
        return self.pages[len(self.calls) - 1]


class StoreScopeTest(unittest.TestCase):
    def test_own_and_competitor_are_separated(self):
        with tempfile.TemporaryDirectory() as d:
            with Store(Path(d) / "t.db") as s:
                sample_data.generate(s, days=40)
                own, comp = s.load_posts(), s.load_posts(scope="competitor")
                self.assertTrue(own and comp)
                self.assertFalse({p.account_id for p in own} & {p.account_id for p in comp})
                self.assertEqual(set(s.load_follower_series()), {"instagram", "facebook", "threads", "x"})
                self.assertTrue(all(not a.startswith("demo_comp") for a in
                                    [k for k in s.account_names().values()]))


class CompareTest(unittest.TestCase):
    def test_public_engagement_ignores_private_metrics(self):
        now = datetime.now(timezone.utc) - timedelta(hours=3)
        own = [Post("instagram", "o1", "me", now, "#a", "reel",
                    metrics=Metrics(views=1000, likes=100, comments=10, shares=50, saves=80))]
        comp = [Post("instagram", "c1", "rv", now, "#b", "image", metrics=Metrics(likes=100, comments=10))]
        today = datetime.now(TZ).date()
        c = compare.compare(own, {"instagram": [(today, 1000)]}, comp,
                            {("instagram", "rv"): [(today, 1000)]}, {("instagram", "rv"): "Rival"},
                            {}, {}, TZ, days=7)
        rows = c["platforms"]["instagram"]["rows"]
        self.assertEqual([r["avg_eng"] for r in rows], [110, 110])  # シェア・保存は除外
        self.assertEqual(rows[0]["name"], compare.OWN)
        self.assertAlmostEqual(rows[1]["er_followers"], 0.11)

    def test_filter_by_configured_names(self):
        now = datetime.now(timezone.utc)
        comp = [Post("x", "c1", "a1", now, "", "text", metrics=Metrics(likes=1)),
                Post("x", "c2", "a2", now, "", "text", metrics=Metrics(likes=1))]
        today = datetime.now(TZ).date()
        c = compare.compare([], {"x": [(today, 10)]}, comp, {}, {("x", "a1"): "A", ("x", "a2"): "B"},
                            {}, {}, TZ, days=7, competitors=["A"])
        self.assertEqual([r["name"] for r in c["platforms"]["x"]["rows"]], [compare.OWN, "A"])


class BusinessDiscoveryTest(unittest.TestCase):
    def test_paginates_until_since(self):
        now = datetime.now(timezone.utc)
        iso = lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%S+0000")  # noqa: E731
        page1 = {"business_discovery": {
            "id": "99", "username": "rival", "followers_count": 5000,
            "media": {"data": [{"id": "m1", "timestamp": iso(now), "like_count": 50, "comments_count": 5,
                                "media_type": "VIDEO", "media_product_type": "REELS"}],
                      "paging": {"cursors": {"after": "CUR"}}}}}
        page2 = {"business_discovery": {
            "id": "99", "media": {"data": [
                {"id": "m2", "timestamp": iso(now - timedelta(days=2)), "comments_count": 1,
                 "media_type": "IMAGE"},
                {"id": "old", "timestamp": iso(now - timedelta(days=90)), "media_type": "IMAGE"}],
                "paging": {"cursors": {"after": "CUR2"}}}}}
        c = InstagramCollector({"user_id": "me", "access_token": "t"})
        c.http = FakeHttp([page1, page2])
        res = c.collect_competitor("@rival", now - timedelta(days=30))
        self.assertEqual(res.account.followers, 5000)
        self.assertEqual([p.post_id for p in res.posts], ["m1", "m2"])
        self.assertEqual(res.posts[0].media_type, "reel")
        self.assertEqual(res.posts[1].metrics.likes, 0)  # いいね非表示
        self.assertIn("media.after(CUR)", c.http.calls[1])


class CliCompetitorTest(unittest.TestCase):
    def test_add_import_report_remove(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "config.json"
            root.write_text(json.dumps({"clients_dir": str(Path(d) / "clients")}))
            run = lambda *a: main(["--config", str(root), *a])  # noqa: E731
            with redirect_stdout(io.StringIO()):
                self.assertEqual(run("client", "add", "acme"), 0)
                self.assertEqual(run("-c", "acme", "competitor", "add", "競合A", "--x", "@rival"), 0)
                self.assertEqual(run("-c", "acme", "competitor", "add", "競合A", "--instagram", "rv"), 0)
                cfg = load_config(root, "acme")
                self.assertEqual(cfg["competitors"], [{"name": "競合A", "x": "rival", "instagram": "rv"}])
                today = datetime.now(TZ).strftime("%Y-%m-%d %H:%M")
                csv = Path(d) / "p.csv"
                csv.write_text(f"created_at,text,likes,comments\n{today},hello,10,1\n", encoding="utf-8")
                self.assertEqual(run("-c", "acme", "import-csv", str(csv), "--platform", "x"), 0)
                self.assertEqual(run("-c", "acme", "import-csv", str(csv), "--platform", "x",
                                     "--competitor", "競合A"), 0)
                self.assertEqual(run("-c", "acme", "followers", "--platform", "x", "--count", "500",
                                     "--competitor", "競合A"), 0)
                data = build(load_config(root, "acme"), 30)
                self.assertEqual(data["summary"]["x"]["posts"], 1)  # 自社集計に競合が混ざらない
                rows = data["competitors"]["platforms"]["x"]["rows"]
                self.assertEqual([r["name"] for r in rows], ["自社", "競合A"])
                self.assertIn("competitors.csv", data["downloads"])
                self.assertIn("競合比較", report.render_html(data))
                self.assertEqual(run("-c", "acme", "competitor", "remove", "競合A"), 0)
                data = build(load_config(root, "acme"), 30)
                self.assertEqual(data["competitors"]["platforms"], {})


if __name__ == "__main__":
    unittest.main()
