"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CAPTCHA_MESSAGE, captchaToken, isCaptchaError } from "@/lib/captcha";
import { clientIp } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/sns/store";

/**
 * ログインの成否を操作ログに残す（2026-11-16）。**失敗のほうが本題。** 同じアカウントに失敗が並べば、
 * 総当たりや流出パスワードの使い回しを受けていると分かる。IP を含むため、90日で消す（日次の収集で整理）。
 * 記録できるのは SNS のログイン画面を通った分だけ。Supabase の認証 API を直接叩かれた分は残らない
 * （その前に人間確認が立っている）。記録に失敗してもログインは止めない。
 */
async function recordLogin(email: string, result: "ok" | "credentials" | "no_access" | "captcha", userId: string | null = null) {
  try {
    const action = result === "ok" ? "auth.login" : result === "no_access" ? "auth.no_access" : "auth.login_failed";
    await audit(createAdminClient(), { id: userId ?? "", email: email.trim().toLowerCase().slice(0, 254) }, action, null,
      result === "credentials" ? "パスワードの誤りなど" : result === "captcha" ? "人間確認が未完了" : "", await clientIp());
  } catch (e) {
    console.error("ログインの記録に失敗", e instanceof Error ? e.message : e);
  }
}

/** SNS分析の利用権限がないアカウントへの案内（ログインが MEO と共通のため、MEO だけの契約でもログインは通る） */
const NO_ACCESS_MESSAGE = "このアカウントでは SNS をご利用いただけません。ご利用をご希望の場合は、担当者にお問い合わせください。";

export type LoginState = { error?: string; email?: string };

const safeNext = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/";
};

export async function login(_: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "メールアドレスとパスワードを入力してください。", email };
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken: captchaToken(form) } });
  if (error) {
    if (isCaptchaError(error)) { await recordLogin(email, "captcha"); return { error: CAPTCHA_MESSAGE, email }; }
    if (error.status === 429) { await recordLogin(email, "credentials"); return { error: "試行回数が多すぎます。しばらく待ってから、もう一度お試しください。", email }; }
    if (error.code === "invalid_credentials" || error.code === "email_not_confirmed") {
      await recordLogin(email, "credentials");
      return { error: "メールアドレスまたはパスワードが正しくありません。", email };
    }
    // 認証情報の誤り以外（接続先・キーの設定ミスなど）は、原因を管理者が調べられるよう記録する（パスワードは記録しない）
    await recordLogin(email, "credentials");
    console.error("ログインに失敗", { status: error.status, code: error.code, name: error.name, message: error.message });
    return { error: `ログインの処理に失敗しました（${error.code ?? error.status ?? "接続エラー"}）。管理者に Supabase の接続設定の確認を依頼してください。`, email };
  }
  // パスワードが合っていても、スタッフか SNS分析の利用者でなければ入れない（MEO だけの契約など）
  const uid = data.user.id;
  const [{ data: staff }, { data: cu }] = await Promise.all([
    supabase.from("staff").select("is_active").eq("id", uid).maybeSingle(),
    supabase.from("sns_client_users").select("is_active").eq("user_id", uid).maybeSingle(),
  ]);
  if (!staff?.is_active && !cu?.is_active) {
    await supabase.auth.signOut();
    await recordLogin(email, "no_access", uid);
    return { error: NO_ACCESS_MESSAGE, email };
  }
  await recordLogin(email, "ok", uid);
  // 多要素認証を登録している人は、確認コードの画面へ（パスワードだけでは1段階目のセッションしか出ない）
  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (level?.nextLevel === "aal2" && level.currentLevel !== "aal2") {
    const next = safeNext(form.get("next"));
    redirect(next === "/" ? "/mfa" : `/mfa?next=${encodeURIComponent(next)}`);
  }
  redirect(safeNext(form.get("next")));
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
