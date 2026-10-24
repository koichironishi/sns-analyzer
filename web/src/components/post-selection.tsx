"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { deletePosts } from "@/app/(app)/clients/[id]/publish/actions";

/**
 * 投稿の一覧で、選んだ投稿をまとめて削除する。一覧（サーバーで描いたカード）を包み、
 * カードの中の選択欄（input.post-select）を数える。すべて選択・選択の解除・削除の操作を、一覧の上に固定して出す
 */
export function PostSelection({ clientId, total, children }: { clientId: string; total: number; children: React.ReactNode }) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const boxes = () => [...(ref.current?.querySelectorAll<HTMLInputElement>("input.post-select") ?? [])];
  const recount = () => setCount(boxes().filter((b) => b.checked).length);
  const setAll = (on: boolean) => { for (const b of boxes()) b.checked = on; recount(); };

  async function remove() {
    const ids = boxes().filter((b) => b.checked).map((b) => b.value);
    if (!ids.length) { setMsg({ kind: "error", text: "削除する投稿を選んでください" }); return; }
    if (!window.confirm(`選んだ${ids.length}件の投稿の記録と画像を削除します。SNS上に公開済みの投稿は削除されません。元に戻せません。よろしいですか？`)) return;
    setBusy(true); setMsg(null);
    const r = await deletePosts(clientId, ids);
    setBusy(false);
    if (!r.ok) { setMsg({ kind: "error", text: r.errors[0] }); return; }
    setMsg({ kind: "ok", text: `${r.deleted}件を削除しました。${r.skipped ? `${r.skipped}件は投稿の処理中などのため削除できませんでした。` : ""}` });
    setCount(0);
    router.refresh();
  }

  return (
    <div ref={ref} onChange={recount}>
      <div className="select-bar" role="toolbar" aria-label="選んだ投稿の操作">
        <label className="check">
          <input type="checkbox" checked={total > 0 && count === total} ref={(el) => { if (el) el.indeterminate = count > 0 && count < total; }}
            onChange={(e) => setAll(e.target.checked)} />
          すべて選択
        </label>
        <span className="small" aria-live="polite">{count ? `${count}件を選択中` : `${total}件`}</span>
        {count > 0 && <button type="button" className="btn" onClick={() => setAll(false)}>選択を解除</button>}
        <button type="button" className="btn danger" onClick={remove} disabled={busy}>{busy ? "削除しています…" : "選んだ投稿を削除"}</button>
      </div>
      {msg && <p className={`msg ${msg.kind}`} role={msg.kind === "error" ? "alert" : "status"}>{msg.text}</p>}
      {children}
    </div>
  );
}
