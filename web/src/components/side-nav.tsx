"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** レポートの目次。期間とSNSの絞り込み（?days=&end=&sns=）を引き継いでページを移動する */
/**
 * fallback：ほかのどの項目にも当たらないページ（ダッシュボードやインサイトなどのレポート）で選択中にする
 * prefix：その下のページ（例：投稿の作成・編集）でも選択中にする
 */
export function SideNav({ base, items }: { base: string; items: { href: string; label: string; keepQuery?: boolean; match?: string[]; fallback?: boolean; prefix?: boolean }[] }) {
  const path = usePathname();
  const sp = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ["days", "end", "sns", "acct"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  const hit = (it: { href: string; match?: string[]; prefix?: boolean }) => path === `${base}${it.href}`
    || (it.prefix === true && path.startsWith(`${base}${it.href}/`)) || (it.match ?? []).some((m) => path === `${base}${m}`);
  const anyHit = items.some((it) => !it.fallback && hit(it));
  return (
    <nav className="side-nav" aria-label="ページ">
      {items.map((it) => {
        const href = `${base}${it.href}`;
        // match：同じ項目として扱うページ（例：「比較・分析」は SNS比較 と 投稿時間）
        const current = it.fallback ? !anyHit && (path === href || path.startsWith(`${href}/`)) : hit(it);
        return (
          <Link key={it.href} href={it.keepQuery !== false && qs ? `${href}?${qs}` : href} aria-current={current ? "page" : undefined}>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
