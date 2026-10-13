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
  const clientItems = v.kind === "staff" ? [{ href: "/settings", label: "設定・連携", keepQuery: false, match: ["/settings/meta-pages"] }] : [];
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
