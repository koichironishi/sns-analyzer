/**
 * 分析データのエクスポート（CSV / Markdown / ZIP）。Python 版 export.py の移植。
 * CSV は Excel でそのまま開けるよう UTF-8（BOM付き）・CRLF で出力する。
 */
import { WEEKDAYS, buildRows, median, type AnalysisResult } from "./analysis.ts";
import type { CompareResult } from "./compare.ts";
import { DEFAULT_TZ, MEDIA_LABELS, PLATFORM_LABELS, slashDate, type FollowerSeries, type Post } from "./models.ts";
import { PRIORITY_LABELS, platformLabel, type AiResult } from "./ai.ts";

export const BOM = "﻿";

type Cell = string | number | null | undefined;

function cell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // 表計算ソフトで数式として解釈されないようにする（CSV インジェクション対策）
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "" : `${(v * 100).toFixed(2)}%`);
const r1 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

export function postsCsv(data: AnalysisResult, posts: Post[], followers: FollowerSeries, tz = DEFAULT_TZ): string {
  const { start, end } = data.period;
  const rows = buildRows(posts, followers, tz).filter((r) => r.local.date >= start && r.local.date <= end);
  const med = new Map<string, number>();
  for (const p of new Set(rows.map((r) => r.post.platform))) {
    med.set(p, median(rows.filter((r) => r.post.platform === p).map((r) => r.engagements)) || 1);
  }
  rows.sort((a, b) => b.post.postedAt.localeCompare(a.post.postedAt));
  return toCsv(
    ["SNS", "投稿日時", "曜日", "形式", "本文", "URL", "表示回数", "リーチ", "いいね", "コメント", "シェア", "保存", "引用",
      "クリック", "エンゲージメント", "ER（表示比）", "ER（フォロワー比）", "パフォーマンス指数", "投稿ID"],
    rows.map((r) => {
      const m = r.post.metrics;
      const hm = `${String(r.local.hour).padStart(2, "0")}:${String(r.local.minute).padStart(2, "0")}`;
      return [PLATFORM_LABELS[r.post.platform], `${r.local.date} ${hm}`, WEEKDAYS[r.local.weekday],
        MEDIA_LABELS[r.post.mediaType] ?? r.post.mediaType, r.post.text, r.post.permalink, m.views, m.reach,
        m.likes, m.comments, m.shares, m.saves, m.quotes, m.clicks, r.engagements, pct(r.erViews), pct(r.erFollowers),
        Math.round((r.engagements / (med.get(r.post.platform) ?? 1)) * 100), r.post.externalId];
    }),
  );
}

export function summaryCsv(data: AnalysisResult): string {
  return toCsv(
    ["SNS", "アカウント", "フォロワー", "フォロワー増減", "フォロワー増加率", "投稿数", "投稿数（前期間）", "エンゲージメント",
      "エンゲージメント（前期間）", "エンゲージメント前期間比", "表示回数", "ER（フォロワー比）", "ER（フォロワー比・前期間）", "ER（表示比）"],
    data.platforms.map((p) => {
      const s = data.summary[p]!;
      return [s.label, s.account, s.followers, s.followersDelta, pct(s.followersGrowth), s.posts, s.prev.posts,
        s.engagements, s.prev.engagements, pct(s.change.engagements), s.views, pct(s.erFollowers), pct(s.prev.erFollowers), pct(s.erViews)];
    }),
  );
}

export function mediaCsv(data: AnalysisResult): string {
  return toCsv(["SNS", "形式", "件数", "平均エンゲージメント", "ER（表示比）", "平均パフォーマンス指数"],
    data.media.map((m) => [PLATFORM_LABELS[m.platform], m.label, m.count, r1(m.avgEngagements ?? 0), pct(m.erViews), Math.round(m.score ?? 0)]));
}

export function hashtagsCsv(data: AnalysisResult): string {
  return toCsv(["ハッシュタグ", "使用数", "SNS", "平均パフォーマンス指数"],
    data.hashtags.map((h) => [`#${h.tag}`, h.count, h.platforms.map((p) => PLATFORM_LABELS[p]).join(" / "), Math.round(h.score)]));
}

export function competitorsCsv(c: CompareResult): string {
  const rows: Cell[][] = [];
  for (const blk of Object.values(c.platforms)) {
    if (!blk) continue;
    for (const r of blk.rows) {
      rows.push([blk.label, r.name, r.username, r.followers, r.followersDelta, pct(r.followersGrowth), r.posts,
        r1(r.postsPerWeek), r1(r.avgEng), pct(r.erFollowers),
        r.mediaMix.map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" / "),
        r.bestType, r.topSlot, r.topTags.map((t) => `#${t}`).join(" "), blk.metricLabel]);
    }
  }
  return toCsv(["SNS", "アカウント", "ユーザー名", "フォロワー", "期間増減", "増加率", "投稿数", "投稿/週", "平均反応",
    "反応率（フォロワー比）", "形式の内訳", "最も反応の良い形式", "よく投稿する枠", "よく使うタグ", "反応の定義"], rows);
}

