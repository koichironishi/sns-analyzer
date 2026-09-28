import type { Metadata } from "next";
import { periodQuery, reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { DOWNLOAD_FILES, type DownloadName } from "@/lib/sns/export";

export const metadata: Metadata = { title: "ダウンロード" };

const DESCRIPTIONS: Record<DownloadName, string> = {
  "posts.csv": "期間内のすべての投稿と指標（Excel でそのまま開けます）",
  "summary.csv": "SNS別の主要指標と前期間比",
  "media_types.csv": "投稿形式ごとの件数と平均指数",
  "hashtags.csv": "2回以上使ったハッシュタグ",
  "competitors.csv": "自社と競合の比較表",
  "competitor_posts.csv": "競合の投稿一覧（公開値）",
  "ai_analysis.md": "最新のAI分析（Markdown 形式）",
};

export default async function DownloadsPage({ params, searchParams }: PageProps<"/clients/[id]/downloads">) {
  const { id } = await params;
  const r = await reportFromSearch(id, await searchParams);
  const q = periodQuery(r.period);
  const available = (Object.keys(DOWNLOAD_FILES) as DownloadName[]).filter((k) =>
    k.startsWith("competitor") ? Boolean(r.competitors) : k === "ai_analysis.md" ? Boolean(r.ai) : true);
  return (
    <ReportPage report={r} title="ダウンロード" lead="表示中の期間のデータを、CSV（UTF-8・BOM付き）などで保存できます。レポートの画面は「PDFで保存・印刷」ボタンからPDFで保存できます。">
      <section>
        <div className="card">
          <a className="btn primary" href={`/api/clients/${id}/export/all.zip${q}`} download>すべてまとめてダウンロード（ZIP）</a>
        </div>
        <div className="card flush scroll" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th scope="col">ファイル</th><th scope="col">内容</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody>
              {available.map((k) => (
                <tr key={k}>
                  <th scope="row">{DOWNLOAD_FILES[k]}</th>
                  <td className="small">{DESCRIPTIONS[k]}</td>
                  <td className="num"><a className="btn sm" href={`/api/clients/${id}/export/${k}${q}`} download aria-label={`${DOWNLOAD_FILES[k]}をダウンロード`}>ダウンロード</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">ダウンロードは操作ログに記録されます。</p>
      </section>
    </ReportPage>
  );
}
