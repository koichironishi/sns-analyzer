import "server-only";
import { json, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { newConfirmationCode, parseSignedRequest, type DeletionService } from "@/lib/sns/privacy";
import { audit, handleDeletionRequest } from "@/lib/sns/store";

/**
 * Meta / Threads の「データ削除リクエスト」コールバック。
 * signed_request をアプリシークレットで検証し、その利用者が許可した連携のデータを削除する。
 * 応答は Meta の仕様どおり { url, confirmation_code }。
 */
export async function handleDeletionCallback(req: Request, service: DeletionService, secret: string | undefined) {
  if (!secret) return json({ error: "not configured" }, 503);
  let signed = "";
  try {
    const form = await req.formData();
    signed = String(form.get("signed_request") ?? "");
  } catch {
    return json({ error: "bad request" }, 400);
  }
  let userId: string;
  try {
    const data = parseSignedRequest(signed, secret);
    userId = String(data.user_id ?? "");
    if (!userId) throw new Error("user_id がありません");
  } catch {
    return json({ error: "invalid signed_request" }, 400);
  }
  const admin = createAdminClient();
  const code = newConfirmationCode();
  const done = await handleDeletionRequest(admin, service, userId, code);
  await audit(admin, null, "deletion.request", null, `${service}・確認コード ${code}・${done.length}件の接続を削除`);
  return json({ url: `${siteUrl(req)}/data-deletion/status?code=${code}`, confirmation_code: code });
}
