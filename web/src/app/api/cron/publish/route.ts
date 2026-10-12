import { timingSafeEqual } from "node:crypto";
import { xApp } from "@/lib/connect-flow";
import { json } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDuePosts } from "@/lib/sns/publish/run";
import { audit } from "@/lib/sns/store";

// 予約投稿の処理。Supabase の pg_cron から数分おきに呼ぶ（supabase/sns-cron.sql）
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
  const admin = createAdminClient();
  const r = await runDuePosts(admin, Date.now() + (maxDuration - 20) * 1000, { xApp: xApp() });
  if (r.processed.length || r.closed) {
    await audit(admin, null, "cron.publish", null, `${r.processed.length}件を投稿（残り ${r.remaining}件・中断 ${r.closed}件）`);
  }
  return json({ processed: r.processed.length, remaining: r.remaining, closed: r.closed });
}

export const GET = run;
export const POST = run;
