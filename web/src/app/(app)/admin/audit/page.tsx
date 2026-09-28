import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listAudit, listClients } from "@/lib/sns/store";
import { fmtDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "操作ログ" };

const ACTIONS: Record<string, string> = {
  "ai.run": "AI分析を実行", download: "ダウンロード", "collect.manual": "今すぐ収集", "connect.meta": "Facebook・Instagram を連携",
  "connect.meta.failed": "Meta 連携に失敗", "connect.threads": "Threads を連携", "connect.threads.failed": "Threads 連携に失敗", "connect.x": "X を連携",
  disconnect: "連携を解除", "competitor.add": "競合を追加", "competitor.update": "競合を更新", "competitor.delete": "競合を削除",
  "consent.grant": "AI分析の同意を記録", "consent.revoke": "AI分析の同意を撤回", "brand.update": "事業内容を更新", "import.csv": "CSV取り込み",
  "followers.manual": "フォロワー数を記録", "data.delete": "データ削除", "data.delete_all": "全データ削除", "settings.update": "全体設定を更新",
  "deletion.request": "削除リクエスト（Meta・Threads）", "cron.collect": "自動収集",
};

export default async function AuditPage() {
  await requireAdmin();
  const db = await createClient();
  const [rows, clients] = await Promise.all([listAudit(db, 500), listClients(db)]);
  const name = new Map(clients.map((c) => [c.id, c.name]));
  return (
    <main id="main" className="app-main" tabIndex={-1}>
      <h1 className="page-title">操作ログ</h1>
      <p className="sub">直近500件。ログインは MEO と共通のため、ログインの記録は Supabase の認証ログで確認してください。</p>
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
