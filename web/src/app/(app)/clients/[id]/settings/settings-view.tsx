import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { metaApp, threadsApp, xApp } from "@/lib/connect-flow";
import { fmtDateTime } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { daysLeft } from "@/lib/sns/connect";
import { PLATFORM_LABELS, accountLabel, todayIn, type Platform } from "@/lib/sns/models";
import { visiblePlatforms } from "@/lib/platforms";
import { CONSENT_VERSION, consentState, consentText } from "@/lib/sns/privacy";
import { getAppSettings, getBrandContext, getClient, getConsentRow, getRequireApproval, listCollectState, listCompetitors, listConnections, listViewers } from "@/lib/sns/store";
import { addViewerAction, deleteClientAction, linkMeoAction, removeViewerAction, resetViewerPasswordAction, setApprovalAction, updateClientAction } from "../../../client-actions";
import { getMeoLink, meoClients, meoLabel } from "@/lib/meo-summary";
import { ActionForm } from "@/components/action-form";
import { Flash } from "@/components/flash";
import { CollectButton } from "@/components/collect-button";
import { Chip, PageHead } from "@/components/report-ui";
import { SubmitButton } from "@/components/submit-button";
import {
  connectX, deleteData, disconnect, grantAiConsent, importCsv, recordFollowerCount, removeCompetitor,
  issueImportKey, revokeAiConsent, revokeImportKey, saveBrand, saveNickname, testConnection, upsertCompetitor,
} from "./actions";
import { getImportKey } from "@/lib/sns/import-posts";

/** 「設定・連携」は MEO と同じく3つのページに分ける（クライアント情報／SNS連携／利用者管理）。中身はこの1つの部品で持つ */
export type SettingsPart = "client" | "connections" | "users";
const LEADS: Record<SettingsPart, string> = {
  client: "クライアントの基本情報、事業内容、AI分析の同意、データの削除を管理します（スタッフのみ）。",
  connections: "SNSの連携、データの収集、競合アカウント、CSVの取り込みを管理します（スタッフのみ）。",
  users: "このクライアントのレポートを見る利用者と、投稿の承認を管理します（スタッフのみ）。",
};

const ERRORS: Record<string, string> = {
  meta_env: "Meta アプリが設定されていません（環境変数 META_APP_ID / META_APP_SECRET）。",
  threads_env: "Threads アプリが設定されていません（環境変数 THREADS_APP_ID / THREADS_APP_SECRET）。",
  x_env: "X アプリが設定されていません（環境変数 X_CLIENT_ID / X_CLIENT_SECRET）。",
  denied: "連携がキャンセルされました。",
  exchange: "連携に失敗しました。アプリの設定（リダイレクトURI・権限）を確認して、もう一度お試しください。",
  nopages: "管理している Facebook ページが見つかりませんでした。Facebook ログインの画面で、対象のページへのアクセスを許可してください。",
  expired: "ページの選択の有効期限が切れました。もう一度連携してください。",
  nopick: "連携するページが選ばれていませんでした。もう一度「アカウントを追加」から選んでください。",
};
const OKS: Record<string, [section: string, text: string]> = {
  meta: ["connections", "Facebook（と紐づく Instagram）を連携しました。"],
  threads: ["connections", "Threads を連携しました。"],
  x: ["connections", "X を連携しました（投稿と分析に使えます）。"],
  disconnected: ["connections", "連携を解除しました（収集済みのデータは残っています）。"],
  disconnected_data: ["connections", "連携を解除し、収集済みのデータを削除しました。"],
  competitor_deleted: ["competitors", "競合とそのデータを削除しました。"],
  consent_granted: ["consent", "AI分析の同意を記録しました。"],
  consent_revoked: ["consent", "AI分析の同意を撤回し、保存済みのAI分析結果を削除しました。"],
  client_created: ["connections", "クライアントを登録しました。続けて SNS を連携してください。"],
  viewer_removed: ["viewers", "利用者を削除しました（ログインアカウントも削除しました）。"],
  viewer_removed_kept: ["viewers", "利用者を削除しました（MEO と共通のアカウントのため、ログインアカウントは残しています）。"],
};

const Hidden = ({ id }: { id: string }) => <input type="hidden" name="client_id" value={id} />;

