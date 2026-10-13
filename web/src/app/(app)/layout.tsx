import Link from "next/link";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { PRODUCTS } from "@/lib/products";
import { MenuBackdrop, MenuButton } from "@/components/mobile-menu";
import { DrawerFoot, DrawerHead } from "@/components/drawer-parts";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const v = await requireViewer();
  // 初期パスワードのままの閲覧ユーザーには、先にパスワードを変更してもらう
  if (v.kind === "client" && v.mustChangePassword) redirect("/account");
  return (
    <>
      <header className="app-bar">
        <div className="app-bar-in">
          <MenuButton />
          <Link className="app-brand" href="/"><span className="app-mark" aria-hidden="true">S</span>SNS分析</Link>
          <span className="spacer" />
          {/* 製品の切り替えはスタッフのみ（クライアントは SNS分析 だけを使う） */}
          {v.kind === "staff" && (
            <nav className="rw-switcher" aria-label="製品の切り替え">
              {PRODUCTS.map((p) => p.key === "sns"
                ? <Link key={p.key} href={p.url} data-to={p.key} aria-current="true">{p.label}</Link>
                : <a key={p.key} href={p.url} data-to={p.key}>{p.label}</a>)}
            </nav>
          )}
        </div>
      </header>
      {/*
        全体メニュー・アカウント・ログアウトは左メニューの下部に置く（MEO と同じ）。
        クライアントの画面では、その左メニュー（.side）に同じ下部を入れ、この .app-drawer は出さない。
        スマホではどちらも ☰ で開くドロワーになる。
      */}
      <div className="frame">
        <aside className="app-drawer no-print" aria-label="メニュー"><DrawerHead /><DrawerFoot v={v} /></aside>
        <div className="frame-main">
          {children}
          <footer className="footer no-print">
            <Link href="/privacy">プライバシーポリシー</Link>
            <Link href="/terms">利用規約</Link>
            <span>本サービスは Meta Platforms, Inc. および X Corp. が提供・承認するものではありません。</span>
          </footer>
        </div>
      </div>
      <MenuBackdrop />
    </>
  );
}
