import type { Metadata } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth";

export const metadata: Metadata = { title: "ご利用ガイド", description: "SNS分析の画面の見方と操作方法をご案内します。" };

/**
 * ご利用ガイド（MEO と同じ形：章立てと、開いて読む項目）。
 * クライアントの利用者も読む前提。数値は出さず、画面への行き先だけを作る。
 */
const NAV = [
  { id: "start", label: "はじめに" },
  { id: "screens", label: "画面の見方" },
  { id: "period", label: "期間とSNSの切り替え" },
  { id: "post", label: "投稿と承認" },
  { id: "faq", label: "よくあるご質問" },
];

function Row({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  return (
    <details className="guide-row">
      <summary><span className="guide-row-title">{title}</span><span className="guide-row-sum">{summary}</span></summary>
      <div className="guide-row-body">{children}</div>
    </details>
  );
}

export default async function HelpPage() {
  const v = await requireViewer();
  const base = v.kind === "client" ? `/clients/${v.clientId}` : "/";
  return (
    <main id="main" className="app-main narrow guide" tabIndex={-1}>
      <h1 className="page-title">ご利用ガイド</h1>
      <p className="sub">SNS分析の画面の見方と、よく使う操作をまとめています。</p>
      <nav className="guide-toc" aria-label="ガイドの目次">
        {NAV.map((n) => <a key={n.id} href={`#${n.id}`}>{n.label}</a>)}
      </nav>

      <section id="start" aria-labelledby="h-start">
        <h2 id="h-start">はじめに</h2>
        <p>SNS分析は、Instagram・Facebook・Threads・X の数値を毎日自動で集め、反応の良い投稿や時間帯を分かりやすく示すツールです。データは毎朝自動で更新されます。</p>
        <p><Link className="btn primary" href={base}>{v.kind === "client" ? "ダッシュボードを開く" : "クライアントの一覧を開く"}</Link></p>
      </section>

      <section id="screens" aria-labelledby="h-screens">
        <h2 id="h-screens">画面の見方</h2>
        <p className="sub">画面の上のタブで切り替えます。</p>
        <div className="card flush">
          <Row title="ダッシュボード" summary="期間全体の結果と、まず押さえるべきポイント">
            <p>エンゲージメント・表示回数・投稿数・フォロワーを前の期間と比べます。「この期間のポイント」には、要対応（下がっている点）・良好（伸びている点）・ヒント（試す価値のある点）を自動でまとめます。下の方に、反応の良かった投稿のランキングと、すべての投稿の一覧があります。</p>
          </Row>
          <Row title="投稿" summary="各SNSへの投稿の作成・予約">
            <p>本文と画像を入れ、投稿先と時間を選んで投稿・予約できます。承認が必要な設定のときは、担当者の承認後に投稿されます。</p>
          </Row>
          <Row title="AI分析" summary="投稿の傾向と改善提案">
            <p>数値と投稿内容をもとに、改善提案と投稿のアイデアを表示します。実行は担当者が行います。</p>
          </Row>
          <Row title="比較・分析" summary="SNS比較と投稿時間">
            <p>「SNS比較」では規模の違うSNSを反応の割合で比べます。「投稿時間」では、曜日と時間帯ごとの反応の良さを色の濃さで示します。</p>
          </Row>
          <Row title="競合比較" summary="登録した競合アカウントとの比較">
            <p>公開されている数値だけを使って、競合と条件をそろえて比べます。</p>
          </Row>
          <Row title="形式・タグ" summary="画像・動画などの形式と、ハッシュタグの効果">
            <p>どの形式・どのハッシュタグの投稿が反応を得ているかを示します。</p>
          </Row>
          <Row title="ダウンロード" summary="CSV・PDFでの保存">
            <p>表示中の期間のデータを CSV で保存できます。画面右上の「PDFで保存・印刷」で、レポートを PDF にできます。</p>
          </Row>
        </div>
      </section>

      <section id="period" aria-labelledby="h-period">
        <h2 id="h-period">期間とSNSの切り替え</h2>
        <p>各画面の上の「期間」で、7日・30日・90日・今月・先月・日付指定から選べます。その下の「すべて／Instagram…」で、1つのSNSだけの数値に切り替えられます。選んだ期間とSNSは、ほかの画面に移っても引き継がれます。</p>
      </section>

      <section id="post" aria-labelledby="h-post">
        <h2 id="h-post">投稿と承認</h2>
        <p>「投稿」から新しい投稿を作れます。承認が必要な設定のときは「承認を依頼する」を押すと担当者に届き、承認されると指定した時間に投稿されます。差し戻された投稿は、理由を確認して直してから依頼し直してください。</p>
      </section>

      <section id="faq" aria-labelledby="h-faq">
        <h2 id="h-faq">よくあるご質問</h2>
        <div className="card flush">
          <Row title="数値はいつ更新されますか" summary="毎朝自動で更新されます">
            <p>毎朝自動で集計します。SNS側の反映に時間がかかるため、直近1〜2日の数値はあとから増えることがあります。</p>
          </Row>
          <Row title="「—」と表示される項目があります" summary="そのSNSでは取得できない数値です">
            <p>たとえばクリック数は Facebook だけ、フォロワーによる閲覧数も Facebook だけで取得できます。SNSの仕様によるもので、故障ではありません。</p>
          </Row>
          <Row title="ストーリーズが一覧にありません" summary="公開中の24時間だけ取得できます">
            <p>Instagram のストーリーズは、公開されている24時間のあいだしか数値を取得できません。毎朝の自動収集の時点で公開中のものを記録しています。</p>
          </Row>
          <Row title="パスワードを変えたい" summary="左メニューの一番下の名前から">
            <p>左メニューの一番下にある名前を押すと、アカウント設定が開きます。現在のパスワードと新しいパスワードを入れて変更してください。</p>
          </Row>
        </div>
      </section>
    </main>
  );
}
