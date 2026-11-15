import type { Metadata } from "next";
import Link from "next/link";
import { publishContext } from "@/lib/publish-page";
import { listConnections, listScheduledPosts, type ScheduledPost } from "@/lib/sns/store";
import { Flash } from "@/components/flash";
import { PageHead } from "@/components/report-ui";
import { PublishViewSwitch } from "@/components/publish-view-switch";
import { PostSelection } from "@/components/post-selection";
import { PostCard } from "@/components/post-card";

export const metadata: Metadata = { title: "投稿" };

const OK: Record<string, [kind: "ok" | "error", text: string]> = {
  published: ["ok", "投稿しました。"], partial: ["error", "一部のSNSで投稿に失敗しました。下の一覧で理由を確認し、再投稿してください。"],
  failed: ["error", "投稿に失敗しました。下の一覧で理由を確認してください。"], publish_error: ["error", "投稿の処理を始められませんでした。一覧で状態を確認してください。"],
  scheduled: ["ok", "予約しました。予約時刻から数分以内に投稿します。"], draft: ["ok", "下書きを保存しました。"],
  pending: ["ok", "担当者に承認を依頼しました。承認されると投稿されます。"],
  bulk: ["ok", "CSVから取り込みました。"],
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
/** 日本時間の「10月24日（金）」 */
function dayLabel(iso: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return `${p.month}月${p.day}日（${WD[wd]}）`;
}
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

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
    // 下書きは予定の日時の順（日時のないものは最後に、作成の新しい順）
    draft: posts.filter((p) => ["draft", "rejected", "canceled"].includes(p.status))
      .sort((a, b) => (a.scheduled_at ?? "9999").localeCompare(b.scheduled_at ?? "9999") || b.created_at.localeCompare(a.created_at)),
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
      <PageHead lead="Instagram・Facebook・Threads への投稿を作成し、今すぐ投稿または予約できます。" />
      {ok && <Flash kind={ok[0]}>{sp.ok === "bulk" ? `CSVから${Number(sp.n) || 0}件を取り込みました。${Number(sp.d) ? `そのうち${Number(sp.d)}件は下書きです（画像が必要な投稿は、画像を足してから予約してください）。` : ""}` : ok[1]}</Flash>}
      <div className="publish-bar">
        <PublishViewSwitch clientId={id} current="list" />
        {canPost && (
          <div className="row">
            <Link className="btn" href={`/clients/${id}/publish/bulk`}>CSVで一括予約</Link>
            <Link className="btn primary" href={`/clients/${id}/publish/new`}>新しい投稿を作成</Link>
          </div>
        )}
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
      <section className="post-section" aria-labelledby="h-posts">
        <h2 id="h-posts" className="sr-only">{current.label}（{lists[tab].length}件）</h2>
        {shown.length === 0 ? <p className="muted">{current.empty}</p> : (
          <PostSelection clientId={id} total={shown.length}>
            {groups.map((list) => (
              <div key={list[0].id} className="post-group">
                {tab === "scheduled" && <h3 className="post-day">{dayLabel(list[0].scheduled_at ?? list[0].created_at)}<span className="muted small">（{list.length}件）</span></h3>}
                <ul className="post-list">{list.map((p) => <PostCard key={p.id} post={p} clientId={id} isStaff={isStaff} conns={conns} />)}</ul>
              </div>
            ))}
          </PostSelection>
        )}
        {tab === "done" && !all && lists.done.length > DONE_PAGE && (
          <p><Link className="btn" href={`${href("done")}&more=1`} scroll={false}>残りの{lists.done.length - DONE_PAGE}件も表示する</Link></p>
        )}
      </section>
    </>
  );
}
