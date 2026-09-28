"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Log = { platform: string; ok: boolean; message: string };

export function CollectButton({ clientId, disabled }: { clientId: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null); setLogs(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/collect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? "収集に失敗しました。");
      else {
        setLogs(body.logs ?? []);
        if (body.skipped?.length) setError(`時間内に終わらなかったSNSがあります（${body.skipped.join("・")}）。もう一度実行するか、次回の自動収集をお待ちください。`);
        router.refresh();
      }
    } catch {
      setError("通信に失敗しました。ネットワークを確認して、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button type="button" className="btn" onClick={run} disabled={busy || disabled} aria-disabled={busy || disabled} aria-describedby="collect-hint">
        {busy ? <><span className="spinner" aria-hidden="true" />収集しています…（数分かかることがあります）</> : "今すぐ収集"}
      </button>
      <div aria-live="polite">
        {error && <div className="msg error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
        {logs && logs.length > 0 && (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
            {logs.map((l, i) => <li key={i} className={`msg ${l.ok ? "ok" : "error"}`} style={{ margin: 0 }}>{l.message}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
