"use client";
import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} noValidate>
      {state.error && <div className="rw-msg error" role="alert" id="login-error">{state.error}</div>}
      <input type="hidden" name="next" value={next} />
      <div className="rw-field">
        <label className="rw-label" htmlFor="email">メールアドレス</label>
        <input className="rw-input" id="email" name="email" type="email" autoComplete="username" required aria-required="true" defaultValue={state.email} key={state.email}
          aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "login-error" : undefined} />
      </div>
      <div className="rw-field">
        <label className="rw-label" htmlFor="password">パスワード</label>
        <input className="rw-input" id="password" name="password" type="password" autoComplete="current-password" required aria-required="true"
          aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "login-error" : undefined} />
      </div>
      <button type="submit" className="rw-btn primary block" disabled={pending} aria-disabled={pending}>
        {pending ? "ログインしています…" : "ログイン"}
      </button>
      <p className="rw-auth-note">利用者の方は、担当者から受け取ったメールアドレスと初期パスワードでログインしてください。パスワードを忘れた場合は、担当者にご連絡ください。</p>
    </form>
  );
}
