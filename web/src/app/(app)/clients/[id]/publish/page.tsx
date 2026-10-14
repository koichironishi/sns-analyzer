import type { Metadata } from "next";
import Link from "next/link";
import { publishContext } from "@/lib/publish-page";
import { listConnections, listScheduledPosts, type ScheduledPost } from "@/lib/sns/store";
import { PLATFORM_LABELS } from "@/lib/sns/models";
import { textFor } from "@/lib/sns/publish/run";
import { resolveTargets } from "@/lib/sns/publish/targets";
import type { Platform } from "@/lib/sns/models";
import { fmtDateTime, truncate } from "@/lib/format";
import { Flash } from "@/components/flash";
import { PageHead } from "@/components/report-ui";
import { PostActions } from "@/components/post-actions";

export const metadata: Metadata = { title: "投稿" };

const STATUS: Record<ScheduledPost["status"], [string, string]> = {
  draft: ["下書き", ""], pending: ["承認待ち", "info"], rejected: ["差し戻し", "warn"], scheduled: ["予約中", "info"], publishing: ["投稿中", "info"], published: ["投稿済み", "good"],
  partial: ["一部失敗", "warn"], failed: ["失敗", "warn"], canceled: ["取り消し", ""],
};
const OK: Record<string, [kind: "ok" | "error", text: string]> = {
  published: ["ok", "投稿しました。"], partial: ["error", "一部のSNSで投稿に失敗しました。下の一覧で理由を確認し、再投稿してください。"],
  failed: ["error", "投稿に失敗しました。下の一覧で理由を確認してください。"], publish_error: ["error", "投稿の処理を始められませんでした。一覧で状態を確認してください。"],
  scheduled: ["ok", "予約しました。予約時刻から数分以内に投稿します。"], draft: ["ok", "下書きを保存しました。"],
  pending: ["ok", "担当者に承認を依頼しました。承認されると投稿されます。"],
};

type Conn = { platform: Platform; external_id: string; username: string | null; connected_at: string };

function PostCard({ post, clientId, isStaff, conns }: { post: ScheduledPost; clientId: string; isStaff: boolean; conns: Conn[] }) {
  const [label, kind] = STATUS[post.status];
  const when = post.status === "pending"
    ? (post.requested_mode === "now" ? "希望：承認されたらすぐ投稿" : `希望の予約：${fmtDateTime(post.scheduled_at)}`)
    : post.status === "scheduled" ? `予約：${fmtDateTime(post.scheduled_at)}` : post.published_at ? `投稿：${fmtDateTime(post.published_at)}` : `作成：${fmtDateTime(post.created_at)}`;
  return (
    <li className="card post-card">
      <div className="row">
        <span className={`badge ${kind}`}>{label}</span>
        <span className="small muted">{when}</span>
        <span className="small muted">作成者：{post.created_by_name ?? "—"}</span>
      </div>
      {post.status === "rejected" && post.review_note && <p className="msg error" style={{ margin: "8px 0" }}>差し戻しの理由（{post.reviewed_by_name ?? "担当者"}）：{post.review_note}</p>}
      {post.reviewed_at && post.status !== "rejected" && post.status !== "pending" && <p className="small muted" style={{ margin: "4px 0" }}>承認：{post.reviewed_by_name}（{fmtDateTime(post.reviewed_at)}）</p>}
      <p style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{truncate(post.text, 160) || <span className="muted">（本文なし）</span>}</p>
      {post.media.length > 0 && (
        <ul className="thumbs small-thumbs" aria-label="画像">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {post.media.map((m, i) => <li key={m.path}><img src={m.url} alt={`画像${i + 1}`} loading="lazy" /></li>)}
        </ul>
      )}
      <ul className="post-results">
        {/* 投稿先はアカウントごと（同じSNSの複数アカウントに出せる） */}
        {resolveTargets(post, conns).map((t) => {
          const p = t.platform;
          const r = post.results?.[t.key];
          const name = conns.find((c) => c.platform === p && c.external_id === t.externalId)?.username;
          return (
            <li key={t.key}>
              <i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />
              <strong>{PLATFORM_LABELS[p]}</strong>{name && <span className="small">（{name}）</span>}
              {r?.state === "published" ? <> <span className="badge good">投稿済み</span>{r.permalink && <> <a href={r.permalink} target="_blank" rel="noopener noreferrer">SNSで見る<span className="sr-only">（{PLATFORM_LABELS[p]}・新しいタブで開きます）</span></a></>}</>
                : r?.state === "failed" ? <> <span className="badge warn">失敗</span> <span className="small">{r.error}</span></>
                : <span className="small muted"> {textFor(post, p) !== post.text ? "（専用の本文あり）" : ""}</span>}
            </li>
          );
        })}
      </ul>
      {/* 公開前（承認待ち・予約中・下書き）は、画像を大きく並べて本文と一緒に確かめられるようにする。
          承認待ちは最初から開く（小さな画像のまま承認して、間違った画像が投稿されかけたため。2026-10-14） */}
      {["pending", "scheduled", "draft", "rejected"].includes(post.status) && (
        <details className="post-preview" open={post.status === "pending"}>
          <summary>中身を確認する（画像{post.media.length}枚・本文{new Set(resolveTargets(post, conns).map((t) => t.platform)).size > 1 ? "・SNSごと" : ""}）</summary>
          {post.media.length > 0 && (
            <ol className="preview-grid" aria-label="投稿する画像（この順番で投稿されます）">
              {post.media.map((m, i) => (
                <li key={m.path}>
                  <span className="preview-no" aria-hidden="true">{i + 1}</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <a href={m.url} target="_blank" rel="noopener noreferrer"><img src={m.url} alt={`${i + 1}枚目`} loading="lazy" /><span className="sr-only">（{i + 1}枚目を新しいタブで大きく開きます）</span></a>
                </li>
              ))}
            </ol>
          )}
          {[...new Set(resolveTargets(post, conns).map((t) => t.platform))].map((p) => (
            <div key={p} className="preview-text">
              <p className="small muted" style={{ margin: "8px 0 4px" }}><i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" /> {PLATFORM_LABELS[p]}の本文</p>
              <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{textFor(post, p) || <span className="muted">（本文なし）</span>}</p>
            </div>
          ))}
        </details>
      )}
      <PostActions clientId={clientId} postId={post.id} status={post.status} isStaff={isStaff} />
    </li>
  );
}

