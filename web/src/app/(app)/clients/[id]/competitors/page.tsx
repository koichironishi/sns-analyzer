import type { Metadata } from "next";
import Link from "next/link";
import { reportFromSearch } from "@/lib/report";
import { getViewer } from "@/lib/auth";
import { ReportPage } from "@/components/report-shell";
import { Bar, Chip, Insights } from "@/components/report-ui";
import { TabLinks } from "@/components/tab-links";
import { fmtNum, fmtPct, fmtSigned, truncate } from "@/lib/format";
import { PLATFORMS, PLATFORM_LABELS, isPlatform } from "@/lib/sns/models";
import type { AccountStats } from "@/lib/sns/compare";

export const metadata: Metadata = { title: "競合比較" };

const Rank = ({ r, k }: { r: AccountStats; k: keyof AccountStats["rank"] }) =>
  r.rank[k] ? <span className="rank">{r.rank[k]![0]}位</span> : null;

export default async function CompetitorsPage({ params, searchParams }: PageProps<"/clients/[id]/competitors">) {
  const { id } = await params;
  const sp = await searchParams;
  const r = await reportFromSearch(id, sp);
  const c = r.competitors;
  const v = await getViewer();
  if (!c) {
    return (
      <ReportPage report={r} title="競合比較" lead="競合アカウントと、公開されている数値だけで条件をそろえて比べます。" needsData={false}>
        <div className="card empty">
          <h2>競合のデータがありません</h2>
          {v?.kind === "staff"
            ? <p>「<Link href={`/clients/${id}/settings#competitors`}>設定・連携</Link>」で競合アカウントを登録すると、次回のデータ収集から比較できます。</p>
            : <p>競合アカウントが登録されると、ここに比較が表示されます。</p>}
        </div>
      </ReportPage>
    );
  }
  const available = PLATFORMS.filter((p) => c.platforms[p]);
  const cur = typeof sp.sns === "string" && isPlatform(sp.sns) && c.platforms[sp.sns] ? sp.sns : available[0];
  const blk = c.platforms[cur]!;
  const mx = Math.max(0, ...blk.rows.map((x) => x.erFollowers ?? 0)) || 1;
  return (
    <ReportPage report={r} title="競合比較" lead="競合アカウントと、公開されている数値だけで条件をそろえて比べます。" needsData={false}>
      <p className="note-top">同じ期間の自社と競合アカウントの比較。フォロワー増減は、競合の記録を始めてからの期間のみ表示されます。</p>
      {c.insights.length > 0 && <div className="card"><Insights items={c.insights} visible={5} /></div>}
      <section>
        <div className="card scroll">
          <TabLinks param="sns" current={cur} sp={sp} label="SNSを選択" options={available.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))} />
          <table>
            <caption className="sr-only">{PLATFORM_LABELS[cur]}の競合比較</caption>
            <thead><tr><th scope="col">アカウント</th><th scope="col" className="num">フォロワー</th><th scope="col" className="num">期間増減</th>
              <th scope="col" className="num">投稿/週</th><th scope="col" className="num">平均反応</th><th scope="col">反応率（フォロワー比）</th>
              <th scope="col">形式の内訳</th><th scope="col">最も反応の良い形式</th><th scope="col">よく投稿する枠</th><th scope="col">よく使うタグ</th></tr></thead>
            <tbody>
              {blk.rows.map((x) => (
                <tr key={x.name} className={x.isOwn ? "own" : undefined}>
                  <th scope="row">{x.name}<div className="muted">{x.username ? `@${x.username}` : ""}</div></th>
                  <td className="num">{fmtNum(x.followers)} <Rank r={x} k="followers" /></td>
                  <td className="num">{fmtSigned(x.followersDelta)}<div className="muted">{fmtPct(x.followersGrowth, 1)}</div></td>
                  <td className="num">{x.postsPerWeek === null ? "—" : x.postsPerWeek.toFixed(1)}</td>
                  <td className="num">{fmtNum(x.avgEng)}</td>
                  <td className="bar-cell">{x.hasPosts
                    ? <><Bar value={x.erFollowers ?? 0} max={mx} color={`var(--c-${cur})`} label={fmtPct(x.erFollowers)} /> <Rank r={x} k="erFollowers" /></>
                    : <span className="muted">投稿データなし</span>}</td>
                  <td className="small">{x.mediaMix.slice(0, 3).map(([k, s]) => `${k} ${Math.round(s * 100)}%`).join("・") || "—"}</td>
                  <td className="small">{x.bestType ?? "—"}</td>
                  <td className="small">{x.topSlot ?? "—"}</td>
                  <td className="small">{x.topTags.map((t) => `#${t}`).join(" ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">反応＝{blk.metricLabel}（競合と条件をそろえるため公開値のみで算出）。</p>
        </div>
      </section>
      {c.topPosts.length > 0 && (
        <section aria-labelledby="h-ctop">
          <h2 id="h-ctop">競合で反応の良かった投稿</h2>
          <div className="card scroll">
            <table>
              <thead><tr><th scope="col">競合</th><th scope="col">SNS</th><th scope="col">日時</th><th scope="col">形式</th><th scope="col">投稿</th>
                <th scope="col" className="num">反応</th><th scope="col" className="num">フォロワー比</th></tr></thead>
              <tbody>
                {c.topPosts.map((t, i) => (
                  <tr key={i}>
                    <td className="nowrap">{t.competitor}</td><td><Chip platform={t.platform} /></td><td className="nowrap">{t.date}</td>
                    <td className="nowrap">{t.media}</td>
                    <td className="post-text">{t.permalink ? <a href={t.permalink} target="_blank" rel="noopener noreferrer">{truncate(t.text, 80) || "（本文なし）"}<span className="sr-only">（新しいタブで開きます）</span></a> : truncate(t.text, 80)}</td>
                    <td className="num">{fmtNum(t.engagements)}</td><td className="num strong">{fmtPct(t.erFollowers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </ReportPage>
  );
}
