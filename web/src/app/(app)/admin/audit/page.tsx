import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listAudit, listClients } from "@/lib/sns/store";
import { fmtDateTime } from "@/lib/format";
import Link from "next/link";

export const metadata: Metadata = { title: "操作ログ" };

const ACTIONS: Record<string, string> = {
  "ai.run": "AI分析を実行", download: "ダウンロード", "collect.manual": "今すぐ収集", "connect.meta": "Facebook・Instagram を連携",
  "connect.meta.failed": "Meta 連携に失敗", "connect.threads": "Threads を連携", "connect.threads.failed": "Threads 連携に失敗", "connect.x": "X を連携",
  disconnect: "連携を解除", "competitor.add": "競合を追加", "competitor.update": "競合を更新", "competitor.delete": "競合を削除",
  "consent.grant": "AI分析の同意を記録", "consent.revoke": "AI分析の同意を撤回", "brand.update": "事業内容を更新", "import.csv": "CSV取り込み",
  "followers.manual": "フォロワー数を記録", "data.delete": "データ削除", "data.delete_all": "全データ削除", "settings.update": "全体設定を更新",
  "deletion.request": "削除リクエスト（Meta・Threads）", "cron.collect": "自動収集",
  "client.create": "クライアントを登録", "client.update": "クライアント情報を更新", "client.delete": "クライアントを削除",
  "viewer.add": "利用者を追加", "viewer.reset_password": "初期パスワードを再発行", "viewer.remove": "利用者を削除",
  "account.password": "パスワードを変更", "account.email": "メールアドレスの変更を申請", "connect.x.failed": "X 連携に失敗",
  "post.save": "投稿を保存・予約", "post.publish": "投稿を実行", "post.cancel": "予約を取り消し", "post.retry": "再投稿", "post.delete": "投稿を削除", "post.delete_bulk": "投稿をまとめて削除", "post.bulk": "CSVで一括予約",
  "cron.publish": "予約投稿", "post.approve": "投稿を承認", "post.reject": "投稿を差し戻し", "client.approval": "承認の設定を変更",
  "account.nickname": "アカウントの呼び名を変更", "client.meo": "MEO との結び付けを変更", "monthly.sent": "月次レポートを送付", "alert.test": "知らせのメールをテスト送信",
  "alert.mail": "知らせのメールを送信", "alert.collect": "収集エラーを通知", "alert.token": "連携の期限を通知", "alert.monthly": "月次レポートの送付を通知",
  "alert.prep": "月初の準備が完了", "monthly.ai": "月初の準備（AI分析）",
};

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdmin();
  const all = (await searchParams).all === "1";
  const db = await createClient();
  const [rows, clients] = await Promise.all([listAudit(db, 500, { includeSystem: all }), listClients(db)]);
  const name = new Map(clients.map((c) => [c.id, c.name]));
  return (
    <main id="main" className="app-main" tabIndex={-1}>
      <h1 className="page-title">操作ログ</h1>
      <p className="sub">直近500件。ログインは MEO と共通のため、ログインの記録は Supabase の認証ログで確認してください。</p>
      <nav className="tabs" aria-label="表示する記録" style={{ marginBottom: 16 }}>
        <Link className="tab" href="/admin/audit" aria-current={all ? undefined : "page"}>人の操作</Link>
        <Link className="tab" href="/admin/audit?all=1" aria-current={all ? "page" : undefined}>自動の処理も含める</Link>
      </nav>
      {!all && <p className="hint" style={{ marginTop: 0 }}>自動収集・予約投稿の処理・知らせのメール・月初の準備の記録は「自動の処理も含める」で表示します。</p>}
      <div className="card flush scroll">
        <table>
          <thead><tr><th scope="col">日時</th><th scope="col">操作者</th><th scope="col">操作</th><th scope="col">クライアント</th><th scope="col">内容</th><th scope="col">IP</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{fmtDateTime(r.at)}</td><td className="small">{r.actor_email ?? "（システム）"}</td>
                <td className="nowrap">{ACTIONS[r.action] ?? r.action}</td><td className="small">{r.client_id ? name.get(r.client_id) ?? "（削除済み）" : "—"}</td>
                <td className="small">{r.detail}</td><td className="small">{r.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
