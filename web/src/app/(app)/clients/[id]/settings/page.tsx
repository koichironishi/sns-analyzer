import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { metaApp, threadsApp } from "@/lib/connect-flow";
import { fmtDateTime } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { daysLeft } from "@/lib/sns/connect";
import { PLATFORMS, PLATFORM_LABELS, todayIn, type Platform } from "@/lib/sns/models";
import { CONSENT_VERSION, consentState, consentText } from "@/lib/sns/privacy";
import { getAppSettings, getBrandContext, getClient, getConsentRow, listCollectState, listCompetitors, listConnections } from "@/lib/sns/store";
import { ActionForm } from "@/components/action-form";
import { Flash } from "@/components/flash";
import { CollectButton } from "@/components/collect-button";
import { Chip, PageHead } from "@/components/report-ui";
import { SubmitButton } from "@/components/submit-button";
import {
  connectX, deleteData, deleteEverything, disconnect, grantAiConsent, importCsv, recordFollowerCount, removeCompetitor,
  revokeAiConsent, saveBrand, testConnection, upsertCompetitor,
} from "./actions";

export const metadata: Metadata = { title: "設定・連携" };

const ERRORS: Record<string, string> = {
  meta_env: "Meta アプリが設定されていません（環境変数 META_APP_ID / META_APP_SECRET）。",
  threads_env: "Threads アプリが設定されていません（環境変数 THREADS_APP_ID / THREADS_APP_SECRET）。",
  denied: "連携がキャンセルされました。",
  exchange: "連携に失敗しました。アプリの設定（リダイレクトURI・権限）を確認して、もう一度お試しください。",
  nopages: "管理している Facebook ページが見つかりませんでした。Facebook ログインの画面で、対象のページへのアクセスを許可してください。",
  expired: "ページの選択の有効期限が切れました。もう一度連携してください。",
};
const OKS: Record<string, [section: string, text: string]> = {
  meta: ["connections", "Facebook（と紐づく Instagram）を連携しました。"],
  threads: ["connections", "Threads を連携しました。"],
  disconnected: ["connections", "連携を解除しました（収集済みのデータは残っています）。"],
  disconnected_data: ["connections", "連携を解除し、収集済みのデータを削除しました。"],
  competitor_deleted: ["competitors", "競合とそのデータを削除しました。"],
  consent_granted: ["consent", "AI分析の同意を記録しました。"],
  consent_revoked: ["consent", "AI分析の同意を撤回し、保存済みのAI分析結果を削除しました。"],
};

const Hidden = ({ id }: { id: string }) => <input type="hidden" name="client_id" value={id} />;

