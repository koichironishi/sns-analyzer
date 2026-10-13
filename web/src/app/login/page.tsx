import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "ログイン" };

/** ログイン画面（MEO・WordPress ツールと共通の見た目。rhythmos-ui.css の .rw-auth） */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  return (
    <main id="main" className="rw-auth" tabIndex={-1}>
      <div className="rw-auth-box">
        <div className="rw-auth-brand">
          <span className="rw-auth-mark" aria-hidden="true">S</span>
          <span><span className="rw-auth-name">SNS分析</span><span className="rw-auth-sub">Rhythmos</span></span>
        </div>
        <div className="rw-auth-card">
          <h1 className="rw-auth-title">ログイン</h1>
          <p className="rw-auth-lead">スタッフは MEO と同じアカウントでログインできます。</p>
          {sp.e === "noaccess" && (
            <div className="rw-msg error" role="alert">このアカウントには、SNS分析の利用権限がありません。管理者にお問い合わせください。</div>
          )}
          <LoginForm next={next} />
        </div>
        <p className="rw-auth-foot">
          <Link href="/privacy">プライバシーポリシー</Link>
          <Link href="/terms">利用規約</Link>
        </p>
      </div>
    </main>
  );
}
