import type { Metadata } from "next";
import Link from "next/link";
import { publicSettings } from "@/lib/public-settings";

export const metadata: Metadata = { title: "データ削除のご案内", robots: { index: true, follow: true } };

export default async function DataDeletionPage() {
  const s = await publicSettings();
  const c = s.legal.contact?.trim();
  return (
    <article className="policy">
      <h1>データ削除のご案内</h1>
      <p>本サービスがSNSから取得したデータの削除は、次の方法でご依頼いただけます。</p>
      <h2>Facebook・Instagram</h2>
      <ol>
        <li>Facebook の「設定とプライバシー」→「設定」→「アプリとウェブサイト」を開きます（名称は変更される場合があります）。</li>
        <li>本サービスのアプリを選び、「削除」を選びます。</li>
        <li>Meta から本サービスに削除リクエストが送られ、その方が連携を許可して取得した Facebook・Instagram のデータを自動的に削除します。確認コードと確認ページの URL が Meta の画面に表示されます。</li>
      </ol>
      <h2>Threads</h2>
      <p>Threads の「設定」→「アカウント」→「ウェブサイトのアクセス許可」（名称は変更される場合があります）から本サービスのアプリを削除すると、同様に自動的に削除します。</p>
      <h2>その他のご依頼</h2>
      <p>上記以外の削除のご依頼は、{c ? (c.includes("@") ? <a href={`mailto:${c}`}>{c}</a> : <a href={c}>{c}</a>) : "お問い合わせ窓口"}までご連絡ください。詳しくは<Link href="/privacy#delete">プライバシーポリシー</Link>をご覧ください。</p>
      <h2>削除状況の確認</h2>
      <form action="/data-deletion/status" method="get" className="card">
        <label htmlFor="code">確認コード</label>
        <input id="code" name="code" type="text" required pattern="[0-9a-f]{16}" autoComplete="off" />
        <div className="form-actions"><button type="submit" className="btn primary">確認</button></div>
      </form>
    </article>
  );
}
