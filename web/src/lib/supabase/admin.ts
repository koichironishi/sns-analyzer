import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * service_role キーを使うサーバー専用クライアント（RLS をバイパス）。
 * 書き込みとトークンの読み出しはすべてここを通す。呼ぶ前に必ず権限を確認すること。
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase の環境変数（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）が設定されていません");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
