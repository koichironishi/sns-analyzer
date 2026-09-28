"""共通デザイントークンとコンポーネントCSS（レポートとWebアプリで共有）。

トンマナ「静かな計器盤」
- 無彩色の地に、操作を示すアクセント1色（青）。SNS固有色はデータの識別にだけ使う
- 数字は等幅数字。結論（大きな数字）→ 根拠（表・グラフ）の順
- 文字サイズ比 約1.2 / 余白スケール 4・8・12・16・24・32・48
- 本文 4.5:1、大きな文字・非テキスト 3:1 以上のコントラスト。タップ領域 40px 以上
"""

TOKENS = """
:root {
  color-scheme: light;
  --bg: #f5f5f3; --surface: #ffffff; --surface-2: #f0efec; --border: #e3e2de; --grid: #eceae6;
  --text: #111110; --text-2: #4d4c48; --muted: #6b6a65;
  --accent: #1a64bd; --accent-bg: #e8f1fc; --on-accent: #ffffff;
  --border-strong: #8a8984; --focus-ring: #111110; --focus-halo: #ffd43b;
  --good: #0f7b3f; --good-bg: #e5f4eb; --warn: #b3261e; --warn-bg: #fcebe8; --info: #1c5cab; --info-bg: #e8f1fc;
  --c-facebook: #2a78d6; --c-instagram: #eb6834; --c-threads: #1baf7a; --c-x: #eda100;
  --seq: #2a78d6;
  --h1: #cde2fb; --h2: #b7d3f6; --h3: #9ec5f4; --h4: #6da7ec; --h5: #3987e5; --h6: #256abf; --h7: #104281;
  --shadow: 0 1px 2px rgba(17,17,16,.04), 0 1px 1px rgba(17,17,16,.03);
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
  --r-sm: 6px; --r-md: 10px; --r-lg: 14px;
  --fs-xs: 14px; --fs-sm: 14px; --fs-table: 14px; --fs-md: 16px; --fs-base: 16px; --fs-lg: 19px; --fs-xl: 23px; --fs-2xl: 28px; --fs-3xl: 34px;
  --font: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #111110; --surface: #1a1a19; --surface-2: #232321; --border: #2f2f2c; --grid: #272725;
    --text: #f5f5f2; --text-2: #c9c8be; --muted: #9a998f;
    --accent: #6da7ec; --accent-bg: #172a42; --on-accent: #0b0b0b;
    --border-strong: #75746e; --focus-ring: #ffffff; --focus-halo: #b88a00;
    --good: #6fd39a; --good-bg: #15301f; --warn: #ff8a80; --warn-bg: #3a1a17; --info: #86b6ef; --info-bg: #172a42;
    --c-facebook: #3987e5; --c-instagram: #d95926; --c-threads: #199e70; --c-x: #c98500;
    --seq: #3987e5; --shadow: none;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111110; --surface: #1a1a19; --surface-2: #232321; --border: #2f2f2c; --grid: #272725;
  --text: #f5f5f2; --text-2: #c9c8be; --muted: #9a998f;
  --accent: #6da7ec; --accent-bg: #172a42; --on-accent: #0b0b0b;
  --border-strong: #75746e; --focus-ring: #ffffff; --focus-halo: #b88a00;
  --good: #6fd39a; --good-bg: #15301f; --warn: #ff8a80; --warn-bg: #3a1a17; --info: #86b6ef; --info-bg: #172a42;
  --c-facebook: #3987e5; --c-instagram: #d95926; --c-threads: #199e70; --c-x: #c98500;
  --seq: #3987e5; --shadow: none;
}
"""

