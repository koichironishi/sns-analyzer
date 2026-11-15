import Link from "next/link";
import { PLATFORM_LABELS, accountLabel, type Platform } from "@/lib/sns/models";
import { publishTextFor, textFor } from "@/lib/sns/publish/run";
import { resolveTargets } from "@/lib/sns/publish/targets";
import type { ScheduledPost } from "@/lib/sns/store";
import { fmtDateTime, truncate } from "@/lib/format";
import { PostActions } from "@/components/post-actions";

export const STATUS: Record<ScheduledPost["status"], [string, string]> = {
  draft: ["下書き", ""], pending: ["承認待ち", "info"], rejected: ["差し戻し", "warn"], scheduled: ["予約中", "info"], publishing: ["投稿中", "info"], published: ["投稿済み", "good"],
  partial: ["一部失敗", "warn"], failed: ["失敗", "warn"], canceled: ["取り消し", ""],
};

export type Conn = { platform: Platform; external_id: string; username: string | null; nickname?: string | null; connected_at: string };

/** 1行目を題名、残りを本文の抜き出しとして分ける（一覧で何の投稿かをすぐ見分けられるように） */
export function splitText(text: string): { title: string; rest: string } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return { title: truncate(lines[0] ?? "", 60), rest: lines.slice(1).join(" ") };
}

/**
 * 投稿1件。一覧で縦に長くならないよう、画像は先頭の1枚と枚数、本文は題名と2行だけを出す。
 * 画像を順番どおり大きく並べた確認と全文は、「確認」で開く別のページ（detail）に出す。
 * 承認待ちは一覧でも最初から中身を出す（2026-10-14 の取り違えの反省）
 */
