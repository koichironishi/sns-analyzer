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

async function recipients(admin: SupabaseClient): Promise<string[]> {
  const fixed = env("ALERT_TO").split(",").map((x) => x.trim()).filter(Boolean);
  if (fixed.length) return fixed;
  const { data } = await admin.from("staff").select("email,role,is_active");
  return ((data ?? []) as { email: string | null; role: string; is_active: boolean }[])
    .filter((s) => s.role === "admin" && s.is_active && s.email).map((s) => s.email!);
}

/** 知らせを送る。送れたら true（未設定・失敗でも本来の処理は止めない） */
export async function sendAlert(admin: SupabaseClient, subject: string, lines: string[]): Promise<boolean> {
  if (!mailConfigured()) return false;
  try {
    const to = await recipients(admin);
    if (!to.length) return false;
    const port = Number(env("SMTP_PORT") || 587);
    const transport = nodemailer.createTransport({
      host: env("SMTP_HOST"), port, secure: port === 465,
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
    await transport.sendMail({
      from: { name: env("SMTP_FROM_NAME") || "Rhythmos マーケティング", address: env("SMTP_USER") },
      to,
      subject: `【SNS分析】${subject}`,
      text: [...lines, "", `SNS分析：${siteUrl()}`, "（このメールは自動で送っています）"].join("\n"),
    });
    await audit(admin, null, "alert.mail", null, `${subject}（${to.length}人）`);
    return true;
  } catch (e) {
    console.error("知らせのメールを送れませんでした", e instanceof Error ? e.message : e);
    return false;
  }
}

/** 今日すでに同じ種類の知らせを送ったか（1日に何度も動く処理から、同じ知らせを重ねて送らないため） */
export async function alertedToday(admin: SupabaseClient, kind: string): Promise<boolean> {
  const start = new Date(`${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })}T00:00:00+09:00`).toISOString();
  const { count } = await admin.from("sns_audit").select("id", { count: "exact", head: true })
    .eq("action", `alert.${kind}`).gte("at", start);
  return (count ?? 0) > 0;
}

export async function markAlerted(admin: SupabaseClient, kind: string, detail: string) {
  await audit(admin, null, `alert.${kind}`, null, detail.slice(0, 500));
}
