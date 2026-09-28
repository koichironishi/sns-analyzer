"use server";
import { getViewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit, updateViewerRow } from "@/lib/sns/store";
import type { ActionState } from "../(app)/clients/[id]/settings/actions";

export async function changePassword(_: ActionState, form: FormData): Promise<ActionState> {
  const v = await getViewer();
  if (!v) return { error: "ログインし直してください" };
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("password_confirm") ?? "");
  if (password.length < 12) return { error: "パスワードは12文字以上にしてください" };
  if (password.length > 72) return { error: "パスワードは72文字以内にしてください" };
  if (password !== confirm) return { error: "確認用のパスワードが一致しません" };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: /same|different/i.test(error.message) ? "今と同じパスワードは使えません" : /reauth|recent/i.test(error.message) ? "安全のため、一度ログアウトしてログインし直してから変更してください" : `変更できませんでした：${error.message}` };
  }
  const admin = createAdminClient();
  if (v.kind === "client") await updateViewerRow(admin, v.id, { must_change_password: false });
  await audit(admin, v, "account.password", v.kind === "client" ? v.clientId : null, "", await clientIp());
  return { ok: "パスワードを変更しました。" };
}
