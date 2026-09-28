"""分析結果を1ファイルの HTML ダッシュボードとして出力する。

グラフは Chart.js（cdnjs）で描画。表や数値はサーバー側で描画するため、
オフラインでも数値は読める。
"""
from __future__ import annotations

import json
import re
from html import escape
from pathlib import Path
from typing import Optional

from .models import PLATFORM_LABELS
from .ui import BASE, TOKENS

CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"

REPORT_CSS = TOKENS + BASE + """
/* レイアウト：左サイドバー（目次）＋本文 */
.shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--surface);
  border-right: 1px solid var(--border); padding: var(--s5) var(--s4); display: flex; flex-direction: column; gap: var(--s5); }
.eyebrow { margin: 0; font-size: var(--fs-xs); font-weight: 700; letter-spacing: .06em; color: var(--muted); }
.side-title { margin: 4px 0 0; font-size: var(--fs-lg); font-weight: 800; line-height: 1.35; }
.side-meta { margin: 6px 0 0; font-size: var(--fs-sm); color: var(--text-2); line-height: 1.6; }
.side-nav { display: grid; gap: 2px; }
.side-nav a { display: flex; align-items: center; min-height: 44px; padding: 8px 12px; border-radius: 8px;
  color: var(--text-2); text-decoration: none; font-size: var(--fs-md); font-weight: 500; }
.side-nav a:hover { background: var(--surface-2); color: var(--text); }
.side-nav a[aria-current="page"] { background: var(--accent-bg); color: var(--accent); font-weight: 700; }
.side-actions { margin-top: auto; display: grid; gap: var(--s2); }
.side-actions .btn, .side-actions summary.btn { width: 100%; justify-content: flex-start; }
.side-actions .menu-panel { bottom: 100%; margin: 0 0 6px; left: 0; right: 0; min-width: 0; }

.content { padding: var(--s6) var(--s7) var(--s7); max-width: 1180px; width: 100%; }
.content:focus, .page:focus, .page:focus-visible { outline: none; }
.page-head { margin-bottom: var(--s5); }
.page-head h1 { font-size: var(--fs-2xl); margin: 4px 0 6px; }
.lead { margin: 0; color: var(--text-2); font-size: var(--fs-base); }
section { margin-top: var(--s6); }
.page-head + section { margin-top: 0; }
section > h2 { font-size: var(--fs-lg); margin: 0 0 4px; }
section > h2 + .card, section > h2 + div { margin-top: var(--s3); }
.note-top { color: var(--text-2); font-size: var(--fs-sm); margin: 0 0 var(--s4); }

/* 概要：結論の4指標 */
.hero { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.stat { padding: var(--s5); border-left: 1px solid var(--grid); display: grid; gap: 4px; align-content: start; }
.stat:first-child { border-left: 0; }
.stat-label { font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); }
.stat-value { font-size: var(--fs-3xl); font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }

/* 今期のポイント */
.insights { list-style: none; margin: 0; padding: 0; display: grid; }
.ins { display: grid; grid-template-columns: 76px 1fr; gap: var(--s3); align-items: start; padding: 12px 0;
  border-top: 1px solid var(--grid); font-size: var(--fs-md); }
.insights .ins:first-child { border-top: 0; padding-top: 0; }
.ins .badge { justify-self: start; margin-top: 2px; }
details.more { margin-top: var(--s2); border-top: 1px solid var(--grid); padding-top: var(--s2); }
details.more > summary { cursor: pointer; font-size: var(--fs-sm); font-weight: 600; color: var(--accent); min-height: 44px;
  display: flex; align-items: center; }
details.more .ins:first-child { border-top: 1px solid var(--grid); padding-top: 12px; }

/* SNS別カード */
.pgrid { display: grid; gap: var(--s4); grid-template-columns: minmax(0, 1fr); margin-top: var(--s3); }
@media (min-width: 600px) { .pgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1360px) { .pgrid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.pcard { padding: var(--s4) var(--s5) var(--s4); display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; }
.spark canvas { max-width: 100%; }
.pcard-head { display: flex; align-items: center; gap: 8px; font-weight: 700; min-width: 0; }
.acct { color: var(--muted); font-weight: 400; font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pcard-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.pcard-value { font-size: var(--fs-2xl); font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.2; }
.pcard-unit { font-size: var(--fs-sm); color: var(--text-2); }
.spark { height: 40px; margin: 4px 0; }
.mini { margin: 0; display: grid; font-size: var(--fs-sm); }
.mini div { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0 8px; padding: 6px 0; border-top: 1px solid var(--grid); }
.mini dt { color: var(--text-2); min-width: 0; } .mini dd { margin: 0; display: flex; gap: 8px; align-items: center; font-variant-numeric: tabular-nums; }

.chart-box { position: relative; height: 320px; }

/* 表の中の横棒 */
.bar-cell { min-width: 190px; white-space: nowrap; }
.bar { display: inline-block; height: 8px; border-radius: 0 4px 4px 0; vertical-align: middle; max-width: calc(100% - 100px); min-width: 2px; }
.bar-val { margin-left: 8px; font-variant-numeric: tabular-nums; }
.post-text { min-width: 260px; }
.post-text a { color: inherit; }
.rank { font-size: var(--fs-xs); color: var(--muted); margin-left: 4px; }
.small { font-size: var(--fs-sm); }
.note { font-size: var(--fs-sm); color: var(--muted); margin: var(--s3) 0 0; }
tr.own > * { background: var(--accent-bg); }

/* ヒートマップ */
.heatmap { table-layout: fixed; min-width: 560px; border-collapse: separate; border-spacing: 3px; }
.heatmap th, .heatmap td { text-align: center; padding: 0; height: 40px; border: 0; background: transparent; }
.heatmap tbody tr:hover > * { background: transparent; }
.heatmap thead th { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0; }
.heatmap tbody th { width: 36px; color: var(--text-2); font-weight: 600; font-size: var(--fs-sm); }
td.heat { font-size: var(--fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; border-radius: 6px; }
.heat.h0 { background: var(--surface-2) !important; }
.heat.h1 { background: var(--h1) !important; color: #0b0b0b; } .heat.h2 { background: var(--h2) !important; color: #0b0b0b; }
.heat.h3 { background: var(--h3) !important; color: #0b0b0b; } .heat.h4 { background: var(--h4) !important; color: #0b0b0b; }
.heat.h5 { background: var(--h5) !important; color: #0b0b0b; } .heat.h6 { background: var(--h6) !important; color: #fff; }
.heat.h7 { background: var(--h7) !important; color: #fff; }
.heat-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: var(--fs-xs); color: var(--text-2); margin-top: var(--s3); align-items: center; }
.heat-legend span { white-space: nowrap; display: inline-flex; align-items: center; }
.heat-legend i { display: inline-block; width: 14px; height: 14px; border-radius: 4px; margin-right: 4px; vertical-align: -2px; }

/* AI分析 */
.h3 { font-size: var(--fs-base); margin: var(--s6) 0 var(--s3); }
.card h3 { font-size: var(--fs-base); margin: 0 0 6px; }
.card p { margin: 0 0 6px; }
.grid.wide { display: grid; gap: var(--s4); grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
.grid.wide > * { min-width: 0; }
.ai-lead { border-left: 4px solid var(--accent); }
.ai-headline { font-size: var(--fs-xl); font-weight: 800; line-height: 1.45; margin-bottom: var(--s2) !important; }
.ai-qa { margin-top: var(--s4); background: var(--accent-bg); border-color: transparent; box-shadow: none; }
.pn { list-style: none; margin: var(--s3) 0 0; padding: 0; display: grid; gap: 6px; font-size: var(--fs-md); }
.pn li { display: flex; gap: 8px; } .pn span { font-weight: 800; flex: none; }
.pn .plus span { color: var(--good); } .pn .minus span { color: var(--warn); }
.evidence { font-size: var(--fs-sm); color: var(--text-2); }
.pri { display: inline-block; min-width: 32px; text-align: center; font-size: var(--fs-xs); font-weight: 800; padding: 3px 8px; border-radius: 6px; }
.pri.warn { background: var(--warn-bg); color: var(--warn); } .pri.info { background: var(--info-bg); color: var(--info); }
.pri.flat { background: var(--surface-2); color: var(--text-2); }
.strong-text { font-weight: 700; min-width: 200px; }
.ai td { min-width: 150px; } .ai td:first-child, .ai td:nth-child(2) { min-width: 0; }
.idea-head { font-size: var(--fs-xs); font-weight: 600; color: var(--muted); margin-bottom: 4px; }
.copy { white-space: pre-wrap; font: inherit; font-size: var(--fs-md); background: var(--surface-2); border-radius: var(--r-md);
  padding: var(--s3) var(--s4); margin: var(--s3) 0 0; }

/* ページ送り */
.paged .page { display: none; }
.paged .page.active { display: block; }
.pager { display: flex; justify-content: space-between; gap: var(--s4); margin-top: var(--s7); padding-top: var(--s5);
  border-top: 1px solid var(--border); }
.pager a { display: grid; gap: 2px; min-height: 44px; padding: 8px 12px; margin: -8px -12px; border-radius: 8px;
  color: var(--text); text-decoration: none; font-weight: 700; }
.pager a small { font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
.pager a.next { text-align: right; }
.pager a:hover { background: var(--surface); }
.foot { margin-top: var(--s6); color: var(--muted); font-size: var(--fs-xs); }

/* タブレット・スマートフォン：目次を上部の横スクロールに */
@media (max-width: 960px) {
  .shell { display: block; }
  .side { position: sticky; top: 0; z-index: 20; height: auto; overflow: visible; flex-direction: row; flex-wrap: wrap;
    align-items: center; gap: var(--s2) var(--s3); padding: var(--s3) var(--s4) 0; border-right: 0; border-bottom: 1px solid var(--border); }
  .side-head { flex: 1; min-width: 0; }
  .side-head .eyebrow, .side-meta { display: none; }
  .side-title { margin: 0; font-size: var(--fs-md); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .side-actions { margin: 0; display: flex; gap: var(--s2); }
  .side-actions .btn, .side-actions summary.btn { width: auto; }
  .side-actions > .btn { display: none; }
  .side-actions .menu-panel { bottom: auto; top: 100%; right: 0; left: auto; margin: 6px 0 0; min-width: 220px; }
  .side-nav { order: 3; flex-basis: 100%; display: flex; overflow-x: auto; gap: 2px; margin: 0 calc(var(--s4) * -1);
    padding: 0 var(--s4) var(--s2); scrollbar-width: none; }
  .side-nav::-webkit-scrollbar { display: none; }
  .side-nav a { flex: none; }
  .content { padding: var(--s5) var(--s4) var(--s7); }
  .hero { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(3) { border-left: 0; }
  .stat:nth-child(n+3) { border-top: 1px solid var(--grid); }
}
@media (max-width: 520px) {
  .page-head h1 { font-size: var(--fs-xl); }
  .stat { padding: var(--s4); }
  .stat-value { font-size: var(--fs-xl); }
  .ins { grid-template-columns: 1fr; gap: 4px; }
  .card, .pcard { padding: var(--s4); }
  .pcard-value { font-size: var(--fs-xl); }
}

/* 印刷・PDF：全ページを順に出力 */
@media print {
  :root { color-scheme: light; }
  body { background: #fff; font-size: 11pt; }
  .shell { display: block; }
  .no-print, .tabs, .app-bar { display: none !important; }
  .content { padding: 0; max-width: none; }
  .page { display: block !important; break-before: page; }
  .page:first-of-type { break-before: auto; }
  .card, tr, .ins, .stat { break-inside: avoid; }
  .card { box-shadow: none; }
  .chart-box { height: 240px; }
  a { text-decoration: none; color: inherit; }
}
"""


