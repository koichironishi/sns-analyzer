import Link from "next/link";
import type { Viewer } from "@/lib/auth";
import { PRODUCTS } from "@/lib/products";
import { MenuBackdrop, MenuButton } from "./mobile-menu";
import { DrawerHead, DrawerNav, DrawerUser } from "./drawer-parts";
import { AppFooter } from "./app-footer";

/** 上バー・左メニュー（全体）・フッターの外枠。(app) のレイアウトとアカウント設定で共通 */
export function AppChrome({ v, children }: { v: Viewer; children: React.ReactNode }) {
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
        <aside className="app-drawer no-print" aria-label="メニュー"><DrawerHead /><DrawerNav v={v} /><DrawerUser v={v} /></aside>
        <div className="frame-main">
          {children}
          {/* 画面の下の注記。クライアントの画面では main.content の中に入れるため、ここのものは出さない（CSS） */}
          <AppFooter />
        </div>
      </div>
      <MenuBackdrop />
    </>
  );
}