export async function SettingsView({ params, searchParams, part }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  part: SettingsPart;
}) {
  const v = await requireStaff();
  const { id } = await params;
  const sp = await searchParams;
  const admin = createAdminClient();
  const client = await getClient(admin, id);
  if (!client) notFound();
  const [conns, states, competitors, consentRow, brand, settings, viewers, requireApproval, importKey] = await Promise.all([
    listConnections(admin, id), listCollectState(admin, id), listCompetitors(admin, id), getConsentRow(admin, id),
    getBrandContext(admin, id), getAppSettings(admin), listViewers(admin, id), getRequireApproval(admin, id),
    part === "connections" ? getImportKey(admin, id).catch(() => null) : null,
  ]);
  // 画面に出すSNS（X は使わないため、X の連携・競合の登録があるときだけ出す）
  const shown = visiblePlatforms(conns.some((c) => c.platform === "x") || competitors.some((c) => Boolean(c.handles?.x)));
  // MEO のクライアント（同じ Supabase）。MEO の表が読めない環境では出さない
  const meo = part === "client"
    ? await Promise.all([meoClients(admin), getMeoLink(admin, id)]).then(([list, linked]) => ({ list, linked })).catch(() => null)
    : null;
  const consent = consentState(consentRow);
  const hasMeta = Boolean(metaApp());
  const hasThreads = Boolean(threadsApp());
  const hasX = Boolean(xApp());
  const reason = typeof sp.r === "string" && /^[a-z0-9-]{1,40}$/.test(sp.r) ? sp.r : null;
  const e = typeof sp.e === "string" && ERRORS[sp.e] ? `${ERRORS[sp.e]}${reason ? `（原因の手がかり：${reason}）` : ""}` : undefined;
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
      <PageHead lead={LEADS[part]} />

      {part === "client" && (
        <>
      <section id="client" aria-labelledby="h-client">
        <h2 id="h-client">クライアント情報</h2>
        <div className="card">
          <ActionForm action={updateClientAction}>
            <Hidden id={id} />
            <label htmlFor="cl-name">クライアント名<span className="req">必須</span></label>
            <input id="cl-name" name="name" type="text" required aria-required="true" maxLength={100} defaultValue={client.name} />
            <label htmlFor="cl-note">メモ（任意）</label>
            <input id="cl-note" name="note" type="text" maxLength={500} defaultValue={client.note ?? ""} />
            <div className="form-actions"><SubmitButton pendingText="保存しています…">保存</SubmitButton></div>
          </ActionForm>
        </div>
        {meo && (
          <div className="card" style={{ marginTop: 12 }}>
            <ActionForm action={linkMeoAction}>
              <Hidden id={id} />
              {(() => {
                const cur = meo.list.find((m) => m.id === meo.linked);
                return meo.linked && (
                  <p className="msg" role="status" style={{ marginTop: 0 }}>
                    いまの結び付け先：<strong>{cur ? meoLabel(cur) : "（MEO 側で削除されたクライアント）"}</strong>
                  </p>
                );
              })()}
              <label htmlFor="cl-meo">MEO のクライアント（任意）</label>
              <select id="cl-meo" name="meo_client_id" defaultValue={meo.linked ?? ""} aria-describedby="cl-meo-hint">
                <option value="">結び付けない</option>
                {meo.list.map((m) => <option key={m.id} value={m.id}>{meoLabel(m)}</option>)}
              </select>
              <p className="hint" id="cl-meo-hint">
                同じ会社の MEO（Googleマップ）のクライアントを選ぶと、月次レポートに口コミ・Googleの投稿・検索キーワードの結果も載ります。
                <strong>月次レポートはクライアントの利用者も見るため、別の会社を選ぶと、その会社の口コミの数字が見えてしまいます。</strong>店舗名で同じ会社かを確かめてください。
              </p>
              <label className="check"><input type="checkbox" name="confirm_same" />選んだ MEO のクライアントが、この会社（{client.name}）と同じであることを店舗名で確かめました</label>
              <div className="form-actions"><SubmitButton className="btn" pendingText="保存しています…">保存</SubmitButton></div>
            </ActionForm>
          </div>
        )}
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

      <section id="delete" aria-labelledby="h-delete">
        <h2 id="h-delete">データの削除</h2>
        <p className="sub">削除したデータは元に戻せません。削除すると、このクライアントのAI分析結果もあわせて削除します。保存期間（{settings.retention_days ? `${settings.retention_days}日` : "無期限"}）を過ぎたデータは自動で削除されます。</p>
        <div className="card danger-zone">
          <h3>SNS別に削除</h3>
          <ActionForm action={deleteData}>
            <Hidden id={id} />
            <label htmlFor="d-platform">SNS</label>
            <select id="d-platform" name="platform">{shown.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select>
            <label htmlFor="d-scope">対象</label>
            <select id="d-scope" name="scope"><option value="own">自社のデータ</option><option value="competitor">競合のデータ</option><option value="all">自社と競合のデータ</option></select>
            <label className="check"><input type="checkbox" name="disconnect" />連携も解除する</label>
            <label className="check"><input type="checkbox" name="confirm" required />選んだデータを削除します（元に戻せません）</label>
            <div className="form-actions"><SubmitButton className="btn danger" pendingText="削除しています…">削除</SubmitButton></div>
          </ActionForm>
          {v.isAdmin && (
            <details className="more">
              <summary>このクライアントを削除する（契約終了時など）</summary>
              <ActionForm action={deleteClientAction}>
                <Hidden id={id} />
                <p className="small">クライアントと、その連携・競合・収集データ・AI分析結果・同意の記録・利用者をすべて削除します（管理者のみ）。MEO のデータには影響しません。</p>
                <label htmlFor="d-name">確認のため、クライアント名「{client.name}」を入力してください</label>
                <input id="d-name" name="confirm_name" type="text" required autoComplete="off" />
                <div className="form-actions"><SubmitButton className="btn danger" pendingText="削除しています…">クライアントを削除</SubmitButton></div>
              </ActionForm>
            </details>
          )}
        </div>
      </section>
        </>
      )}

      {part === "connections" && (
        <>
      <section id="connections" aria-labelledby="h-conn">
        <h2 id="h-conn">SNS連携</h2>
        <p className="sub">連携すると、毎日自動でデータを収集します（直近{settings.collect_days}日間の投稿・1回あたり最大{settings.max_posts_per_run}件）。</p>
        {notice("connections")}
        <div className="card">
          {shown.map((p) => {
            // 同じSNSで複数のアカウントを連携できる。1アカウント＝1行
            const list = conns.filter((c) => c.platform === p);
            const has = list.length > 0;
            const add = has ? "アカウントを追加" : undefined;
            return (
              <div className="conn-group" key={p}>
                <div className="conn conn-head">
                  <div>
                    <div className="conn-name">
                      <Chip platform={p} />
                      {has ? <span className="badge good">{list.length}アカウント</span> : <span className="badge">未連携</span>}
                    </div>
                    {p === "instagram" && <p className="conn-meta">Instagram は Facebook ページ経由で連携します（ビジネス／クリエイターアカウントを Facebook ページに紐づけてください）。複数のページを一度に選べます。</p>}
                  </div>
                  <div className="row end">
                    {(p === "facebook" || p === "instagram") && (hasMeta
                      ? <a className={`btn ${has ? "" : "primary"}`} href={`/api/connect/meta?client=${id}`}>{add ?? "Facebook でログインして連携"}</a>
                      : <span className="small muted">Meta アプリの設定後に連携できます</span>)}
                    {p === "threads" && (hasThreads
                      ? <a className={`btn ${has ? "" : "primary"}`} href={`/api/connect/threads?client=${id}`}>{add ?? "Threads でログインして連携"}</a>
                      : <span className="small muted">Threads アプリの設定後に連携できます</span>)}
                    {p === "x" && hasX && (
                      <a className={`btn ${has ? "" : "primary"}`} href={`/api/connect/x?client=${id}`}>{add ?? "X でログインして連携（投稿・分析）"}</a>
                    )}
                  </div>
                </div>
                {(p === "threads" || p === "x") && has && (
                  <p className="conn-meta conn-note">別のアカウントを追加するときは、{PLATFORM_LABELS[p]} で連携済みのアカウントからいったんログアウトしてから「アカウントを追加」を押してください（同じアカウントのままだと、そのアカウントの再連携になります）。</p>
                )}
                {list.map((c) => {
                  const st = states.find((x) => x.platform === p && x.external_id === c.external_id);
                  const left = daysLeft(c.token_expires_at ?? null);
                  const name = accountLabel(p, c.username, c.nickname, c.external_id);
                  return (
                    <div className="conn conn-account" key={c.external_id}>
                      <div>
                        <div className="conn-name">
                          <strong>{name}</strong>
                          {c.status === "error" ? <span className="badge warn">要再連携</span> : <span className="badge good">連携中</span>}
                          {c.can_publish ? <span className="badge good">投稿できます</span> : <span className="badge">投稿するには再連携が必要</span>}
                        </div>
                        {left !== null && <p className="conn-meta">トークンの有効期限まであと{Math.max(0, Math.floor(left))}日</p>}
                        {st && <p className="conn-meta">最終収集：{fmtDateTime(st.last_run_at)}{st.posts_saved !== null && `・投稿 ${st.posts_saved}件`}{st.last_error && <><br /><span style={{ color: "var(--warn)" }}>{st.last_error}</span></>}</p>}
                        {c.last_error && !st?.last_error && <p className="conn-meta" style={{ color: "var(--warn)" }}>{c.last_error}</p>}
                      </div>
                      <div className="row end">
                        <ActionForm action={testConnection}><Hidden id={id} /><input type="hidden" name="platform" value={p} /><input type="hidden" name="external_id" value={c.external_id} />
                          <SubmitButton className="btn" pendingText="確認しています…">連携を確認</SubmitButton></ActionForm>
                      </div>
                      <details className="more" style={{ gridColumn: "1 / -1" }}>
                        <summary>{c.nickname ? "呼び名を変える" : "呼び名を付ける（「本店」「店舗A」など）"}</summary>
                        <ActionForm action={saveNickname} className="row">
                          <Hidden id={id} /><input type="hidden" name="platform" value={p} /><input type="hidden" name="external_id" value={c.external_id} />
                          <label htmlFor={`nick-${p}-${c.external_id}`} className="sr-only">{name}の呼び名</label>
                          <input id={`nick-${p}-${c.external_id}`} name="nickname" type="text" maxLength={30} defaultValue={c.nickname ?? ""} placeholder="例：本店" style={{ maxWidth: 240 }} />
                          <SubmitButton className="btn" pendingText="保存しています…">保存</SubmitButton>
                        </ActionForm>
                        <p className="hint">レポートのアカウントの切り替えと、投稿先の選択に表示します。空にして保存すると外れます。</p>
                      </details>
                      <details className="more" style={{ gridColumn: "1 / -1" }}>
                        <summary>このアカウントの連携を解除する</summary>
                        <ActionForm action={disconnect}>
                          <Hidden id={id} /><input type="hidden" name="platform" value={p} /><input type="hidden" name="external_id" value={c.external_id} />
                          <label className="check"><input type="checkbox" name="delete_data" />このアカウント（{name}）の収集済みのデータも削除する（ほかのアカウントと競合のデータは残ります）</label>
                          <div className="form-actions"><SubmitButton className="btn danger" pendingText="解除しています…">連携を解除</SubmitButton></div>
                        </ActionForm>
                      </details>
                    </div>
                  );
                })}
                {p === "x" && (
                  <details className="more conn-note">
                    <summary>{hasX ? "分析だけに使う：Bearer Token で連携する" : "Bearer Token で連携する（アカウントを追加・更新）"}</summary>
                    <ActionForm action={connectX} resetOnSuccess>
                      <Hidden id={id} />
                      <label htmlFor="x-user">X のユーザー名<span className="req">必須</span></label>
                      <input id="x-user" name="username" type="text" required aria-required="true" autoComplete="off" placeholder="例：example" />
                      <label htmlFor="x-token">Bearer Token<span className="req">必須</span></label>
                      <input id="x-token" name="bearer_token" type="password" required aria-required="true" autoComplete="off" aria-describedby="x-token-hint" />
                      <p className="hint" id="x-token-hint">X Developer Portal のアプリで発行します。保存後は画面に表示されません。Bearer Token では投稿できません（分析だけ）。同じユーザー名なら更新、違うユーザー名ならアカウントの追加になります。X API は従量課金のため、取得件数は全体設定の上限に従います。</p>
                      <div className="form-actions"><SubmitButton pendingText="確認しています…">保存して確認</SubmitButton></div>
                    </ActionForm>
                  </details>
                )}
              </div>
            );
          })}
          {(!hasMeta || !hasThreads || (!hasX && shown.includes("x"))) && (
            <p className="note">{!hasMeta && "Facebook・Instagram の連携には Meta アプリの設定（META_APP_ID / META_APP_SECRET）が必要です。"}{!hasThreads && "Threads の連携には THREADS_APP_ID / THREADS_APP_SECRET が必要です。"}{!hasX && shown.includes("x") && "X への投稿には X_CLIENT_ID / X_CLIENT_SECRET が必要です。"}手順は README をご覧ください。</p>
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
              <thead><tr><th scope="col">競合</th>{shown.map((p) => <th scope="col" key={p}>{PLATFORM_LABELS[p]}</th>)}<th scope="col"><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {competitors.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.name}</th>
                    {shown.map((p) => <td key={p} className="small">{c.handles?.[p] ?? "—"}</td>)}
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
              {shown.map((p) => (
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

      <section id="import" aria-labelledby="h-import">
        <h2 id="h-import">CSV取り込み・フォロワー数の記録</h2>
        <p className="sub">APIで取得できないデータを補います。Meta Business Suite や X アナリティクスのエクスポート（UTF-8 / Shift_JIS）をそのまま取り込めます。</p>
        <div className="grid wide">
          <div className="card">
            <h3>投稿のCSVを取り込む</h3>
            <ActionForm action={importCsv} resetOnSuccess>
              <Hidden id={id} />
              <OwnerFields competitors={competitors} prefix="i" platforms={shown} />
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
              <OwnerFields competitors={competitors} prefix="f" platforms={shown} />
              <label htmlFor="f-count">フォロワー数<span className="req">必須</span></label>
              <input id="f-count" name="followers" type="number" min={0} step={1} required inputMode="numeric" />
              <label htmlFor="f-date">日付</label>
              <input id="f-date" name="date" type="date" max={todayIn()} defaultValue={todayIn()} />
              <div className="form-actions"><SubmitButton pendingText="記録しています…">記録</SubmitButton></div>
            </ActionForm>
          </div>
        </div>
      </section>

      <section id="external" aria-labelledby="h-external">
        <h2 id="h-external">外部ツールからの投稿の登録</h2>
        <p className="sub">
          Rhythmos AI で作ったカルーセルなどを、コマンド1つでこのクライアントの「投稿」に<strong>承認待ち</strong>で登録できるようにします。
          登録された投稿は、スタッフが「投稿」の画面で中身を見て承認するまで公開されません。
        </p>
        <div className="card">
          {importKey ? (
            <p>
              合言葉：発行済み（末尾 <code>{importKey.key_hint}</code>・{importKey.created_by_name ?? "—"}・{fmtDateTime(importKey.created_at)}）
              <br /><span className="muted small">最後に使われた日時：{importKey.last_used_at ? fmtDateTime(importKey.last_used_at) : "まだ使われていません"}</span>
            </p>
          ) : <p className="muted">合言葉はまだ発行していません。</p>}
          <dl className="kv-list">
            <dt>クライアントID</dt><dd><code>{id}</code></dd>
          </dl>
          <div className="form-actions">
            <ActionForm action={issueImportKey}>
              <Hidden id={id} />
              <SubmitButton pendingText="発行しています…">{importKey ? "合言葉を作り直す（前の合言葉は使えなくなります）" : "合言葉を発行する"}</SubmitButton>
            </ActionForm>
            {importKey && (
              <ActionForm action={revokeImportKey}>
                <Hidden id={id} />
                <SubmitButton pendingText="無効にしています…" className="btn danger">合言葉を無効にする</SubmitButton>
              </ActionForm>
            )}
          </div>
        </div>
      </section>
        </>
      )}

      {part === "users" && (
        <>
      <section id="viewers" aria-labelledby="h-viewers">
        <h2 id="h-viewers">利用者</h2>
        {notice("viewers")}
        <p className="sub">このクライアントのレポートの閲覧・ダウンロードと、SNSへの投稿の作成・予約ができるアカウントです。設定の変更やAI分析の実行はできません。</p>
        {viewers.length > 0 && (
          <div className="card flush scroll">
            <table>
              <caption className="sr-only">利用者の一覧</caption>
              <thead><tr><th scope="col">氏名</th><th scope="col">メールアドレス</th><th scope="col">状態</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {viewers.map((u) => (
                  <tr key={u.user_id}>
                    <th scope="row">{u.name}</th>
                    <td className="small">{u.email}</td>
                    <td>{u.must_change_password ? <span className="badge">初回ログイン前</span> : <span className="badge good">利用中</span>}{!u.created_by_sns && <span className="badge" style={{ marginLeft: 6 }}>MEOと共通</span>}</td>
                    <td>
                      <details className="more">
                        <summary>操作<span className="sr-only">：{u.name}</span></summary>
                        {u.created_by_sns && (
                          <ActionForm action={resetViewerPasswordAction}>
                            <Hidden id={id} /><input type="hidden" name="user_id" value={u.user_id} />
                            <div className="form-actions"><SubmitButton className="btn" pendingText="再発行しています…">初期パスワードを再発行</SubmitButton></div>
                          </ActionForm>
                        )}
                        <ActionForm action={removeViewerAction}>
                          <Hidden id={id} /><input type="hidden" name="user_id" value={u.user_id} />
                          <label className="check"><input type="checkbox" name="confirm" required />「{u.name}」を利用者から削除します</label>
                          <div className="form-actions"><SubmitButton className="btn danger" pendingText="削除しています…">削除</SubmitButton></div>
                        </ActionForm>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card" style={{ marginTop: 16 }}>
          <h3>投稿の承認</h3>
          <ActionForm action={setApprovalAction}>
            <Hidden id={id} />
            <label className="check"><input type="checkbox" name="require_approval" defaultChecked={requireApproval} />利用者が作った投稿は、スタッフの承認を経てから公開する</label>
            <p className="hint">
              通常はオフです（利用者が作った投稿は、クライアントの責任でそのまま公開されます）。オンにすると、利用者の投稿は「投稿」の画面で承認待ちになり、スタッフが「承認する」か「差し戻す」を選べます。
              スタッフが作った投稿は承認なしで公開されます。外部ツール（Rhythmos AI）から登録した投稿は、この設定に関係なく承認待ちになります。
            </p>
            <div className="form-actions"><SubmitButton className="btn" pendingText="保存しています…">保存</SubmitButton></div>
          </ActionForm>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h3>利用者を追加</h3>
          <ActionForm action={addViewerAction} resetOnSuccess>
            <Hidden id={id} />
            <label htmlFor="vw-name">氏名<span className="req">必須</span></label>
            <input id="vw-name" name="name" type="text" required aria-required="true" maxLength={100} autoComplete="off" />
            <label htmlFor="vw-email">メールアドレス<span className="req">必須</span></label>
            <input id="vw-email" name="email" type="email" required aria-required="true" maxLength={254} autoComplete="off" aria-describedby="vw-hint" />
            <p className="hint" id="vw-hint">初期パスワードを作成して画面に表示します（メールは送信しません）。ご本人に安全な方法で伝えてください。すでに MEO のアカウントがある方は、そのアカウントのまま追加します。</p>
            <div className="form-actions"><SubmitButton pendingText="追加しています…">追加</SubmitButton></div>
          </ActionForm>
        </div>
      </section>
        </>
      )}
    </>
  );
}

function OwnerFields({ competitors, prefix, platforms }: { competitors: { id: string; name: string }[]; prefix: string; platforms: Platform[] }) {
  return (
    <>
      <label htmlFor={`${prefix}-owner`}>記録先</label>
      <select id={`${prefix}-owner`} name="owner" defaultValue="own">
        <option value="own">自社</option>
        {competitors.map((c) => <option key={c.id} value={c.id}>競合：{c.name}</option>)}
      </select>
      <label htmlFor={`${prefix}-platform`}>SNS</label>
      <select id={`${prefix}-platform`} name="platform">{platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select>
      <label htmlFor={`${prefix}-user`}>アカウント名（ユーザー名）<span className="req">必須</span></label>
      <input id={`${prefix}-user`} name="username" type="text" required aria-required="true" autoComplete="off" />
    </>
  );
}
