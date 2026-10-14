import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionOverview, listClients, listCollectState, pendingCounts } from "@/lib/sns/store";
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
  const [clients, conns, states, pendings] = await Promise.all([listClients(db), connectionOverview(admin), listCollectState(db), pendingCounts(admin)]);
  return (
    <main id="main" className="app-main" tabIndex={-1}>
      <h1 className="page-title">クライアント一覧</h1>
      <p className="sub">SNS分析のクライアントです（MEO のクライアントとは別に管理します）。スタッフは MEO と同じアカウントでログインできます。</p>
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
          {clients.map((c) => {
            const mine = conns.filter((x) => x.client_id === c.id);
            const last = states.filter((s) => s.client_id === c.id).map((s) => s.last_success_at ?? "").sort().at(-1);
            const errors = mine.filter((x) => x.status === "error").length;
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
                  {errors > 0 && <span className="badge warn">要対応：連携エラー {errors}件</span>}
                  {(pendings.get(c.id) ?? 0) > 0 && <span className="badge info">承認待ちの投稿 {pendings.get(c.id)}件</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
