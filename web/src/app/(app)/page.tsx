import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionOverview, listClients, listCollectState, postStatusCounts } from "@/lib/sns/store";
import { daysLeft } from "@/lib/sns/connect";
import { PLATFORMS, PLATFORM_LABELS } from "@/lib/sns/models";
import { fmtDateTime } from "@/lib/format";
import { ActionForm } from "@/components/action-form";
import { Flash } from "@/components/flash";
import { SubmitButton } from "@/components/submit-button";
import { EmptyState } from "@/components/empty-state";
import { createClientAction } from "./client-actions";

export const metadata: Metadata = { title: "クライアント一覧" };

export default async function ClientsPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const v = await requireViewer();
  if (v.kind === "client") redirect(`/clients/${v.clientId}`);
  const db = await createClient();
  const admin = createAdminClient();
  const [clients, conns, states, counts] = await Promise.all([listClients(db), connectionOverview(admin), listCollectState(db), postStatusCounts(admin)]);
  // クライアントごとの「対応が要ること」。毎朝この一覧だけで確認できるようにする
  const issues = new Map(clients.map((c) => {
    const mine = conns.filter((x) => x.client_id === c.id);
    const relink = mine.filter((x) => { const d = daysLeft(x.token_expires_at); return x.status === "error" || (d !== null && d <= 7); }).length;
    const collect = states.filter((s) => s.client_id === c.id && s.last_error).length;
    return [c.id, { relink, collect, failed: counts.failed.get(c.id) ?? 0, pending: counts.pending.get(c.id) ?? 0 }];
  }));
  const attention = clients.filter((c) => { const i = issues.get(c.id)!; return i.relink + i.collect + i.failed > 0; }).length;
  // 対応が要るクライアントを先に並べる（並びは名前順のまま）
  const sorted = [...clients].sort((a, b) => {
    const w = (id: string) => { const i = issues.get(id)!; return i.relink + i.collect + i.failed > 0 ? 0 : i.pending > 0 ? 1 : 2; };
    return w(a.id) - w(b.id);
  });
  return (
    <main id="main" className="app-main" tabIndex={-1}>
      <h1 className="page-title">クライアント一覧</h1>
      <p className="sub">SNS分析のクライアントです（MEO のクライアントとは別に管理します）。スタッフは MEO と同じアカウントでログインできます。</p>
      {clients.length > 0 && (
        <p className={`msg ${attention ? "error" : "ok"}`} role="status">
          {attention ? `対応が必要なクライアントが${attention}件あります（一覧の上に並べています）。` : "対応が必要なクライアントはありません。"}
        </p>
      )}
      {sp.ok === "client_deleted" && <Flash kind="ok">クライアントと、そのSNSデータをすべて削除しました。</Flash>}
      <details className="card no-print" style={{ marginBottom: 16 }} open={clients.length === 0}>
        <summary className="btn primary" style={{ display: "inline-flex" }}>クライアントを追加</summary>
        <ActionForm action={createClientAction}>
          <label htmlFor="new-name">クライアント名<span className="req">必須</span></label>
          <input id="new-name" name="name" type="text" required aria-required="true" maxLength={100} autoComplete="organization" />
          <label htmlFor="new-note">メモ（任意）</label>
          <input id="new-note" name="note" type="text" maxLength={500} placeholder="例：担当 山田／契約 2026年10月〜" />
          <div className="form-actions"><SubmitButton pendingText="登録しています…">登録して連携に進む</SubmitButton></div>
        </ActionForm>
      </details>
      {clients.length === 0 ? (
        <EmptyState title="クライアントがまだありません" body="上の「クライアントを追加」から登録すると、ここに一覧が表示されます。" />
      ) : (
        <ul className="client-list">
          {sorted.map((c) => {
            const mine = conns.filter((x) => x.client_id === c.id);
            const last = states.filter((s) => s.client_id === c.id).map((s) => s.last_success_at ?? "").sort().at(-1);
            const i = issues.get(c.id)!;
            return (
              <li key={c.id}>
                <Link href={`/clients/${c.id}`} className="card client-card">
                  <h2>{c.name}</h2>
                  <div className="chips" aria-label="連携中のSNS">
                    {mine.length === 0 && <span className="badge">SNS未連携</span>}
                    {PLATFORMS.filter((p) => mine.some((x) => x.platform === p)).map((p) => (
                      <span key={p} className="chip small"><i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />{PLATFORM_LABELS[p]}</span>
                    ))}
                  </div>
                  <span className="small muted">最終収集：{last ? fmtDateTime(last) : "まだありません"}</span>
                  {(i.relink + i.collect + i.failed + i.pending) > 0 && (
                    <div className="chips" aria-label="対応が必要なこと">
                      {i.relink > 0 && <span className="badge warn">要再連携 {i.relink}件</span>}
                      {i.collect > 0 && <span className="badge warn">収集エラー {i.collect}件</span>}
                      {i.failed > 0 && <span className="badge warn">投稿の失敗 {i.failed}件</span>}
                      {i.pending > 0 && <span className="badge info">承認待ち {i.pending}件</span>}
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
