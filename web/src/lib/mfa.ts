import type { Factor, User } from "@supabase/supabase-js";

/**
 * 多要素認証（MFA。認証アプリの6桁のコード）。MEO と同じ作り（2026-11-16）。
 *
 * **ログイン（Supabase Auth）は MEO と共通。** MEO で登録した人は、SNS でも2段階目を求めないと、
 * SNS の入口からパスワードだけで入れてしまう。Supabase はパスワードが合えば aal1（1段階目）の
 * セッションを出すので、アプリ側で止める。止めているのはプロキシ（lib/supabase/proxy.ts）と
 * 利用者の判定（lib/auth.ts の requireViewer）の2か所。
 *
 * **登録していない人は今までどおり入れる**（必須にすると、設定を終えていない人がその日から入れなくなるため）。
 */
export type MfaState = {
  /** 検証済みの要素を1つ以上持っているか（＝MFA を登録済み） */
  enrolled: boolean;
  /** いまのセッションが2段階目まで通っているか */
  satisfied: boolean;
};

/** 全角の数字を半角に直し、数字だけにする（日本語入力のまま打つと全角になり、見た目は同じなのに弾かれるため） */
export function cleanCode(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "").slice(0, 6);
}

/**
 * アクセストークンから aal（何段階まで通ったか）を読む。
 * **信じてよいのは、同じトークンを getUser() で確かめた直後だけ**（認証サーバーが署名を確かめたあと）。
 */
export function readAal(accessToken: string | null | undefined): string | null {
  const part = accessToken?.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as { aal?: string };
    return payload.aal ?? null;
  } catch {
    return null;
  }
}

/** user は必ず getUser()（認証サーバーで確認済み）の戻り値を渡す。クッキーから読んだだけの値では要素の有無を偽れる */
export function mfaState(user: User | null, accessToken: string | null | undefined): MfaState {
  const factors: Factor[] = user?.factors ?? [];
  const enrolled = factors.some((f) => f.status === "verified");
  if (!enrolled) return { enrolled: false, satisfied: true };
  const aal = readAal(accessToken);
  if (aal === null) {
    // 読めないのはこちらの不具合（読めないトークンは getUser() も通らない）。締め出すと登録者が全員入れなくなるので通し、ログに出す
    console.error("[mfa] aal を読めませんでした。MFA の確認を省略します");
    return { enrolled: true, satisfied: true };
  }
  return { enrolled: true, satisfied: aal === "aal2" };
}

/** ログイン後の戻り先として安全か（自サイトの中だけ）。
 *  ブラウザは URL の中のタブ・改行を読み飛ばすため、"/\t/evil.com" は "//evil.com"（外部）になる。
 *  制御文字とバックスラッシュを含むものは断り、さらに URL として解釈して自サイト内かを確かめる */
export const safeNext = (v: unknown): string => {
  const s = typeof v === "string" ? v : "";
  if (!s.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(s)) return "/";
  try {
    const u = new URL(s, "http://self.invalid");
    return u.origin === "http://self.invalid" ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
};
