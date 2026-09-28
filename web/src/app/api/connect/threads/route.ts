import { redirect } from "next/navigation";
import { getViewer, UUID_RE } from "@/lib/auth";
import { startOAuth, threadsApp } from "@/lib/connect-flow";
import { siteUrl } from "@/lib/http";
import { threadsAuthorizeUrl } from "@/lib/sns/connect";

export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get("client") ?? "";
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !UUID_RE.test(clientId)) return new Response("権限がありません", { status: 403 });
  const app = threadsApp();
  if (!app) redirect(`/clients/${clientId}/settings?e=threads_env#connections`);
  const state = await startOAuth("threads", clientId, v.id);
  redirect(threadsAuthorizeUrl(app, `${siteUrl(req)}/api/connect/threads/callback`, state, process.env.THREADS_PROFILE_DISCOVERY === "1"));
}
