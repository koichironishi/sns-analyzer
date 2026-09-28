"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AiRunner({ clientId, days, end, disabledReason }: { clientId: string; days: number; end: string; disabledReason: string | null }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string; done?: boolean }>({ busy: false });
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setState({ busy: true });
    try {
      const res = await fetch(`/api/clients/${clientId}/ai`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days, end, question }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setState({ busy: false, error: body.error ?? "AI分析に失敗しました。" }); return; }
      setState({ busy: false, done: true });
      router.refresh();
    } catch {
      setState({ busy: false, error: "通信に失敗しました。ネットワークを確認して、もう一度お試しください。" });
    }
  }
  return (
    <form className="card no-print" onSubmit={run} aria-busy={state.busy}>
      <h2 style={{ fontSize: "var(--fs-base)", margin: 0 }}>この期間で AI分析を実行</h2>
      {disabledReason ? <div className="msg error" role="alert" style={{ marginTop: 12 }}>{disabledReason}</div> : (
        <>
          <label htmlFor="q">AIへの質問（任意）</label>
          <textarea id="q" value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)}
            placeholder="例：リールの反応を上げるには？" aria-describedby="q-hint" />
          <p className="hint" id="q-hint">500文字まで。分析には1〜3分ほどかかります。結果は保存され、クライアントの閲覧ユーザーも見られます。</p>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={state.busy} aria-disabled={state.busy}>
              {state.busy ? <><span className="spinner" aria-hidden="true" />分析しています…</> : "AI分析を実行"}
            </button>
          </div>
        </>
      )}
      <div aria-live="polite">
        {state.error && <div className="msg error" role="alert" style={{ marginTop: 12 }}>{state.error}</div>}
        {state.done && <div className="msg ok" style={{ marginTop: 12 }}>AI分析が完了しました。</div>}
      </div>
    </form>
  );
}