def _n(v, digits: int = 0) -> str:
    if v is None:
        return "—"
    return f"{v:,.{digits}f}"


def _pct(v: Optional[float], digits: int = 2) -> str:
    return "—" if v is None else f"{v * 100:.{digits}f}%"


def _delta(v: Optional[float], label: str = "") -> str:
    if v is None:
        return f'<span class="delta flat">{label}—</span>' if label else '<span class="delta flat">—</span>'
    cls = "up" if v > 0.005 else "down" if v < -0.005 else "flat"
    arrow = {"up": "▲", "down": "▼", "flat": "→"}[cls]
    word = {"up": "増", "down": "減", "flat": "横ばい"}[cls]
    return (f'<span class="delta {cls}" title="前期間比 {v * 100:+.1f}%">{label}<span aria-hidden="true">{arrow}</span> {abs(v) * 100:.1f}%'
            f'<span class="sr-only">{word}</span></span>')


def _chip(platform: str) -> str:
    return (f'<span class="chip"><i class="dot" style="background:var(--c-{platform})"></i>'
            f'{PLATFORM_LABELS[platform]}</span>')


def _heat_class(score: Optional[float]) -> str:
    if score is None:
        return "h0"
    for i, th in enumerate((60, 80, 100, 120, 150, 200), start=1):
        if score < th:
            return f"h{i}"
    return "h7"


