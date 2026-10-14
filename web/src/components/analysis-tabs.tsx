"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** 「比較・分析」の中の表示の切り替え（塗りの切り替え。上の画面のタブと二重の下線にならないように）。期間とSNSの絞り込みは引き継ぐ */
const TABS = [
  { seg: "sns", label: "SNS比較" },
  { seg: "timing", label: "投稿時間" },
] as const;

export function AnalysisTabs({ base }: { base: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ["days", "end", "sns", "acct"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return (
    <nav className="tabs analysis-tabs" aria-label="比較・分析の表示">
      {TABS.map((t) => {
        const href = `${base}/${t.seg}`;
        return (
          <Link key={t.seg} className="tab" href={qs ? `${href}?${qs}` : href} aria-current={path === href ? "page" : undefined}>{t.label}</Link>
        );
      })}
    </nav>
  );
}