BASE = """
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: var(--fs-base)/1.7 var(--font);
  font-feature-settings: "palt" 0; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; box-shadow: 0 0 0 4px var(--focus-halo); }
.skip { position: absolute; left: 8px; top: -100px; z-index: 100; padding: 12px 16px; background: var(--surface);
  color: var(--text); border-radius: var(--r-md); font-weight: 700; }
.skip:focus { top: 8px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important;
  scroll-behavior: auto !important; } }
h1, h2, h3 { line-height: 1.4; font-weight: 700; letter-spacing: .01em; }
.num, .tnum { font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.sub { color: var(--text-2); font-size: var(--fs-sm); margin: 0 0 var(--s4); }
.nowrap { white-space: nowrap; }
.strong { font-weight: 700; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* カード */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  padding: var(--s5); box-shadow: var(--shadow); }
.card.flush { padding: 0; overflow: hidden; }
.card > :first-child { margin-top: 0; }
.card > :last-child { margin-bottom: 0; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; position: relative; }  /* 読み上げ専用テキストをはみ出させない */

/* ボタン */
.btn { font: inherit; font-size: var(--fs-md); font-weight: 600; line-height: 1.2; min-height: 44px;
  padding: 10px 16px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--surface);
  color: var(--text); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  text-decoration: none; transition: background .12s, border-color .12s; }
.btn:hover { background: var(--surface-2); text-decoration: none; }
.btn:active { transform: translateY(1px); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: .45; cursor: not-allowed; transform: none; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn.primary:hover { filter: brightness(1.08); background: var(--accent); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--text-2); }
.btn.ghost:hover { background: var(--surface-2); color: var(--text); }
.btn.danger { color: var(--warn); border-color: currentColor; background: transparent; }
.btn.danger:hover { background: var(--warn-bg); }
.btn.block { width: 100%; justify-content: flex-start; }
.btn.sm { min-height: 44px; padding: 8px 14px; font-size: var(--fs-sm); }

/* セグメント切替（SNS 切替など） */
.tabs { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; background: var(--surface-2);
  border-radius: var(--r-md); margin-bottom: var(--s4); }
.tab { font: inherit; font-size: var(--fs-sm); font-weight: 600; min-height: 44px; min-width: 44px; padding: 8px 16px; border: 0;
  border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; }
.tab:hover { color: var(--text); }
.tab[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow), 0 0 0 1px var(--border); }

/* チップ・バッジ */
.chip { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: var(--fs-md); }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; }
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); font-weight: 700;
  padding: 2px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); white-space: nowrap; }
.badge.good { background: var(--good-bg); color: var(--good); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.info { background: var(--info-bg); color: var(--info); }

/* 増減 */
.delta { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; }
.delta.up { color: var(--good); } .delta.down { color: var(--warn); } .delta.flat { color: var(--muted); }

/* 表 */
table { width: 100%; border-collapse: collapse; font-size: var(--fs-table); }
th, td { padding: 12px; border-bottom: 1px solid var(--grid); text-align: left; vertical-align: middle; }
thead th { font-size: var(--fs-xs); font-weight: 700; color: var(--text-2); letter-spacing: .02em;
  border-bottom: 1px solid var(--border); white-space: nowrap; background: var(--surface); }
tbody tr:last-child > * { border-bottom: 0; }
tbody tr:hover > * { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
.card.flush table th:first-child, .card.flush table td:first-child { padding-left: var(--s5); }
.card.flush table th:last-child, .card.flush table td:last-child { padding-right: var(--s5); }
th.num, td.num { text-align: right; white-space: nowrap; }

/* フォーム */
label { display: block; font-size: var(--fs-sm); font-weight: 600; color: var(--text-2); margin: var(--s4) 0 6px; }
input[type=text], input[type=password], select, textarea { font: inherit; font-size: var(--fs-base); width: 100%;
  max-width: 440px; min-height: 44px; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: var(--r-md);
  background: var(--surface); color: var(--text); }
input:focus-visible, select:focus-visible, textarea:focus-visible { border-color: var(--focus-ring); }
textarea { max-width: 100%; min-height: 88px; }
.hint { font-size: var(--fs-sm); color: var(--muted); margin: 6px 0 0; }
.checks { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); }
.checks label, label.check { display: inline-flex; gap: 8px; align-items: center; margin: 0; font-weight: 400;
  color: var(--text); font-size: var(--fs-md); min-height: 44px; cursor: pointer; }
input[type=checkbox] { width: 20px; height: 20px; accent-color: var(--accent); }
.req { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 4px; font-size: var(--fs-xs);
  font-weight: 700; color: var(--warn); background: var(--warn-bg); vertical-align: 1px; }

/* 通知 */
.msg { display: flex; gap: 10px; align-items: flex-start; padding: 12px 16px; border-radius: var(--r-md);
  margin-bottom: var(--s5); background: var(--info-bg); color: var(--text); font-size: var(--fs-md); }
.msg::before { content: "i"; font-weight: 700; color: var(--info); }
.msg.error { background: var(--warn-bg); } .msg.error::before { content: "!"; color: var(--warn); }
.msg.ok { background: var(--good-bg); } .msg.ok::before { content: "✓"; color: var(--good); }

/* 折りたたみメニュー */
details.menu { position: relative; }
details.menu > summary { list-style: none; }
details.menu > summary::-webkit-details-marker { display: none; }
details.menu[open] > summary { background: var(--surface-2); }
.menu-panel { position: absolute; z-index: 30; min-width: 240px; margin-top: 6px; padding: 6px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
  box-shadow: 0 8px 24px rgba(0,0,0,.12); display: grid; gap: 2px; }
.menu-panel.up { bottom: 100%; margin: 0 0 6px; }
.menu-panel .btn { justify-content: flex-start; border-color: transparent; font-weight: 500; }

/* アプリバー（Webアプリ・レポートで共通） */
.app-bar { background: var(--surface); border-bottom: 1px solid var(--border); }
.app-bar-in { max-width: 1280px; margin: 0 auto; padding: 0 var(--s5); min-height: 56px; display: flex;
  gap: var(--s2); align-items: center; flex-wrap: wrap; }
.app-brand { font-weight: 800; font-size: var(--fs-md); min-height: 44px; color: var(--text); text-decoration: none; margin-right: var(--s4);
  display: inline-flex; align-items: center; gap: 8px; letter-spacing: .02em; }
.app-brand::before { content: ""; width: 18px; height: 18px; border-radius: 5px;
  background: conic-gradient(var(--c-instagram) 0 25%, var(--c-facebook) 0 50%, var(--c-threads) 0 75%, var(--c-x) 0); }
.app-nav { display: flex; gap: 2px; flex-wrap: wrap; }
.app-nav a { font-size: var(--fs-md); color: var(--text-2); text-decoration: none; padding: 8px 12px;
  border-radius: 8px; min-height: 44px; display: inline-flex; align-items: center; }
.app-nav a:hover { background: var(--surface-2); color: var(--text); }
.app-nav a[aria-current="page"] { color: var(--text); font-weight: 700; background: var(--surface-2); }
.app-right { margin-left: auto; display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.who { font-size: var(--fs-sm); color: var(--muted); }
td a:not(.btn) { display: inline-block; padding: 4px 0; }  /* 表内リンクのターゲットを24px以上に */
@media (max-width: 600px) {
  .app-bar-in { padding: 4px var(--s4); gap: 4px var(--s2); }
  .app-brand { margin-right: 0; }
  .app-nav { order: 3; flex-basis: 100%; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;
    margin: 0 calc(var(--s4) * -1); padding: 0 var(--s4); }
  .app-nav::-webkit-scrollbar { display: none; }
  .app-nav a { flex: none; }
  .app-right { gap: 4px; }
  .app-right .acct-name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
"""