def _hero(d: dict) -> str:
    """全体の結論（最初に見る4つの数字）。"""
    t = d["total"]
    fol = [d["summary"][p]["followers"] for p in d["platforms"] if d["summary"][p]["followers"] is not None]
    fdel = [d["summary"][p]["followers_delta"] for p in d["platforms"]
            if d["summary"][p]["followers_delta"] is not None]
    fol_prev = sum(fol) - sum(fdel) if fol and fdel else None
    tiles = [
        ("エンゲージメント", _n(t["engagements"]), _delta(t["change"].get("engagements"), "前期間比 ")),
        ("表示回数", _n(t["views"]), _delta(t["change"].get("views"), "前期間比 ")),
        ("投稿数", _n(t["posts"]), _delta(t["change"].get("posts"), "前期間比 ")),
        ("フォロワー合計", _n(sum(fol)) if fol else "—",
         _delta((sum(fdel) / fol_prev) if fol_prev else None, f"{sum(fdel):+,}人 ") if fdel else _delta(None)),
    ]
    return '<div class="hero">' + "".join(
        f'<div class="stat"><div class="stat-label">{label}</div><div class="stat-value">{value}</div>{delta}</div>'
        for label, value, delta in tiles) + "</div>"


def _spark_label(d: dict, p: str) -> str:
    vals = [v for v in d["daily"][p]["followers"] if v is not None]
    return f"{vals[0]:,}人から{vals[-1]:,}人" if vals else "データなし"


def _trend_table(d: dict) -> str:
    dates = d["daily"]["dates"]
    weeks = [(i, min(i + 7, len(dates))) for i in range(0, len(dates), 7)]
    head = "".join(f'<th scope="col" class="num">{PLATFORM_LABELS[p]}</th>' for p in d["platforms"])
    rows = "".join(
        f'<tr><th scope="row" class="nowrap">{dates[a][5:].replace("-", "/")}〜{dates[b - 1][5:].replace("-", "/")}</th>'
        + "".join(f'<td class="num">{sum(d["daily"][p]["engagements"][a:b]):,}</td>' for p in d["platforms"])
        + "</tr>" for a, b in weeks)
    return f'<table><caption class="sr-only">週ごとのエンゲージメント合計</caption><thead><tr><th scope="col">期間</th>{head}</tr></thead><tbody>{rows}</tbody></table>'


def _platform_cards(d: dict) -> str:
    cards = []
    for p in d["platforms"]:
        s = d["summary"][p]
        fd = s["followers_delta"]
        ch = s["change"]
        cards.append(f"""
      <article class="card pcard">
        <header class="pcard-head">{_chip(p)}<span class="acct">{escape(s['account'] or '')}</span></header>
        <div class="pcard-main"><span class="pcard-value">{_n(s['followers'])}</span>
          <span class="pcard-unit">フォロワー</span>
          <span class="delta {'up' if (fd or 0) > 0 else 'down' if (fd or 0) < 0 else 'flat'}">{'—' if fd is None else f'{fd:+,}'}</span></div>
        <div class="spark"><canvas data-spark="{p}" aria-label="{PLATFORM_LABELS[p]}のフォロワー推移：{_spark_label(d, p)}" role="img"></canvas></div>
        <dl class="mini">
          <div><dt>投稿</dt><dd>{_n(s['posts'])}{_delta(ch.get('posts'))}</dd></div>
          <div><dt>エンゲージメント</dt><dd>{_n(s['engagements'])}{_delta(ch.get('engagements'))}</dd></div>
          <div><dt>ER（フォロワー比）</dt><dd>{_pct(s['er_followers'])}{_delta(ch.get('er_followers'))}</dd></div>
          <div><dt>ER（表示比）</dt><dd>{_pct(s['er_views'])}</dd></div>
        </dl>
      </article>""")
    return '<div class="pgrid">' + "".join(cards) + "</div>"


def _compare_table(d: dict) -> str:
    rows = [(p, d["summary"][p]) for p in d["platforms"]]
    mx = max((s["er_followers"] or 0 for _, s in rows), default=0) or 1
    body = "".join(f"""
        <tr><th scope="row">{_chip(p)}</th>
          <td class="num">{_n(s['posts'])}</td>
          <td class="num">{_n(s['avg_engagements'])}</td>
          <td class="bar-cell"><span class="bar" style="width:{(s['er_followers'] or 0) / mx * 100:.1f}%;background:var(--c-{p})"></span><span class="bar-val">{_pct(s['er_followers'])}</span></td>
          <td class="num">{_pct(s['er_views'])}</td>
          <td class="num">{_pct(s['followers_growth'])}</td></tr>""" for p, s in rows)
    return f"""<table><thead><tr><th>SNS</th><th class="num">投稿数</th><th class="num">1投稿平均エンゲージメント</th>
      <th>ER（フォロワー比）</th><th class="num">ER（表示比）</th><th class="num">フォロワー増加率</th></tr></thead>
      <tbody>{body}</tbody></table>"""


def _media_table(d: dict) -> str:
    mx = max((m["score"] or 0 for m in d["media"]), default=0) or 1
    body = "".join(f"""
        <tr><td>{_chip(m['platform'])}</td><td>{escape(m['label'])}</td>
          <td class="num">{m['count']}</td><td class="num">{_n(m['avg_engagements'])}</td>
          <td class="num">{_pct(m['er_views'])}</td>
          <td class="bar-cell"><span class="bar" style="width:{(m['score'] or 0) / mx * 100:.1f}%;background:var(--c-{m['platform']})"></span><span class="bar-val">{_n(m['score'])}</span></td></tr>"""
                   for m in d["media"])
    return f"""<table><thead><tr><th>SNS</th><th>形式</th><th class="num">件数</th>
      <th class="num">平均エンゲージメント</th><th class="num">ER（表示比）</th><th>パフォーマンス指数</th></tr></thead>
      <tbody>{body}</tbody></table>"""


