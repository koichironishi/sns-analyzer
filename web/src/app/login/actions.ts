"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.status === 429) return { error: "試行回数が多すぎます。しばらく待ってから、もう一度お試しください。", email };
    if (error.code === "invalid_credentials" || error.code === "email_not_confirmed") {
      return { error: "メールアドレスまたはパスワードが正しくありません。", email };
    }
    // 認証情報の誤り以外（接続先・キーの設定ミスなど）は、原因を管理者が調べられるよう記録する（パスワードは記録しない）
    console.error("ログインに失敗", { status: error.status, code: error.code, name: error.name, message: error.message });
    return { error: `ログインの処理に失敗しました（${error.code ?? error.status ?? "接続エラー"}）。管理者に Supabase の接続設定の確認を依頼してください。`, email };
  }
  redirect(safeNext(form.get("next")));
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
