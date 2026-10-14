import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AIError, runAiAnalysis, type AiResult } from "@/lib/sns/ai";
import { analyze } from "@/lib/sns/analysis";
import { compare } from "@/lib/sns/compare";
import { consentProblem, consentState } from "@/lib/sns/privacy";
import { getAppSettings, getBrandContext, getConsentRow, loadReportData, saveAiResult } from "@/lib/sns/store";

/** 実行の前提が整っていない（同意がない・データがない）。利用者が直せる理由 */
export class AiNotReady extends AIError {}

/**
 * 1クライアントのAI分析を実行して保存する（画面からの実行と、月初の自動実行で共通）。
 * 同意がない・データがないときは AiNotReady、API の失敗は AIError（どちらも、理由をそのまま画面やメールに出せる文）
 */
export async function runAiForClient(admin: SupabaseClient, db: SupabaseClient, clientId: string,
  opts: { days: number; end: string; question?: string; createdBy: string | null; signal?: AbortSignal }): Promise<AiResult> {
  const { days, end } = opts;
  const consent = consentState(await getConsentRow(admin, clientId));
  const problem = consentProblem(consent);
  if (problem) throw new AiNotReady(problem);
  const [settings, brand, data] = await Promise.all([getAppSettings(admin), getBrandContext(admin, clientId), loadReportData(db, clientId, { days, end })]);
  if (!data.hasData) throw new AiNotReady("この期間のデータがありません。期間を変えるか、データを収集してから実行してください。");
  const analysis = analyze(data.ownPosts, data.ownFollowers, { days, end, accountNames: data.ownNames });
  const cmp = data.competitors.length ? compare(data.ownPosts, data.ownFollowers, data.competitors, { days, end, ownNames: data.ownNames }) : null;
  const result = await runAiAnalysis(analysis, data.ownPosts, data.ownFollowers, cmp && Object.keys(cmp.platforms).length ? cmp : null, {
    model: settings.ai_model, effort: settings.ai_effort, brandContext: brand, question: opts.question ?? "",
    includePostText: consent.row!.include_post_text, consentBy: consent.row!.granted_by ?? "", consentAt: consent.row!.granted_at ?? "",
    signal: opts.signal,
  });
  await saveAiResult(admin, clientId, end, days, result, opts.createdBy);
  return result;
}
