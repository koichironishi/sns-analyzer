import Link from "next/link";

export default function PublicLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <header className="app-bar"><div className="app-bar-in"><Link className="app-brand" href="/">SNS分析</Link></div></header>
      <main id="main" className="app-main narrow" tabIndex={-1}>{children}</main>
      <footer className="footer">
        <Link href="/privacy">プライバシーポリシー</Link>
        <Link href="/terms">利用規約</Link>
        <Link href="/data-deletion">データ削除のご案内</Link>
      </footer>
    </>
  );
}
