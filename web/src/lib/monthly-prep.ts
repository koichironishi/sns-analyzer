import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { siteUrl } from "@/lib/http";
import { monthLabel, monthRange } from "@/lib/monthly";
import { alertedKeys, markAlerted, sendAlert } from "@/lib/notify";
import { AIError } from "@/lib/sns/ai";
import { AiNotReady, runAiForClient } from "@/lib/sns/ai-run";
import { PREP_MAX_TRIES, PREP_RUNNING_MIN, prepWindow } from "@/lib/sns/alert-rules";
import { todayIn, toLocal } from "@/lib/sns/models";
import { consentProblem, consentState } from "@/lib/sns/privacy";
import { audit, getConsentRow } from "@/lib/sns/store";

type Db = SupabaseClient;

/**
 * 月初の準備：先月を対象にしたAI分析を、同意のあるクライアントについて自動で実行し、月次レポートを「送るだけ」にする。
 * 予約投稿の定期処理（5分おき）から呼び、1回に1クライアントだけ進める（AI分析は数分かかるため）。
 * 全員が終わったら、スタッフに「準備ができました」と送付の一覧を知らせる
 */
export async function monthlyPrepStep(admin: Db): Promise<string | null> {
  const now = new Date().toISOString();
  const plan = prepWindow(todayIn(), toLocal(now).hour);
  if (!plan) return null;
  const { month } = plan;
  if ((await alertedKeys(admin, "prep", 40)).has(`${month}:done`)) return null;
  const { start, end, days } = monthRange(month);

  const [{ data: conns }, { data: clients }, { data: results }, { data: logs }] = await Promise.all([
    admin.from("sns_connections").select("client_id"),
    admin.from("sns_clients").select("id,name"),
    admin.from("sns_ai_results").select("client_id").eq("period_end", end).eq("days", days),
    admin.from("sns_audit").select("detail,at").eq("action", "monthly.ai").like("detail", `${month}:%`),
  ]);
  const name = new Map(((clients ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const active = [...new Set(((conns ?? []) as { client_id: string }[]).map((c) => c.client_id))]
    .filter((id) => name.has(id)).sort((a, b) => name.get(a)!.localeCompare(name.get(b)!, "ja"));
  const done = new Set(((results ?? []) as { client_id: string }[]).map((r) => r.client_id));
  // 監査ログの detail：「YYYY-MM:<clientId>:start」「…:fail:<理由>」「…:skip:<理由>」
  const entries = ((logs ?? []) as { detail: string; at: string }[]).map((l) => {
    const [, id, kind, ...rest] = l.detail.split(":");
    return { id, kind, reason: rest.join(":"), at: l.at };
  });
  const tries = (id: string) => entries.filter((e) => e.id === id && e.kind === "start");
  const skipped = (id: string) => entries.find((e) => e.id === id && e.kind === "skip");
  // 実行中：最後に始めてから PREP_RUNNING_MIN 分以内で、まだ失敗も記録されていない（止まった実行は時間がたてばやり直す）
  const running = (id: string) => {
    const last = tries(id).map((e) => e.at).sort().at(-1);
    return Boolean(last && Date.parse(last) > Date.now() - PREP_RUNNING_MIN * 60_000
      && !entries.some((e) => e.id === id && e.kind !== "start" && e.at >= last));
  };

  // 次に進めるクライアント（まだ結果がなく、同意の問題で外しておらず、上限まで試していない）
  for (const id of active) {
    if (done.has(id) || skipped(id) || tries(id).length >= PREP_MAX_TRIES) continue;
    if (running(id)) return `実行中：${name.get(id)}`;
    const problem = consentProblem(consentState(await getConsentRow(admin, id)));
    if (problem) {
      await audit(admin, null, "monthly.ai", id, `${month}:${id}:skip:AI分析の同意なし`);
      continue;
    }
    await audit(admin, null, "monthly.ai", id, `${month}:${id}:start`);
    try {
      const r = await runAiForClient(admin, admin, id, { days, end, createdBy: null });
      await audit(admin, null, "ai.run", id, `月初の自動実行・${days}日間・${end}まで・${r._meta.model}・投稿${r._meta.postsSent}件`);
      return `完了：${name.get(id)}`;
    } catch (e) {
      const msg = e instanceof AIError ? e.message : "AI分析に失敗しました";
      await audit(admin, null, "monthly.ai", id, `${month}:${id}:${e instanceof AiNotReady ? "skip" : "fail"}:${msg}`);
      return `失敗：${name.get(id)}（${msg}）`;
    }
  }

  // 全員を処理し終えた：送付の一覧をスタッフに知らせる（月の1回目の知らせを兼ねる）
  const ready = active.filter((id) => done.has(id));
  const others = active.filter((id) => !done.has(id));
  const reason = (id: string) => skipped(id)?.reason ?? entries.filter((e) => e.id === id && e.kind === "fail").at(-1)?.reason ?? "AI分析なし";
  const link = (id: string) => `${siteUrl()}/clients/${id}/monthly?month=${month}`;
  const label = monthLabel(month);
  const ok = active.length === 0 || await sendAlert(admin, `${label}の月次レポートの準備ができました`, [
    `${label}（${start.slice(5).replace("-", "/")}〜${end.slice(5).replace("-", "/")}）の月次レポートを準備しました。内容を確認して、クライアントに送ってください。`,
    "",
    ...(ready.length ? [`■ AI分析まで済んだクライアント（${ready.length}件）`, ...ready.map((id) => `・${name.get(id)}\n　${link(id)}`)] : []),
    ...(others.length ? ["", `■ AI分析なしのクライアント（${others.length}件）：数字のレポートは送れます。AI分析が必要なら画面から実行してください`,
      ...others.map((id) => `・${name.get(id)}（${reason(id)}）\n　${link(id)}`)] : []),
  ]);
  if (ok) {
    await markAlerted(admin, "prep", `${month}:done`);
    await markAlerted(admin, "monthly", `${month}:first`);
  }
  return `準備完了：AI分析 ${ready.length}件・なし ${others.length}件`;
}
