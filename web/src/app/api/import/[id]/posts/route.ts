import { clientIp, json } from "@/lib/http";
import { importAuth } from "@/lib/import-auth";
import { IMPORT_ACTOR, importPost, type ImportPostInput } from "@/lib/sns/import-posts";
import { audit, MEDIA_BUCKET } from "@/lib/sns/store";

/** 投稿を「承認待ち」で登録する（外部ツール用）。公開はスタッフが SNS分析で承認してから */
export async function POST(req: Request, ctx: RouteContext<"/api/import/[id]/posts">) {
  const { id } = await ctx.params;
  const { admin, denied } = await importAuth(req, id);
  if (denied) return denied;
  const input = (await req.json().catch(() => null)) as ImportPostInput | null;
  if (!input || typeof input !== "object") return json({ error: "JSON を送ってください" }, 400);
  const r = await importPost(admin, id, input, (p) => admin.storage.from(MEDIA_BUCKET).getPublicUrl(p).data.publicUrl);
  // 登録しなかった（入力の誤り・承認済みで変更なし）ときは、このために送られた画像を残さない
  const own = (Array.isArray(input.mediaPaths) ? input.mediaPaths : []).map(String).filter((x) => x.startsWith(`${id}/`) && /\/[0-9a-f-]{36}\.jpg$/.test(x));
  if ((!r.ok || r.action === "unchanged") && own.length) {
    // ほかの投稿が使っている画像は消さない（パスを指定するだけで、別の予約投稿の画像を消せないように）
    const { data: used } = await admin.from("sns_scheduled_posts").select("media").eq("client_id", id);
    const inUse = new Set((used ?? []).flatMap((p) => ((p.media ?? []) as { path?: string }[]).map((m) => m.path)));
    const orphan = own.filter((x) => !inUse.has(x));
    if (orphan.length) await admin.storage.from(MEDIA_BUCKET).remove(orphan);
  }
  if (!r.ok) return json({ errors: r.errors }, 422);
  if (r.action !== "unchanged") {
    await audit(admin, { id: "", email: IMPORT_ACTOR }, `post.import.${r.action}`, id,
      `${String(input.ref).slice(0, 100)}・${input.scheduledAt}・画像${input.mediaPaths.length}枚`, await clientIp());
  }
  return json(r);
}
