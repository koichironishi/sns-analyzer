import Link from "next/link";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { logout } from "../login/actions";
import { AppNav } from "@/components/app-nav";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const v = await requireViewer();
  // 初期パスワードのままの閲覧ユーザーには、先にパスワードを変更してもらう
  if (v.kind === "client" && v.mustChangePassword) redirect("/account");
  const items = v.kind === "staff"
    ? [{ href: "/", label: "クライアント" }, ...(v.isAdmin ? [{ href: "/admin", label: "全体設定" }, { href: "/admin/audit", label: "操作ログ" }] : [])]
    : [{ href: `/clients/${v.clientId}`, label: "レポート" }];
  return (
    <>
      <header className="app-bar">
        <div className="app-bar-in">
          <Link className="app-brand" href="/">SNS分析</Link>
          <AppNav items={items} />
          <div className="app-right">
            <span className="who"><span className="acct-name">{v.name || v.email}</span>{v.kind === "staff" && v.isAdmin && <span className="badge" style={{ marginLeft: 6 }}>管理者</span>}</span>
            <Link className="btn ghost sm" href="/account">アカウント</Link>
            <form action={logout}><button type="submit" className="btn ghost sm">ログアウト</button></form>
          </div>
        </div>
      </header>
      {children}
      <footer className="footer no-print">
        <Link href="/privacy">プライバシーポリシー</Link>
        <Link href="/terms">利用規約</Link>
        <span>本サービスは Meta Platforms, Inc. および X Corp. が提供・承認するものではありません。</span>
      </footer>
    </>
  );
}
