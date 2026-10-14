import { timingSafeEqual } from "node:crypto";
import { json, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { runScheduledCollection } from "@/lib/sns/collect";
import { audit, getConnectionSecrets } from "@/lib/sns/store";
import { alertedKeys, markAlerted, sendAlert } from "@/lib/notify";
import { daysLeft } from "@/lib/sns/connect";
import { PLATFORM_LABELS, todayIn } from "@/lib/sns/models";
import { REPEAT_DAYS, collectKey, monthlyReminder, tokenStage, tokenWindowDays } from "@/lib/sns/alert-rules";

// 1回の実行で処理しきれない分は、次の実行（Supabase の pg_cron などから数回呼ぶ）で続きを処理する
export const maxDuration = 300;

type Admin = ReturnType<typeof createAdminClient>;

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
  // 知らせの失敗で収集の結果を返せなくならないように
  try {
    const name = await clientNames(admin);
    await alertCollect(admin, r.logs, name);
    await alertTokens(admin, name);
    await alertMonthly(admin, name);
  } catch (e) {
    console.error("知らせの処理に失敗しました", e instanceof Error ? e.message : e);
  }
  return json({ processed: r.logs.length, failed, remaining: r.remaining, purge: r.purge, seconds: Math.round((Date.now() - started) / 1000) });
}

async function clientNames(admin: Admin) {
  const { data } = await admin.from("sns_clients").select("id,name");
  return new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
}

const link = (clientId: string, path: string) => `${siteUrl()}/clients/${clientId}${path}`;

/** 収集のエラー：接続ごとに、初めて起きたときと、続いていれば7日ごとに知らせる（毎日は送らない） */
async function alertCollect(admin: Admin, logs: { clientId: string; platform: string; externalId: string; ok: boolean; message: string }[], name: Map<string, string>) {
  const failed = logs.filter((l) => !l.ok);
  if (!failed.length) return;
  const done = await alertedKeys(admin, "collect", REPEAT_DAYS);
  const fresh = failed.filter((l) => !done.has(collectKey(l.clientId, l.platform, l.externalId)));
  if (!fresh.length) return;
  const ok = await sendAlert(admin, `データ収集のエラー（${fresh.length}件）`, [
    "データ収集でエラーがありました。トークンが無効な場合は「SNS連携」で連携し直してください。",
    `同じエラーが続いている場合は、${REPEAT_DAYS}日後にもう一度お知らせします（毎日の状況はクライアント一覧で確認できます）。`, "",
    ...fresh.map((l) => `■ ${name.get(l.clientId) ?? "（クライアント）"}　${l.message}\n　${link(l.clientId, "/settings/connections")}`),
  ]);
  if (ok) for (const l of fresh) await markAlerted(admin, "collect", collectKey(l.clientId, l.platform, l.externalId));
}

/** 連携の期限：7日前・3日前・1日前に1回ずつ。切れたあとは7日ごと */
async function alertTokens(admin: Admin, name: Map<string, string>) {
  const conns = await getConnectionSecrets(admin);
  const [once, weekly] = await Promise.all([alertedKeys(admin, "token", 30), alertedKeys(admin, "token", REPEAT_DAYS)]);
  const due = conns.flatMap((c) => {
    const left = daysLeft(c.token_expires_at);
    const stage = tokenStage(left);
    if (!stage) return [];
    const key = `${collectKey(c.client_id, c.platform, c.external_id)}:${stage}`;
    return (tokenWindowDays(stage) === REPEAT_DAYS ? weekly : once).has(key) ? [] : [{ c, left: left!, key }];
  });
  if (!due.length) return;
  const lines = due.map(({ c, left }) => `■ ${name.get(c.client_id) ?? "（クライアント）"}　${PLATFORM_LABELS[c.platform]}（${c.username ?? c.external_id}）：${left <= 0 ? "期限切れ" : `あと${Math.max(1, Math.floor(left))}日`}\n　${link(c.client_id, "/settings/connections")}`);
  const ok = await sendAlert(admin, `連携の期限（${due.length}件）`, [
    "次の連携は、期限が切れると収集と投稿が止まります。「SNS連携」で連携し直してください。",
    "期限の7日前・3日前・1日前に1回ずつ、切れたあとは7日ごとにお知らせします。", "", ...lines,
  ]);
  if (ok) for (const d of due) await markAlerted(admin, "token", d.key);
}

/** 月次レポートの送り忘れ：月の1日と5日に、先月分をまだ送っていないクライアントを知らせる */
async function alertMonthly(admin: Admin, name: Map<string, string>) {
  const plan = monthlyReminder(todayIn());
  if (!plan) return;
  const key = `${plan.month}:${plan.round}`;
  if ((await alertedKeys(admin, "monthly", 40)).has(key)) return;
  // 対象は、SNS を連携しているクライアント
  const { data: conns } = await admin.from("sns_connections").select("client_id");
  const active = [...new Set(((conns ?? []) as { client_id: string }[]).map((c) => c.client_id))];
  const { data: sent } = await admin.from("sns_audit").select("client_id").eq("action", "monthly.sent").like("detail", `${plan.month}：%`);
  const done = new Set(((sent ?? []) as { client_id: string | null }[]).map((s) => s.client_id));
  const { data: users } = await admin.from("sns_client_users").select("client_id,is_active,email");
  const reachable = new Set(((users ?? []) as { client_id: string; is_active: boolean; email: string | null }[]).filter((u) => u.is_active && u.email).map((u) => u.client_id));
  const todo = active.filter((id) => !done.has(id) && name.has(id)).sort((a, b) => name.get(a)!.localeCompare(name.get(b)!, "ja"));
  // 2回目（5日）は、まだ送っていないクライアントがあるときだけ。1回目は「準備ができた」知らせとして送る
  if (!todo.length) {
    await markAlerted(admin, "monthly", key);
    return;
  }
  const [y, m] = plan.month.split("-").map(Number);
  const label = `${y}年${m}月`;
  const ok = await sendAlert(admin, plan.round === "first" ? `${label}の月次レポートを送る時期です（${todo.length}件）` : `${label}の月次レポートが未送付です（${todo.length}件）`, [
    plan.round === "first"
      ? `${label}の月次レポートが作れるようになりました。内容を確認して、クライアントに送ってください。`
      : `${label}の月次レポートを、まだ送っていないクライアントがあります。`,
    "", ...todo.map((id) => `■ ${name.get(id)}${reachable.has(id) ? "" : "　※送り先（利用者）が未登録"}\n　${link(id, `/monthly?month=${plan.month}`)}`),
  ]);
  if (ok) await markAlerted(admin, "monthly", key);
}

// Vercel Cron は GET、pg_net からは POST で呼ぶ
export const GET = run;
export const POST = run;
