import { redirect } from "next/navigation";
import { getViewer, UUID_RE } from "@/lib/auth";
import { startOAuth, xApp } from "@/lib/connect-flow";
import { siteUrl } from "@/lib/http";
import { pkcePair, xAuthorizeUrl } from "@/lib/sns/connect";

/** X にユーザーとしてログインして連携する（投稿と分析の両方に使う） */
export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get("client") ?? "";
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !UUID_RE.test(clientId)) return new Response("権限がありません", { status: 403 });
  const app = xApp();
  if (!app) redirect(`/clients/${clientId}/settings/connections?e=x_env#connections`);
  const { verifier, challenge } = pkcePair();
  const state = await startOAuth("x", clientId, v.id, verifier);
  redirect(xAuthorizeUrl(app, `${siteUrl(req)}/api/connect/x/callback`, state, challenge));
}
