"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** レポートの目次。期間（?days=&end=）を引き継いでページを移動する */
export function SideNav({ base, items }: { base: string; items: { href: string; label: string; keepQuery?: boolean }[] }) {
  const path = usePathname();
  const sp = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ["days", "end"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return (
    <nav className="side-nav" aria-label="ページ">
      {items.map((it) => {
        const href = `${base}${it.href}`;
        const current = path === href;
        return (
          <Link key={it.href} href={it.keepQuery !== false && qs ? `${href}?${qs}` : href} aria-current={current ? "page" : undefined}>
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
