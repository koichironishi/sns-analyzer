import type { Metadata } from "next";
import { Suspense } from "react";
import { clientName } from "@/lib/report";
import { notFound } from "next/navigation";
import { UUID_RE, requireClientAccess } from "@/lib/auth";
import { SideNav } from "@/components/side-nav";
import { ClientHead } from "@/components/client-head";
import { DrawerHead, DrawerNav, DrawerUser } from "@/components/drawer-parts";

/** タブを並べても区別できるよう、ページ名にクライアント名を添える */
export async function generateMetadata({ params }: LayoutProps<"/clients/[id]">): Promise<Metadata> {
  const name = await clientName((await params).id);
  return { title: { template: name ? `%s｜${name} | SNS分析` : "%s | SNS分析", default: name || "SNS分析" } };
}

export default async function ClientLayout({ children, params }: LayoutProps<"/clients/[id]">) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const v = await requireClientAccess(id);
  const name = await clientName(id);
  if (!name) notFound();
  // 左メニュー：全体のメニュー／選択中のクライアント（設定・連携）／名前とログアウト（MEO と同じ並び）
  // 「投稿」と「AI分析」はレポートのタブではなく、左メニューに置く（作業の画面のため）
  const workItems = [
    { href: "/publish", label: "投稿", keepQuery: false, prefix: true },
    { href: "/ai", label: "AI分析" },
  ];
  const clientItems = v.kind === "staff" ? [
    // 設定の画面からレポートへ戻れるように。レポートの画面（インサイトなど）ではこの項目を選択中にする
    { href: "", label: "ダッシュボード", fallback: true },
    ...workItems,
    { href: "/settings", label: "クライアント情報", keepQuery: false },
    { href: "/settings/connections", label: "SNS連携", keepQuery: false, match: ["/settings/meta-pages"] },
    { href: "/settings/users", label: "利用者管理", keepQuery: false },
  ] : workItems; // 利用者は、ダッシュボードが全体のメニューにある
  return (
    <div className="shell">
      <aside className="side no-print" aria-label="メニュー">
        <DrawerHead />
        <DrawerNav v={v} />
        <div className="drawer-section">
          <p className="drawer-label">選択中のクライアント</p>
          <p className="side-title">{name}</p>
          {clientItems.length > 0 && (
            <Suspense>
              <SideNav base={`/clients/${id}`} items={clientItems} />
            </Suspense>
          )}
        </div>
        <DrawerUser v={v} />
      </aside>
      <main className="content" id="main" tabIndex={-1}>
        <Suspense><ClientHead clientId={id} clientName={name} /></Suspense>
        {children}
      </main>
    </div>
  );
}
