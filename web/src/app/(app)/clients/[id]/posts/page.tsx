import type { Metadata } from "next";
import { reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { Chip } from "@/components/report-ui";
import { fmtNum, fmtPct, truncate } from "@/lib/format";

export const metadata: Metadata = { title: "投稿ランキング" };

export default async function PostsPage({ params, searchParams }: PageProps<"/clients/[id]/posts">) {
  const { id } = await params;
  const r = await reportFromSearch(id, await searchParams);
  const d = r.analysis;
  return (
    <ReportPage report={r} title="投稿ランキング" lead="SNSの規模差を補正した「パフォーマンス指数」で並べた上位投稿です。">
      <section>
        <div className="card flush scroll">
          <table>
            <thead><tr><th scope="col">SNS</th><th scope="col">日時</th><th scope="col">形式</th><th scope="col">投稿</th>
              <th scope="col" className="num">エンゲージメント</th><th scope="col" className="num">表示回数</th><th scope="col" className="num">ER（表示比）</th><th scope="col" className="num">指数</th></tr></thead>
            <tbody>
              {d.topPosts.map((t, i) => (
                <tr key={i}>
                  <td><Chip platform={t.platform} /></td><td className="nowrap">{t.date}</td><td>{t.media}</td>
                  <td className="post-text">{t.permalink ? <a href={t.permalink} target="_blank" rel="noopener noreferrer">{truncate(t.text, 80) || "（本文なし）"}<span className="sr-only">（新しいタブで開きます）</span></a> : truncate(t.text, 80)}</td>
                  <td className="num">{fmtNum(t.engagements)}</td><td className="num">{fmtNum(t.views)}</td>
                  <td className="num">{fmtPct(t.erViews)}</td><td className="num strong">{fmtNum(t.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">すべての投稿は、「ダウンロード」の「投稿一覧」（CSV）で確認できます。</p>
      </section>
    </ReportPage>
  );
}
