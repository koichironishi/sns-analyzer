import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { finishOAuth, threadsApp } from "@/lib/connect-flow";
import { clientIp, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { threadsExchangeCode } from "@/lib/sns/connect";
import { audit, saveConnection } from "@/lib/sns/store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = await getViewer();
  if (!v || v.kind !== "staff") return new Response("権限がありません", { status: 403 });
  const flow = await finishOAuth("threads", url.searchParams.get("state"), v.id);
  if (!flow) redirect("/?e=oauth_state");
  const back = `/clients/${flow.clientId}/settings`;
  if (url.searchParams.get("error")) redirect(`${back}?e=denied#connections`);
  const code = url.searchParams.get("code");
  const app = threadsApp();
  if (!code || !app) redirect(`${back}?e=threads_env#connections`);
  const admin = createAdminClient();
  try {
    const r = await threadsExchangeCode(app, code, `${siteUrl(req)}/api/connect/threads/callback`);
    await saveConnection(admin, flow.clientId, "threads", {
      externalId: r.userId, username: r.username, accessToken: r.accessToken, expiresAt: r.expiresAt, connectedUserId: r.userId,
    });
    await audit(admin, v, "connect.threads", flow.clientId, `@${r.username}`, await clientIp());
  } catch (e) {
    await audit(admin, v, "connect.threads.failed", flow.clientId, e instanceof Error ? e.message : "", await clientIp());
    redirect(`${back}?e=exchange#connections`);
  }
  redirect(`${back}?ok=threads#connections`);
}