export function PostCard({ post, clientId, isStaff, conns, detail = false }: { post: ScheduledPost; clientId: string; isStaff: boolean; conns: Conn[]; detail?: boolean }) {
  const [label, kind] = STATUS[post.status];
  const when = post.status === "pending"
    ? (post.requested_mode === "now" ? "承認されたらすぐ投稿" : `希望 ${fmtDateTime(post.scheduled_at)}`)
    : post.status === "scheduled" || post.status === "publishing" ? fmtDateTime(post.scheduled_at)
    : post.published_at ? fmtDateTime(post.published_at)
    // 下書きに予定の日時があれば（CSVの一括予約など）それを出す。並べ替えの目安になるため
    : post.scheduled_at ? `予定 ${fmtDateTime(post.scheduled_at)}` : `作成 ${fmtDateTime(post.created_at)}`;
  const { title, rest } = splitText(post.text);
  const targets = resolveTargets(post, conns);
  const first = post.media[0];
  const showPreview = detail || post.status === "pending";
  const previewDetail = post.kind === "story" ? `ストーリーズ${post.media.length}枚` : post.media.length ? `画像${post.media.length}枚・全文` : "全文";
  const listHref = `/clients/${clientId}/publish`;
  // 一覧では <li>、確認のページでは1件だけなので <article>
  const Tag = detail ? "article" : "li";
  return (
    <Tag className={`card post-card compact${detail ? " detail" : ""}`} id={`post-${post.id}`}>
      <div className="post-main">
        {!detail && (
          <label className="post-check">
            <input type="checkbox" className="post-select" value={post.id} disabled={post.status === "publishing"} />
            <span className="sr-only">「{title || "本文なし"}」を選ぶ</span>
          </label>
        )}
        <div className="post-thumb">
          {first
            /* eslint-disable-next-line @next/next/no-img-element */
            ? <img src={first.url} alt="" loading="lazy" />
            : <span className="post-thumb-empty" aria-hidden="true">画像なし</span>}
          {post.media.length > 1 && <span className="post-thumb-count" aria-hidden="true">{post.media.length}枚</span>}
        </div>
        <div className="post-body">
          <p className="post-meta">
            <span className={`badge ${kind}`}>{label}</span>
            {post.kind === "story" && <span className="badge story">ストーリーズ{post.media.length > 1 ? `×${post.media.length}` : ""}</span>}
            <strong className="post-when">{when}</strong>
            <span className="small muted">作成者：{post.created_by_name ?? "—"}</span>
          </p>
          <p className="post-title">{title || <span className="muted">{post.kind === "story" ? "（メモなし）" : "（本文なし）"}</span>}</p>
          {rest && !detail && <p className="post-excerpt">{rest}</p>}
          <ul className="post-targets" aria-label="投稿先">
            {/* 投稿先はアカウントごと（同じSNSの複数アカウントに出せる） */}
            {targets.map((t) => {
              const p = t.platform;
              const r = post.results?.[t.key];
              const conn = conns.find((c) => c.platform === p && c.external_id === t.externalId);
              const name = conn ? accountLabel(p, conn.username, conn.nickname) : null;
              // 投稿済みでリンクがあるときは、SNSの名前そのものを投稿へのリンクにする（アカウント名は、同じSNSに複数出したときだけ）
              if (r?.state === "published" && r.permalink) {
                const dup = targets.filter((x) => x.platform === p).length > 1;
                return (
                  <li key={t.key}>
                    <i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />
                    <a href={r.permalink} target="_blank" rel="noopener noreferrer">{PLATFORM_LABELS[p]}{dup && name && `（${name}）`}<span className="sr-only">（投稿済み・SNSの投稿を新しいタブで開きます）</span></a>
                  </li>
                );
              }
              return (
                <li key={t.key}>
                  <i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />
                  {PLATFORM_LABELS[p]}{name && <span className="muted">（{name}）</span>}
                  {r?.state === "published" && <> <span className="badge good">投稿済み</span></>}
                  {r?.state === "failed" && <> <span className="badge warn">失敗</span></>}
                  {!r && textFor(post, p) !== post.text && <span className="muted">（専用の本文あり）</span>}
                </li>
              );
            })}
          </ul>
          {/* 失敗の理由は省略せずに出す（直すための情報のため） */}
          {targets.some((t) => post.results?.[t.key]?.state === "failed") && (
            <ul className="post-errors">
              {targets.filter((t) => post.results?.[t.key]?.state === "failed").map((t) => (
                <li key={t.key} className="small"><strong>{PLATFORM_LABELS[t.platform]}：</strong>{post.results[t.key]!.error}</li>
              ))}
            </ul>
          )}
          {post.status === "rejected" && post.review_note && <p className="msg error" style={{ margin: "8px 0 0" }}>差し戻しの理由（{post.reviewed_by_name ?? "担当者"}）：{post.review_note}</p>}
          {post.reviewed_at && post.status !== "rejected" && post.status !== "pending" && <p className="small muted" style={{ margin: "4px 0 0" }}>承認：{post.reviewed_by_name}（{fmtDateTime(post.reviewed_at)}）</p>}
        </div>
      </div>
      <div className="post-foot">
        {/* 確認：画像を順番どおり大きく並べたものと全文を、別のページで見る */}
        {!detail && <Link className="btn sm" href={`${listHref}/${post.id}/view`}>確認<span className="sr-only">（「{title || "本文なし"}」の{previewDetail}を見る）</span></Link>}
        {/* 複製：本文・画像・投稿先を入れた新しい投稿を作る（画像は保存時に複製する。日時は入れない）。削除より前に置く */}
        {post.status !== "publishing" && (
          <Link className="btn sm" href={`/clients/${clientId}/publish/new?from=${post.id}`}>複製<span className="sr-only">（「{title || "本文なし"}」の本文・画像・投稿先を入れた新しい投稿を作ります）</span></Link>
        )}
        <PostActions clientId={clientId} postId={post.id} status={post.status} isStaff={isStaff} afterDelete={detail ? listHref : undefined} />
      </div>
      {showPreview && (
      <div className="post-preview">
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
        {post.kind !== "story" && [...new Set(targets.map((t) => t.platform))].map((p) => (
          <div key={p} className="preview-text">
            <p className="small muted" style={{ margin: "8px 0 4px" }}><i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" /> {PLATFORM_LABELS[p]}の本文</p>
            {/* 実際に投稿する本文（計測用の印を付ける設定なら、付けたあとの文） */}
            <p style={{ whiteSpace: "pre-wrap", margin: 0, overflowWrap: "anywhere" }}>{publishTextFor(post, p) || <span className="muted">（本文なし）</span>}</p>
          </div>
        ))}
      </div>
      )}
    </Tag>
  );
}

