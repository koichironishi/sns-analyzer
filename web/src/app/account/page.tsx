import type { Metadata } from "next";
import { requireViewer } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { AppChrome } from "@/components/app-chrome";
import { SubmitButton } from "@/components/submit-button";
import { changeEmail, changePassword } from "./actions";

export const metadata: Metadata = { title: "アカウント設定" };

/** アカウント設定（MEO と同じ形：ログイン情報のカードに、メールアドレスとパスワードの変更を並べる） */
export default async function AccountPage() {
  const v = await requireViewer();
  const first = v.kind === "client" && v.mustChangePassword;
  return (
    <AppChrome v={v}>
      <main id="main" className="app-main" tabIndex={-1}>
        <h1 className="page-title">アカウント設定</h1>
        <p className="sub">ログインに使うメールアドレスとパスワードを変更します。</p>
        {first && <div className="msg" role="status">初回ログインのため、パスワードを変更してください。変更するとレポートを見られるようになります。</div>}

        <section className="card flush account-card" aria-labelledby="h-login">
          <div className="account-head">
            <h2 id="h-login">ログイン情報</h2>
            <span className="muted">{v.email}</span>
          </div>
          <div className="account-grid">
            <ActionForm action={changeEmail} className="account-col" resetOnSuccess label="メールアドレスの変更">
              <p className="account-label">現在のメールアドレス</p>
              <p className="account-current">{v.email}</p>
              {v.kind === "staff" ? (
                <>
                  <label htmlFor="new-email">新しいメールアドレス</label>
                  <input id="new-email" name="email" type="email" autoComplete="email" placeholder="new@rhythmos-works.jp" required aria-describedby="new-email-hint" />
                  <p className="hint" id="new-email-hint">新しいアドレスに確認メールが届きます。メール内のリンクを開くまで変更は確定しません。アカウントは MEO と共通のため、MEO のログインにも反映されます。</p>
                  <div className="form-actions"><SubmitButton pendingText="送信しています…">メールアドレスを変更</SubmitButton></div>
                </>
              ) : (
                <p className="hint">メールアドレスを変更したい場合は、担当者にご連絡ください。</p>
              )}
            </ActionForm>

            <ActionForm action={changePassword} className="account-col" resetOnSuccess label="パスワードの変更">
              <label htmlFor="pw-current" style={{ marginTop: 0 }}>現在のパスワード</label>
              <input id="pw-current" name="current_password" type="password" autoComplete="current-password" required />
              <label htmlFor="pw">新しいパスワード</label>
              <input id="pw" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} placeholder="12文字以上" aria-describedby="pw-hint" />
              <label htmlFor="pw2">新しいパスワード（確認）</label>
              <input id="pw2" name="password_confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={72} />
              <p className="hint" id="pw-hint">12文字以上。ほかのサービスと同じパスワードは使わないでください。{v.kind === "staff" && "MEO のパスワードも変わります。"}</p>
              <div className="form-actions"><SubmitButton pendingText="変更しています…">パスワードを変更</SubmitButton></div>
            </ActionForm>
          </div>
        </section>
      </main>
    </AppChrome>
  );
}
