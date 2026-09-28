import type { Metadata } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { logout } from "../login/actions";
import { changePassword } from "./actions";

export const metadata: Metadata = { title: "パスワードの変更" };

export default async function AccountPage() {
  const v = await requireViewer();
  const first = v.kind === "client" && v.mustChangePassword;
  return (
    <>
      <header className="app-bar">
        <div className="app-bar-in">
          <Link className="app-brand" href="/">SNS分析</Link>
          <div className="app-right">
            <span className="who"><span className="acct-name">{v.name || v.email}</span></span>
            <form action={logout}><button type="submit" className="btn ghost sm">ログアウト</button></form>
          </div>
        </div>
      </header>
      <main id="main" className="app-main narrow" tabIndex={-1}>
        <h1 className="page-title">パスワードの変更</h1>
        {first && <div className="msg" role="status">初回ログインのため、パスワードを変更してください。変更するとレポートを見られるようになります。</div>}
        {v.kind === "staff" && <p className="sub">スタッフのアカウントは MEO コンソールと共通です。ここで変更すると、MEO コンソールのパスワードも変わります。</p>}
        <ActionForm action={changePassword} className="card" resetOnSuccess>
          <label htmlFor="pw">新しいパスワード<span className="req">必須</span></label>
          <input id="pw" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={72} aria-describedby="pw-hint" />
          <p className="hint" id="pw-hint">12文字以上。ほかのサービスと同じパスワードは使わないでください。</p>
          <label htmlFor="pw2">新しいパスワード（確認）<span className="req">必須</span></label>
          <input id="pw2" name="password_confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={72} />
          <div className="form-actions">
            <SubmitButton pendingText="変更しています…">パスワードを変更</SubmitButton>
            <Link className="btn ghost" href="/">{first ? "変更後にレポートへ" : "戻る"}</Link>
          </div>
        </ActionForm>
      </main>
    </>
  );
}
