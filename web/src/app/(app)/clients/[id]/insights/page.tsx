import type { Metadata } from "next";
import { InsightsShell } from "@/components/insights-shell";
import { DailyLine } from "@/components/charts";
import { Delta } from "@/components/report-ui";
import { EmptyState } from "@/components/empty-state";
import { insightsBase, resultCards, type MetricCard } from "@/lib/insights-view";
import { fmtNum } from "@/lib/format";
import { PLATFORM_LABELS } from "@/lib/sns/models";

export const metadata: Metadata = { title: "インサイト" };

const fmt = (c: MetricCard, v: number | null) => fmtNum(v, c.how === "avg" && v !== null && v < 100 ? 1 : 0);
const ratio = (c: MetricCard) => (c.total !== null && c.prev ? (c.total - c.prev) / c.prev : null);

/** Meta のインサイト「結果」と同じ形：指標ごとのカードに、期間の数字・前期間比・日別の推移 */
export default async function InsightsPage({ params, searchParams }: PageProps<"/clients/[id]/insights">) {
  const { id } = await params;
  const base = await insightsBase(id, await searchParams);
  const { dates, cards, hasData } = await resultCards(id, base);
  const color = base.platform ? `var(--c-${base.platform})` : "var(--seq)";
  return (
    <InsightsShell base={base} lead="アカウント全体の数字の推移です（投稿していない日の閲覧なども含みます）。">
      {!hasData ? (
        <EmptyState title="この期間のインサイトはまだありません"
          body="毎日の自動収集で、前日までの数字を集めています。連携した直後は、翌日以降に表示されます。" />
      ) : (
        <section aria-labelledby="h-results">
          <h2 id="h-results" className="sr-only">{base.platform ? PLATFORM_LABELS[base.platform] : ""}の結果</h2>
          <div className="insight-grid">
            {cards.map((c) => (
              <article className="card insight-card" key={c.key} aria-labelledby={`h-${c.key}`}>
                <h3 id={`h-${c.key}`}>{c.title}</h3>
                {c.note && <p className="sub">{c.note}</p>}
                <p className="insight-value">
                  <span className="stat-value">{fmt(c, c.total)}</span>
                  {c.how === "avg" && c.total !== null && <span className="muted small">／日</span>}
                  {c.prev !== null && <Delta value={ratio(c)} />}
                </p>
                {c.extra && (
                  <dl className="insight-extra">
                    {c.extra.map((x) => <div key={x.label}><dt>{x.label}</dt><dd>{fmtNum(x.value)}</dd></div>)}
                  </dl>
                )}
                {c.total === null
                  ? <p className="muted small">この期間のデータがありません。</p>
                  : <DailyLine dates={dates} values={c.daily} color={color} label={`${c.title}の日別の推移（期間の${c.how === "avg" ? "1日平均" : "合計"} ${fmt(c, c.total)}）`} />}
              </article>
            ))}
          </div>
        </section>
      )}
    </InsightsShell>
  );
}
