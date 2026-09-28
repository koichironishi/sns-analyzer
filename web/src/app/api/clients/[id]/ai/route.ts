import { z } from "zod";
import { getViewer, UUID_RE } from "@/lib/auth";
import { clientIp, json, sameOrigin } from "@/lib/http";
import { DAY_OPTIONS, parsePeriod } from "@/lib/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AIError, runAiAnalysis } from "@/lib/sns/ai";
import { analyze } from "@/lib/sns/analysis";
import { compare } from "@/lib/sns/compare";
import { consentProblem, consentState } from "@/lib/sns/privacy";
import { audit, getAppSettings, getBrandContext, getConsentRow, loadReportData, saveAiResult } from "@/lib/sns/store";

// AI分析は数分かかることがある
export const maxDuration = 300;

const Body = z.object({
  days: z.number().int().refine((d) => (DAY_OPTIONS as readonly number[]).includes(d)),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  question: z.string().max(500).default(""),
});

export async function POST(req: Request, ctx: RouteContext<"/api/clients/[id]/ai">) {
  const { id } = await ctx.params;
  if (!sameOrigin(req)) return json({ error: "不正なリクエストです" }, 403);
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !UUID_RE.test(id)) return json({ error: "権限がありません" }, 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "入力内容を確認してください" }, 400);
  const { days, end } = parsePeriod({ days: String(parsed.data.days), end: parsed.data.end });

  const admin = createAdminClient();
  const consent = consentState(await getConsentRow(admin, id));
  const problem = consentProblem(consent);
  if (problem) return json({ error: problem }, 400);

  const db = await createClient();
  const [settings, brand, data] = await Promise.all([getAppSettings(admin), getBrandContext(admin, id), loadReportData(db, id, { days, end })]);
  if (!data.hasData) return json({ error: "この期間のデータがありません。期間を変えるか、データを収集してから実行してください。" }, 400);
  const analysis = analyze(data.ownPosts, data.ownFollowers, { days, end, accountNames: data.ownNames });
  const cmp = data.competitors.length ? compare(data.ownPosts, data.ownFollowers, data.competitors, { days, end, ownNames: data.ownNames }) : null;
  try {
    const result = await runAiAnalysis(analysis, data.ownPosts, data.ownFollowers, cmp && Object.keys(cmp.platforms).length ? cmp : null, {
      model: settings.ai_model, effort: settings.ai_effort, brandContext: brand, question: parsed.data.question,
      includePostText: consent.row!.include_post_text, consentBy: consent.row!.granted_by ?? "", consentAt: consent.row!.granted_at ?? "",
    });
    await saveAiResult(admin, id, end, days, result, v.id);
    await audit(admin, v, "ai.run", id, `${days}日間・${end}まで・${result._meta.model}・投稿${result._meta.postsSent}件${result._meta.postTextSent ? "" : "（本文なし）"}`, await clientIp());
    return json({ ok: true });
  } catch (e) {
    if (e instanceof AIError) return json({ error: e.message }, 502);
    console.error("AI分析に失敗", e instanceof Error ? e.name : "unknown");
    return json({ error: "AI分析に失敗しました。時間をおいて、もう一度お試しください。" }, 500);
  }
}
