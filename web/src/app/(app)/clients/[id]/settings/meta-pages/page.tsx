import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { checkPending } from "@/lib/connect-flow";
import { createAdminClient } from "@/lib/supabase/admin";
import { listMetaPages } from "@/lib/sns/connect";
import { getAppSettings, listConnections } from "@/lib/sns/store";
import { PageHead } from "@/components/report-ui";
import { SubmitButton } from "@/components/submit-button";
import { selectMetaPage } from "../actions";

export const metadata: Metadata = { title: "連携する Facebook ページの選択" };
// ページを選んだ直後に、そのまま最初の収集を行うため（collectSoon）
export const maxDuration = 300;

export default async function MetaPagesPage({ params }: PageProps<"/clients/[id]/settings/meta-pages">) {
  const v = await requireStaff();
  const { id } = await params;
  const chk = await checkPending(id, v.id);
  if (!chk.ok) {
    console.error("Meta ページ選択：選択待ちの情報を読めません", chk.reason);
    redirect(`/clients/${id}/settings/connections?e=expired&r=${chk.reason}#connections`);
  }
  const pending = chk.pending;
  const admin = createAdminClient();
  const { graph_api_version } = await getAppSettings(admin);
  const pages = await listMetaPages({ graphVersion: graph_api_version }, pending.userToken).catch(() => null);
  if (!pages) redirect(`/clients/${id}/settings/connections?e=exchange&r=listpages#connections`);
  // すでに連携しているページ（選ぶとトークンを更新する。外しても連携は解除されない）
  const connected = new Set((await listConnections(admin, id)).filter((c) => c.platform === "facebook").map((c) => c.external_id));
  return (
    <>
      <PageHead lead="選んだ Facebook ページと、そのページに紐づく Instagram アカウントを連携します。複数のページを選べます（1ページ＝Facebook と Instagram で1組）。" />
      <form action={selectMetaPage} className="card">
        <input type="hidden" name="client_id" value={id} />
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Facebook ページ（複数選択できます）</legend>
          {pages.map((p, i) => (
            <label className="check" key={p.pageId} style={{ display: "flex" }}>
              <input type="checkbox" name="page_id" value={p.pageId} defaultChecked={connected.size ? connected.has(p.pageId) : i === 0} />
              <span>
                {p.name}<span className="muted small">{p.igUsername ? `（Instagram：@${p.igUsername}）` : "（Instagram の紐づけなし）"}</span>
                {connected.has(p.pageId) && <span className="badge good" style={{ marginLeft: 8 }}>連携済み</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <p className="hint">連携済みのページは、選ぶと連携を更新します。選ばなくても連携は解除されません（解除は「SNS連携」の各アカウントから行います）。</p>
        <div className="form-actions">
          <SubmitButton pendingText="連携しています…">選んだページを連携</SubmitButton>
          <a className="btn ghost" href={`/clients/${id}/settings/connections#connections`}>キャンセル</a>
        </div>
      </form>
    </>
  );
}
