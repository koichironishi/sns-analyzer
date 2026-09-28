import "server-only";
import { connection } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppSettings, type AppSettings } from "@/lib/sns/store";

/** 公開ページ用（ログイン不要）。設定を読めない場合も既定値で表示する */
export async function publicSettings(): Promise<AppSettings> {
  await connection(); // 全体設定の変更をすぐ反映するため、リクエストのたびに描画する
  try {
    return await getAppSettings(createAdminClient());
  } catch {
    return { retention_days: 400, collect_days: 60, max_posts_per_run: 300, ai_model: "", ai_effort: "high", graph_api_version: "v26.0", legal: {} };
  }
}
