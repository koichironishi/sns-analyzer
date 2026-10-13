"use server";
import { getViewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit, updateViewerRow } from "@/lib/sns/store";
import type { ActionState } from "../(app)/clients/[id]/settings/actions";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** パスワードの変更（MEO と同じく、現在のパスワードで本人確認してから変える） */
export async function changePassword(_: ActionState, form: FormData): Promise<ActionState> {
  const v = await getViewer();
  if (!v) return { error: "ログインし直してください" };
  const current = String(form.get("current_password") ?? "");
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("password_confirm") ?? "");
  if (!current) return { error: "現在のパスワードを入力してください" };
  if (password.length < 12) return { error: "新しいパスワードは12文字以上にしてください" };
  if (password.length > 72) return { error: "新しいパスワードは72文字以内にしてください" };
  if (password !== confirm) return { error: "確認用のパスワードが一致しません" };
  if (password === current) return { error: "現在のパスワードと同じです" };
  const supabase = await createClient();
  const { error: authError } = await supabase.auth.signInWithPassword({ email: v.email, password: current });
  if (authError) return { error: "現在のパスワードが正しくありません" };
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: /same|different/i.test(error.message) ? "今と同じパスワードは使えません" : `変更できませんでした：${error.message}` };
  }
  const admin = createAdminClient();
  if (v.kind === "client") await updateViewerRow(admin, v.id, { must_change_password: false });
  await audit(admin, v, "account.password", v.kind === "client" ? v.clientId : null, "", await clientIp());
  return { ok: "パスワードを変更しました。" };
}

/**
 * メールアドレスの変更（スタッフのみ。アカウントは MEO と共通）。
 * 新しいアドレスに確認メールが届き、リンクを開くと確定する。確定の処理は MEO の /auth/callback で行う
 * （Supabase のリダイレクト先として MEO の URL がすでに許可されているため）。
 */
export async function changeEmail(_: ActionState, form: FormData): Promise<ActionState> {
  const v = await getViewer();
  if (!v) return { error: "ログインし直してください" };
  if (v.kind !== "staff") return { error: "メールアドレスの変更は担当者にご依頼ください" };
  const email = String(form.get("email") ?? "").trim();
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: "メールアドレスの形式を確認してください" };
  if (email.toLowerCase() === v.email.toLowerCase()) return { error: "現在のメールアドレスと同じです" };
  const meo = process.env.NEXT_PUBLIC_MEO_URL || "https://meo.rhythmos-works.jp";
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ email }, { emailRedirectTo: `${meo}/auth/callback?next=/account` });
  if (error) return { error: "変更できませんでした。すでに使われているアドレスの可能性があります" };
  await audit(createAdminClient(), v, "account.email", null, "確認メールを送信", await clientIp());
  return { ok: "確認メールを送信しました。新しいアドレス宛のリンクを開くと変更が確定します。" };
}
