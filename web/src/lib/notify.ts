import "server-only";
import nodemailer from "nodemailer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { siteUrl } from "@/lib/http";
import { audit } from "@/lib/sns/store";

/**
 * スタッフへの知らせ（メール）。予約投稿の失敗・収集のエラー・トークンの期限切れを、画面を開かなくても気づけるようにする。
 *
 * 送信は MEO と同じ SMTP（お名前.com）。環境変数：
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS … 未設定なら送らない（画面の表示はこれまでどおり）
 *   ALERT_TO        … 送り先（カンマ区切り）。未設定なら、有効な管理者スタッフ全員
 *   SMTP_FROM_NAME  … 送信者名（既定「Rhythmos マーケティング」）
 */
const env = (k: string) => (process.env[k] ?? "").trim();

export const mailConfigured = () => Boolean(env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS"));

export async function recipients(admin: SupabaseClient): Promise<string[]> {
  const fixed = env("ALERT_TO").split(",").map((x) => x.trim()).filter(Boolean);
  if (fixed.length) return fixed;
  const { data } = await admin.from("staff").select("email,role,is_active");
  return ((data ?? []) as { email: string | null; role: string; is_active: boolean }[])
    .filter((s) => s.role === "admin" && s.is_active && s.email).map((s) => s.email!);
}

/** 知らせを送る。送れたら true（未設定・失敗でも本来の処理は止めない） */
export async function sendAlert(admin: SupabaseClient, subject: string, lines: string[]): Promise<boolean> {
  try {
    return (await deliver(admin, subject, lines)) > 0;
  } catch (e) {
    console.error("知らせのメールを送れませんでした", e instanceof Error ? e.message : e);
    return false;
  }
}

/** 送る。送った人数を返し、送れなければ例外を投げる（テスト送信で理由を見せるため） */
export async function deliver(admin: SupabaseClient, subject: string, lines: string[]): Promise<number> {
  if (!mailConfigured()) throw new Error("メールの設定（SMTP_HOST・SMTP_USER・SMTP_PASS）がありません");
  const to = await recipients(admin);
  if (!to.length) throw new Error("送り先がありません（ALERT_TO も、メールアドレスのある有効な管理者もいません）");
  await sendMail(to, `【SNS分析】${subject}`, [...lines, "", `SNS分析：${siteUrl()}`, "（このメールは自動で送っています）"]);
  await audit(admin, null, "alert.mail", null, `${subject}（${to.length}人）`);
  return to.length;
}

/** メールを送る（送れなければ例外）。スタッフへの知らせと、クライアントへの月次レポートの送付で使う */
export async function sendMail(to: string[], subject: string, lines: string[]): Promise<void> {
  if (!mailConfigured()) throw new Error("メールの設定（SMTP_HOST・SMTP_USER・SMTP_PASS）がありません");
  const port = Number(env("SMTP_PORT") || 587);
  const transport = nodemailer.createTransport({
    host: env("SMTP_HOST"), port, secure: port === 465,
    auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  });
  await transport.sendMail({
    from: { name: env("SMTP_FROM_NAME") || "Rhythmos マーケティング", address: env("SMTP_USER") },
    to,
    subject,
    text: lines.join("\n"),
  });
}

/** 直近 days 日に知らせた単位（markAlerted の detail）。同じ問題を重ねて知らせないため */
export async function alertedKeys(admin: SupabaseClient, kind: string, days: number): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await admin.from("sns_audit").select("detail").eq("action", `alert.${kind}`).gte("at", since).limit(5000);
  return new Set(((data ?? []) as { detail: string | null }[]).map((r) => r.detail ?? ""));
}

export async function markAlerted(admin: SupabaseClient, kind: string, detail: string) {
  await audit(admin, null, `alert.${kind}`, null, detail.slice(0, 500));
}
