import "server-only";
import { getReport, type Report } from "@/lib/report";
import { addDays, todayIn } from "@/lib/sns/models";
import { fmtNum, fmtPct, fmtSigned } from "@/lib/format";

/** 月次レポートの対象月（YYYY-MM）。指定がなければ先月。今月は今日までの途中経過 */
export function parseMonth(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  const thisMonth = todayIn().slice(0, 7);
  if (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && s <= thisMonth && s >= "2024-01") return s;
  return addDays(`${thisMonth}-01`, -1).slice(0, 7);
}

export const monthLabel = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;

/** 直近12か月（新しい順） */
export function recentMonths(n = 12): string[] {
  const out: string[] = [];
  let d = `${todayIn().slice(0, 7)}-01`;
  for (let i = 0; i < n; i++) {
    out.push(d.slice(0, 7));
    d = `${addDays(d, -1).slice(0, 7)}-01`;
  }
  return out;
}

/** その月の1日〜末日（今月なら今日まで）。前期間は同じ日数だけさかのぼる（前月とほぼ同じ） */
export function monthRange(month: string): { start: string; end: string; days: number; partial: boolean } {
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const today = todayIn();
  const end = last > today ? today : last;
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  return { start, end, days, partial: end !== last };
}

export async function monthlyReport(clientId: string, month: string): Promise<Report> {
  const { days, end } = monthRange(month);
  return getReport(clientId, days, end);
}

/** 主要な数字（画面とメールで同じものを出す） */
export function monthlyTotals(r: Report) {
  const d = r.analysis;
  const t = d.total;
  const fol = d.platforms.map((p) => d.summary[p]!.followers).filter((v): v is number => v !== null);
  const fdel = d.platforms.map((p) => d.summary[p]!.followersDelta).filter((v): v is number => v !== null);
  const folSum = fol.reduce((a, b) => a + b, 0);
  const delSum = fdel.reduce((a, b) => a + b, 0);
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? "前月のデータなし" : `前月比 ${v > 0 ? "+" : ""}${fmtPct(v, 1)}`);
  return [
    { label: "エンゲージメント", value: fmtNum(t.engagements), change: t.change.engagements, note: pct(t.change.engagements) },
    { label: "表示回数", value: fmtNum(t.views), change: t.change.views, note: pct(t.change.views) },
    { label: "投稿数", value: fmtNum(t.posts), change: t.change.posts, note: pct(t.change.posts) },
    { label: "フォロワー合計", value: fol.length ? `${fmtNum(folSum)}人` : "—", change: null,
      note: fdel.length ? `この月 ${fmtSigned(delSum)}人` : "記録なし" },
  ];
}

/** クライアントへ送るメールの本文 */
export function monthlyMailLines(r: Report, month: string, url: string): string[] {
  const ins = [...r.analysis.insights].sort((a, b) => (a.kind === "good" ? -1 : 0) - (b.kind === "good" ? -1 : 0)).slice(0, 4);
  return [
    `${r.client.name} ご担当者さま`,
    "",
    `${monthLabel(month)}のSNSレポートをお送りします。`,
    "",
    "■ 主な数字",
    ...monthlyTotals(r).map((x) => `・${x.label}：${x.value}（${x.note}）`),
    ...(ins.length ? ["", "■ この月のポイント", ...ins.map((i) => `・${i.text}`)] : []),
    "",
    "SNS別の結果、反応の良かった投稿、競合との比較は、こちらからご覧いただけます（ログインが必要です）。",
    url,
    "",
    "ご不明な点があれば、このメールにご返信ください。",
    "Rhythmos",
  ];
}
