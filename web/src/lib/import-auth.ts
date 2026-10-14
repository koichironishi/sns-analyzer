import "server-only";
import { UUID_RE } from "@/lib/auth";
import { json } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyImportKey } from "@/lib/sns/import-posts";

/**
 * 外部ツール用 API（/api/import/<クライアントID>/...）の認証。
 * 合言葉が違うときは、クライアントの有無を推測されないよう同じ応答を返す。
 */
export async function importAuth(req: Request, id: string) {
  const admin = createAdminClient();
  if (!UUID_RE.test(id) || !(await verifyImportKey(admin, id, req.headers.get("authorization")))) {
    return { admin, denied: json({ error: "認証に失敗しました。SNS分析の「SNS連携」で発行した合言葉を確認してください" }, 401) };
  }
  return { admin, denied: null };
}