export default async function SettingsPage({ params, searchParams }: PageProps<"/clients/[id]/settings">) {
  await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  const admin = createAdminClient();
  const client = await getClient(admin, id);
  if (!client) notFound();
  const [conns, states, competitors, consentRow, brand, settings] = await Promise.all([
    listConnections(admin, id), listCollectState(admin, id), listCompetitors(admin, id), getConsentRow(admin, id),
    getBrandContext(admin, id), getAppSettings(admin),
  ]);
  const consent = consentState(consentRow);
  const connOf = (p: Platform) => conns.find((c) => c.platform === p);
  const stateOf = (p: Platform) => states.find((s) => s.platform === p);
  const hasMeta = Boolean(metaApp());
  const hasThreads = Boolean(threadsApp());
  const e = typeof sp.e === "string" ? ERRORS[sp.e] : undefined;
  const ok = typeof sp.ok === "string" ? OKS[sp.ok] : undefined;
  const notice = (section: string) => (
    <>
      {section === "connections" && e && <Flash kind="error">{e}</Flash>}
      {ok && ok[0] === section && <Flash kind="ok">{ok[1]}</Flash>}
    </>
  );
  const editing = typeof sp.edit === "string" ? competitors.find((c) => c.id === sp.edit) : undefined;

  return (
    <>
      <PageHead eyebrow={client.name} title="設定・連携" lead="SNSの連携、競合の登録、AI分析の同意、データの取り込みと削除を行います（スタッフのみ）。" />

      <section id="connections" aria-labelledby="h-conn">
        <h2 id="h-conn">SNS連携</h2>
        <p className="sub">連携すると、毎日自動でデータを収集します（直近{settings.collect_days}日間の投稿・1回あたり最大{settings.max_posts_per_run}件）。</p>
        {notice("connections")}
        <div className="card">
          {PLATFORMS.map((p) => {
            const c = connOf(p);
            const st = stateOf(p);
            const left = daysLeft(c?.token_expires_at ?? null);
            return (
              <div className="conn" key={p}>
                <div>
                  <div className="conn-name">
                    <Chip platform={p} />
                    {c ? (c.status === "error" ? <span className="badge warn">要再連携</span> : <span className="badge good">連携中</span>) : <span className="badge">未連携</span>}
                  </div>
                  {c && <p className="conn-meta">{c.username ? `${p === "facebook" ? "" : "@"}${c.username}` : c.external_id}{left !== null && `・トークンの有効期限まであと${Math.max(0, Math.floor(left))}日`}</p>}
                  {st && <p className="conn-meta">最終収集：{fmtDateTime(st.last_run_at)}{st.posts_saved !== null && `・投稿 ${st.posts_saved}件`}{st.last_error && <><br /><span style={{ color: "var(--warn)" }}>{st.last_error}</span></>}</p>}
                  {c?.last_error && !st?.last_error && <p className="conn-meta" style={{ color: "var(--warn)" }}>{c.last_error}</p>}
                  {p === "instagram" && !c && <p className="conn-meta">Instagram は Facebook ページ経由で連携します（ビジネス／クリエイターアカウントを Facebook ページに紐づけてください）。</p>}
                </div>
                <div className="row end">
                  {(p === "facebook" || p === "instagram") && (hasMeta
                    ? <a className={`btn ${c ? "" : "primary"}`} href={`/api/connect/meta?client=${id}`}>{c ? "再連携" : "Facebook でログインして連携"}</a>
                    : <span className="small muted">Meta アプリの設定後に連携できます</span>)}
                  {p === "threads" && (hasThreads
                    ? <a className={`btn ${c ? "" : "primary"}`} href={`/api/connect/threads?client=${id}`}>{c ? "再連携" : "Threads でログインして連携"}</a>
                    : <span className="small muted">Threads アプリの設定後に連携できます</span>)}
                  {c && (
                    <ActionForm action={testConnection}><Hidden id={id} /><input type="hidden" name="platform" value={p} />
                      <SubmitButton className="btn" pendingText="確認しています…">連携を確認</SubmitButton></ActionForm>
                  )}
                </div>
                {p === "x" && (
                  <details className="more" style={{ gridColumn: "1 / -1" }}>
                    <summary>{c ? "Bearer Token を更新する" : "Bearer Token で連携する"}</summary>
                    <ActionForm action={connectX} resetOnSuccess>
                      <Hidden id={id} />
                      <label htmlFor="x-user">X のユーザー名<span className="req">必須</span></label>
                      <input id="x-user" name="username" type="text" required aria-required="true" autoComplete="off" defaultValue={c?.username ?? ""} placeholder="例：example" />
                      <label htmlFor="x-token">Bearer Token<span className="req">必須</span></label>
                      <input id="x-token" name="bearer_token" type="password" required aria-required="true" autoComplete="off" aria-describedby="x-token-hint" />
                      <p className="hint" id="x-token-hint">X Developer Portal のアプリで発行します。保存後は画面に表示されません。X API は従量課金のため、取得件数は全体設定の上限に従います。</p>
                      <div className="form-actions"><SubmitButton pendingText="確認しています…">保存して確認</SubmitButton></div>
                    </ActionForm>
                  </details>
                )}
                {c && (
                  <details className="more" style={{ gridColumn: "1 / -1" }}>
                    <summary>連携を解除する</summary>
                    <ActionForm action={disconnect}>
                      <Hidden id={id} /><input type="hidden" name="platform" value={p} />
                      <label className="check"><input type="checkbox" name="delete_data" />収集済みの {PLATFORM_LABELS[p]} のデータ（自社・競合）も削除する</label>
                      <div className="form-actions"><SubmitButton className="btn danger" pendingText="解除しています…">連携を解除</SubmitButton></div>
                    </ActionForm>
                  </details>
                )}
              </div>
            );
          })}
          {(!hasMeta || !hasThreads) && (
            <p className="note">{!hasMeta && "Facebook・Instagram の連携には Meta アプリの設定（META_APP_ID / META_APP_SECRET）が必要です。"}{!hasThreads && "Threads の連携には THREADS_APP_ID / THREADS_APP_SECRET が必要です。"}手順は README をご覧ください。</p>
          )}
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ margin: "0 0 8px", fontSize: "var(--fs-base)" }}>データ収集</h3>
          <p className="small muted" style={{ marginTop: 0 }} id="collect-hint">自動収集は1日1回です。連携直後や、すぐに最新の数値を見たいときに実行してください。{conns.length === 0 && "（SNSを連携すると実行できます）"}</p>
          <CollectButton clientId={id} disabled={conns.length === 0} />
        </div>
      </section>

      <section id="competitors" aria-labelledby="h-comp">
        <h2 id="h-comp">競合アカウント</h2>
        {notice("competitors")}
        <p className="sub">自社の連携を使って、競合の公開データを取得します。Instagram はビジネス／クリエイターアカウントのみ、Threads・Facebook はフォロワー数のみ（Facebook は Meta の審査が必要）。取得できない場合は、フォロワー数の手動記録やCSV取り込みで補えます。</p>
        {competitors.length > 0 && (
          <div className="card flush scroll">
            <table>
              <thead><tr><th scope="col">競合</th>{PLATFORMS.map((p) => <th scope="col" key={p}>{PLATFORM_LABELS[p]}</th>)}<th scope="col"><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {competitors.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.name}</th>
                    {PLATFORMS.map((p) => <td key={p} className="small">{c.handles?.[p] ?? "—"}</td>)}
                    <td className="nowrap">
                      <a className="btn sm" href={`?edit=${c.id}#competitor-form`}>編集<span className="sr-only">：{c.name}</span></a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ margin: 0, fontSize: "var(--fs-base)" }}>{editing ? `「${editing.name}」を編集` : "競合を追加"}</h3>
          <ActionForm action={upsertCompetitor} resetOnSuccess={!editing} id="competitor-form" key={editing?.id ?? "new"}>
            <Hidden id={id} /><input type="hidden" name="id" value={editing?.id ?? ""} />
            <label htmlFor="c-name">競合名<span className="req">必須</span></label>
            <input id="c-name" name="name" type="text" required aria-required="true" maxLength={80} defaultValue={editing?.name ?? ""} />
            <fieldset>
              <legend>アカウント（ユーザー名またはURL）</legend>
              {PLATFORMS.map((p) => (
                <div key={p}>
                  <label htmlFor={`c-${p}`}>{PLATFORM_LABELS[p]}{p === "facebook" ? "（ページIDまたはユーザー名）" : ""}</label>
                  <input id={`c-${p}`} name={p} type="text" autoComplete="off" defaultValue={editing?.handles?.[p] ?? ""} />
                </div>
              ))}
            </fieldset>
            <div className="form-actions">
              <SubmitButton pendingText="保存しています…">{editing ? "更新" : "追加"}</SubmitButton>
              {editing && <a className="btn ghost" href="?#competitors">キャンセル</a>}
            </div>
          </ActionForm>
          {editing && (
            <details className="more">
              <summary>この競合を削除する</summary>
              <ActionForm action={removeCompetitor}>
                <Hidden id={id} /><input type="hidden" name="competitor_id" value={editing.id} />
                <label className="check"><input type="checkbox" name="confirm" required />「{editing.name}」と収集済みのデータを削除します（元に戻せません）</label>
                <div className="form-actions"><SubmitButton className="btn danger" pendingText="削除しています…">削除</SubmitButton></div>
              </ActionForm>
            </details>
          )}
        </div>
      </section>

      <section id="consent" aria-labelledby="h-consent">
        <h2 id="h-consent">AI分析の同意</h2>
        <p className="sub">AI分析は、クライアントから外部送信への同意を得て記録した場合にのみ実行できます（説明の版：{CONSENT_VERSION}）。</p>
        {notice("consent")}
        <div className="card">
          <p style={{ marginTop: 0 }}>
            {consent.valid && <span className="badge good">同意済み</span>}
            {consent.outdated && <span className="badge warn">再同意が必要（説明が更新されました）</span>}
            {consent.status === "revoked" && <span className="badge">撤回済み</span>}
            {consent.status === "unset" && <span className="badge">未記録</span>}
            {consent.row?.status === "granted" && <span className="small muted" style={{ marginLeft: 8 }}>
              {consent.row.granted_by}（{fmtDateTime(consent.row.granted_at)}）・投稿本文の送信：{consent.row.include_post_text ? "あり" : "なし"}
            </span>}
          </p>
          <h3 style={{ fontSize: "var(--fs-base)", margin: "16px 0 8px" }}>クライアントへの説明内容</h3>
          <ul>{consentText(true).map((t) => <li key={t}>{t}</li>)}</ul>
          {!consent.valid ? (
            <ActionForm action={grantAiConsent}>
              <Hidden id={id} />
              <label htmlFor="g-by">同意した方の氏名・所属<span className="req">必須</span></label>
              <input id="g-by" name="granted_by" type="text" required aria-required="true" maxLength={100} placeholder="例：株式会社〇〇 広報部 山田様" />
              <label className="check"><input type="checkbox" name="include_post_text" defaultChecked />投稿本文の送信にも同意を得た（外すと数値のみを送信します）</label>
              <label htmlFor="g-note">メモ（同意の方法など）</label>
              <input id="g-note" name="note" type="text" maxLength={500} placeholder="例：2026/09/28 のメールで同意" />
              <label className="check"><input type="checkbox" name="confirm" required />上の説明内容をクライアントに伝え、同意を得ました</label>
              <div className="form-actions"><SubmitButton pendingText="記録しています…">同意を記録</SubmitButton></div>
            </ActionForm>
          ) : (
            <details className="more">
              <summary>同意を撤回する</summary>
              <ActionForm action={revokeAiConsent}>
                <Hidden id={id} />
                <label className="check"><input type="checkbox" name="confirm" required />同意を撤回し、保存済みのAI分析結果を削除します</label>
                <div className="form-actions"><SubmitButton className="btn danger" pendingText="撤回しています…">同意を撤回</SubmitButton></div>
              </ActionForm>
            </details>
          )}
        </div>
      </section>

      <section id="brand" aria-labelledby="h-brand">
        <h2 id="h-brand">事業内容・SNSの目的</h2>
        <p className="sub">AI分析の前提として Claude に伝えます（例：業種、ターゲット、SNSで達成したいこと）。</p>
        <div className="card">
          <ActionForm action={saveBrand}>
            <Hidden id={id} />
            <label htmlFor="brand-text" className="sr-only">事業内容・SNSの目的</label>
            <textarea id="brand-text" name="brand_context" maxLength={2000} defaultValue={brand} rows={5} />
            <div className="form-actions"><SubmitButton pendingText="保存しています…">保存</SubmitButton></div>
          </ActionForm>
        </div>
      </section>

      <section id="import" aria-labelledby="h-import">
        <h2 id="h-import">CSV取り込み・フォロワー数の記録</h2>
        <p className="sub">APIで取得できないデータを補います。Meta Business Suite や X アナリティクスのエクスポート（UTF-8 / Shift_JIS）をそのまま取り込めます。</p>
        <div className="grid wide">
          <div className="card">
            <h3>投稿のCSVを取り込む</h3>
            <ActionForm action={importCsv} resetOnSuccess>
              <Hidden id={id} />
              <OwnerFields competitors={competitors} prefix="i" />
              <label htmlFor="i-file">CSVファイル<span className="req">必須</span></label>
              <input id="i-file" name="file" type="file" accept=".csv,text/csv" required aria-describedby="i-hint" />
              <p className="hint" id="i-hint">日時の列は必須です。本文・いいね・コメントなどの列名は日本語・英語の代表的な表記を自動で判別します（4MBまで）。</p>
              <div className="form-actions"><SubmitButton pendingText="取り込んでいます…">取り込む</SubmitButton></div>
            </ActionForm>
          </div>
          <div className="card">
            <h3>フォロワー数を記録する</h3>
            <ActionForm action={recordFollowerCount} resetOnSuccess>
              <Hidden id={id} />
              <OwnerFields competitors={competitors} prefix="f" />
              <label htmlFor="f-count">フォロワー数<span className="req">必須</span></label>
              <input id="f-count" name="followers" type="number" min={0} step={1} required inputMode="numeric" />
              <label htmlFor="f-date">日付</label>
              <input id="f-date" name="date" type="date" max={todayIn()} defaultValue={todayIn()} />
              <div className="form-actions"><SubmitButton pendingText="記録しています…">記録</SubmitButton></div>
            </ActionForm>
          </div>
        </div>
      </section>

      <section id="delete" aria-labelledby="h-delete">
        <h2 id="h-delete">データの削除</h2>
        <p className="sub">削除したデータは元に戻せません。削除すると、このクライアントのAI分析結果もあわせて削除します。保存期間（{settings.retention_days ? `${settings.retention_days}日` : "無期限"}）を過ぎたデータは自動で削除されます。</p>
        <div className="card danger-zone">
          <h3>SNS別に削除</h3>
          <ActionForm action={deleteData}>
            <Hidden id={id} />
            <label htmlFor="d-platform">SNS</label>
            <select id="d-platform" name="platform">{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select>
            <label htmlFor="d-scope">対象</label>
            <select id="d-scope" name="scope"><option value="own">自社のデータ</option><option value="competitor">競合のデータ</option><option value="all">自社と競合のデータ</option></select>
            <label className="check"><input type="checkbox" name="disconnect" />連携も解除する</label>
            <label className="check"><input type="checkbox" name="confirm" required />選んだデータを削除します（元に戻せません）</label>
            <div className="form-actions"><SubmitButton className="btn danger" pendingText="削除しています…">削除</SubmitButton></div>
          </ActionForm>
          <details className="more">
            <summary>このクライアントのSNSデータをすべて削除する（契約終了時など）</summary>
            <ActionForm action={deleteEverything}>
              <Hidden id={id} />
              <p className="small">連携・競合・収集データ・AI分析結果・同意の記録をすべて削除します。MEO のクライアント情報は削除しません。</p>
              <label htmlFor="d-name">確認のため、クライアント名「{client.name}」を入力してください</label>
              <input id="d-name" name="confirm_name" type="text" required autoComplete="off" />
              <div className="form-actions"><SubmitButton className="btn danger" pendingText="削除しています…">すべて削除</SubmitButton></div>
            </ActionForm>
          </details>
        </div>
      </section>
    </>
  );
}

function OwnerFields({ competitors, prefix }: { competitors: { id: string; name: string }[]; prefix: string }) {
  return (
    <>
      <label htmlFor={`${prefix}-owner`}>記録先</label>
      <select id={`${prefix}-owner`} name="owner" defaultValue="own">
        <option value="own">自社</option>
        {competitors.map((c) => <option key={c.id} value={c.id}>競合：{c.name}</option>)}
      </select>
      <label htmlFor={`${prefix}-platform`}>SNS</label>
      <select id={`${prefix}-platform`} name="platform">{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select>
      <label htmlFor={`${prefix}-user`}>アカウント名（ユーザー名）<span className="req">必須</span></label>
      <input id={`${prefix}-user`} name="username" type="text" required aria-required="true" autoComplete="off" />
    </>
  );
}
