import { getViewer, UUID_RE } from "@/lib/auth";
import { clientIp, json, sameOrigin } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectClient } from "@/lib/sns/collect";
import { isPlatform } from "@/lib/sns/models";
import { audit } from "@/lib/sns/store";

export const maxDuration = 300;

/** 「今すぐ収集」 */
export async function POST(req: Request, ctx: RouteContext<"/api/clients/[id]/collect">) {
  const { id } = await ctx.params;
  if (!sameOrigin(req)) return json({ error: "不正なリクエストです" }, 403);
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !UUID_RE.test(id)) return json({ error: "権限がありません" }, 403);
  const body = (await req.json().catch(() => ({}))) as { platform?: string };
  const platform = isPlatform(body.platform) ? body.platform : undefined;
  const admin = createAdminClient();
  const started = Date.now();
  const { logs, skipped } = await collectClient(admin, id, started + (maxDuration - 20) * 1000, platform);
  await audit(admin, v, "collect.manual", id, logs.map((l) => l.message).join(" / ").slice(0, 500), await clientIp());
  return json({ logs, skipped });
}
