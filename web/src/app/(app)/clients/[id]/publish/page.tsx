import type { Metadata } from "next";
import Link from "next/link";
import { publishContext } from "@/lib/publish-page";
import { listConnections, listScheduledPosts, type ScheduledPost } from "@/lib/sns/store";
import { PLATFORM_LABELS, accountLabel } from "@/lib/sns/models";
import { publishTextFor, textFor } from "@/lib/sns/publish/run";
import { resolveTargets } from "@/lib/sns/publish/targets";
import type { Platform } from "@/lib/sns/models";
import { fmtDateTime, truncate } from "@/lib/format";
import { Flash } from "@/components/flash";
import { PageHead } from "@/components/report-ui";
import { PostActions } from "@/components/post-actions";
import { PublishViewSwitch } from "@/components/publish-view-switch";

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

type Conn = { platform: Platform; external_id: string; username: string | null; nickname?: string | null; connected_at: string };

/** 1行目を題名、残りを本文の抜き出しとして分ける（一覧で何の投稿かをすぐ見分けられるように） */
function splitText(text: string): { title: string; rest: string } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return { title: truncate(lines[0] ?? "", 60), rest: lines.slice(1).join(" ") };
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
/** 日本時間の「10月24日（金）」 */
function dayLabel(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return `${p.month}月${p.day}日（${WD[wd]}）`;
}
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

/**
 * 投稿1件。一覧で縦に長くならないよう、画像は先頭の1枚と枚数、本文は題名と2行だけを出す。
 * 画像を順番どおり大きく並べた確認と全文は「中身を確認する」に畳む（承認待ちは最初から開く。2026-10-14 の取り違えの反省）
 */
