import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { monthlyPrepStep } from "@/lib/monthly-prep";

// 月初の準備（先月のAI分析の自動実行）。Supabase の pg_cron から月初に10分おきに呼ぶ（supabase/sns-cron.sql）。
// AI分析は数分かかるため、予約投稿の処理とは分けて、この処理の時間をまるごと使う
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const a = Buffer.from(req.headers.get("authorization") ?? "");
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function run(req: Request) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const started = Date.now();
  try {
    const prep = await monthlyPrepStep(createAdminClient(), started + (maxDuration - 25) * 1000);
    return json({ prep, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    console.error("月初の準備に失敗しました", e instanceof Error ? e.message : e);
    return json({ error: "月初の準備に失敗しました" }, 500);
  }
}

export const GET = run;
export const POST = run;