def _heatmaps(d: dict) -> str:
    tabs = ['<button type="button" class="tab" aria-pressed="true" data-heat="all">全体</button>']
    tabs += [f'<button type="button" class="tab" aria-pressed="false" data-heat="{p}">{PLATFORM_LABELS[p]}</button>'
             for p in d["platforms"]]
    tables = []
    for key, h in d["heatmap"].items():
        head = "".join(f'<th scope="col">{escape(s)}</th>' for s in d["slots"])
        rows = []
        for w, wd in enumerate(d["weekdays"]):
            cells = []
            for sl in range(len(d["slots"])):
                sc, n = h["score"][w][sl], h["count"][w][sl]
                tip = f"{wd}曜 {d['slots'][sl]}：" + (f"指数 {sc:.0f}（{n}件）" if sc is not None else "投稿なし")
                cells.append(f'<td class="heat {_heat_class(sc)}" title="{tip}">'
                             f'{"" if sc is None else f"{sc:.0f}"}</td>')
            rows.append(f"<tr><th scope=\"row\">{wd}</th>{''.join(cells)}</tr>")
        hidden = "" if key == "all" else " hidden"
        name = "全体" if key == "all" else PLATFORM_LABELS[key]
        tables.append(f'<table class="heatmap" data-heat-table="{key}"{hidden}>'
                      f'<caption class="sr-only">{name}：曜日×時間帯のパフォーマンス指数</caption>'
                      f'<thead><tr><td></td>{head}</tr></thead>'
                      f'<tbody>{"".join(rows)}</tbody></table>')
    legend = "".join(f'<span><i class="heat {c}"></i>{t}</span>' for c, t in
                     (("h1", "〜60"), ("h2", "60〜80"), ("h3", "80〜100"), ("h4", "100〜120"),
                      ("h5", "120〜150"), ("h6", "150〜200"), ("h7", "200〜")))
    return (f'<div class="tabs" role="group" aria-label="SNSを選択">{"".join(tabs)}</div>'
            f'<div class="scroll">{"".join(tables)}</div><div class="heat-legend">指数：{legend}</div>')


def _hashtag_table(d: dict) -> str:
    if not d["hashtags"]:
        return '<p class="muted">2回以上使われたハッシュタグはありません。</p>'
    mx = max(h["score"] for h in d["hashtags"]) or 1
    body = "".join(f"""
        <tr><td>#{escape(h['tag'])}</td><td class="num">{h['count']}</td>
          <td>{''.join(f'<i class="dot" title="{PLATFORM_LABELS[p]}" style="background:var(--c-{p})"></i>' for p in h['platforms'])}</td>
          <td class="bar-cell"><span class="bar" style="width:{h['score'] / mx * 100:.1f}%;background:var(--seq)"></span><span class="bar-val">{h['score']:.0f}</span></td></tr>"""
                   for h in d["hashtags"])
    return f"""<table><thead><tr><th>ハッシュタグ</th><th class="num">使用数</th><th>SNS</th>
      <th>平均パフォーマンス指数</th></tr></thead><tbody>{body}</tbody></table>"""


def _top_posts(d: dict) -> str:
    body = []
    for t in d["top_posts"]:
        text = escape(t["text"][:80] + ("…" if len(t["text"]) > 80 else ""))
        if t["permalink"]:
            text = f'<a href="{escape(t["permalink"])}" target="_blank" rel="noopener">{text}</a>'
        body.append(f"""<tr><td>{_chip(t['platform'])}</td><td class="nowrap">{t['date']}</td>
          <td>{escape(t['media'])}</td><td class="post-text">{text}</td>
          <td class="num">{_n(t['engagements'])}</td><td class="num">{_n(t['views'])}</td>
          <td class="num">{_pct(t['er_views'])}</td><td class="num strong">{t['score']:.0f}</td></tr>""")
    return f"""<table><thead><tr><th>SNS</th><th>日時</th><th>形式</th><th>投稿</th>
      <th class="num">エンゲージメント</th><th class="num">表示回数</th><th class="num">ER（表示比）</th><th class="num">指数</th></tr></thead>
      <tbody>{''.join(body)}</tbody></table>"""


INSIGHT_KIND = {"good": ("✓", "好調"), "warn": ("!", "要注意"), "info": ("i", "示唆")}


def _insight_items(items: list[dict], visible: int = 4) -> str:
    if not items:
        return '<p class="muted">データが不足しています。</p>'
    def li(i):
        icon, label = INSIGHT_KIND[i["kind"]]
        return (f'<li class="ins {i["kind"]}"><span class="badge {i["kind"]}"><span aria-hidden="true">{icon}</span>'
                f'{label}</span><span class="ins-text">{escape(i["text"])}</span></li>')
    # 注意 → 好調 → 示唆 の順に並べ、先頭だけ見せる
    order = {"warn": 0, "good": 1, "info": 2}
    items = sorted(items, key=lambda i: order[i["kind"]])
    head = "".join(li(i) for i in items[:visible])
    rest = items[visible:]
    more = (f'<details class="more"><summary>ほか{len(rest)}件を表示</summary><ul class="insights">'
            + "".join(li(i) for i in rest) + "</ul></details>") if rest else ""
    return f'<ul class="insights">{head}</ul>{more}'


def _insights(d: dict) -> str:
    return _insight_items(d["insights"])


PRIORITY = {"high": ("高", "warn"), "medium": ("中", "info"), "low": ("低", "flat")}


def _plabel(p: str) -> str:
    return "全体" if p == "all" else PLATFORM_LABELS.get(p, p)


