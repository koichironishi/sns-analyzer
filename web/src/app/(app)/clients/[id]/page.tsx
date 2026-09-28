import type { Metadata } from "next";
import { clientName, reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { Chip, Delta, Insights } from "@/components/report-ui";
import { Legend, Sparkline, StackedDaily } from "@/components/charts";
import { fmtNum, fmtPct, fmtSigned, slash } from "@/lib/format";
import { PLATFORM_LABELS } from "@/lib/sns/models";

// レイアウトのタイトルの型は同じ階層のページには効かないため、ここで組み立てる
export async function generateMetadata({ params }: PageProps<"/clients/[id]">): Promise<Metadata> {
  const name = await clientName((await params).id);
  return { title: { absolute: name ? `概要｜${name} | SNS分析` : "概要 | SNS分析" } };
}

export default async function OverviewPage({ params, searchParams }: PageProps<"/clients/[id]">) {
  const { id } = await params;
  const r = await reportFromSearch(id, await searchParams);
  const d = r.analysis;
  const t = d.total;
  const fol = d.platforms.map((p) => d.summary[p]!.followers).filter((v): v is number => v !== null);
  const fdel = d.platforms.map((p) => d.summary[p]!.followersDelta).filter((v): v is number => v !== null);
  const folSum = fol.reduce((a, b) => a + b, 0);
  const delSum = fdel.reduce((a, b) => a + b, 0);
  const folPrev = fol.length && fdel.length ? folSum - delSum : null;
  const tiles = [
    { label: "エンゲージメント", value: fmtNum(t.engagements), delta: <Delta value={t.change.engagements} label="前期間比 " /> },
    { label: "表示回数", value: fmtNum(t.views), delta: <Delta value={t.change.views} label="前期間比 " /> },
    { label: "投稿数", value: fmtNum(t.posts), delta: <Delta value={t.change.posts} label="前期間比 " /> },
    { label: "フォロワー合計", value: fol.length ? fmtNum(folSum) : "—",
      delta: fdel.length ? <Delta value={folPrev ? delSum / folPrev : null} label={`${fmtSigned(delSum)}人 `} /> : <Delta value={null} /> },
  ];
  const dates = d.daily.dates;
  const weeks = Array.from({ length: Math.ceil(dates.length / 7) }, (_, i) => [i * 7, Math.min(i * 7 + 7, dates.length)] as const);

  return (
    <ReportPage report={r} title="概要" lead="期間全体の結果と、まず押さえるべきポイントです。">
      <section aria-label="主要指標">
        <div className="hero">
          {tiles.map((x) => (
            <div className="stat" key={x.label}><div className="stat-label">{x.label}</div><div className="stat-value">{x.value}</div>{x.delta}</div>
          ))}
        </div>
      </section>

      <section aria-labelledby="h-ins">
        <h2 id="h-ins">この期間のポイント</h2>
        <div className="card"><Insights items={d.insights} /></div>
      </section>

      <section aria-labelledby="h-kpi">
        <h2 id="h-kpi">SNS別</h2>
        <p className="sub">ER＝エンゲージメント率（いいね・コメント・シェア・保存・引用の合計 ÷ フォロワー数または表示回数）。矢印は前期間比。</p>
        <div className="pgrid">
          {d.platforms.map((p) => {
            const s = d.summary[p]!;
            const fd = s.followersDelta;
            const vals = d.daily.byPlatform[p]?.followers ?? [];
            const known = vals.filter((v): v is number => v !== null);
            return (
              <article className="card pcard" key={p}>
                <header className="pcard-head"><h3 className="pcard-title"><Chip platform={p} /></h3><span className="acct">{s.account}</span></header>
                <div className="pcard-main">
                  <span className="pcard-value">{fmtNum(s.followers)}</span><span className="pcard-unit">フォロワー</span>
                  <span className={`delta ${(fd ?? 0) > 0 ? "up" : (fd ?? 0) < 0 ? "down" : "flat"}`}>{fmtSigned(fd)}</span>
                </div>
                <div className="spark">
                  <Sparkline values={vals} platform={p}
                    label={`${PLATFORM_LABELS[p]}のフォロワー推移：${known.length ? `${fmtNum(known[0])}人から${fmtNum(known.at(-1))}人` : "データなし"}`} />
                </div>
                <dl className="mini">
                  <div><dt>投稿</dt><dd>{fmtNum(s.posts)}<Delta value={s.change.posts} /></dd></div>
                  <div><dt>エンゲージメント</dt><dd>{fmtNum(s.engagements)}<Delta value={s.change.engagements} /></dd></div>
                  <div><dt>ER（フォロワー比）</dt><dd>{fmtPct(s.erFollowers)}<Delta value={s.change.erFollowers} /></dd></div>
                  <div><dt>ER（表示比）</dt><dd>{fmtPct(s.erViews)}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="h-trend">
        <h2 id="h-trend">エンゲージメント推移</h2>
        <p className="sub">投稿日ごとのエンゲージメント合計（SNS別の積み上げ）。</p>
        <div className="card">
          <Legend platforms={d.platforms} />
          <StackedDaily dates={dates} label="日別エンゲージメント推移のグラフ。数値は下の「表で見る」で確認できます"
            series={d.platforms.map((p) => ({ platform: p, values: d.daily.byPlatform[p]?.engagements ?? [] }))} />
          <details className="more">
            <summary>表で見る（週ごとの合計）</summary>
            <div className="scroll">
              <table>
                <caption className="sr-only">週ごとのエンゲージメント合計</caption>
                <thead><tr><th scope="col">期間</th>{d.platforms.map((p) => <th scope="col" className="num" key={p}>{PLATFORM_LABELS[p]}</th>)}</tr></thead>
                <tbody>
                  {weeks.map(([a, b]) => (
                    <tr key={a}>
                      <th scope="row" className="nowrap">{slash(dates[a].slice(5))}〜{slash(dates[b - 1].slice(5))}</th>
                      {d.platforms.map((p) => (
                        <td className="num" key={p}>{fmtNum((d.daily.byPlatform[p]?.engagements ?? []).slice(a, b).reduce((x, y) => x + y, 0))}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>
    </ReportPage>
  );
}
