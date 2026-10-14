import type { Metadata } from "next";
import { InsightsShell } from "@/components/insights-shell";
import { Bar } from "@/components/report-ui";
import { EmptyState } from "@/components/empty-state";
import { contentBreakdown, insightsBase } from "@/lib/insights-view";
import { fmtNum, fmtPct } from "@/lib/format";

export const metadata: Metadata = { title: "インサイト" };

/** Meta のインサイト「コンテンツの概要」「トップコンテンツフォーマット」にあたる表示 */
export default async function InsightsContentPage({ params, searchParams }: PageProps<"/clients/[id]/insights/content">) {
  const { id } = await params;
  const base = await insightsBase(id, await searchParams);
  const { rows, totals, followerShare } = contentBreakdown(base);
  const color = base.platform ? `var(--c-${base.platform})` : "var(--seq)";
  const maxViews = Math.max(0, ...rows.map((r) => r.views ?? 0)) || 1;
  return (
    <InsightsShell base={base} lead="期間内に公開したコンテンツの、形式ごとの閲覧数とインタラクションです。">
      {!rows.length ? <EmptyState title="この期間に公開したコンテンツはありません" body="期間を変えると表示される場合があります。" /> : (
        <>
          <section aria-labelledby="h-sum">
            <h2 id="h-sum">コンテンツの概要</h2>
            <div className="hero">
              <div className="stat"><div className="stat-label">公開したコンテンツ</div><div className="stat-value">{fmtNum(totals.count)}<span className="muted small">件</span></div></div>
              <div className="stat"><div className="stat-label">閲覧数</div><div className="stat-value">{fmtNum(totals.views)}</div></div>
              <div className="stat"><div className="stat-label">インタラクション</div><div className="stat-value">{fmtNum(totals.interactions)}</div></div>
              {followerShare && (
                <div className="stat">
                  <div className="stat-label">閲覧のうちフォロワーから</div>
                  <div className="stat-value">{fmtPct(followerShare.followers, 1)}</div>
                  <span className="muted small">フォロワー以外から {fmtPct(followerShare.others, 1)}</span>
                </div>
              )}
            </div>
          </section>
          <section aria-labelledby="h-format">
            <h2 id="h-format">形式ごとの内訳</h2>
            <p className="sub">閲覧数の多い順。1件あたりは、その形式の平均です。</p>
            <div className="card flush scroll">
              <table>
                <thead><tr>
                  <th scope="col">形式</th><th scope="col" className="num">件数</th><th scope="col">閲覧数</th>
                  <th scope="col" className="num">1件あたりの閲覧数</th><th scope="col" className="num">インタラクション</th><th scope="col" className="num">1件あたり</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <th scope="row">{r.label}</th>
                      <td className="num">{fmtNum(r.count)}</td>
                      <td className="bar-cell"><Bar value={r.views ?? 0} max={maxViews} color={color} label={fmtNum(r.views)} /></td>
                      <td className="num">{fmtNum(r.views === null ? null : r.views / r.count)}</td>
                      <td className="num">{fmtNum(r.interactions)}</td>
                      <td className="num">{fmtNum(r.interactions / r.count, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </InsightsShell>
  );
}