export function competitorPostsCsv(c: CompareResult): string {
  return toCsv(["競合", "SNS", "投稿日時", "形式", "本文", "URL", "反応", "反応率（フォロワー比）"],
    c.allPosts.map((t) => [t.competitor, PLATFORM_LABELS[t.platform], t.date, t.media, t.text, t.permalink, t.engagements, pct(t.erFollowers)]));
}

export function aiMarkdown(ai: AiResult, data: AnalysisResult, clientName = ""): string {
  const per = data.period;
  const out = [
    `# AI分析レポート${clientName ? `：${clientName}` : ""}`,
    `対象期間：${slashDate(per.start)}〜${slashDate(per.end)}（${per.days}日間）／ モデル：${ai._meta.model}`, "",
    `## ${ai.headline}`, "", ai.summary, "",
  ];
  if (ai.question_answer) out.push("## ご質問への回答", `> ${ai._meta.question}`, "", ai.question_answer, "");
  out.push("## SNS別の評価");
  for (const p of ai.platforms) {
    out.push(`### ${platformLabel(p.platform)}`, p.assessment, "",
      ...p.strengths.map((s) => `- 良い点：${s}`), ...p.issues.map((s) => `- 課題：${s}`), "");
  }
  out.push("## 投稿内容から見えたこと");
  for (const c of ai.content_insights) out.push(`### ${c.title}`, c.detail, `*根拠：${c.evidence}*`, "");
  if (ai.competitor_insights.length) {
    out.push("## 競合から学べること");
    for (const c of ai.competitor_insights) out.push(`### ${c.competitor}：${c.observation}`, `→ ${c.takeaway}`, "");
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  out.push("## 改善提案", "| 優先度 | SNS | アクション | 理由 | 期待効果 |", "|---|---|---|---|---|",
    ...ai.recommendations.map((r) => `| ${PRIORITY_LABELS[r.priority]} | ${platformLabel(r.platform)} | ${esc(r.action)} | ${esc(r.reason)} | ${esc(r.expected_effect)} |`),
    "", "## 投稿アイデア");
  for (const i of ai.post_ideas) {
    out.push(`### [${platformLabel(i.platform)} / ${i.format}] ${i.idea}`, `推奨タイミング：${i.suggested_timing}`, "", "```", i.sample_copy, "```", "");
  }
  out.push("## 次の期間のKPI目標", "| SNS | 指標 | 現状 | 目標 | 根拠 |", "|---|---|---|---|---|",
    ...ai.kpi_targets.map((k) => `| ${platformLabel(k.platform)} | ${esc(k.metric)} | ${esc(k.current)} | ${esc(k.target)} | ${esc(k.rationale)} |`));
  return out.join("\n").replace(/\r/g, "") + "\n";
}

export const DOWNLOAD_FILES = {
  "posts.csv": "投稿一覧",
  "summary.csv": "SNS別サマリー",
  "media_types.csv": "投稿形式別",
  "hashtags.csv": "ハッシュタグ",
  "competitors.csv": "競合比較",
  "competitor_posts.csv": "競合の投稿",
  "ai_analysis.md": "AI分析（Markdown）",
} as const;
export type DownloadName = keyof typeof DOWNLOAD_FILES;

/** ダウンロードできるファイル群（ファイル名 → 内容）。CSV には BOM を付ける */
export function downloads(data: AnalysisResult, posts: Post[], followers: FollowerSeries,
  competitors: CompareResult | null, ai: AiResult | null, clientName = "", tz = DEFAULT_TZ): Partial<Record<DownloadName, string>> {
  const files: Partial<Record<DownloadName, string>> = {
    "posts.csv": BOM + postsCsv(data, posts, followers, tz),
    "summary.csv": BOM + summaryCsv(data),
    "media_types.csv": BOM + mediaCsv(data),
    "hashtags.csv": BOM + hashtagsCsv(data),
  };
  if (competitors && Object.keys(competitors.platforms).length) {
    files["competitors.csv"] = BOM + competitorsCsv(competitors);
    files["competitor_posts.csv"] = BOM + competitorPostsCsv(competitors);
  }
  if (ai) files["ai_analysis.md"] = aiMarkdown(ai, data, clientName);
  return files;
}

// ---- ZIP（無圧縮・依存なし） -------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** 無圧縮（stored）の ZIP を作る。ファイル名は UTF-8（フラグ 0x0800） */
export function zip(files: Record<string, string | Uint8Array>, now = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const [time, date] = dosTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = typeof content === "string" ? enc.encode(content) : content;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true); ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}
