"use client";
import { createContext, useContext, useEffect, useRef } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

/**
 * ログイン・パスワード変更の前に置く人間確認（Cloudflare Turnstile。MEO と同じウィジェット・同じサイトキー）。
 *
 * 確認が済むと、フォームの中に captcha_token という隠し項目が入り、送信すると Server Action に届く。
 * Server Action は captchaToken として Supabase に渡す。
 *
 * **サイトキーが未設定のときは何も出さず、トークンも送らない。**
 * Supabase の CAPTCHA は MEO と SNS で共通（同じプロジェクト）なので、
 * 必ず「MEO と SNS の両方でサイトキーを設定 → 表示とログインを確認 → Supabase を有効化」の順にする。
 *
 * トークンは1回しか使えない。送信のたびに resetKey が変わり、取り直す（呼ばないと2回目以降が必ず失敗する）。
 */
const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
export const CAPTCHA_FIELD = "captcha_token";

/** フォームの送信回数（ActionForm が送信のたびに増やす）。変わったら確認を取り直す */
export const FormSubmitCount = createContext<number>(0);

export function CaptchaField({ resetKey }: { resetKey?: unknown }) {
  const count = useContext(FormSubmitCount);
  const key = resetKey ?? count;
  const widget = useRef<TurnstileInstance | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    widget.current?.reset();
  }, [key]);
  if (!SITE_KEY) return null;
  return (
    <div className="captcha-field">
      <Turnstile ref={widget} siteKey={SITE_KEY} options={{ language: "ja", theme: "light", responseFieldName: CAPTCHA_FIELD }} />
    </div>
  );
}
