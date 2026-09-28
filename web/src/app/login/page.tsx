import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "ログイン" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  return (
    <main id="main" className="login" tabIndex={-1}>
      <h1>SNS分析にログイン</h1>
      {sp.e === "noaccess" && (
        <div className="msg error" role="alert">このアカウントには、SNS分析の利用権限がありません。管理者にお問い合わせください。</div>
      )}
      <LoginForm next={next} />
      <p className="footer" style={{ padding: "16px 0" }}>
        <Link href="/privacy">プライバシーポリシー</Link>
        <Link href="/terms">利用規約</Link>
      </p>
    </main>
  );
}
