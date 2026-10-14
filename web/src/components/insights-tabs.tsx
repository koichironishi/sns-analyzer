"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** 「インサイト」の中の表示の切り替え（塗りの切り替え）。期間とSNSの選択は引き継ぐ */
const TABS = [
  { seg: "", label: "結果" },
  { seg: "/content", label: "コンテンツ" },
  { seg: "/audience", label: "オーディエンス" },
] as const;

export function InsightsTabs({ base }: { base: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ["days", "end", "sns"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return (
    <nav className="tabs analysis-tabs" aria-label="インサイトの表示">
      {TABS.map((t) => {
        const href = `${base}/insights${t.seg}`;
        return <Link key={t.seg} className="tab" href={qs ? `${href}?${qs}` : href} aria-current={path === href ? "page" : undefined}>{t.label}</Link>;
      })}
    </nav>
  );
}
