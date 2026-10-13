import type { Viewer } from "@/lib/auth";
import { appNavItems } from "@/lib/app-nav";
import { PRODUCTS } from "@/lib/products";
import { logout } from "@/app/login/actions";
import { MenuClose } from "./mobile-menu";
import { AppNav } from "./app-nav";

/** ドロワーの上部（スマホのみ）：ロゴと閉じるボタン */
export function DrawerHead() {
  return (
    <div className="drawer-head">
      <span className="drawer-brand"><span className="app-mark" aria-hidden="true">S</span>SNS分析</span>
      <MenuClose />
    </div>
  );
}

/** 左メニューの下部：全体のメニュー・アカウント・ログアウト（製品の切り替えはスマホのみ） */
export function DrawerFoot({ v }: { v: Viewer }) {
  return (
    <div className="drawer-foot">
      <p className="drawer-label">メニュー</p>
      <AppNav items={[...appNavItems(v), { href: "/account", label: "アカウント" }]} />
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
      <div className="drawer-user">
        <span className="drawer-avatar" aria-hidden="true">{(v.name || v.email || "?").slice(0, 1).toUpperCase()}</span>
        <span className="drawer-user-name">{v.name || v.email}</span>
        {v.kind === "staff" && v.isAdmin && <span className="drawer-role">管理者</span>}
      </div>
      <form action={logout}><button type="submit" className="drawer-logout">ログアウト</button></form>
    </div>
  );
}
