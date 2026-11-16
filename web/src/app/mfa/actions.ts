"use server";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/http";
import { cleanCode, safeNext } from "@/lib/mfa";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/sns/store";

export type MfaState = { error?: string };

/**
 * ログインの2段階目：認証アプリの6桁のコードを確かめる。通れば aal2 のセッションに上がる。
 * **失敗は記録する。** パスワードは合っていたのに2段階目で止まった＝正しいパスワードを持っている誰かがいる、という意味になるため。
 */
export async function verifyMfa(_: MfaState, form: FormData): Promise<MfaState> {
  const code = cleanCode(String(form.get("code") ?? ""));
  if (code.length !== 6) return { error: "認証アプリに出ている6桁の数字を入れてください。" };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp.find((f) => f.status === "verified");
  if (!factor) redirect(safeNext(form.get("next")));
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) {
    await audit(createAdminClient(), { id: user.id, email: user.email ?? "" }, "auth.mfa_failed", null, "認証アプリ", await clientIp()).catch(() => {});
    if (error.status === 429) return { error: "試行回数が多すぎます。しばらく待ってから、もう一度お試しください。" };
    return { error: "確認コードが正しくありません。認証アプリに出ている、いまの6桁を入れてください（30秒ごとに変わります）。" };
  }
  redirect(safeNext(form.get("next")));
}
