import "server-only";
import { cache } from "react";
import { UUID_RE } from "@/lib/auth";
import { notFound } from "next/navigation";
import { requireClientAccess } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { analyze, type AnalysisResult } from "@/lib/sns/analysis";
import { compare, type CompareResult } from "@/lib/sns/compare";
import { addDays, todayIn } from "@/lib/sns/models";
import { getClient, latestAiResult, loadReportData, type ReportData, type StoredAi } from "@/lib/sns/store";

export const DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
export type Period = { days: number; end: string };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parsePeriod(sp: SP): Period {
  const today = todayIn();
  const d = Number(one(sp.days));
  const days = (DAY_OPTIONS as readonly number[]).includes(d) ? d : 30;
  const e = one(sp.end) ?? "";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(e) && !Number.isNaN(Date.parse(e)) && e <= today && e >= addDays(today, -730) ? e : today;
  return { days, end };
}

export const periodQuery = (p: Period) => {
  const q = new URLSearchParams();
  if (p.days !== 30) q.set("days", String(p.days));
  if (p.end !== todayIn()) q.set("end", p.end);
  const s = q.toString();
  return s ? `?${s}` : "";
};

export type Report = {
  client: { id: string; name: string };
  period: Period;
  data: ReportData;
  analysis: AnalysisResult;
  competitors: CompareResult | null;
  ai: StoredAi | null;
};

/** 同じリクエスト内（レイアウトとページ）では1回だけ計算する */
export const getReport = cache(async (clientId: string, days: number, end: string): Promise<Report> => {
  await requireClientAccess(clientId);
  const db = await createClient();
  const client = await getClient(db, clientId);
  if (!client) notFound();
  const [data, ai] = await Promise.all([loadReportData(db, clientId, { days, end }), latestAiResult(db, clientId)]);
  const analysis = analyze(data.ownPosts, data.ownFollowers, { days, end, accountNames: data.ownNames });
  const cmp = data.competitors.length
    ? compare(data.ownPosts, data.ownFollowers, data.competitors, { days, end, ownNames: data.ownNames })
    : null;
  return {
    client: { id: client.id, name: client.name }, period: { days, end }, data, analysis,
    competitors: cmp && Object.keys(cmp.platforms).length ? cmp : null, ai,
  };
});

export async function reportFromSearch(clientId: string, sp: SP) {
  const p = parsePeriod(sp);
  return getReport(clientId, p.days, p.end);
}

/** ページ名（タイトル）用のクライアント名。見られないクライアントは空文字 */
export const clientName = cache(async (id: string) =>
  (UUID_RE.test(id) ? (await getClient(await createClient(), id))?.name ?? "" : ""));
