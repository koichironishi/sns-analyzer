import type { Metadata } from "next";
import { safeNext } from "@/lib/mfa";
import { MfaForm } from "./mfa-form";

export const metadata: Metadata = { title: "確認コードの入力" };

/** ログインの2段階目（多要素認証を登録した人だけ）。ここへ誰を送るかはプロキシ（lib/supabase/proxy.ts）が決める */
export default async function MfaPage({ searchParams }: PageProps<"/mfa">) {
  const sp = await searchParams;
  return (
    <main id="main" className="rw-auth" tabIndex={-1}>
      <div className="rw-auth-box">
        <div className="rw-auth-brand">
          <span className="rw-auth-name">GOENOS SNS</span>
        </div>
        <div className="rw-auth-card">
          <h1 className="rw-auth-title">確認コードの入力</h1>
          <p className="rw-auth-lead">このアカウントは2段階のログインを設定しています。認証アプリに出ている6桁の数字を入れてください。</p>
          <MfaForm next={safeNext(sp.next)} />
        </div>
      </div>
    </main>
  );
}