def _ai_section(d: dict) -> str:
    ai = d.get("ai")
    if not ai:
        return ""
    e = escape
    meta = ai["_meta"]
    qa = ""
    if ai.get("question_answer"):
        qa = (f'<div class="card ai-qa"><h3>ご質問：{e(meta.get("question", ""))}</h3>'
              f'<p>{e(ai["question_answer"])}</p></div>')
    plats = "".join(
        f'<div class="card"><h3>{_chip(p["platform"]) if p["platform"] != "all" else "全体"}</h3>'
        f'<p>{e(p["assessment"])}</p><ul class="pn">'
        + "".join(f'<li class="plus"><span aria-label="強み">＋</span>{e(x)}</li>' for x in p["strengths"])
        + "".join(f'<li class="minus"><span aria-label="課題">－</span>{e(x)}</li>' for x in p["issues"])
        + "</ul></div>" for p in ai["platforms"])
    content = "".join(
        f'<div class="card"><h3>{e(c["title"])}</h3><p>{e(c["detail"])}</p>'
        f'<p class="evidence">根拠：{e(c["evidence"])}</p></div>' for c in ai["content_insights"])
    comp = "".join(
        f'<div class="card"><div class="idea-head">{e(c["competitor"])}</div><h3>{e(c["observation"])}</h3>'
        f'<p>→ {e(c["takeaway"])}</p></div>' for c in ai.get("competitor_insights", []))
    comp = f'<h2 class="h3">競合から学べること</h2><div class="grid wide">{comp}</div>' if comp else ""
    recs = "".join(
        f'<tr><td><span class="pri {PRIORITY[r["priority"]][1]}">{PRIORITY[r["priority"]][0]}</span></td>'
        f'<td class="nowrap">{e(_plabel(r["platform"]))}</td><td class="strong-text">{e(r["action"])}</td>'
        f'<td>{e(r["reason"])}</td><td>{e(r["expected_effect"])}</td></tr>' for r in ai["recommendations"])
    ideas = "".join(
        f'<div class="card idea"><div class="idea-head">{e(_plabel(i["platform"]))} ・ {e(i["format"])}'
        f'<span class="muted"> ／ {e(i["suggested_timing"])}</span></div><h3>{e(i["idea"])}</h3>'
        f'<pre class="copy">{e(i["sample_copy"])}</pre></div>' for i in ai["post_ideas"])
    kpis = "".join(
        f'<tr><td class="nowrap">{e(_plabel(k["platform"]))}</td><td>{e(k["metric"])}</td>'
        f'<td class="num">{e(k["current"])}</td><td class="num strong">{e(k["target"])}</td>'
        f'<td>{e(k["rationale"])}</td></tr>' for k in ai["kpi_targets"])
    return f"""
  <section aria-labelledby="h-ai" class="ai">
    <h2 id="h-ai">AI分析 <span class="badge">Claude</span></h2>
    <p class="sub">{'投稿本文と数値' if meta.get("post_text_sent", True) else '数値のみ（投稿本文は送信していません）'}をもとに Claude が分析（{e(meta["model"])}、{e(meta["generated_at"])}、投稿{meta["posts_sent"]}件）。{f'送信の同意：{e(meta["consent_by"])}（{e(meta["consent_at"][:10].replace("-", "/"))}）。' if meta.get("consent_by") else ''}提案は仮説として検証しながら活用してください。</p>
    <div class="card ai-lead"><p class="ai-headline">{e(ai["headline"])}</p><p>{e(ai["summary"])}</p></div>
    {qa}
    <h2 class="h3">SNS別の評価</h2><div class="grid wide">{plats}</div>
    <h2 class="h3">投稿内容から見えたこと</h2><div class="grid wide">{content}</div>
    {comp}
    <h2 class="h3">改善提案</h2>
    <div class="card scroll"><table><thead><tr><th>優先度</th><th>SNS</th><th>アクション</th><th>理由</th><th>期待効果</th></tr></thead><tbody>{recs}</tbody></table></div>
    <h2 class="h3">投稿アイデア</h2><div class="grid wide">{ideas}</div>
    <h2 class="h3">来期のKPI目標</h2>
    <div class="card scroll"><table><thead><tr><th>SNS</th><th>指標</th><th class="num">現状</th><th class="num">目標</th><th>根拠</th></tr></thead><tbody>{kpis}</tbody></table></div>
  </section>"""


def _rank(r: dict, key: str) -> str:
    rk = r.get("rank", {}).get(key)
    return f'<span class="rank">{rk[0]}位</span>' if rk else ""


def _competitor_section(d: dict) -> str:
    c = d.get("competitors")
    if not c or not c["platforms"]:
        return ""
    e = escape
    tabs, tables = [], []
    for i, (platform, blk) in enumerate(c["platforms"].items()):
        rows = blk["rows"]
        mx = max((r["er_followers"] or 0 for r in rows), default=0) or 1
        body = []
        for r in rows:
            fd = r["followers_delta"]
            mix = "・".join(f"{k} {v * 100:.0f}%" for k, v in list(r["media_mix"].items())[:3])
            no_posts = not r["has_posts"]
            body.append(f"""<tr class="{'own' if r['is_own'] else ''}">
              <th scope="row">{e(r['name'])}<div class="muted">{('@' + e(r['username'])) if r['username'] else ''}</div></th>
              <td class="num">{_n(r['followers'])} {_rank(r, 'followers')}</td>
              <td class="num">{'—' if fd is None else f'{fd:+,}'}<div class="muted">{_pct(r['followers_growth'], 1)}</div></td>
              <td class="num">{'—' if r['posts_per_week'] is None else f"{r['posts_per_week']:.1f}"}</td>
              <td class="num">{_n(r['avg_eng'])}</td>
              <td class="bar-cell">{'<span class="muted">投稿データなし</span>' if no_posts else
                f'<span class="bar" style="width:{(r["er_followers"] or 0) / mx * 100:.1f}%;background:var(--c-{platform})"></span><span class="bar-val">{_pct(r["er_followers"])}</span> {_rank(r, "er_followers")}'}</td>
              <td class="small">{e(mix) or '—'}</td>
              <td class="small">{e(r['best_type'] or '—')}</td>
              <td class="small">{e(r['top_slot'] or '—')}</td>
              <td class="small">{' '.join('#' + e(t) for t in r['top_tags']) or '—'}</td></tr>""")
        tabs.append(f'<button type="button" class="tab" aria-pressed="{str(i == 0).lower()}" '
                    f'data-comp="{platform}">{PLATFORM_LABELS[platform]}</button>')
        tables.append(f"""<div data-comp-table="{platform}"{'' if i == 0 else ' hidden'}>
          <table><thead><tr><th>アカウント</th><th class="num">フォロワー</th><th class="num">期間増減</th>
          <th class="num">投稿/週</th><th class="num">平均反応</th><th>反応率（フォロワー比）</th>
          <th>形式の内訳</th><th>最も反応の良い形式</th><th>よく投稿する枠</th><th>よく使うタグ</th></tr></thead>
          <tbody>{''.join(body)}</tbody></table>
          <p class="note">反応＝{e(blk['metric_label'])}（競合と条件をそろえるため公開値のみで算出）。</p></div>""")
    top = "".join(f"""<tr><td class="nowrap">{e(t['competitor'])}</td><td>{_chip(t['platform'])}</td>
        <td class="nowrap">{t['date']}</td><td class="nowrap">{e(t['media'])}</td>
        <td class="post-text">{f'<a href="{e(t["permalink"])}" target="_blank" rel="noopener">' if t['permalink'] else ''}{e(t['text'][:80])}{'</a>' if t['permalink'] else ''}</td>
        <td class="num">{_n(t['engagements'])}</td><td class="num strong">{_pct(t['er_followers'])}</td></tr>"""
                  for t in c["top_posts"])
    ins = _insight_items(c["insights"], visible=5) if c["insights"] else ""
    return f"""
  <section aria-labelledby="h-comp">
    <h2 id="h-comp">競合比較</h2>
    <p class="sub">同じ期間の自社と競合アカウントの比較。フォロワー増減は、競合の記録を始めてからの期間のみ表示されます。</p>
    {f'<div class="card">{ins}</div>' if ins else ''}
    <div class="card scroll" style="margin-top:12px">
      <div class="tabs" role="group" aria-label="SNSを選択">{''.join(tabs)}</div>
      {''.join(tables)}
    </div>
    {f"""<h2 class="h3">競合で反応の良かった投稿</h2>
    <div class="card scroll"><table><thead><tr><th>競合</th><th>SNS</th><th>日時</th><th>形式</th><th>投稿</th>
      <th class="num">反応</th><th class="num">フォロワー比</th></tr></thead><tbody>{top}</tbody></table></div>""" if top else ''}
  </section>"""


