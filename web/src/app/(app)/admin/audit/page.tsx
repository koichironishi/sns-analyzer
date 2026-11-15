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
  "post.ai_draft": "AIで本文を作成", "post.ai_write": "AIでSNSごとに書き分け", "collect.after_connect": "連携直後の収集",
  "import.key_issue": "外部ツールの鍵を発行", "import.key_revoke": "外部ツールの鍵を無効化",
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const jst = (iso: string) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
/** 日本時間の「2026年11月13日（木）」と「20:06」 */
function dayAndTime(iso: string): { day: string; time: string } {
  const p = jst(iso);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { day: `${p.year}年${p.month}月${p.day}日（${WD[wd]}）`, time: `${p.hour}:${p.minute}` };
}

/**
 * 操作ログ。広い画面では表、960px未満では日付ごとに区切ったリストで出す（6列の表は狭い画面で1件が長くなるため）。
 * クライアントで絞り込める
 */
export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  await requireAdmin();
  const sp = await searchParams;
  const all = sp.all === "1";
  const db = await createClient();
  const clients = await listClients(db);
  const clientId = typeof sp.client === "string" && clients.some((c) => c.id === sp.client) ? sp.client : "";
  const rows = await listAudit(db, 500, { includeSystem: all, clientId: clientId || undefined });
  const name = new Map(clients.map((c) => [c.id, c.name]));
  const href = (withAll: boolean) => `/admin/audit?${new URLSearchParams({ ...(withAll ? { all: "1" } : {}), ...(clientId ? { client: clientId } : {}) })}`.replace(/\?$/, "");
  const label = (a: string) => ACTIONS[a] ?? a;
  const clientName = (id: string | null) => (id ? name.get(id) ?? "（削除済み）" : null);
  // スマートフォン用：日付ごとにまとめる（新しい順のまま）
  const days: { day: string; items: (typeof rows[number] & { time: string })[] }[] = [];
  for (const r of rows) {
    const { day, time } = dayAndTime(r.at);
    if (days.at(-1)?.day !== day) days.push({ day, items: [] });
    days.at(-1)!.items.push({ ...r, time });
  }
  return (
    <main id="main" className="app-main" tabIndex={-1}>
      <h1 className="page-title">操作ログ</h1>
      <p className="sub">直近500件。ログインは MEO と共通のため、ログインの記録は Supabase の認証ログで確認してください。</p>
      <nav className="tabs audit-tabs" aria-label="表示する記録">
        <Link className="tab" href={href(false)} aria-current={all ? undefined : "page"}>人の操作</Link>
        <Link className="tab" href={href(true)} aria-current={all ? "page" : undefined}>自動の処理も含める</Link>
      </nav>
      {!all && <p className="hint" style={{ marginTop: 0 }}>自動収集・予約投稿の処理・知らせのメール・月初の準備の記録は「自動の処理も含める」で表示します。</p>}
      <form className="audit-filter" method="get" action="/admin/audit">
        {all && <input type="hidden" name="all" value="1" />}
        <div>
          <label htmlFor="audit-client">クライアント</label>
          <select id="audit-client" name="client" defaultValue={clientId}>
            <option value="">すべてのクライアント</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <button type="submit" className="btn">絞り込む</button>
      </form>
      <p className="small muted" aria-live="polite">{clientId ? `${name.get(clientId)}の記録` : "すべての記録"}：{rows.length}件</p>
      {rows.length === 0 ? <p className="muted">記録はありません。</p> : (
        <>
          <div className="card flush scroll audit-table">
            <table>
              <thead><tr><th scope="col">日時</th><th scope="col">操作者</th><th scope="col">操作</th><th scope="col">クライアント</th><th scope="col">内容</th><th scope="col">IP</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtDateTime(r.at)}</td><td className="small audit-nowrap">{r.actor_email ?? "（システム）"}</td>
                    <td className="nowrap">{label(r.action)}</td><td className="small audit-nowrap">{clientName(r.client_id) ?? "—"}</td>
                    <td className="small audit-detail-cell">{r.detail}</td><td className="small audit-nowrap">{r.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="audit-list">
            {days.map((d) => (
              <section key={d.day} aria-label={d.day}>
                <h2 className="audit-day">{d.day}<span className="small muted">（{d.items.length}件）</span></h2>
                <ul className="card flush">
                  {d.items.map((r) => (
                    <li key={r.id} className="audit-item">
                      <p className="audit-head"><strong>{label(r.action)}</strong><span className="audit-time">{r.time}</span></p>
                      <p className="small audit-who">
                        {clientName(r.client_id) && <span>{clientName(r.client_id)}</span>}
                        <span className="muted">{r.actor_email ?? "（システム）"}</span>
                      </p>
                      {r.detail && <p className="small muted audit-detail">{r.detail}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
