import type { Metadata } from "next";
import { reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { Bar, Chip } from "@/components/report-ui";
import { fmtNum, fmtPct } from "@/lib/format";

export const metadata: Metadata = { title: "SNS比較" };

export default async function SnsComparePage({ params, searchParams }: PageProps<"/clients/[id]/sns">) {
  const { id } = await params;
  const r = await reportFromSearch(id, await searchParams);
  const d = r.analysis;
  const rows = d.platforms.map((p) => [p, d.summary[p]!] as const);
  const mx = Math.max(0, ...rows.map(([, s]) => s.erFollowers ?? 0)) || 1;
  return (
    <ReportPage report={r} title="SNS比較" lead="規模の違うSNSを、フォロワーあたり・表示あたりの反応でそろえて比べます。">
      <section>
        <div className="card flush scroll">
          <table>
            <caption className="sr-only">SNSごとの比較</caption>
            <thead><tr><th scope="col">SNS</th><th scope="col" className="num">投稿数</th><th scope="col" className="num">1投稿平均エンゲージメント</th>
              <th scope="col">ER（フォロワー比）</th><th scope="col" className="num">ER（表示比）</th><th scope="col" className="num">フォロワー増加率</th></tr></thead>
            <tbody>
              {rows.map(([p, s]) => (
                <tr key={p}>
                  <th scope="row"><Chip platform={p} /></th>
                  <td className="num">{fmtNum(s.posts)}</td>
                  <td className="num">{fmtNum(s.avgEngagements)}</td>
                  <td className="bar-cell"><Bar value={s.erFollowers ?? 0} max={mx} color={`var(--c-${p})`} label={fmtPct(s.erFollowers)} /></td>
                  <td className="num">{fmtPct(s.erViews)}</td>
                  <td className="num">{fmtPct(s.followersGrowth)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">ER（フォロワー比）はフォロワー数が記録されている期間のみ算出します。表示回数を取得できないSNS・投稿では ER（表示比）は「—」になります。</p>
      </section>
    </ReportPage>
  );
}
