import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from snsanalyzer import analysis, importers, report, sample_data
from snsanalyzer.collectors.base import ApiError, InsightsFetcher, parse_insights
from snsanalyzer.collectors.x import XCollector
from snsanalyzer.db import Store
from snsanalyzer.models import AccountSnapshot, Metrics, Post

TZ = ZoneInfo("Asia/Tokyo")


class FakeHttp:
    """パスごとに応答（dict か ApiError）を返すテスト用クライアント。"""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, dict(params or {})))
        res = self.handler(path, params or {})
        if isinstance(res, Exception):
            raise res
        return res


class InsightsTest(unittest.TestCase):
    def test_parse_values_and_total_value(self):
        resp = {"data": [
            {"name": "reach", "values": [{"value": 120}]},
            {"name": "views", "total_value": {"value": 300}},
            {"name": "breakdown", "values": [{"value": {"a": 1, "b": 2}}]},
        ]}
        self.assertEqual(parse_insights(resp), {"reach": 120, "views": 300, "breakdown": 3})

    def test_falls_back_per_metric_and_remembers_unsupported(self):
        def handler(path, params):
            if "," in params["metric"] or params["metric"] == "saved":
                return ApiError("unsupported", 400)
            return {"data": [{"name": params["metric"], "values": [{"value": 5}]}]}

        http = FakeHttp(handler)
        f = InsightsFetcher(http, ["reach", "saved"])
        self.assertEqual(f.fetch("1", "reel"), {"reach": 5})
        http.calls.clear()
        self.assertEqual(f.fetch("2", "reel"), {"reach": 5})
        self.assertEqual(len(http.calls), 1)  # saved はスキップされる

    def test_non_400_errors_propagate(self):
        f = InsightsFetcher(FakeHttp(lambda p, q: ApiError("auth", 401)), ["reach"])
        with self.assertRaises(ApiError):
            f.fetch("1")


class XCollectorTest(unittest.TestCase):
    def test_collect_maps_public_metrics_and_paginates(self):
        pages = {
            None: {"data": [{"id": "10", "text": "hi #tag", "created_at": "2026-09-01T10:00:00.000Z",
                             "attachments": {"media_keys": ["m1"]},
                             "public_metrics": {"impression_count": 1000, "like_count": 10,
                                                "reply_count": 2, "retweet_count": 3,
                                                "quote_count": 1, "bookmark_count": 4}}],
                   "includes": {"media": [{"media_key": "m1", "type": "video"}]},
                   "meta": {"next_token": "abc"}},
            "abc": {"data": [{"id": "11", "text": "https://example.com",
                              "created_at": "2026-09-02T10:00:00.000Z",
                              "entities": {"urls": [{}]}, "public_metrics": {}}], "meta": {}},
        }

        def handler(path, params):
            if path.startswith("users/by/username"):
                return {"data": {"id": "42", "username": "demo",
                                 "public_metrics": {"followers_count": 500}}}
            return pages[params.get("pagination_token")]

        c = XCollector({"bearer_token": "t", "username": "demo"})
        c.http = FakeHttp(handler)
        res = c.collect(datetime(2026, 8, 1, tzinfo=timezone.utc))
        self.assertEqual(res.account.followers, 500)
        self.assertEqual([p.media_type for p in res.posts], ["video", "link"])
        m = res.posts[0].metrics
        self.assertEqual((m.views, m.engagements), (1000, 20))
        self.assertEqual(res.posts[0].permalink, "https://x.com/demo/status/10")


class ImporterTest(unittest.TestCase):
    def test_japanese_headers_and_cp932(self):
        csv_text = "投稿日時,本文,投稿タイプ,インプレッション,いいね数,コメント,シェア\n" \
                   "2026/09/01 19:30,新作です #デザイン,リール,\"1,200\",80,5,3\n"
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "ig.csv"
            path.write_bytes(csv_text.encode("cp932"))
            posts = importers.read_csv(path, "instagram", "acct", TZ)
        self.assertEqual(len(posts), 1)
        p = posts[0]
        self.assertEqual(p.media_type, "reel")
        self.assertEqual(p.metrics.views, 1200)
        self.assertEqual(p.metrics.engagements, 88)
        self.assertEqual(p.created_at, datetime(2026, 9, 1, 10, 30, tzinfo=timezone.utc))

    def test_missing_date_column_raises(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.csv"
            path.write_text("text,likes\nhello,1\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                importers.read_csv(path, "x", "acct", TZ)


class AnalysisTest(unittest.TestCase):
    def _post(self, pid, day, eng, platform="x", media="text", text=""):
        created = datetime.combine(day, datetime.min.time(), tzinfo=TZ).replace(hour=20)
        return Post(platform, pid, "a", created.astimezone(timezone.utc), text, media,
                    metrics=Metrics(views=eng * 10, likes=eng))

    def test_score_and_period_split(self):
        end = date(2026, 9, 28)
        posts = [self._post("1", end, 10), self._post("2", end - timedelta(days=1), 20),
                 self._post("3", end - timedelta(days=2), 30),
                 self._post("old", end - timedelta(days=10), 99)]
        followers = {"x": [(end - timedelta(days=20), 1000), (end, 1100)]}
        d = analysis.analyze(posts, followers, TZ, days=7, end=end)
        s = d["summary"]["x"]
        self.assertEqual(s["posts"], 3)
        self.assertEqual(s["prev"]["posts"], 1)
        self.assertEqual(s["followers"], 1100)
        self.assertAlmostEqual(s["er_views"], 0.1)
        self.assertEqual([round(t["score"]) for t in d["top_posts"]], [150, 100, 50])

    def test_hashtags_need_two_uses(self):
        end = date(2026, 9, 28)
        posts = [self._post("1", end, 10, text="#a #b"), self._post("2", end, 30, text="#A")]
        d = analysis.analyze(posts, {}, TZ, days=7, end=end)
        self.assertEqual([h["tag"] for h in d["hashtags"]], ["a"])


class EndToEndTest(unittest.TestCase):
    def test_demo_pipeline_renders_report(self):
        with tempfile.TemporaryDirectory() as d:
            with Store(Path(d) / "t.db") as store:
                n = sample_data.generate(store, days=70)
                store.save_snapshot(AccountSnapshot("x", "demo_x", "demo", date.today(), 1))
                data = analysis.analyze(store.load_posts(), store.load_follower_series(), TZ,
                                        days=30, account_names=store.account_names())
            self.assertGreater(n, 100)
            self.assertEqual(data["platforms"], ["instagram", "facebook", "threads", "x"])
            self.assertTrue(data["insights"])
            html = report.render_html(data)
            self.assertIn("SNS分析レポート", html)
            self.assertNotIn("</script><", html.split('id="report-data"')[1].split("</script>")[0])


if __name__ == "__main__":
    unittest.main()
