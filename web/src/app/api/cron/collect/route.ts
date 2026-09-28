import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { runScheduledCollection } from "@/lib/sns/collect";
import { audit } from "@/lib/sns/store";

// 1回の実行で処理しきれない分は、次の実行（Supabase の pg_cron などから数回呼ぶ）で続きを処理する
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization") ?? "";
  if (!secret) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function run(req: Request) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const admin = createAdminClient();
  const started = Date.now();
  const r = await runScheduledCollection(admin, started + (maxDuration - 30) * 1000);
  const failed = r.logs.filter((l) => !l.ok).length;
  await audit(admin, null, "cron.collect", null, `${r.logs.length}件の接続を処理（失敗 ${failed}件・残り ${r.remaining}件）${r.purge ? `・${r.purge}` : ""}`);
  return json({ processed: r.logs.length, failed, remaining: r.remaining, purge: r.purge, seconds: Math.round((Date.now() - started) / 1000) });
}

// Vercel Cron は GET、pg_net からは POST で呼ぶ
export const GET = run;
export const POST = run;
