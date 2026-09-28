import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { readPages } from "@/lib/connect-flow";
import { PageHead } from "@/components/report-ui";
import { SubmitButton } from "@/components/submit-button";
import { selectMetaPage } from "../actions";

export const metadata: Metadata = { title: "連携する Facebook ページの選択" };

export default async function MetaPagesPage({ params }: PageProps<"/clients/[id]/settings/meta-pages">) {
  const v = await requireStaff();
  const { id } = await params;
  const pending = await readPages();
  if (!pending || pending.clientId !== id || pending.userId !== v.id) redirect(`/clients/${id}/settings?e=expired#connections`);
  return (
    <>
      <PageHead eyebrow="SNS連携" title="連携するページを選んでください" lead="選んだ Facebook ページと、そのページに紐づく Instagram アカウントを連携します。" />
      <form action={selectMetaPage} className="card">
        <input type="hidden" name="client_id" value={id} />
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Facebook ページ</legend>
          {pending.pages.map((p, i) => (
            <label className="check" key={p.pageId} style={{ display: "flex" }}>
              <input type="radio" name="page_id" value={p.pageId} defaultChecked={i === 0} required />
              <span>{p.name}<span className="muted small">{p.igUsername ? `（Instagram：@${p.igUsername}）` : "（Instagram の紐づけなし）"}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="form-actions">
          <SubmitButton pendingText="連携しています…">このページを連携</SubmitButton>
          <a className="btn ghost" href={`/clients/${id}/settings#connections`}>キャンセル</a>
        </div>
      </form>
    </>
  );
}
