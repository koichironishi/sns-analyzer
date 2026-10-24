import Link from "next/link";
import type { Viewer } from "@/lib/auth";
import { appNavItems } from "@/lib/app-nav";
import { PRODUCTS } from "@/lib/products";
import { logout } from "@/app/login/actions";
import { MenuClose } from "./mobile-menu";
import { AppNav } from "./app-nav";

/*
 * 左メニューの部品（MEO と同じ並び）
 *   上：全体のメニュー（DrawerNav）
 *   中：選択中のクライアント（クライアントの画面のときだけ。レイアウト側で入れる）
 *   下：製品の切り替え（スマホのみ）・名前（アカウント設定へ）・ログアウト（DrawerUser）
 */

/** ドロワーの上部（スマホのみ）：ロゴと閉じるボタン */
export function DrawerHead() {
  return (
    <div className="drawer-head">
      <span className="drawer-brand"><span className="app-mark" aria-hidden="true">S</span>SNS</span>
      <MenuClose />
    </div>
  );
}

/** 全体のメニュー */
export function DrawerNav({ v }: { v: Viewer }) {
  return (
    <div className="drawer-section">
      <p className="drawer-label">メニュー</p>
      <AppNav items={appNavItems(v)} />
    </div>
  );
}

/** 左メニューの一番下：製品の切り替え（スマホのみ）・名前・ログアウト */
export function DrawerUser({ v }: { v: Viewer }) {
  return (
    <div className="drawer-foot">
      {v.kind === "staff" && (
        <div className="drawer-products">
          <p className="drawer-label">製品</p>
          <nav className="drawer-nav" aria-label="製品の切り替え">
            {PRODUCTS.filter((p) => p.key !== "sns").map((p) => (
              <a key={p.key} href={p.url} className="drawer-product" data-to={p.key}>{p.label}</a>
            ))}
          </nav>
        </div>
      )}
      {/* 名前を押すとアカウント設定へ（MEO と同じ） */}
      <Link href="/account" className="drawer-user">
        <span className="drawer-avatar" aria-hidden="true">{(v.name || v.email || "?").slice(0, 1).toUpperCase()}</span>
        <span className="drawer-user-text">
          <span className="drawer-user-name">{v.name || v.email}</span>
          <span className="drawer-user-sub">{v.kind === "staff" ? (v.isAdmin ? "Rhythmos ・ 管理者" : "Rhythmos") : "利用者"}</span>
        </span>
        <svg className="drawer-user-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </Link>
      <form action={logout}><button type="submit" className="drawer-logout">ログアウト</button></form>
    </div>
  );
}
