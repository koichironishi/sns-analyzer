"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { PLATFORM_LABELS, type Platform } from "@/lib/sns/models";

/** SNSごとの表示切り替え（?sns=）。リンクなので JS なしでも動き、URL を共有できる */
export function PlatformSwitch({ platforms, current, allowAll = true }: { platforms: Platform[]; current: Platform | null; allowAll?: boolean }) {
  const path = usePathname();
  const sp = useSearchParams();
  const href = (p: Platform | null) => {
    const q = new URLSearchParams(sp.toString());
    if (p) q.set("sns", p);
    else q.delete("sns");
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  const options: { value: Platform | null; label: string }[] = [
    ...(allowAll ? [{ value: null, label: "すべて" }] : []), ...platforms.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))];
  return (
    <nav className="tabs platform-switch" aria-label="SNSの切り替え">
      {options.map((o) => (
        <Link key={o.value ?? "all"} className="tab" href={href(o.value)} scroll={false}
          aria-current={o.value === current ? "page" : undefined}>
          {o.value && <i className="dot" style={{ background: `var(--c-${o.value})` }} aria-hidden="true" />}{o.label}
        </Link>
      ))}
    </nav>
  );
}
