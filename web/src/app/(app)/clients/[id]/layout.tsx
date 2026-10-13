import type { Metadata } from "next";
import { Suspense } from "react";
import { clientName } from "@/lib/report";
import { notFound } from "next/navigation";
import { UUID_RE, requireClientAccess } from "@/lib/auth";
import { SideNav } from "@/components/side-nav";
import { PrintButton } from "@/components/print-button";
import { DrawerFoot, DrawerHead } from "@/components/drawer-parts";

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
  const items = [
    { href: "", label: "ダッシュボード" },
    { href: "/publish", label: "投稿", keepQuery: false },
    { href: "/ai", label: "AI分析" },
    { href: "/sns", label: "比較・分析", match: ["/timing"] },
    { href: "/competitors", label: "競合比較" },
    { href: "/content", label: "形式・タグ" },
    { href: "/downloads", label: "ダウンロード" },
    ...(v.kind === "staff" ? [{ href: "/settings", label: "設定・連携", keepQuery: false }] : []),
  ];
  return (
    <div className="shell">
      <aside className="side no-print" aria-label="レポートの目次">
        <DrawerHead />
        <div className="side-head">
          <p className="eyebrow">SNS分析レポート</p>
          <p className="side-title">{name}</p>
        </div>
        <Suspense>
          <SideNav base={`/clients/${id}`} items={items} />
        </Suspense>
        <div className="side-actions"><PrintButton /></div>
        <DrawerFoot v={v} />
      </aside>
      <main className="content" id="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