function PostCard({ post, clientId, isStaff, conns }: { post: ScheduledPost; clientId: string; isStaff: boolean; conns: Conn[] }) {
  const [label, kind] = STATUS[post.status];
  const when = post.status === "pending"
    ? (post.requested_mode === "now" ? "承認されたらすぐ投稿" : `希望 ${fmtDateTime(post.scheduled_at)}`)
    : post.status === "scheduled" || post.status === "publishing" ? fmtDateTime(post.scheduled_at)
    : post.published_at ? fmtDateTime(post.published_at) : `作成 ${fmtDateTime(post.created_at)}`;
  const { title, rest } = splitText(post.text);
  const targets = resolveTargets(post, conns);
  const first = post.media[0];
  return (
    <li className="card post-card compact" id={`post-${post.id}`}>
      <div className="post-main">
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
            <strong className="post-when">{when}</strong>
            <span className="small muted">作成者：{post.created_by_name ?? "—"}</span>
          </p>
          <p className="post-title">{title || <span className="muted">（本文なし）</span>}</p>
          {rest && <p className="post-excerpt">{rest}</p>}
          <ul className="post-targets" aria-label="投稿先">
            {/* 投稿先はアカウントごと（同じSNSの複数アカウントに出せる） */}
            {targets.map((t) => {
              const p = t.platform;
              const r = post.results?.[t.key];
              const conn = conns.find((c) => c.platform === p && c.external_id === t.externalId);
              const name = conn ? accountLabel(p, conn.username, conn.nickname) : null;
              return (
                <li key={t.key}>
                  <i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />
                  {PLATFORM_LABELS[p]}{name && <span className="muted">（{name}）</span>}
                  {r?.state === "published" && <> <span className="badge good">投稿済み</span>{r.permalink && <> <a href={r.permalink} target="_blank" rel="noopener noreferrer">SNSで見る<span className="sr-only">（{PLATFORM_LABELS[p]}・新しいタブで開きます）</span></a></>}</>}
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
      <details className="post-preview" open={post.status === "pending"}>
        <summary>中身を確認する（画像{post.media.length}枚・全文）</summary>
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
        {[...new Set(targets.map((t) => t.platform))].map((p) => (
          <div key={p} className="preview-text">
            <p className="small muted" style={{ margin: "8px 0 4px" }}><i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" /> {PLATFORM_LABELS[p]}の本文</p>
            {/* 実際に投稿する本文（計測用の印を付ける設定なら、付けたあとの文） */}
            <p style={{ whiteSpace: "pre-wrap", margin: 0, overflowWrap: "anywhere" }}>{publishTextFor(post, p) || <span className="muted">（本文なし）</span>}</p>
          </div>
        ))}
      </details>
      <div className="post-foot">
        <PostActions clientId={clientId} postId={post.id} status={post.status} isStaff={isStaff} />
        {["published", "partial", "failed", "canceled"].includes(post.status) && (
          <Link className="small" href={`/clients/${clientId}/publish/new?from=${post.id}`}>これをもとに新しい投稿を作る<span className="sr-only">（本文・画像・投稿先を入れた状態で始めます）</span></Link>
        )}
      </div>
    </li>
  );
}

type TabKey = "pending" | "scheduled" | "draft" | "done";
const DONE_PAGE = 20;

export default async function PublishPage({ params, searchParams }: PageProps<"/clients/[id]/publish">) {
  const { id } = await params;
  const sp = await searchParams;
  const { v, admin, connections, needsApproval } = await publishContext(id);
  const isStaff = v.kind === "staff";
  const [posts, conns] = await Promise.all([listScheduledPosts(admin, id), listConnections(admin, id)]);
  const ok = typeof sp.ok === "string" ? OK[sp.ok] : undefined;
  const lists: Record<TabKey, ScheduledPost[]> = {
    pending: posts.filter((p) => p.status === "pending"),
    scheduled: posts.filter((p) => ["scheduled", "publishing"].includes(p.status)).sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "")),
    draft: posts.filter((p) => ["draft", "rejected", "canceled"].includes(p.status)),
    done: posts.filter((p) => ["published", "partial", "failed"].includes(p.status))
      .sort((a, b) => (b.published_at ?? b.updated_at).localeCompare(a.published_at ?? a.updated_at)),
  };
  const TABS: { key: TabKey; label: string; empty: string }[] = [
    { key: "pending", label: "承認待ち", empty: isStaff ? "承認待ちの投稿はありません。" : "承認を待っている投稿はありません。" },
    { key: "scheduled", label: "予約中", empty: "予約中の投稿はありません。" },
    { key: "draft", label: "下書き・差し戻し", empty: "下書き・差し戻し・取り消した投稿はありません。" },
    { key: "done", label: "投稿済み・失敗", empty: "まだ投稿はありません。" },
  ];
  // 表示するタブ：指定がなければ、対応が要るもの（承認待ち）→ 予約中 → 投稿済みの順に、件数のある最初のもの
  const want = typeof sp.tab === "string" && sp.tab in lists ? (sp.tab as TabKey) : null;
  const tab: TabKey = want ?? (["pending", "scheduled", "done", "draft"] as TabKey[]).find((k) => lists[k].length) ?? "scheduled";
  const failed = lists.done.filter((p) => p.status !== "published").length;
  const all = sp.more === "1";
  const shown = tab === "done" && !all ? lists.done.slice(0, DONE_PAGE) : lists[tab];
  const canPost = connections.some((c) => c.canPublish);
  const href = (k: TabKey) => `/clients/${id}/publish?tab=${k}`;
  // 予約中は日付ごとに見出しを付ける（同じ日の投稿の重なりと、空いている日が分かるように）
  const groups = tab === "scheduled"
    ? [...shown.reduce((m, p) => m.set(dayKey(p.scheduled_at ?? p.created_at), [...(m.get(dayKey(p.scheduled_at ?? p.created_at)) ?? []), p]), new Map<string, ScheduledPost[]>()).values()]
    : [shown];
  const current = TABS.find((t) => t.key === tab)!;
  return (
    <>
      <PageHead lead="Instagram・Facebook・Threads・X への投稿を作成し、今すぐ投稿または予約できます。" />
      {ok && <Flash kind={ok[0]}>{ok[1]}</Flash>}
      <div className="publish-bar">
        <PublishViewSwitch clientId={id} current="list" />
        {canPost && <Link className="btn primary" href={`/clients/${id}/publish/new`}>新しい投稿を作成</Link>}
      </div>
      {!canPost && <p className="msg" role="status">投稿できるSNSがありません。スタッフが「設定・連携」で、投稿の許可を含めて SNS を連携すると使えるようになります。</p>}
      {needsApproval && <p className="note-top">この画面で作成した投稿は、担当者の承認を経てから公開されます。</p>}
      <nav className="tabs status-tabs" aria-label="投稿の状態">
        {TABS.map((t) => (
          <Link key={t.key} className="tab" href={href(t.key)} scroll={false} aria-current={t.key === tab ? "page" : undefined}>
            {t.label}
            <span className={`tab-count${t.key === "pending" && lists.pending.length ? " attention" : ""}`}>{lists[t.key].length}<span className="sr-only">件</span></span>
            {t.key === "done" && failed > 0 && <span className="badge warn">失敗 {failed}</span>}
          </Link>
        ))}
      </nav>
      <section aria-labelledby="h-posts">
        <h2 id="h-posts" className="sr-only">{current.label}（{lists[tab].length}件）</h2>
        {shown.length === 0 ? <p className="muted">{current.empty}</p> : groups.map((list) => (
          <div key={list[0].id} className="post-group">
            {tab === "scheduled" && <h3 className="post-day">{dayLabel(list[0].scheduled_at ?? list[0].created_at)}<span className="muted small">（{list.length}件）</span></h3>}
            <ul className="post-list">{list.map((p) => <PostCard key={p.id} post={p} clientId={id} isStaff={isStaff} conns={conns} />)}</ul>
          </div>
        ))}
        {tab === "done" && !all && lists.done.length > DONE_PAGE && (
          <p><Link className="btn" href={`${href("done")}&more=1`} scroll={false}>残りの{lists.done.length - DONE_PAGE}件も表示する</Link></p>
        )}
      </section>
    </>
  );
}
