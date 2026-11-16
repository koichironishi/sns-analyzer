"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { finishMfaEnroll, removeMfa, startMfaEnroll } from "@/app/account/mfa-actions";

/** アカウント設定の「多要素認証」。設定（QR を読み取り → 6桁で確かめる）と解除 */
export function MfaManager({ factor }: { factor: { id: string; createdAt: string } | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const start = async () => {
    setBusy(true); setError(null); setDone(null);
    const r = await startMfaEnroll();
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setEnroll(r);
  };
  const finish = async () => {
    if (!enroll) return;
    setBusy(true); setError(null);
    const r = await finishMfaEnroll(enroll.factorId, code);
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "設定できませんでした"); return; }
    setEnroll(null); setCode("");
    setDone("設定しました。次のログインから、パスワードのあとに確認コードを入れます（MEO も同じです）。");
    router.refresh();
  };
  const remove = async () => {
    if (!factor) return;
    if (!window.confirm("多要素認証を解除します。パスワードだけでログインできる状態に戻ります（MEO も同じです）。よろしいですか？")) return;
    setBusy(true); setError(null); setDone(null);
    const r = await removeMfa(factor.id);
    setBusy(false);
    if (!r.ok) { setError(r.error ?? "解除できませんでした"); return; }
    setDone("解除しました。");
    router.refresh();
  };

  return (
    <div className="mfa-manager">
      {error && <div className="msg error" role="alert">{error}</div>}
      {done && <div className="msg ok" role="status">{done}</div>}
      {factor ? (
        <div className="row">
          <p style={{ margin: 0 }}><span className="badge good">設定済み</span> 認証アプリ（{new Date(factor.createdAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}に設定）</p>
          <button type="button" className="btn danger" onClick={remove} disabled={busy}>{busy ? "解除しています…" : "解除"}</button>
        </div>
      ) : enroll ? (
        <div className="stack">
          <ol className="mfa-steps">
            <li>スマートフォンの認証アプリ（Google Authenticator・Microsoft Authenticator・1Password など）で、下の QR コードを読み取ります。</li>
            <li>アプリに出た6桁の数字を入れて、「設定を終える」を押します。</li>
          </ol>
          {/* QR は Supabase が返す SVG の data URL */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="mfa-qr" src={enroll.qr} alt="認証アプリで読み取る QR コード" width={180} height={180} />
          <details className="more">
            <summary>QR コードを読み取れない場合</summary>
            <p className="small">アプリで「セットアップキーを入力」を選び、次の文字を入れてください。</p>
            <code className="mfa-secret">{enroll.secret}</code>
          </details>
          <label htmlFor="mfa-new-code">確認コード（6桁）</label>
          <input id="mfa-new-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={finish} disabled={busy}>{busy ? "確かめています…" : "設定を終える"}</button>
            <button type="button" className="btn" onClick={() => { setEnroll(null); setCode(""); setError(null); }} disabled={busy}>やめる</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p style={{ margin: 0 }}><span className="badge warn">未設定</span> パスワードが漏れても、それだけでは入られないようにできます。</p>
          <div><button type="button" className="btn primary" onClick={start} disabled={busy}>{busy ? "準備しています…" : "認証アプリを設定"}</button></div>
        </div>
      )}
    </div>
  );
}
