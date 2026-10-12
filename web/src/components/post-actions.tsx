"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { approvePost, cancelPost, deletePost, prepareRetry, rejectPost } from "@/app/(app)/clients/[id]/publish/actions";

/** 予約の取り消し・再投稿・削除 */
export function PostActions({ clientId, postId, status, isStaff }: { clientId: string; postId: string; status: string; isStaff: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  async function run(label: string, fn: () => Promise<{ ok: boolean; errors?: string[] }>, after?: () => Promise<void>) {
    setBusy(label); setError(null);
    const r = await fn();
    if (!r.ok) { setBusy(null); setError(r.errors?.[0] ?? "処理に失敗しました"); return; }
    if (after) await after();
    setBusy(null);
    router.refresh();
  }
  const retry = () => run("再投稿しています…", () => prepareRetry(clientId, postId), async () => { await publish(); });
  const publish = async () => {
    const res = await fetch(`/api/clients/${clientId}/posts/${postId}/publish`, { method: "POST" });
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "投稿に失敗しました");
  };
  const approve = async () => {
    setBusy("承認しています…"); setError(null);
    const r = await approvePost(clientId, postId);
    if (!r.ok) { setBusy(null); setError(r.errors[0]); return; }
    if (r.publishNow) { setBusy("投稿しています…"); await publish(); }
    setBusy(null);
    router.refresh();
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
    {isStaff && status === "pending" && (
      <div className="row">
        <button type="button" className="btn sm primary" disabled={Boolean(busy)} onClick={approve}>承認する</button>
        <details className="more" style={{ margin: 0, padding: 0, border: 0 }}>
          <summary>差し戻す</summary>
          <label htmlFor={`rj-${postId}`}>差し戻しの理由（クライアントに表示されます）</label>
          <textarea id={`rj-${postId}`} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="form-actions">
            <button type="button" className="btn sm danger" disabled={Boolean(busy)} onClick={() => run("差し戻しています…", () => rejectPost(clientId, postId, note))}>差し戻す</button>
          </div>
        </details>
      </div>
    )}
    <div className="row" aria-busy={Boolean(busy)}>
      {["draft", "pending", "rejected", "scheduled", "canceled"].includes(status) && <a className="btn sm" href={`/clients/${clientId}/publish/${postId}`}>{status === "rejected" ? "直して依頼し直す" : "編集"}</a>}
      {["scheduled", "pending"].includes(status) && <button type="button" className="btn sm" disabled={Boolean(busy)} onClick={() => run("取り消しています…", () => cancelPost(clientId, postId))}>{status === "pending" ? "依頼を取り消す" : "予約を取り消す"}</button>}
      {["failed", "partial"].includes(status) && <button type="button" className="btn sm primary" disabled={Boolean(busy)} onClick={retry}>失敗したSNSに再投稿</button>}
      {status !== "publishing" && (
        <button type="button" className="btn sm danger" disabled={Boolean(busy)} onClick={() => {
          if (window.confirm("この投稿の記録と画像を削除します。SNS上に公開済みの投稿は削除されません。よろしいですか？")) run("削除しています…", () => deletePost(clientId, postId));
        }}>削除</button>
      )}
      <span aria-live="polite" className="small muted">{busy ? <><span className="spinner" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "middle", marginRight: 6 }} />{busy}</> : null}</span>
      {error && <span role="alert" className="small" style={{ color: "var(--warn)" }}>{error}</span>}
    </div>
    </div>
  );
}