def _pages(d: dict) -> list[tuple[str, str]]:
    """(ページID, タブ名)。データがないページは出さない。"""
    pages = [("overview", "概要")]
    if d.get("ai"):
        pages.append(("ai", "AI分析"))
    pages.append(("compare", "SNS比較"))
    if d.get("competitors") and d["competitors"]["platforms"]:
        pages.append(("competitors", "競合比較"))
    pages += [("timing", "投稿時間"), ("content", "形式・タグ"), ("posts", "投稿ランキング")]
    return pages


def _sidebar(d: dict, pages: list[tuple[str, str]], title: str) -> str:
    per = d["period"]
    links = "".join(f'<a href="#p-{k}" data-page-link="{k}">{label}</a>' for k, label in pages)
    items = [f'<button type="button" class="btn sm" data-download="{escape(n)}">{DOWNLOAD_LABELS.get(n, n)}</button>'
             for n in d.get("downloads", {})]
    dl = (f'<details class="menu"><summary class="btn sm">データをダウンロード</summary>'
          f'<div class="menu-panel">{"".join(items)}</div></details>') if items else ""
    return f"""<aside class="side no-print" aria-label="レポートの目次">
  <div class="side-head">
    <p class="eyebrow">SNS分析レポート</p>
    <p class="side-title">{escape(d.get('client_name') or 'レポート')}</p>
    <p class="side-meta">{per['start'].replace('-', '/')}〜{per['end'][5:].replace('-', '/')}<br>{per['days']}日間・前期間と比較</p>
  </div>
  <nav class="side-nav" aria-label="ページ">{links}</nav>
  <div class="side-actions">
    <button type="button" class="btn sm" onclick="window.print()">PDFで保存・印刷</button>
    {dl}
  </div>
</aside>"""


def _page_head(d: dict, label: str, lead: str) -> str:
    per = d["period"]
    return f"""<header class="page-head">
    <p class="eyebrow">{escape(d.get('client_name') or 'SNS分析レポート')} ・ {per['start'].replace('-', '/')}〜{per['end'].replace('-', '/')}</p>
    <h1>{label}</h1>
    <p class="lead">{lead}</p>
  </header>"""


PAGE_LEADS = {
    "overview": "期間全体の結果と、まず押さえるべきポイントです。",
    "ai": "投稿本文と数値をもとに、Claude が改善策と投稿アイデアを提案します。",
    "compare": "規模の違うSNSを、フォロワーあたり・表示あたりの反応でそろえて比べます。",
    "competitors": "競合アカウントと、公開されている数値だけで条件をそろえて比べます。",
    "timing": "どの曜日・時間帯の投稿が反応を得ているか。",
    "content": "どの投稿形式・ハッシュタグが効いているか。",
    "posts": "SNSの規模差を補正した「パフォーマンス指数」で並べた上位投稿です。",
}


def _strip_head(section: str) -> str:
    """ページ見出しと重複するセクション先頭の h2 / 説明文を取り除く。"""
    section = re.sub(r"<h2 id=\"h-(ai|comp)\">.*?</h2>\s*", "", section, count=1, flags=re.S)
    return re.sub(r"<p class=\"sub\">.*?</p>", lambda m: f'<p class="note-top">{m.group(0)[15:-4]}</p>', section, count=1, flags=re.S)


def _pages_html(d: dict, pages: list[tuple[str, str]]) -> str:
    content = {
        "overview": f"""
  <section aria-label="主要指標">{_hero(d)}</section>
  <section aria-labelledby="h-ins">
    <h2 id="h-ins">今期のポイント</h2>
    <div class="card">{_insights(d)}</div>
  </section>
  <section aria-labelledby="h-kpi">
    <h2 id="h-kpi">SNS別</h2>
    <p class="sub">ER＝エンゲージメント率（いいね・コメント・シェア・保存・引用 ÷ フォロワー数 または 表示回数）。矢印は前期間比。</p>
    {_platform_cards(d)}
  </section>
  <section aria-labelledby="h-trend">
    <h2 id="h-trend">エンゲージメント推移</h2>
    <p class="sub">投稿日ごとのエンゲージメント合計（SNS別の積み上げ）。凡例をクリックで表示を切り替えられます。</p>
    <div class="card"><div class="chart-box"><canvas id="trend" role="img" aria-label="日別エンゲージメント推移のグラフ。数値は下の表で確認できます"></canvas></div>
      <details class="more"><summary>表で見る（週ごとの合計）</summary><div class="scroll">{_trend_table(d)}</div></details></div>
  </section>""",
        "ai": _strip_head(_ai_section(d)),
        "compare": f"""
  <section><div class="card flush scroll">{_compare_table(d)}</div></section>""",
        "competitors": _strip_head(_competitor_section(d)),
        "timing": f"""
  <section aria-labelledby="h-heat">
    <h2 id="h-heat">曜日 × 時間帯</h2>
    <p class="sub">パフォーマンス指数の平均（100＝そのSNSの普段の投稿、200＝2倍の反応）。空欄は投稿なし。</p>
    <div class="card">{_heatmaps(d)}</div>
  </section>""",
        "content": f"""
  <section aria-labelledby="h-media">
    <h2 id="h-media">投稿形式別</h2>
    <p class="sub">形式ごとの平均パフォーマンス指数。</p>
    <div class="card flush scroll">{_media_table(d)}</div>
  </section>
  <section aria-labelledby="h-tags">
    <h2 id="h-tags">ハッシュタグ</h2>
    <p class="sub">2回以上使ったタグの平均パフォーマンス指数（上位15）。</p>
    <div class="card flush scroll">{_hashtag_table(d)}</div>
  </section>""",
        "posts": f"""
  <section><div class="card flush scroll">{_top_posts(d)}</div></section>""",
    }
    out = []
    for i, (key, label) in enumerate(pages):
        prev_link = f'<a href="#p-{pages[i - 1][0]}"><small>前へ</small>{pages[i - 1][1]}</a>' if i > 0 else "<span></span>"
        next_link = (f'<a class="next" href="#p-{pages[i + 1][0]}"><small>次へ</small>{pages[i + 1][1]}</a>'
                     if i < len(pages) - 1 else "<span></span>")
        out.append(f"""<div class="page" id="p-{key}" tabindex="-1">
  {_page_head(d, label, PAGE_LEADS.get(key, ''))}
  {content[key]}
  <nav class="pager no-print" aria-label="前後のページ">{prev_link}{next_link}</nav>
</div>""")
    return "\n".join(out)

