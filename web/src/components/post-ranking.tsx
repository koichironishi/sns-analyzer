import type { AnalysisResult } from "@/lib/sns/analysis";
import { Chip } from "./report-ui";
import { fmtNum, fmtPct, truncate } from "@/lib/format";

/** 投稿ランキング（SNSの規模差を補正したパフォーマンス指数の順） */
export function PostRanking({ analysis: d }: { analysis: AnalysisResult }) {
  if (!d.topPosts.length) return <div className="card empty"><p>この期間の投稿はありません。</p></div>;
  return (
    <div className="card flush scroll">
      <table>
        <caption className="sr-only">パフォーマンス指数の上位投稿</caption>
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
  );
}
