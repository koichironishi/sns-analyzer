"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

/**
 * レポートをPDFにしてダウンロードする（サーバーで画面をそのままPDFにする）。
 * 作るのに数秒〜十数秒かかるため、その間は「PDFを作っています…」と出す
 */
export function PrintButton({ clientId }: { clientId: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true); setError(null);
    try {
      const q = sp.toString();
      const r = await fetch(`/api/clients/${clientId}/pdf?path=${encodeURIComponent(`${path}${q ? `?${q}` : ""}`)}`);
      if (!r.ok) {
        const j = await r.json().catch(() => null) as { error?: string } | null;
        throw new Error(j?.error ?? "PDFを作れませんでした");
      }
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(r.headers.get("Content-Disposition") ?? "")?.[1] ?? "report.pdf");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFを作れませんでした");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="pdf-action">
      <button type="button" className="btn sm" onClick={download} disabled={busy} aria-describedby={error ? "pdf-error" : undefined}>
        {busy ? "PDFを作っています…" : "PDFをダウンロード"}
      </button>
      {error && <span id="pdf-error" role="alert" className="small warn-text">{error}</span>}
    </span>
  );
}
