import type { Metadata } from "next";
import { Suspense } from "react";
import { clientName } from "@/lib/report";
import { notFound } from "next/navigation";
import { UUID_RE, requireClientAccess } from "@/lib/auth";
import { todayIn } from "@/lib/sns/models";
import { SideNav } from "@/components/side-nav";
import { PeriodForm } from "@/components/period-form";
import { PrintButton } from "@/components/print-button";

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
    { href: "", label: "概要" },
    { href: "/ai", label: "AI分析" },
    { href: "/sns", label: "SNS比較" },
    { href: "/competitors", label: "競合比較" },
    { href: "/timing", label: "投稿時間" },
    { href: "/content", label: "形式・タグ" },
    { href: "/posts", label: "投稿ランキング" },
    { href: "/downloads", label: "ダウンロード" },
    ...(v.kind === "staff" ? [{ href: "/settings", label: "設定・連携", keepQuery: false }] : []),
  ];
  return (
    <div className="shell">
      <aside className="side no-print" aria-label="レポートの目次">
        <div className="side-head">
          <p className="eyebrow">SNS分析レポート</p>
          <p className="side-title">{name}</p>
        </div>
        <Suspense>
          <PeriodForm today={todayIn()} />
          <SideNav base={`/clients/${id}`} items={items} />
        </Suspense>
        <div className="side-actions"><PrintButton /></div>
      </aside>
      <main className="content" id="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
