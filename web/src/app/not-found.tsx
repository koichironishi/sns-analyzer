import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="app-main narrow" tabIndex={-1}>
      <h1 className="page-title">ページが見つかりません</h1>
      <p>URLが正しいか、閲覧する権限があるかをご確認ください。</p>
      <p><Link className="btn" href="/">トップへ戻る</Link></p>
    </main>
  );
}
