import Link from "next/link";
import type { Report } from "@/lib/report";
import { Chip } from "./report-ui";
import { fmtNum, fmtPct, slash, truncate } from "@/lib/format";
import { EmptyState } from "./empty-state";
import { CONTENT_LABELS, MEDIA_LABELS, engagementsOf, toLocal, type Post } from "@/lib/sns/models";

type Scores = Report["analysis"]["postScores"];
type Val = string | number | null;

/** 並べ替えられる列。初期の並び（大きい順／新しい順）は desc */
const SORTS = {
  // lines：見出しの改行位置（日本語は1文字ずつ折り返されて読みにくいため、区切りを決めておく）
  date: { label: "投稿日", lines: ["投稿日"], value: (p: Post) => p.postedAt },
  score: { label: "指数", lines: ["指数"], value: (p: Post, s: Scores) => s[p.id]?.score ?? null },
  engagements: { label: "エンゲージメント", lines: ["エンゲー", "ジメント"], value: (p: Post, s: Scores) => s[p.id]?.engagements ?? engagementsOf(p.metrics) },
  er: { label: "ER（表示比）", lines: ["ER", "（表示比）"], value: (p: Post, s: Scores) => s[p.id]?.erViews ?? null },
  reach: { label: "アクセス数", lines: ["アクセス", "数"], value: (p: Post) => p.metrics.reach },
  views: { label: "インプレッション数", lines: ["インプレッ", "ション数"], value: (p: Post) => p.metrics.views },
  followers: { label: "フォロワーの閲覧数", lines: ["フォロワー", "の閲覧数"], value: (p: Post) => p.followerViews ?? null },
  clicks: { label: "クリック数", lines: ["クリック", "数"], value: (p: Post) => p.metrics.clicks },
} satisfies Record<string, { label: string; lines: string[]; value: (p: Post, s: Scores) => Val }>;
type SortKey = keyof typeof SORTS;

/** 本文の1行目をタイトルとして使う */
const titleOf = (text: string) => truncate(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 60);

type SP = Record<string, string | string[] | undefined>;

/**
 * 投稿一覧（旧「投稿ランキング」を統合）。
 * 見出しのリンクで並べ替え、同じ見出しをもう一度押すと昇順・降順が入れ替わる。
 * パフォーマンス指数＝SNSの規模差を補正した値（100＝そのSNSの普段の投稿）。
 */
