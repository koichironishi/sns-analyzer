import { redirect } from "next/navigation";
import { getViewer, UUID_RE } from "@/lib/auth";
import { metaApp, startOAuth } from "@/lib/connect-flow";
import { siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaAuthorizeUrl } from "@/lib/sns/connect";
import { getAppSettings } from "@/lib/sns/store";

/** Facebook ログインを始める（Facebook ページと、紐づく Instagram をまとめて連携） */
export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get("client") ?? "";
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !UUID_RE.test(clientId)) return new Response("権限がありません", { status: 403 });
  const app = metaApp();
  if (!app) redirect(`/clients/${clientId}/settings?e=meta_env#connections`);
  const { graph_api_version } = await getAppSettings(createAdminClient());
  const state = await startOAuth("meta", clientId, v.id);
  redirect(metaAuthorizeUrl({ ...app, graphVersion: graph_api_version }, `${siteUrl(req)}/api/connect/meta/callback`, state));
}