DOWNLOAD_LABELS = {
    "posts.csv": "投稿データ（CSV）", "summary.csv": "サマリー（CSV）",
    "media_types.csv": "形式別（CSV）", "hashtags.csv": "ハッシュタグ（CSV）",
    "competitors.csv": "競合比較（CSV）", "competitor_posts.csv": "競合の投稿（CSV）",
    "ai_analysis.md": "AI分析（Markdown）",
}


def render_html(d: dict) -> str:
    per = d["period"]
    title = f"SNS分析レポート｜{d['client_name']}" if d.get("client_name") else "SNS分析レポート"
    pages = _pages(d)
    slug = (d.get("client_id") or "sns") + f"_{per['end']}_{per['days']}d"
    data_json = json.dumps({"daily": d["daily"], "platforms": d["platforms"],
                            "labels": PLATFORM_LABELS, "files": d.get("downloads", {}),
                            "slug": slug}, ensure_ascii=False).replace("</", "<\\/")
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<style>{REPORT_CSS}</style>
</head>
<body>
<a class="skip" href="#main">本文へスキップ</a>
<div class="shell">
{_sidebar(d, pages, title)}
<main class="content" id="main" tabindex="-1">
{_pages_html(d, pages)}
  <footer class="foot">SNS Analyzer で生成（{d['generated_at']}）。パフォーマンス指数＝投稿のエンゲージメント÷同じSNSの期間内中央値×100。<br>
    本ツールは Meta Platforms, Inc. および X Corp. が提供・承認するものではありません。各サービス名は各社の商標です。</footer>
