"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { commitBulk, previewBulk, type BulkPreviewRow } from "@/app/(app)/clients/[id]/publish/actions";
import { PLATFORM_LABELS, accountLabel } from "@/lib/sns/models";
import { bulkTemplate, BULK_MAX_ROWS } from "@/lib/sns/publish/bulk-format";
import type { ComposerConnection } from "./post-composer";

const fmt = (local: string) => (local ? local.replace("T", " ").replaceAll("-", "/") : "—");

/**
 * CSV一括予約：①投稿先とCSVを選ぶ → ②一覧で確かめる → ③予約か下書きを選んで取り込む。
 * 画像が要るSNS（Instagram）を含む投稿は、画像を足すまで予約できないため、下書きで入る
 */
export function BulkImport({ clientId, connections, needsApproval }: { clientId: string; connections: ComposerConnection[]; needsApproval: boolean }) {
  const router = useRouter();
  const usable = connections.filter((c) => c.connected && c.canPublish && c.key);
  const [targets, setTargets] = useState<string[]>(usable.map((c) => c.key!));
  const [utm, setUtm] = useState(true);
  const [rows, setRows] = useState<BulkPreviewRow[] | null>(null);
  const [mode, setMode] = useState<"schedule" | "draft">("schedule");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const ok = rows?.filter((r) => !r.errors.length) ?? [];
  const bad = rows?.filter((r) => r.errors.length) ?? [];
  const withIg = targets.some((k) => k.startsWith("instagram:"));

  const download = () => {
    const url = URL.createObjectURL(new Blob([bulkTemplate()], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "一括予約のひな形.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  async function preview(form: FormData) {
    setBusy("読み込んでいます…"); setErrors([]); setRows(null);
    form.set("client_id", clientId);
    for (const t of targets) form.append("targets", t);
    if (utm) form.set("add_utm", "on");
    const r = await previewBulk(form);
    setBusy(null);
    if (!r.ok) { setErrors(r.errors); return; }
    setRows(r.rows);
  }

  async function commit() {
    if (!ok.length) return;
    setBusy("取り込んでいます…"); setErrors([]);
    const r = await commitBulk({ clientId, targets, rows: ok.map((x) => ({ local: x.local, text: x.text })), mode, addUtm: utm });
    if (!r.ok) { setBusy(null); setErrors(r.errors); return; }
    const tab = r.pending ? "pending" : r.scheduled ? "scheduled" : "draft";
    router.push(`/clients/${clientId}/publish?tab=${tab}&ok=bulk&n=${r.scheduled + r.drafts + r.pending}&d=${r.drafts}`);
  }

  return (
    <div className="stack bulk">
      {errors.length > 0 && <div className="msg error" role="alert"><ul style={{ margin: 0, paddingLeft: "1.2em" }}>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}

      <section className="card" aria-labelledby="h-bulk-1">
        <h2 id="h-bulk-1" className="bulk-step"><span aria-hidden="true">1</span>投稿先とCSVを選ぶ</h2>
        <form action={preview}>
          <fieldset>
            <legend>投稿先</legend>
            {usable.length === 0 ? <p className="muted">投稿できるアカウントがありません。スタッフが「SNS連携」で、投稿の許可を含めて連携すると使えます。</p> : (
              <div className="checks">
                {usable.map((c) => (
                  <label key={c.key} className="check">
                    <input type="checkbox" checked={targets.includes(c.key!)}
                      onChange={(e) => { setTargets((cur) => (e.target.checked ? [...cur, c.key!] : cur.filter((x) => x !== c.key))); setRows(null); }} />
                    {PLATFORM_LABELS[c.platform]}{accountLabel(c.platform, c.username, c.nickname) && <span className="small">（{accountLabel(c.platform, c.username, c.nickname)}）</span>}
                  </label>
                ))}
              </div>
            )}
            {withIg && <p className="hint">Instagram は画像がないと投稿できないため、Instagram を含む投稿は<strong>下書き</strong>で入ります。取り込んだあと、「下書き」から1件ずつ画像を足して予約してください。</p>}
          </fieldset>
          <label htmlFor="bulk-file">CSVファイル<span className="req">必須</span></label>
          <input id="bulk-file" name="file" type="file" accept=".csv,text/csv" required aria-required="true" aria-describedby="bulk-file-hint" onChange={() => setRows(null)} />
          <p className="hint" id="bulk-file-hint">
            1行目に「配信日時」と「本文」の見出しを書き、2行目から1行＝1投稿にします。日時は日本時間で「2026/11/01 12:00」の形です。改行を含む本文もそのまま書けます（Excel で保存すると自動で囲まれます）。一度に{BULK_MAX_ROWS}件まで。
            {" "}<button type="button" className="link-button" onClick={download}>ひな形のCSVをダウンロード</button>
          </p>
          <label className="check"><input type="checkbox" checked={utm} onChange={(e) => setUtm(e.target.checked)} />本文のリンクに計測用の印（UTM）を付ける</label>
          <div className="form-actions"><button type="submit" className="btn primary" disabled={Boolean(busy)}>{busy === "読み込んでいます…" ? busy : "読み込んで確認する"}</button></div>
        </form>
      </section>

      {rows && (
        <section className="card" aria-labelledby="h-bulk-2">
          <h2 id="h-bulk-2" className="bulk-step"><span aria-hidden="true">2</span>中身を確かめて取り込む</h2>
          <p role="status" style={{ marginTop: 0 }}>
            {rows.length}件のうち、取り込めるのは<strong>{ok.length}件</strong>です。
            {bad.length > 0 && <span className="warn-text">エラーの{bad.length}件は取り込みません（CSVを直して、もう一度読み込んでください）。</span>}
          </p>
          <div className="card flush scroll bulk-table">
            <table>
              <caption className="sr-only">取り込む投稿の一覧</caption>
              <thead><tr><th scope="col" className="num">行</th><th scope="col">配信日時</th><th scope="col">本文</th><th scope="col">取り込み後</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} className={r.errors.length ? "bulk-bad" : undefined}>
                    <td className="num">{r.line}</td>
                    <td className="nowrap">{fmt(r.local)}</td>
                    <td><p className="bulk-text">{r.text || <span className="muted">（本文なし）</span>}</p>
                      {r.warnings.map((w) => <p key={w} className="small" style={{ margin: "4px 0 0" }}>注意：{w}</p>)}</td>
                    <td>
                      {r.errors.length
                        ? <ul className="bulk-errors">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                        : <span className={`badge ${mode === "draft" || r.draft ? "" : needsApproval ? "info" : "info"}`}>
                          {mode === "draft" || r.draft ? (r.draft && mode !== "draft" ? "下書き（画像が必要）" : "下書き") : needsApproval ? "承認待ち" : "予約"}
                        </span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ok.length > 0 ? (
            <>
              <fieldset style={{ marginTop: 16 }}>
                <legend>取り込み方</legend>
                <div className="checks">
                  <label className="check"><input type="radio" name="bulk-mode" checked={mode === "schedule"} onChange={() => setMode("schedule")} />{needsApproval ? "承認を依頼する" : "予約する"}（画像が必要な投稿は下書き）</label>
                  <label className="check"><input type="radio" name="bulk-mode" checked={mode === "draft"} onChange={() => setMode("draft")} />すべて下書きで入れる</label>
                </div>
              </fieldset>
              <div className="form-actions">
                <button type="button" className="btn primary" onClick={commit} disabled={Boolean(busy)}>{busy === "取り込んでいます…" ? busy : `${ok.length}件を取り込む`}</button>
                <Link className="btn" href={`/clients/${clientId}/publish`}>やめる</Link>
              </div>
            </>
          ) : <p className="muted">取り込める行がありません。</p>}
        </section>
      )}
    </div>
  );
}
