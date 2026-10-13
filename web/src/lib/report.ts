import "server-only";
import { cache } from "react";
import { UUID_RE } from "@/lib/auth";
import { notFound } from "next/navigation";
import { requireClientAccess } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { analyze, type AnalysisResult } from "@/lib/sns/analysis";
import { compare, type CompareResult } from "@/lib/sns/compare";
import { addDays, isPlatform, todayIn, type Platform } from "@/lib/sns/models";
import { filterReportData, getClient, latestAiResult, loadReportData, reportPlatforms, type ReportData, type StoredAi } from "@/lib/sns/store";

/** 期間の日数の上限（今月・先月・日付指定で任意の日数を受け付ける。1年＋α） */
export const MAX_DAYS = 400;
/** sns：1つのSNSに絞り込む（null はすべて） */
export type Period = { days: number; end: string; sns: Platform | null };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parsePeriod(sp: SP): Period {
  const today = todayIn();
  const d = Number(one(sp.days));
  const days = Number.isInteger(d) && d >= 1 && d <= MAX_DAYS ? d : 30;
  const e = one(sp.end) ?? "";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(e) && !Number.isNaN(Date.parse(e)) && e <= today && e >= addDays(today, -730) ? e : today;
  const s = one(sp.sns);
  return { days, end, sns: isPlatform(s) ? s : null };
}

export const periodQuery = (p: Period) => {
  const q = new URLSearchParams();
  if (p.days !== 30) q.set("days", String(p.days));
  if (p.end !== todayIn()) q.set("end", p.end);
  if (p.sns) q.set("sns", p.sns);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export type Report = {
  client: { id: string; name: string };
  period: Period;
  data: ReportData;
  /** 自社のデータがあるSNS（絞り込む前） */
  platforms: Platform[];
  analysis: AnalysisResult;
  competitors: CompareResult | null;
  ai: StoredAi | null;
};

/** 同じリクエスト内（レイアウトとページ）では1回だけ計算する */
export const getReport = cache(async (clientId: string, days: number, end: string, sns: Platform | null = null): Promise<Report> => {
  await requireClientAccess(clientId);
  const db = await createClient();
  const client = await getClient(db, clientId);
  if (!client) notFound();
  const [all, ai] = await Promise.all([loadReportData(db, clientId, { days, end }), latestAiResult(db, clientId)]);
  const platforms = reportPlatforms(all);
  // データのないSNSが指定されたら、すべてを表示する
  const picked = sns && platforms.includes(sns) ? sns : null;
  const data = filterReportData(all, picked);
  const analysis = analyze(data.ownPosts, data.ownFollowers, { days, end, accountNames: data.ownNames });
  const cmp = data.competitors.length
    ? compare(data.ownPosts, data.ownFollowers, data.competitors, { days, end, ownNames: data.ownNames })
    : null;
  return {
    client: { id: client.id, name: client.name }, period: { days, end, sns: picked }, data, platforms, analysis,
    competitors: cmp && Object.keys(cmp.platforms).length ? cmp : null, ai,
  };
});

export async function reportFromSearch(clientId: string, sp: SP) {
  const p = parsePeriod(sp);
  return getReport(clientId, p.days, p.end, p.sns);
}

/** ページ名（タイトル）用のクライアント名。見られないクライアントは空文字 */
export const clientName = cache(async (id: string) =>
  (UUID_RE.test(id) ? (await getClient(await createClient(), id))?.name ?? "" : ""));
