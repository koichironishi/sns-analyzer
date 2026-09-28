"use client";
import { useActionState } from "react";
import { login, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="card" noValidate>
      {state.error && <div className="msg error" role="alert" id="login-error">{state.error}</div>}
      <input type="hidden" name="next" value={next} />
      <label htmlFor="email">メールアドレス</label>
      <input id="email" name="email" type="email" autoComplete="username" required aria-required="true"
        aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "login-error" : undefined} />
      <label htmlFor="password">パスワード</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required aria-required="true"
        aria-invalid={Boolean(state.error)} aria-describedby={state.error ? "login-error" : undefined} />
      <div className="form-actions">
        <button type="submit" className="btn primary block" disabled={pending} aria-disabled={pending}>
          {pending ? "ログインしています…" : "ログイン"}
        </button>
      </div>
      <p className="hint">MEO コンソールと同じアカウントでログインできます。パスワードを忘れた場合は MEO コンソールで再設定してください。</p>
    </form>
  );
}
