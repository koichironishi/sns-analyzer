import type { Metadata } from "next";
import Link from "next/link";
import { publishContext } from "@/lib/publish-page";
import { listScheduledPosts, type ScheduledPost } from "@/lib/sns/store";
import { PLATFORM_LABELS } from "@/lib/sns/models";
import { textFor } from "@/lib/sns/publish/run";
import { fmtDateTime, truncate } from "@/lib/format";
import { Flash } from "@/components/flash";
import { PageHead } from "@/components/report-ui";
import { PostActions } from "@/components/post-actions";

export const metadata: Metadata = { title: "投稿" };

const STATUS: Record<ScheduledPost["status"], [string, string]> = {
  draft: ["下書き", ""], scheduled: ["予約中", "info"], publishing: ["投稿中", "info"], published: ["投稿済み", "good"],
  partial: ["一部失敗", "warn"], failed: ["失敗", "warn"], canceled: ["取り消し", ""],
};
const OK: Record<string, [kind: "ok" | "error", text: string]> = {
  published: ["ok", "投稿しました。"], partial: ["error", "一部のSNSで投稿に失敗しました。下の一覧で理由を確認し、再投稿してください。"],
  failed: ["error", "投稿に失敗しました。下の一覧で理由を確認してください。"], publish_error: ["error", "投稿の処理を始められませんでした。一覧で状態を確認してください。"],
  scheduled: ["ok", "予約しました。予約時刻から数分以内に投稿します。"], draft: ["ok", "下書きを保存しました。"],
};

function PostCard({ post, clientId }: { post: ScheduledPost; clientId: string }) {
  const [label, kind] = STATUS[post.status];
  const when = post.status === "scheduled" ? `予約：${fmtDateTime(post.scheduled_at)}` : post.published_at ? `投稿：${fmtDateTime(post.published_at)}` : `作成：${fmtDateTime(post.created_at)}`;
  return (
    <li className="card post-card">
      <div className="row">
        <span className={`badge ${kind}`}>{label}</span>
        <span className="small muted">{when}</span>
        <span className="small muted">作成者：{post.created_by_name ?? "—"}</span>
      </div>
      <p style={{ margin: "8px 0", whiteSpace: "pre-wrap" }}>{truncate(post.text, 160) || <span className="muted">（本文なし）</span>}</p>
      {post.media.length > 0 && (
        <ul className="thumbs small-thumbs" aria-label="画像">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {post.media.map((m, i) => <li key={m.path}><img src={m.url} alt={`画像${i + 1}`} loading="lazy" /></li>)}
        </ul>
      )}
      <ul className="post-results">
        {post.platforms.map((p) => {
          const r = post.results?.[p];
          return (
            <li key={p}>
              <i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />
              <strong>{PLATFORM_LABELS[p]}</strong>
              {r?.state === "published" ? <> <span className="badge good">投稿済み</span>{r.permalink && <> <a href={r.permalink} target="_blank" rel="noopener noreferrer">SNSで見る<span className="sr-only">（{PLATFORM_LABELS[p]}・新しいタブで開きます）</span></a></>}</>
                : r?.state === "failed" ? <> <span className="badge warn">失敗</span> <span className="small">{r.error}</span></>
                : <span className="small muted"> {textFor(post, p) !== post.text ? "（専用の本文あり）" : ""}</span>}
            </li>
          );
        })}
      </ul>
      <PostActions clientId={clientId} postId={post.id} status={post.status} />
    </li>
  );
}

export default async function PublishPage({ params, searchParams }: PageProps<"/clients/[id]/publish">) {
  const { id } = await params;
  const sp = await searchParams;
  const { admin, client, connections } = await publishContext(id);
  const posts = await listScheduledPosts(admin, id);
  const ok = typeof sp.ok === "string" ? OK[sp.ok] : undefined;
  const upcoming = posts.filter((p) => ["scheduled", "publishing"].includes(p.status)).sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""));
  const drafts = posts.filter((p) => ["draft", "canceled"].includes(p.status));
  const done = posts.filter((p) => ["published", "partial", "failed"].includes(p.status));
  const canPost = connections.some((c) => c.canPublish);
  return (
    <>
      <PageHead eyebrow={client.name} title="投稿" lead="Instagram・Facebook・Threads・X への投稿を作成し、今すぐ投稿または予約できます。" />
      {ok && <Flash kind={ok[0]}>{ok[1]}</Flash>}
      <div className="row" style={{ marginBottom: 16 }}>
        {canPost ? <Link className="btn primary" href={`/clients/${id}/publish/new`}>新しい投稿を作成</Link>
          : <p className="msg" role="status" style={{ margin: 0 }}>投稿できるSNSがありません。スタッフが「設定・連携」で、投稿の許可を含めて SNS を連携すると使えるようになります。</p>}
      </div>
      {[["予約中", upcoming, "予約中の投稿はありません。"], ["下書き・取り消し", drafts, "下書きはありません。"], ["投稿済み・失敗", done, "まだ投稿はありません。"]].map(([title, list, empty]) => (
        <section key={title as string} aria-labelledby={`h-${title}`}>
          <h2 id={`h-${title}`}>{title as string}</h2>
          {(list as ScheduledPost[]).length === 0 ? <p className="muted">{empty as string}</p>
            : <ul className="post-list">{(list as ScheduledPost[]).map((p) => <PostCard key={p.id} post={p} clientId={id} />)}</ul>}
        </section>
      ))}
    </>
  );
}
