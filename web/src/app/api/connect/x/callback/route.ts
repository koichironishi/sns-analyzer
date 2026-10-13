import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { finishOAuth, xApp } from "@/lib/connect-flow";
import { clientIp, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { xExchangeCode } from "@/lib/sns/connect";
import { audit, saveConnection } from "@/lib/sns/store";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = await getViewer();
  if (!v || v.kind !== "staff") return new Response("権限がありません", { status: 403 });
  const flow = await finishOAuth("x", url.searchParams.get("state"), v.id);
  if (!flow || !flow.verifier) redirect("/?e=oauth_state");
  const back = `/clients/${flow.clientId}/settings/connections`;
  if (url.searchParams.get("error")) redirect(`${back}?e=denied#connections`);
  const code = url.searchParams.get("code");
  const app = xApp();
  if (!code || !app) redirect(`${back}?e=x_env#connections`);
  const admin = createAdminClient();
  try {
    const r = await xExchangeCode(app, code, `${siteUrl(req)}/api/connect/x/callback`, flow.verifier);
    await saveConnection(admin, flow.clientId, "x", {
      externalId: r.userId, username: r.username, accessToken: r.accessToken, expiresAt: r.expiresAt, connectedUserId: r.userId,
      refreshToken: r.refreshToken, canPublish: true, authKind: "oauth",
    });
    await audit(admin, v, "connect.x", flow.clientId, `@${r.username}（ログインで連携）`, await clientIp());
  } catch (e) {
    await audit(admin, v, "connect.x.failed", flow.clientId, e instanceof Error ? e.message : "", await clientIp());
    redirect(`${back}?e=exchange#connections`);
  }
  redirect(`${back}?ok=x#connections`);
}
