import type { Metadata } from "next";

export const metadata: Metadata = { title: "初期設定" };

export default function SetupPage() {
  return (
    <main id="main" className="app-main narrow" tabIndex={-1}>
      <h1 className="page-title">初期設定が必要です</h1>
      <div className="msg error" role="alert">Supabase の接続先が設定されていません。</div>
      <p>環境変数 <code>NEXT_PUBLIC_SUPABASE_URL</code>・<code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>・<code>SUPABASE_SERVICE_ROLE_KEY</code> を設定してから、もう一度デプロイしてください。手順は web/README.md をご覧ください。</p>
    </main>
  );
}