</main>
</div>
<script id="report-data" type="application/json">{data_json}</script>
<script src="{CHART_JS}"></script>
<script>
(() => {{
  const D = JSON.parse(document.getElementById('report-data').textContent);
  const pages = [...document.querySelectorAll('.page')];
  const links = [...document.querySelectorAll('[data-page-link]')];
  document.documentElement.classList.add('paged');
  const baseTitle = document.title;
  function showPage(scroll, forced) {{
    const id = forced || decodeURIComponent(location.hash.slice(1));
    const target = pages.find(p => p.id === id) || pages[0];
    pages.forEach(p => p.classList.toggle('active', p === target));
    links.forEach(a => a.setAttribute('aria-current', a.dataset.pageLink === target.id.slice(2) ? 'page' : 'false'));
    const cur = links.find(a => a.dataset.pageLink === target.id.slice(2));
    if (cur && matchMedia('(max-width: 960px)').matches) cur.scrollIntoView({{ block: 'nearest', inline: 'center' }});
    document.querySelectorAll('details.menu[open]').forEach(m => m.open = false);
    const h1 = target.querySelector('h1');
    document.title = (h1 ? h1.textContent + '｜' : '') + baseTitle;
    if (scroll) {{ window.scrollTo({{ top: 0, behavior: 'instant' }}); if (h1) {{ h1.setAttribute('tabindex', '-1'); h1.focus({{ preventScroll: true }}); }} }}
  }}
  // ページ内リンクは JS で切り替え（URL の #p-xxx も更新し、戻る／進むに対応）
  document.addEventListener('click', ev => {{
    const a = ev.target.closest('a[href^="#p-"]');
    if (!a) return;
    ev.preventDefault();
    const id = a.getAttribute('href').slice(1);
    try {{ history.pushState(null, '', '#' + id); }} catch (err) {{}}
    showPage(true, id);
  }});
  window.addEventListener('popstate', () => showPage(true));
  window.addEventListener('hashchange', () => showPage(true));
  showPage(false);
  window.addEventListener('beforeprint', () => document.documentElement.classList.remove('paged'));
  window.addEventListener('afterprint', () => document.documentElement.classList.add('paged'));
  document.querySelectorAll('[data-heat]').forEach(btn => btn.addEventListener('click', () => {{
    document.querySelectorAll('[data-heat]').forEach(b => b.setAttribute('aria-pressed', b === btn));
    document.querySelectorAll('[data-heat-table]').forEach(t => t.hidden = t.dataset.heatTable !== btn.dataset.heat);
  }}));
  document.querySelectorAll('[data-comp]').forEach(btn => btn.addEventListener('click', () => {{
    document.querySelectorAll('[data-comp]').forEach(b => b.setAttribute('aria-pressed', b === btn));
    document.querySelectorAll('[data-comp-table]').forEach(t => t.hidden = t.dataset.compTable !== btn.dataset.comp);
  }}));
  document.querySelectorAll('[data-download]').forEach(btn => btn.addEventListener('click', () => {{
    const name = btn.dataset.download, body = D.files[name];
    const isCsv = name.endsWith('.csv');
    const blob = new Blob([(isCsv ? '\ufeff' : '') + body],
      {{ type: isCsv ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8' }});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${{D.slug}}_${{name}}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }}));
  document.addEventListener('keydown', ev => {{
    if (ev.key !== 'Escape') return;
    document.querySelectorAll('details.menu[open]').forEach(m => {{ m.open = false; m.querySelector('summary').focus(); }});
  }});
  document.addEventListener('click', ev => document.querySelectorAll('details.menu[open]').forEach(m => {{
    if (!m.contains(ev.target)) m.open = false;
  }}));
  if (!window.Chart) return;  // オフライン時は表のみ
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const charts = [];
  const fmt = v => v == null ? '—' : Number(v).toLocaleString('ja-JP');
  function draw() {{
    charts.splice(0).forEach(c => c.destroy());
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = css('--text-2'); Chart.defaults.font.size = 14;
    Chart.defaults.animation = matchMedia('(prefers-reduced-motion: reduce)').matches ? false : Chart.defaults.animation;
    const grid = css('--grid'), surface = css('--surface');
    charts.push(new Chart(document.getElementById('trend'), {{
      type: 'bar',
      data: {{
        labels: D.daily.dates.map(s => s.slice(5).replace('-', '/')),
        datasets: D.platforms.map(p => ({{
          label: D.labels[p], data: D.daily[p].engagements,
          backgroundColor: css('--c-' + p), borderColor: surface, borderWidth: {{top: 2}},
          borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 18,
        }})),
      }},
      options: {{
        maintainAspectRatio: false, interaction: {{ mode: 'index', intersect: false }},
        scales: {{ x: {{ stacked: true, grid: {{ display: false }}, ticks: {{ maxRotation: 0, autoSkipPadding: 12 }} }},
                   y: {{ stacked: true, grid: {{ color: grid }}, border: {{ display: false }}, ticks: {{ callback: fmt }} }} }},
        plugins: {{ legend: {{ position: 'top', align: 'start', labels: {{ boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 5, color: css('--text') }} }},
                    tooltip: {{ callbacks: {{ label: c => `${{c.dataset.label}}: ${{fmt(c.raw)}}（${{D.daily[D.platforms[c.datasetIndex]].posts[c.dataIndex]}}件）` }} }} }},
      }},
    }}));
    document.querySelectorAll('[data-spark]').forEach(cv => {{
      const p = cv.dataset.spark, vals = D.daily[p].followers;
      if (!vals.some(v => v != null)) return;
      charts.push(new Chart(cv, {{
        type: 'line',
        data: {{ labels: D.daily.dates, datasets: [{{ data: vals, borderColor: css('--c-' + p), borderWidth: 2,
                 pointRadius: 0, pointHoverRadius: 4, tension: 0.3, spanGaps: true }}] }},
        options: {{ maintainAspectRatio: false, animation: false,
          interaction: {{ mode: 'index', intersect: false }},
          scales: {{ x: {{ display: false }}, y: {{ display: false }} }},
          plugins: {{ legend: {{ display: false }},
            tooltip: {{ displayColors: false, callbacks: {{ label: c => `フォロワー ${{fmt(c.raw)}}` }} }} }} }},
      }}));
    }});
  }}
  draw();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
}})();
</script>
</body>
</html>
"""


def write_report(d: dict, path: str | Path) -> Path:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_html(d), encoding="utf-8")
    return out


def render_overview(entries: list[dict], generated_at: str) -> str:
    """クライアント一覧ページ。entries: {id, name, data, report(相対パス)}"""
    rows = []
    for e in entries:
        d = e["data"]
        t = d["total"] if d else None
        chips = " ".join(_chip(p) for p in (d["platforms"] if d else []))
        followers = sum((d["summary"][p]["followers"] or 0) for p in d["platforms"]) if d else None
        link = (f'<a href="{escape(e["report"])}">{escape(e["name"])}</a>' if e.get("report")
                else escape(e["name"]))
        rows.append(f"""<tr><td class="strong-text">{link}<div class="muted">{escape(e['id'])}</div></td>
          <td>{chips or '<span class="muted">未接続</span>'}</td>
          <td class="num">{_n(followers)}</td><td class="num">{_n(t['posts']) if t else '—'}</td>
          <td class="num">{_n(t['engagements']) if t else '—'} {_delta(t['change'].get('engagements')) if t else ''}</td>
          <td>{escape(e.get('note', ''))}</td></tr>""")
    return f"""<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>クライアント一覧</title>
<style>
:root {{ color-scheme: light; --bg:#f6f6f4; --surface:#fcfcfb; --border:#e4e3df; --grid:#ecebe7; --text:#0b0b0b; --text-2:#52514e; --muted:#7a7974;
  --good:#0f7b3f; --warn:#b3261e; --c-facebook:#2a78d6; --c-instagram:#eb6834; --c-threads:#1baf7a; --c-x:#eda100; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ color-scheme: dark; --bg:#121211; --surface:#1a1a19; --border:#2e2e2c; --grid:#262624;
  --text:#fff; --text-2:#c3c2b7; --muted:#8e8d86; --good:#6fd39a; --warn:#ff8a80; --c-facebook:#3987e5; --c-instagram:#d95926; --c-threads:#199e70; --c-x:#c98500; }} }}
:root[data-theme="dark"] {{ color-scheme: dark; --bg:#121211; --surface:#1a1a19; --border:#2e2e2c; --grid:#262624;
  --text:#fff; --text-2:#c3c2b7; --muted:#8e8d86; --good:#6fd39a; --warn:#ff8a80; --c-facebook:#3987e5; --c-instagram:#d95926; --c-threads:#199e70; --c-x:#c98500; }}
body {{ margin:0; background:var(--bg); color:var(--text); font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif; }}
main {{ max-width:1100px; margin:0 auto; padding:24px 16px 64px; }}
h1 {{ font-size:24px; margin:0 0 4px; }} p {{ color:var(--text-2); margin:0 0 16px; }}
.card {{ background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:8px 16px; overflow-x:auto; }}
table {{ width:100%; border-collapse:collapse; font-size:14px; }}
th,td {{ padding:10px 8px; border-bottom:1px solid var(--grid); text-align:left; vertical-align:middle; }}
thead th {{ color:var(--text-2); font-size:13px; white-space:nowrap; }}
tbody tr:last-child td {{ border-bottom:0; }}
.num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
.strong-text {{ font-weight:600; }} .strong-text a {{ color:inherit; }} .muted {{ color:var(--muted); font-size:12px; font-weight:400; }}
.chip {{ display:inline-flex; align-items:center; gap:4px; white-space:nowrap; font-size:13px; margin-right:6px; }}
.dot {{ display:inline-block; width:9px; height:9px; border-radius:50%; }}
.delta {{ font-size:12px; margin-left:4px; }} .delta.up {{ color:var(--good); }} .delta.down {{ color:var(--warn); }} .delta.flat {{ color:var(--muted); }}
</style></head><body><main>
<h1>クライアント一覧</h1>
<p>{len(entries)}件 ／ 各クライアントの直近レポートへのリンク ／ 作成：{escape(generated_at)}</p>
<div class="card"><table><thead><tr><th>クライアント</th><th>接続中のSNS</th><th class="num">フォロワー合計</th>
<th class="num">投稿数</th><th class="num">エンゲージメント</th><th>備考</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>
</main></body></html>
"""
