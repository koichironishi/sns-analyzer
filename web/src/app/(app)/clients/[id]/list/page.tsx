import type { Metadata } from "next";
import Link from "next/link";
import { reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { Chip } from "@/components/report-ui";
import { fmtNum, slash, truncate } from "@/lib/format";
import { MEDIA_LABELS, toLocal, type Post } from "@/lib/sns/models";

export const metadata: Metadata = { title: "投稿一覧" };

const SORTS = {
  date: { label: "投稿日", value: (p: Post) => p.postedAt },
  reach: { label: "アクセス数", value: (p: Post) => p.metrics.reach },
  views: { label: "インプレッション数", value: (p: Post) => p.metrics.views },
  clicks: { label: "クリック数", value: (p: Post) => p.metrics.clicks },
} as const;
type SortKey = keyof typeof SORTS;

/** 本文の1行目をタイトルとして使う */
const titleOf = (text: string) => truncate(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 60);

export default async function PostListPage({ params, searchParams }: PageProps<"/clients/[id]/list">) {
  const { id } = await params;
  const sp = await searchParams;
  const r = await reportFromSearch(id, sp);
  const { start, end } = r.analysis.period;
  const sort: SortKey = typeof sp.sort === "string" && sp.sort in SORTS ? (sp.sort as SortKey) : "date";
  const value = SORTS[sort].value;
  // 期間内の投稿を、選んだ列の大きい順（新しい順）に並べる。値がないものは最後
  const posts = r.data.ownPosts
    .map((p) => ({ p, date: toLocal(p.postedAt) }))
    .filter((x) => x.date.date >= start && x.date.date <= end)
    .sort((a, b) => {
      const va = value(a.p), vb = value(b.p);
      if (va === vb) return b.p.postedAt.localeCompare(a.p.postedAt);
      if (va === null) return 1;
      if (vb === null) return -1;
      return va < vb ? 1 : -1;
    });
  const showSns = !r.period.sns;

  const sortHref = (k: SortKey) => {
    const q = new URLSearchParams();
    for (const [key, v] of Object.entries(sp)) if (typeof v === "string" && key !== "sort") q.set(key, v);
    if (k !== "date") q.set("sort", k);
    const s = q.toString();
    return s ? `?${s}` : "?";
  };
  const th = (k: SortKey, num = false) => (
    <th key={k} scope="col" className={num ? "num" : undefined} aria-sort={sort === k ? "descending" : undefined}>
      <Link href={sortHref(k)} scroll={false} className="sort-link">
        {SORTS[k].label}{sort === k ? <span aria-hidden="true"> ▼</span> : null}
        <span className="sr-only">{sort === k ? "（この列の大きい順に並んでいます）" : "（この列で並べ替え）"}</span>
      </Link>
    </th>
  );

  return (
    <ReportPage report={r} title="投稿一覧" lead="期間内のすべての投稿と、アクセス数・インプレッション数・クリック数です。列の見出しを押すと並べ替えられます。">
      <section>
        <p className="note-top">{posts.length}件の投稿。アクセス数＝投稿を見たアカウント数（リーチ）、インプレッション数＝表示された回数。「—」はそのSNSでは取得できない数値です。</p>
        {posts.length === 0 ? (
          <div className="card empty"><h2>この期間の投稿はありません</h2></div>
        ) : (
          <div className="card flush scroll">
            <table>
              <caption className="sr-only">投稿一覧（{SORTS[sort].label}の{sort === "date" ? "新しい" : "大きい"}順）</caption>
              <thead><tr>
                {th("date")}
                {showSns && <th scope="col">SNS</th>}
                <th scope="col">タイトル</th><th scope="col">投稿の種類</th>
                {th("reach", true)}{th("views", true)}{th("clicks", true)}
              </tr></thead>
              <tbody>
                {posts.map(({ p, date }) => {
                  const title = titleOf(p.text) || "（本文なし）";
                  return (
                    <tr key={p.id}>
                      <td className="nowrap">{slash(date.date)} {String(date.hour).padStart(2, "0")}:{String(date.minute).padStart(2, "0")}</td>
                      {showSns && <td><Chip platform={p.platform} /></td>}
                      <td className="post-text">{p.permalink
                        ? <a href={p.permalink} target="_blank" rel="noopener noreferrer">{title}<span className="sr-only">（新しいタブで開きます）</span></a>
                        : title}</td>
                      <td className="nowrap">{MEDIA_LABELS[p.mediaType] ?? p.mediaType}</td>
                      <td className="num">{fmtNum(p.metrics.reach)}</td>
                      <td className="num">{fmtNum(p.metrics.views)}</td>
                      <td className="num">{fmtNum(p.metrics.clicks)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </ReportPage>
  );
}
