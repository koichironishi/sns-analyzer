import { timingSafeEqual } from "node:crypto";
import { xApp } from "@/lib/connect-flow";
import { json, siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDuePosts } from "@/lib/sns/publish/run";
import { audit } from "@/lib/sns/store";
import { sendAlert } from "@/lib/notify";
import { monthlyPrepStep } from "@/lib/monthly-prep";

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
  const started = Date.now();
  const r = await runDuePosts(admin, started + (maxDuration - 20) * 1000, { xApp: xApp() });
  if (r.processed.length || r.closed) {
    await audit(admin, null, "cron.publish", null, `${r.processed.length}件を投稿（残り ${r.remaining}件・中断 ${r.closed}件）`);
  }
  // 予約投稿が失敗・一部失敗したら、スタッフにメールで知らせる（画面を開かないと気づけないため）
  const bad = r.processed.filter((x) => x.status === "failed" || x.status === "partial");
  if (bad.length || r.closed) {
    const { data } = await admin.from("sns_clients").select("id,name").in("id", [...new Set(bad.map((x) => x.post.client_id))]);
    const name = new Map(((data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    const lines = ["予約投稿で失敗がありました。「投稿」の画面で理由を確認し、必要なら再投稿してください。", ""];
    for (const x of bad) {
      lines.push(`■ ${name.get(x.post.client_id) ?? "（クライアント）"}　${x.status === "partial" ? "一部失敗" : "失敗"}　「${x.post.text.split("\n")[0].slice(0, 40)}」`);
      for (const [k, v] of Object.entries(x.post.results)) if (v?.state === "failed") lines.push(`　・${k}：${v.error ?? "理由不明"}`);
      lines.push(`　${siteUrl()}/clients/${x.post.client_id}/publish`);
    }
    if (r.closed) lines.push("", `途中で止まった投稿が${r.closed}件あります（失敗として閉じました）。SNS上に出ていないか確認してから再投稿してください。`);
    await sendAlert(admin, `予約投稿の失敗（${bad.length + r.closed}件）`, lines);
  }
  // 月初の準備（先月のAI分析の自動実行）を1クライアントだけ進める。投稿に時間がかかった回と、残りがある回は次に回す
  let prep: string | null = null;
  if (!r.remaining && Date.now() - started < 60_000) {
    try {
      prep = await monthlyPrepStep(admin);
    } catch (e) {
      console.error("月初の準備に失敗しました", e instanceof Error ? e.message : e);
    }
  }
  return json({ processed: r.processed.length, remaining: r.remaining, closed: r.closed, prep });
}

export const GET = run;
export const POST = run;
