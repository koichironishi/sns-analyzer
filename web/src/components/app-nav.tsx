"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function AppNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="app-nav" aria-label="メイン">
      {items.map((it) => {
        const current = it.href === "/" ? path === "/" || path.startsWith("/clients") : path === it.href;
        return <Link key={it.href} href={it.href} aria-current={current ? "page" : undefined}>{it.label}</Link>;
      })}
    </nav>
  );
}
