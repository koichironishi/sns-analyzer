"use server";
import { revalidatePath } from "next/cache";
import { getViewer, UUID_RE } from "@/lib/auth";
import { clientIp, siteUrl } from "@/lib/http";
import { monthLabel, monthlyAccounts, monthlyAudience, monthlyMailLines, monthlyMeo, monthlyReport, parseMonth } from "@/lib/monthly";
import { mailConfigured, sendMail } from "@/lib/notify";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, listViewers } from "@/lib/sns/store";
import type { ActionState } from "../settings/actions";

/** 月次レポートを、そのクライアントの利用者（有効な人）にメールで送る。スタッフだけ */
export async function sendMonthlyReport(_: ActionState, form: FormData): Promise<ActionState> {
  const v = await getViewer();
  if (!v || v.kind !== "staff") return { error: "権限がありません" };
  const clientId = String(form.get("client_id") ?? "");
  if (!UUID_RE.test(clientId)) return { error: "クライアントが正しくありません" };
  const month = parseMonth(String(form.get("month") ?? ""));
  if (!mailConfigured()) return { error: "メールの設定がありません（全体設定の「知らせのメール」を確認してください）" };
  const admin = createAdminClient();
  const to = (await listViewers(admin, clientId)).filter((u) => u.is_active && u.email).map((u) => u.email);
  if (!to.length) return { error: "送り先がありません。「利用者管理」でクライアントの利用者を登録してください。" };
  try {
    const r = await monthlyReport(clientId, month);
    const [accts, meo, aud] = await Promise.all([monthlyAccounts(r, month), monthlyMeo(clientId, month), monthlyAudience(r)]);
    const lines = monthlyMailLines(r, month, `${siteUrl()}/clients/${clientId}/monthly?month=${month}`, accts, meo, aud);
    // 利用者どうしにほかの人のアドレスが見えないよう、1人ずつ送る
    for (const addr of to) await sendMail([addr], `【SNSレポート】${r.client.name} ${monthLabel(month)}`, lines);
    await audit(admin, v, "monthly.sent", clientId, `${month}：${to.join(", ")}`, await clientIp());
    revalidatePath(`/clients/${clientId}/monthly`);
    return { ok: `${monthLabel(month)}のレポートを${to.length}人に送りました（${to.join("、")}）。` };
  } catch (e) {
    return { error: `送れませんでした：${e instanceof Error ? e.message : String(e)}` };
  }
}
