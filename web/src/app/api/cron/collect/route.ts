import { timingSafeEqual } from "node:crypto";
import { json, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { runScheduledCollection } from "@/lib/sns/collect";
import { audit, getConnectionSecrets } from "@/lib/sns/store";
import { alertedToday, markAlerted, sendAlert } from "@/lib/notify";
import { daysLeft } from "@/lib/sns/connect";
import { PLATFORM_LABELS } from "@/lib/sns/models";

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
  await alertCollect(admin, r.logs);
  return json({ processed: r.logs.length, failed, remaining: r.remaining, purge: r.purge, seconds: Math.round((Date.now() - started) / 1000) });
}

/**
 * 収集の失敗（トークン切れなど）と、トークンの期限が近い接続を、スタッフにメールで知らせる。
 * 収集は接続ごとに1日1回なので、失敗の知らせも1日1回。期限の知らせは1日1回だけまとめて送る
 */
async function alertCollect(admin: ReturnType<typeof createAdminClient>, logs: { clientId: string; ok: boolean; message: string }[]) {
  const failed = logs.filter((l) => !l.ok);
  const conns = await getConnectionSecrets(admin);
  const { data } = await admin.from("sns_clients").select("id,name");
  const name = new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  if (failed.length) {
    await sendAlert(admin, `データ収集のエラー（${failed.length}件）`, [
      "データ収集でエラーがありました。トークンが無効な場合は「SNS連携」で連携し直してください。", "",
      ...failed.map((l) => `■ ${name.get(l.clientId) ?? "（クライアント）"}　${l.message}\n　${siteUrl()}/clients/${l.clientId}/settings/connections`),
    ]);
  }
  if (await alertedToday(admin, "token")) return;
  const soon = conns.map((c) => ({ c, left: daysLeft(c.token_expires_at) })).filter((x) => x.left !== null && x.left <= 7);
  if (!soon.length) return;
  const lines = soon.map(({ c, left }) => `■ ${name.get(c.client_id) ?? "（クライアント）"}　${PLATFORM_LABELS[c.platform]}（${c.username ?? c.external_id}）：${left! <= 0 ? "期限切れ" : `あと${Math.floor(left!)}日`}\n　${siteUrl()}/clients/${c.client_id}/settings/connections`);
  await sendAlert(admin, `連携の期限が近づいています（${soon.length}件）`, ["次の連携は、期限が切れると収集と投稿が止まります。期限前に「SNS連携」で連携し直してください。", "", ...lines]);
  await markAlerted(admin, "token", `${soon.length}件`);
}

// Vercel Cron は GET、pg_net からは POST で呼ぶ
export const GET = run;
export const POST = run;
