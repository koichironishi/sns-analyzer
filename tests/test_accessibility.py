"""アクセシビリティの回帰テスト（DADS / WCAG 2.2 の数値基準のうち静的に検査できるもの）。"""
import re
import tempfile
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

from snsanalyzer import analysis, report, sample_data, ui, web
from snsanalyzer.db import Store

TZ = ZoneInfo("Asia/Tokyo")


def _lum(hex_):
    rgb = [int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    rgb = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def contrast(a, b):
    x, y = sorted((_lum(a), _lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def tokens(block: str) -> dict:
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})", block))


class TokenTest(unittest.TestCase):
    def setUp(self):
        light, dark = ui.TOKENS.split("@media (prefers-color-scheme: dark)")
        self.modes = {"light": tokens(light), "dark": {**tokens(light), **tokens(dark.split(":root[data-theme")[0])}}

    def test_text_contrast_4_5(self):
        for mode, t in self.modes.items():
            for fg in ("text", "text-2", "muted", "accent", "good", "warn", "info"):
                for bg in ("bg", "surface", "surface-2"):
                    self.assertGreaterEqual(contrast(t[fg], t[bg]), 4.5, f"{mode}: {fg} on {bg}")
            for fg, bg in (("accent", "accent-bg"), ("good", "good-bg"), ("warn", "warn-bg"), ("info", "info-bg"),
                           ("on-accent", "accent")):
                self.assertGreaterEqual(contrast(t[fg], t[bg]), 4.5, f"{mode}: {fg} on {bg}")

    def test_non_text_contrast_3(self):
        for mode, t in self.modes.items():
            self.assertGreaterEqual(contrast(t["border-strong"], t["surface"]), 3, mode)
            self.assertGreaterEqual(contrast(t["focus-ring"], t["bg"]), 3, mode)

    def test_font_sizes_at_least_14(self):
        css = ui.TOKENS + ui.BASE + report.REPORT_CSS + web.APP_CSS
        for px in re.findall(r"font-size:\s*(\d+)px", css) + re.findall(r"--fs-[\w-]+:\s*(\d+)px", css):
            self.assertGreaterEqual(int(px), 14)

    def test_targets_at_least_44(self):
        css = ui.BASE + report.REPORT_CSS + web.APP_CSS
        interactive = re.compile(r"(\.btn|\.tab\b|summary|\ba\b|label|input|select|button)")
        for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
            m = re.search(r"min-height:\s*(\d+)px", body)
            if m and interactive.search(selector) and int(m.group(1)) < 44:
                self.fail(f"{selector.strip()}: min-height {m.group(1)}px < 44px")


class ReflowAndTargetTest(unittest.TestCase):
    """2回目の監査で見つかった不具合の再発防止（320px リフロー・ターゲット）。"""

    def test_scroll_containers_contain_hidden_text(self):
        self.assertRegex(ui.BASE, r"\.scroll \{[^}]*position: relative")

    def test_platform_card_track_can_shrink(self):
        self.assertRegex(report.REPORT_CSS, r"\.pcard \{[^}]*grid-template-columns: minmax\(0, 1fr\)")
        self.assertIn(".spark canvas { max-width: 100%; }", report.REPORT_CSS)

    def test_footer_and_table_links_have_targets(self):
        self.assertRegex(web.APP_CSS, r"\.foot a \{[^}]*min-height: 44px")
        self.assertRegex(ui.BASE, r"td a:not\(\.btn\) \{[^}]*padding: 4px 0")

    def test_card_title_links_are_underlined(self):
        self.assertRegex(web.APP_CSS, r"\.ccard h2 a \{[^}]*text-decoration: underline")


class MarkupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as d:
            with Store(Path(d) / "t.db") as s:
                sample_data.generate(s, days=60)
                data = analysis.analyze(s.load_posts(), s.load_follower_series(), TZ, days=30)
        cls.html = report.render_html(data)

    def test_skip_link_and_landmarks(self):
        self.assertIn('<a class="skip" href="#main">', self.html)
        self.assertIn('<main class="content" id="main"', self.html)
        self.assertIn('lang="ja"', self.html)

    def test_charts_have_text_alternatives(self):
        for canvas in re.findall(r"<canvas[^>]*>", self.html):
            self.assertIn('role="img"', canvas)
            self.assertIn("aria-label=", canvas)
        self.assertIn("表で見る", self.html)

    def test_tables_have_captions_and_scopes(self):
        self.assertIn('<caption class="sr-only">全体：曜日×時間帯', self.html)
        self.assertIn('<th scope="col">', self.html)

    def test_no_heading_level_skip_within_pages(self):
        for page in re.findall(r'<div class="page".*?(?=<div class="page"|<footer)', self.html, re.S):
            levels = [int(h) for h in re.findall(r"<h([1-6])", page)]
            for a, b in zip(levels, levels[1:]):
                self.assertLessEqual(b - a, 1, f"見出しの飛び: {levels}")


if __name__ == "__main__":
    unittest.main()
