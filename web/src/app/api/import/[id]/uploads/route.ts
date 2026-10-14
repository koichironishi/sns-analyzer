import { randomUUID } from "node:crypto";
import { json } from "@/lib/http";
import { importAuth } from "@/lib/import-auth";
import { MEDIA_BUCKET } from "@/lib/sns/store";

/**
 * 画像のアップロード先を発行する（外部ツール用）。
 * 画像は SNS分析を経由せず、返した URL へ直接 PUT する（サーバーの受け取れる大きさの上限を避けるため）。
 */
export async function POST(req: Request, ctx: RouteContext<"/api/import/[id]/uploads">) {
  const { id } = await ctx.params;
  const { admin, denied } = await importAuth(req, id);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { count?: unknown };
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 10) return json({ error: "count は1〜10で指定してください" }, 400);
  const targets = [];
  for (let i = 0; i < count; i++) {
    const path = `${id}/${randomUUID()}.jpg`;
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return json({ error: `アップロードの準備に失敗しました：${error?.message ?? "不明なエラー"}` }, 500);
    targets.push({ path, signedUrl: data.signedUrl });
  }
  return json({ targets });
}