export function PostList({ report: r, sp, anchor }: { report: Report; sp: SP; anchor: string }) {
  const { start, end } = r.analysis.period;
  const scores = r.analysis.postScores;
  const sort: SortKey = typeof sp.sort === "string" && sp.sort in SORTS ? (sp.sort as SortKey) : "date";
  const asc = sp.order === "asc";
  const value = SORTS[sort].value;
  // 値がないものは、昇順・降順どちらでも最後に置く
  const posts = [...r.data.ownPosts, ...r.data.ownStories]
    .map((p) => ({ p, date: toLocal(p.postedAt), v: value(p, scores) as Val }))
    .filter((x) => x.date.date >= start && x.date.date <= end)
    .sort((a, b) => {
      if (a.v === b.v) return b.p.postedAt.localeCompare(a.p.postedAt);
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      return (a.v < b.v ? 1 : -1) * (asc ? -1 : 1);
    });
  // 同じSNSに複数のアカウントがあるときは、どのアカウントの投稿かも出す（1つのアカウントに絞り込んでいるときは不要）
  const multi = new Set(r.accounts.filter((a, _, all) => all.filter((b) => b.platform === a.platform).length > 1).map((a) => a.id));
  const accountName = (id: string) => (multi.has(id) && !r.period.acct ? r.accounts.find((a) => a.id === id)?.name : undefined);
  const showSns = !r.period.sns || (multi.size > 0 && !r.period.acct);

  const sortHref = (k: SortKey) => {
    const q = new URLSearchParams();
    for (const [key, v] of Object.entries(sp)) if (typeof v === "string" && key !== "sort" && key !== "order") q.set(key, v);
    if (k !== "date") q.set("sort", k);
    // 並んでいる列をもう一度押したら、向きを入れ替える
    if (k === sort && !asc) q.set("order", "asc");
    const s = q.toString();
    return `${s ? `?${s}` : "?"}#${anchor}`;
  };
  const dirWord = (k: SortKey) => (k === "date" ? (asc ? "古い順" : "新しい順") : (asc ? "小さい順" : "大きい順"));
  const th = (k: SortKey, num = false) => (
    <th key={k} scope="col" className={num ? "num" : undefined} aria-sort={sort === k ? (asc ? "ascending" : "descending") : undefined}>
      <Link href={sortHref(k)} scroll={false} className="sort-link">
        <span aria-hidden="true">{SORTS[k].lines.map((l, i) => <span key={i} className="th-line">{l}</span>)}</span>
        <span className="sr-only">{SORTS[k].label}</span>
        {sort === k ? <span aria-hidden="true" className="sort-mark">{asc ? "▲" : "▼"}</span> : null}
        <span className="sr-only">{sort === k ? `（${dirWord(k)}に並んでいます。押すと逆順）` : "（この列で並べ替え）"}</span>
      </Link>
    </th>
  );

  return (
    <>
      <div className="list-head">
        <p className="sub">{posts.length}件・{SORTS[sort].label}の{dirWord(sort)}（見出しを押すと並べ替え）</p>
        <details className="help-note">
          <summary>数字の見方</summary>
          <dl>
            <div><dt>指数</dt><dd>SNSの規模の差を補正したパフォーマンス指数。100＝そのSNSの普段の投稿</dd></div>
            <div><dt>アクセス数</dt><dd>投稿を見たアカウント数（リーチ）</dd></div>
            <div><dt>インプレッション数</dt><dd>表示された回数</dd></div>
            <div><dt>フォロワーの閲覧数</dt><dd>表示のうちフォロワーによるもの（Facebook のみ）</dd></div>
            <div><dt>ストーリーズ</dt><dd>公開中の24時間に収集できたもの（指数の計算には含めません）</dd></div>
            <div><dt>—</dt><dd>そのSNSでは取得できない数値</dd></div>
          </dl>
        </details>
      </div>
      {posts.length === 0 ? (
        <EmptyState title="この期間の投稿はありません" body="期間を広げるか、別のSNSを選ぶと表示される場合があります。" />
      ) : (
        <div className="card flush scroll posts-table">
          <table>
            <caption className="sr-only">投稿一覧（{SORTS[sort].label}の{dirWord(sort)}）</caption>
            <thead><tr>
              {th("date")}
              <th scope="col">{showSns ? "SNS・タイトル" : "タイトル"}</th><th scope="col">形式</th>
              {th("score", true)}{th("engagements", true)}{th("er", true)}
              {th("reach", true)}{th("views", true)}{th("followers", true)}{th("clicks", true)}
            </tr></thead>
            <tbody>
              {posts.map(({ p, date }) => {
                const title = titleOf(p.text) || "（本文なし）";
                const s = scores[p.id];
                return (
                  <tr key={p.id}>
                    <td className="nowrap">{slash(date.date)}<br /><span className="muted">{String(date.hour).padStart(2, "0")}:{String(date.minute).padStart(2, "0")}</span></td>
                    {/* SNS は列を分けずタイトルの上に置く（列が多く、表が横にはみ出すため） */}
                    <td className="post-text">
                      {showSns && <div className="post-sns"><Chip platform={p.platform} />{accountName(p.accountId) && <span className="muted">（{accountName(p.accountId)}）</span>}</div>}
                      {p.permalink
                        ? <a href={p.permalink} target="_blank" rel="noopener noreferrer">{title}<span className="sr-only">（新しいタブで開きます）</span></a>
                        : title}
                    </td>
                    <td className="nowrap">
                      {p.contentType === "story"
                        ? <span className="tag story">{CONTENT_LABELS.story}</span>
                        : MEDIA_LABELS[p.mediaType] ?? p.mediaType}
                    </td>
                    <td className="num strong">{fmtNum(s?.score ?? null)}</td>
                    <td className="num">{fmtNum(s?.engagements ?? engagementsOf(p.metrics))}</td>
                    <td className="num">{fmtPct(s?.erViews ?? null)}</td>
                    <td className="num">{fmtNum(p.metrics.reach)}</td>
                    <td className="num">{fmtNum(p.metrics.views)}</td>
                    <td className="num">{fmtNum(p.followerViews)}</td>
                    <td className="num">{fmtNum(p.metrics.clicks)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
