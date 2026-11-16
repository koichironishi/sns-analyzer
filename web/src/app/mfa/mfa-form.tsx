"use client";
import { useActionState } from "react";
import { logout } from "@/app/login/actions";
import { verifyMfa, type MfaState } from "./actions";

export function MfaForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<MfaState, FormData>(verifyMfa, {});
  return (
    <>
      <form action={action} noValidate>
        {state.error && <div className="rw-msg error" role="alert" id="mfa-error">{state.error}</div>}
        <input type="hidden" name="next" value={next} />
        <div className="rw-field">
          <label className="rw-label" htmlFor="mfa-code">確認コード（6桁）</label>
          <input className="rw-input mfa-code" id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
            required aria-required="true" autoFocus aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "mfa-error mfa-hint" : "mfa-hint"} />
          <p className="rw-auth-note" id="mfa-hint" style={{ marginTop: 8 }}>スマートフォンの認証アプリ（Google Authenticator など）に出ている数字です。30秒ごとに変わります。</p>
        </div>
        <button type="submit" className="rw-btn primary block" disabled={pending} aria-disabled={pending}>
          {pending ? "確かめています…" : "確認してログイン"}
        </button>
      </form>
      <form action={logout} style={{ marginTop: 16 }}>
        <button type="submit" className="rw-btn block">別のアカウントでログインする</button>
      </form>
      <p className="rw-auth-note">スマートフォンをなくした・認証アプリを消した場合は、管理者にご連絡ください。</p>
    </>
  );
}
