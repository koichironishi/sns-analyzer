import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { finishOAuth, metaApp, stashPages } from "@/lib/connect-flow";
import { clientIp, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaExchangeCode } from "@/lib/sns/connect";
import { audit, getAppSettings } from "@/lib/sns/store";
import { saveMetaPage } from "@/lib/meta-pages";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = await getViewer();
  if (!v || v.kind !== "staff") return new Response("権限がありません", { status: 403 });
  const flow = await finishOAuth("meta", url.searchParams.get("state"), v.id);
  if (!flow) redirect("/?e=oauth_state");
  const back = `/clients/${flow.clientId}/settings`;
  if (url.searchParams.get("error")) redirect(`${back}?e=denied#connections`);
  const code = url.searchParams.get("code");
  const app = metaApp();
  if (!code || !app) redirect(`${back}?e=meta_env#connections`);

  const admin = createAdminClient();
  const { graph_api_version } = await getAppSettings(admin);
  let result: Awaited<ReturnType<typeof metaExchangeCode>>;
  try {
    result = await metaExchangeCode({ ...app, graphVersion: graph_api_version }, code, `${siteUrl(req)}/api/connect/meta/callback`);
  } catch (e) {
    await audit(admin, v, "connect.meta.failed", flow.clientId, e instanceof Error ? e.message : "", await clientIp());
    redirect(`${back}?e=exchange#connections`);
  }
  if (!result.pages.length) redirect(`${back}?e=nopages#connections`);
  if (result.pages.length === 1) {
    await saveMetaPage(admin, v, flow.clientId, result.pages[0], result.userId);
    redirect(`${back}?ok=meta#connections`);
  }
  // 複数のページを管理している場合は、どのページを連携するか選んでもらう
  await stashPages({ clientId: flow.clientId, userId: v.id, metaUserId: result.userId, pages: result.pages.slice(0, 12) });
  redirect(`${back}/meta-pages`);
}
