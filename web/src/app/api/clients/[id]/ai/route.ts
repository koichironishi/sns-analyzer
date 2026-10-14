import { z } from "zod";
import { getViewer, UUID_RE } from "@/lib/auth";
import { clientIp, json, sameOrigin } from "@/lib/http";
import { MAX_DAYS, parsePeriod } from "@/lib/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { AIError } from "@/lib/sns/ai";
import { AiNotReady, runAiForClient } from "@/lib/sns/ai-run";
import { audit } from "@/lib/sns/store";

// AI分析は数分かかることがある
export const maxDuration = 300;

const Body = z.object({
  days: z.number().int().min(1).max(MAX_DAYS),
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
  try {
    const result = await runAiForClient(admin, await createClient(), id, { days, end, question: parsed.data.question, createdBy: v.id });
    await audit(admin, v, "ai.run", id, `${days}日間・${end}まで・${result._meta.model}・投稿${result._meta.postsSent}件${result._meta.postTextSent ? "" : "（本文なし）"}`, await clientIp());
    return json({ ok: true });
  } catch (e) {
    if (e instanceof AiNotReady) return json({ error: e.message }, 400);
    if (e instanceof AIError) return json({ error: e.message }, 502);
    console.error("AI分析に失敗", e instanceof Error ? e.name : "unknown");
    return json({ error: "AI分析に失敗しました。時間をおいて、もう一度お試しください。" }, 500);
  }
}
