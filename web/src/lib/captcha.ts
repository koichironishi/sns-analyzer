/** フォームから人間確認のトークンを取り出す（サイトキー未設定のときは空なので undefined） */
export function captchaToken(form: FormData): string | undefined {
  const v = form.get("captcha_token");
  return typeof v === "string" && v ? v : undefined;
}

/** Supabase が人間確認で止めたか */
export const isCaptchaError = (e: { code?: string; message?: string } | null) =>
  Boolean(e && (e.code === "captcha_failed" || /captcha/i.test(e.message ?? "")));

export const CAPTCHA_MESSAGE = "ロボットでないことの確認が終わっていません。確認の表示が「成功しました」になってから、もう一度お試しください。";
