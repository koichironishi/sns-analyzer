/**
 * 投稿のCSV一括予約：CSV（配信日時・本文）を読み、行ごとに日時と本文を確かめる。画面やDBに依存しない（テストしやすくするため）。
 *
 *   配信日時,本文
 *   2026/11/01 12:00,"1行目
 *   2行目"
 *
 * - 見出しの行は「配信日時」「本文」（「日時」「投稿日時」「date」「text」なども可）。見出しがなければ1列目＝日時・2列目＝本文
 * - 日時は日本時間（2026/11/01 12:00、2026-11-01 12:00 など）
 * - 改行を含む本文は、Excel で保存すれば自動でダブルクォートで囲まれる
 */
import { ImportError, decodeCsv, parseCsv, parseDateTime } from "../importers.ts";
import { BULK_MAX_ROWS } from "./bulk-format.ts";

export { BULK_MAX_ROWS, bulkTemplate } from "./bulk-format.ts";
/** 予約できるのは、今から5分以上あと・1年以内 */
export const BULK_MIN_AHEAD_MS = 5 * 60_000;
export const BULK_MAX_AHEAD_MS = 366 * 86_400_000;

export type BulkRow = {
  /** CSV の行番号（見出しを含めた1始まり。エラーの場所を伝えるため） */
  line: number;
  /** 日本時間の「YYYY-MM-DDTHH:mm」（解釈できなければ空） */
  local: string;
  /** UTC の ISO（解釈できなければ null） */
  at: string | null;
  text: string;
  errors: string[];
  /** 取り込めるが確かめてほしいこと（同じ日時が重なっている など） */
  warnings: string[];
};

const DATE_HEADS = ["配信日時", "日時", "投稿日時", "予約日時", "date", "datetime", "scheduled_at"];
const TEXT_HEADS = ["本文", "テキスト", "投稿文", "text", "body", "message"];
const norm = (s: string) => s.trim().replace(/^﻿/, "").toLowerCase();

function toLocal(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function readBulkCsv(bytes: Uint8Array, now = Date.now()): BulkRow[] {
  const rows = parseCsv(decodeCsv(bytes));
  if (!rows.length) throw new ImportError("CSV に行がありません");
  const head = rows[0].map(norm);
  const di = head.findIndex((h) => DATE_HEADS.includes(h));
  const ti = head.findIndex((h) => TEXT_HEADS.includes(h));
  const hasHead = di >= 0 || ti >= 0;
  if (hasHead && (di < 0 || ti < 0)) throw new ImportError("見出しに「配信日時」と「本文」の両方が必要です");
  const [dc, tc] = hasHead ? [di, ti] : [0, 1];
  const body = rows.slice(hasHead ? 1 : 0);
  if (!body.length) throw new ImportError("見出しのほかに行がありません");
  if (body.length > BULK_MAX_ROWS) throw new ImportError(`一度に取り込めるのは${BULK_MAX_ROWS}件までです（${body.length}件あります）`);
  const seen = new Map<string, number>();
  return body.map((r, i) => {
    const line = i + (hasHead ? 2 : 1);
    const raw = (r[dc] ?? "").trim();
    const text = (r[tc] ?? "").replace(/\r\n/g, "\n").trim();
    const errors: string[] = [];
    const warnings: string[] = [];
    let at: string | null = null;
    if (!raw) errors.push("配信日時がありません");
    else {
      try {
        at = parseDateTime(raw);
      } catch {
        errors.push(`配信日時を読み取れません（${raw.slice(0, 30)}）。2026/11/01 12:00 の形で書いてください`);
      }
    }
    if (at) {
      const t = Date.parse(at);
      if (t < now + BULK_MIN_AHEAD_MS) errors.push("配信日時が過去か、5分以内です");
      else if (t > now + BULK_MAX_AHEAD_MS) errors.push("予約できるのは1年先までです");
      const k = toLocal(at);
      if (seen.has(k)) warnings.push(`${seen.get(k)}行目と同じ日時です`);
      else seen.set(k, line);
    }
    if (!text) errors.push("本文がありません");
    return { line, local: at ? toLocal(at) : "", at, text, errors, warnings };
  });
}
