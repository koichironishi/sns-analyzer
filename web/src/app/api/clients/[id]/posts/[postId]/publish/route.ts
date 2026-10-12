import { getViewer, UUID_RE } from "@/lib/auth";
import { xApp } from "@/lib/connect-flow";
import { clientIp, json, sameOrigin } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { publishNow } from "@/lib/sns/publish/run";
import { audit, getScheduledPost } from "@/lib/sns/store";

// 画像の処理待ちがあるため、1件で1分ほどかかることがある
export const maxDuration = 300;

/** 予約中（予約時刻を過ぎたもの）の投稿を、すぐに公開する。「今すぐ投稿」と「再投稿」から呼ぶ */
export async function POST(req: Request, ctx: RouteContext<"/api/clients/[id]/posts/[postId]/publish">) {
  const { id, postId } = await ctx.params;
  if (!sameOrigin(req)) return json({ error: "不正なリクエストです" }, 403);
  const v = await getViewer();
  if (!v || !UUID_RE.test(id) || !UUID_RE.test(postId)) return json({ error: "権限がありません" }, 403);
  if (v.kind === "client" && (v.clientId !== id || v.mustChangePassword)) return json({ error: "権限がありません" }, 403);
  const admin = createAdminClient();
  const post = await getScheduledPost(admin, postId);
  if (!post || post.client_id !== id) return json({ error: "投稿が見つかりません" }, 404);
  const done = await publishNow(admin, postId, { xApp: xApp() });
  if (!done) return json({ error: "この投稿はすでに処理中か、予約時刻になっていません" }, 409);
  await audit(admin, v, "post.publish", id, `${postId}：${done.status}`, await clientIp());
  return json({ status: done.status, results: done.results });
}