export default async function PublishPage({ params, searchParams }: PageProps<"/clients/[id]/publish">) {
  const { id } = await params;
  const sp = await searchParams;
  const { v, admin, connections, needsApproval } = await publishContext(id);
  const isStaff = v.kind === "staff";
  const [posts, conns] = await Promise.all([listScheduledPosts(admin, id), listConnections(admin, id)]);
  const ok = typeof sp.ok === "string" ? OK[sp.ok] : undefined;
  const pending = posts.filter((p) => p.status === "pending");
  const upcoming = posts.filter((p) => ["scheduled", "publishing"].includes(p.status)).sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  const drafts = posts.filter((p) => ["draft", "rejected", "canceled"].includes(p.status));
  const done = posts.filter((p) => ["published", "partial", "failed"].includes(p.status));
  const canPost = connections.some((c) => c.canPublish);
  return (
    <>
      <PageHead lead="Instagram・Facebook・Threads・X への投稿を作成し、今すぐ投稿または予約できます。" />
      {ok && <Flash kind={ok[0]}>{ok[1]}</Flash>}
      <div className="row" style={{ marginBottom: 16 }}>
        {canPost ? <Link className="btn primary" href={`/clients/${id}/publish/new`}>新しい投稿を作成</Link>
          : <p className="msg" role="status" style={{ margin: 0 }}>投稿できるSNSがありません。スタッフが「設定・連携」で、投稿の許可を含めて SNS を連携すると使えるようになります。</p>}
      </div>
      {needsApproval && <p className="note-top">この画面で作成した投稿は、担当者の承認を経てから公開されます。</p>}
      {[["承認待ち", pending, isStaff ? "承認待ちの投稿はありません。" : "承認を待っている投稿はありません。"], ["予約中", upcoming, "予約中の投稿はありません。"],
        ["下書き・差し戻し・取り消し", drafts, "下書きはありません。"], ["投稿済み・失敗", done, "まだ投稿はありません。"]].map(([title, list, empty]) => (
        <section key={title as string} aria-labelledby={`h-${title}`}>
          <h2 id={`h-${title}`}>{title as string}</h2>
          {(list as ScheduledPost[]).length === 0 ? <p className="muted">{empty as string}</p>
            : <ul className="post-list">{(list as ScheduledPost[]).map((p) => <PostCard key={p.id} post={p} clientId={id} isStaff={isStaff} conns={conns} />)}</ul>}
        </section>
      ))}
    </>
  );
}
