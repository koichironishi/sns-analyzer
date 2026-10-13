"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** 全体のメニュー（左メニューの下部）。今いる画面に aria-current を付ける */
export function AppNav({ items, className = "drawer-nav", label = "全体のメニュー" }: {
  items: { href: string; label: string }[]; className?: string; label?: string;
}) {
  const path = usePathname();
  return (
    <nav className={className} aria-label={label}>
      {items.map((it) => (
        <Link key={it.href} href={it.href} aria-current={path === it.href ? "page" : undefined}>{it.label}</Link>
      ))}
    </nav>
  );
}
