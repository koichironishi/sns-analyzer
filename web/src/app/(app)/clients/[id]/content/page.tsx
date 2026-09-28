import type { Metadata } from "next";
import { reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { Bar, Chip } from "@/components/report-ui";
import { fmtNum, fmtPct } from "@/lib/format";
import { PLATFORM_LABELS } from "@/lib/sns/models";

export const metadata: Metadata = { title: "形式・タグ" };

export default async function ContentPage({ params, searchParams }: PageProps<"/clients/[id]/content">) {
  const { id } = await params;
  const r = await reportFromSearch(id, await searchParams);
  const d = r.analysis;
  const mxMedia = Math.max(0, ...d.media.map((m) => m.score ?? 0)) || 1;
  const mxTag = Math.max(0, ...d.hashtags.map((h) => h.score)) || 1;
  return (
    <ReportPage report={r} title="形式・タグ" lead="どの投稿形式・ハッシュタグが効いているか。">
      <section aria-labelledby="h-media">
        <h2 id="h-media">投稿形式別</h2>
        <p className="sub">形式ごとの平均パフォーマンス指数。</p>
        <div className="card flush scroll">
          <table>
            <thead><tr><th scope="col">SNS</th><th scope="col">形式</th><th scope="col" className="num">件数</th>
              <th scope="col" className="num">平均エンゲージメント</th><th scope="col" className="num">ER（表示比）</th><th scope="col">パフォーマンス指数</th></tr></thead>
            <tbody>
              {d.media.map((m) => (
                <tr key={`${m.platform}-${m.mediaType}`}>
                  <td><Chip platform={m.platform} /></td><td>{m.label}</td><td className="num">{m.count}</td>
                  <td className="num">{fmtNum(m.avgEngagements)}</td><td className="num">{fmtPct(m.erViews)}</td>
                  <td className="bar-cell"><Bar value={m.score ?? 0} max={mxMedia} color={`var(--c-${m.platform})`} label={fmtNum(m.score)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="h-tags">
        <h2 id="h-tags">ハッシュタグ</h2>
        <p className="sub">2回以上使ったハッシュタグの平均パフォーマンス指数（上位15）。</p>
        <div className="card flush scroll">
          {d.hashtags.length === 0 ? <p className="muted" style={{ padding: 24 }}>2回以上使ったハッシュタグはありません。</p> : (
            <table>
              <thead><tr><th scope="col">ハッシュタグ</th><th scope="col" className="num">使用数</th><th scope="col">SNS</th><th scope="col">平均パフォーマンス指数</th></tr></thead>
              <tbody>
                {d.hashtags.map((h) => (
                  <tr key={h.tag}>
                    <td>#{h.tag}</td><td className="num">{h.count}</td>
                    <td>{h.platforms.map((p) => PLATFORM_LABELS[p]).join("・")}</td>
                    <td className="bar-cell"><Bar value={h.score} max={mxTag} color="var(--seq)" label={fmtNum(h.score)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </ReportPage>
  );
}
