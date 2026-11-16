"use server";
import { getViewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { cleanCode } from "@/lib/mfa";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/sns/store";

/**
 * 多要素認証（認証アプリ）の設定と解除。アカウントは MEO と共通なので、ここで設定すると MEO のログインにも効く。
 * 名前は MEO と同じ「認証アプリ」（Supabase は同じ人の要素に同じ名前を許さないため、1人1つになる）。
 */
const NAME = "認証アプリ";

async function staffOnly() {
  const v = await getViewer();
  return v && v.kind === "staff" ? v : null;
}

export type EnrollStart = { ok: true; factorId: string; qr: string; secret: string } | { ok: false; error: string };

/** 設定を始める：QR コードと、手で入れる用の文字列を返す。途中でやめた要素（未確認）が残っていれば先に消す */
export async function startMfaEnroll(): Promise<EnrollStart> {
  if (!(await staffOnly())) return { ok: false, error: "ログインし直してください" };
  const supabase = await createClient();
  const { data: list } = await supabase.auth.mfa.listFactors();
  if (list?.totp.some((f) => f.status === "verified")) return { ok: false, error: "すでに設定されています（MEO で設定した場合も含みます）。" };
  for (const f of list?.all ?? []) if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: NAME, issuer: "Rhythmos" });
  if (error || !data) return { ok: false, error: `設定を始められませんでした（${error?.message ?? "不明なエラー"}）。` };
  return { ok: true, factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

/** 設定を終える：アプリに出た6桁で確かめる。通るとこのセッションは2段階目まで通った状態になる */
export async function finishMfaEnroll(factorId: string, rawCode: string): Promise<{ ok: boolean; error?: string }> {
  const v = await staffOnly();
  if (!v) return { ok: false, error: "ログインし直してください" };
  const code = cleanCode(rawCode);
  if (code.length !== 6) return { ok: false, error: "認証アプリに出ている6桁の数字を入れてください" };
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: String(factorId), code });
  if (error) return { ok: false, error: "確認コードが正しくありません。アプリに出ている、いまの6桁を入れてください" };
  await audit(createAdminClient(), v, "auth.mfa_enrolled", null, NAME, await clientIp());
  return { ok: true };
}

/** 解除する（2段階目を通ったセッションでないと Supabase が断る） */
export async function removeMfa(factorId: string): Promise<{ ok: boolean; error?: string }> {
  const v = await staffOnly();
  if (!v) return { ok: false, error: "ログインし直してください" };
  const supabase = await createClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId: String(factorId) });
  if (error) return { ok: false, error: `解除できませんでした（${error.message}）。ログインし直してから、もう一度お試しください` };
  await audit(createAdminClient(), v, "auth.mfa_removed", null, NAME, await clientIp());
  return { ok: true };
}
