/**
 * CSV 取り込み（Python 版 importers.py の移植）。
 * API を使わない場合や、Meta Business Suite / X アナリティクスのエクスポートを取り込む場合に使う。
 * 列名は日本語・英語の代表的な表記を自動判別する。
 */
import { createHash } from "node:crypto";
import { DEFAULT_TZ, type MediaType } from "./models.ts";
import { metrics, type CollectedPost } from "./collectors/http.ts";

const ALIASES: Record<string, string[]> = {
  postId: ["post_id", "id", "post id", "tweet id", "投稿id", "メディアid", "ポストid"],
  createdAt: ["created_at", "publish time", "published", "time", "date", "timestamp", "公開日時", "投稿日時", "日時", "日付"],
  text: ["text", "description", "tweet text", "post text", "caption", "message", "説明", "本文", "投稿内容", "キャプション"],
  mediaType: ["media_type", "post type", "type", "投稿タイプ", "種類"],
  permalink: ["permalink", "tweet permalink", "url", "link", "パーマリンク", "リンク"],
  views: ["views", "impressions", "impression_count", "閲覧数", "インプレッション", "インプレッション数", "表示回数", "ビュー"],
  reach: ["reach", "リーチ", "リーチ数"],
  likes: ["likes", "reactions", "like_count", "いいね", "いいね！", "いいね数", "リアクション"],
  comments: ["comments", "replies", "reply_count", "コメント", "コメント数", "返信", "返信数"],
  shares: ["shares", "retweets", "reposts", "シェア", "シェア数", "リポスト", "リツイート"],
  saves: ["saves", "saved", "bookmarks", "保存", "保存数", "ブックマーク"],
  quotes: ["quotes", "quote_count", "引用"],
  clicks: ["clicks", "link clicks", "url clicks", "クリック数", "リンクのクリック"],
};

const MEDIA_ALIASES: Record<string, MediaType> = {
  image: "image", photo: "image", 画像: "image", 写真: "image", "ig image": "image",
  video: "video", 動画: "video", "ig video": "video",
  reel: "reel", reels: "reel", "ig reel": "reel", リール: "reel",
  carousel: "carousel", carousel_album: "carousel", album: "carousel", "ig carousel": "carousel", カルーセル: "carousel",
  text: "text", status: "text", テキスト: "text",
  link: "link", links: "link", リンク: "link",
};

export class ImportError extends Error {}

/** UTF-8（BOM可）か Shift_JIS（Excel 保存）を判別して文字列にする */
export function decodeCsv(bytes: Uint8Array): string {
  for (const enc of ["utf-8", "shift_jis"]) {
    try {
      return new TextDecoder(enc, { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      /* 次の文字コードを試す */
    }
  }
  throw new ImportError("文字コードを判別できません（UTF-8 か Shift_JIS で保存してください）");
}

/** RFC 4180 の CSV を行の配列にする */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s: string) => s.trim().replace(/^﻿/, "").toLowerCase();

/** タイムゾーン tz の壁時計時刻 → UTC の ms */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  const first = guess - offset(guess);
  return guess - offset(first);
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** CSV の日時を ISO（UTC）に。タイムゾーンなしは tz のローカル時刻とみなす */
export function parseDateTime(value: string, tz = DEFAULT_TZ): string {
  const v = value.trim();
  // ISO 8601（タイムゾーン付き）
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const d = new Date(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*([+-]\d{2}):?(\d{2}))?$/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", oh, om] = m;
    if (oh !== undefined) {
      const sign = oh.startsWith("-") ? -1 : 1;
      const off = sign * (Math.abs(Number(oh)) * 60 + Number(om)) * 60_000;
      return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - off).toISOString();
    }
    return new Date(zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz)).toISOString();
  }
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/); // 米国式 月/日/年
  if (m) {
    const [, mo, d, y, h = "0", mi = "0", s = "0"] = m;
    return new Date(zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz)).toISOString();
  }
  m = v.match(/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{4})$/); // "Mon Sep 01 2026"
  if (m && MONTHS[m[1].toLowerCase()]) {
    return new Date(zonedToUtc(+m[3], MONTHS[m[1].toLowerCase()], +m[2], 0, 0, 0, tz)).toISOString();
  }
  throw new ImportError(`日時を解釈できません：${v.slice(0, 40)}`);
}

function toNum(value: string | undefined): number | null {
  if (value === undefined) return null;
  const s = value.trim().replace(/,/g, "");
  if (["", "-", "--", "N/A"].includes(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export const MAX_IMPORT_ROWS = 20_000;

export function readCsv(bytes: Uint8Array, tz = DEFAULT_TZ): CollectedPost[] {
  const rows = parseCsv(decodeCsv(bytes));
  if (!rows.length) throw new ImportError("CSVが空です");
  const [header, ...body] = rows;
  if (body.length > MAX_IMPORT_ROWS) throw new ImportError(`一度に取り込めるのは ${MAX_IMPORT_ROWS.toLocaleString()} 行までです`);
  const lookup = new Map(header.map((h, i) => [norm(h), i]));
  const cols: Record<string, number> = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    for (const n of names) if (lookup.has(n)) { cols[field] = lookup.get(n)!; break; }
  }
  if (cols.createdAt === undefined) {
    throw new ImportError(`日時の列が見つかりません。列名：${header.slice(0, 12).join("、")}`);
  }
  const posts: CollectedPost[] = [];
  body.forEach((row, i) => {
    const get = (f: string) => (cols[f] !== undefined ? row[cols[f]] ?? "" : "");
    if (!get("createdAt").trim()) return;
    let postedAt: string;
    try {
      postedAt = parseDateTime(get("createdAt"), tz);
    } catch (e) {
      throw new ImportError(`${i + 2}行目：${(e as Error).message}`);
    }
    const text = get("text");
    const externalId = get("postId").trim() || createHash("sha1").update(`${postedAt}|${text}`).digest("hex").slice(0, 16);
    const mt = get("mediaType");
    const permalink = get("permalink").trim();
    posts.push({
      externalId, postedAt, text,
      mediaType: MEDIA_ALIASES[norm(mt)] ?? (mt ? "other" : "text"),
      permalink: /^https?:\/\//.test(permalink) ? permalink : null,
      metrics: metrics({
        views: toNum(get("views")), reach: toNum(get("reach")), clicks: toNum(get("clicks")),
        likes: toNum(get("likes")) ?? 0, comments: toNum(get("comments")) ?? 0, shares: toNum(get("shares")) ?? 0,
        saves: toNum(get("saves")) ?? 0, quotes: toNum(get("quotes")) ?? 0,
      }),
    });
  });
  return posts;
}
