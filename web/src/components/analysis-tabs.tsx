"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** 「比較・分析」の中の画面切り替え（下線のタブ）。期間とSNSの絞り込みは引き継ぐ */
const TABS = [
  { seg: "sns", label: "SNS比較" },
  { seg: "timing", label: "投稿時間" },
] as const;

export function AnalysisTabs({ base }: { base: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ["days", "end", "sns"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return (
    <nav className="rw-navtabs analysis-tabs" aria-label="比較・分析の画面">
      {TABS.map((t) => {
        const href = `${base}/${t.seg}`;
        return (
          <Link key={t.seg} href={qs ? `${href}?${qs}` : href} aria-current={path === href ? "page" : undefined}>{t.label}</Link>
        );
      })}
    </nav>
  );
}
