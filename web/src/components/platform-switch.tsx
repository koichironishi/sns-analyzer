"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { PLATFORM_LABELS, type Platform } from "@/lib/sns/models";

type Account = { id: string; platform: Platform; name: string };

/**
 * SNSごとの表示切り替え（?sns=、同じSNSに複数アカウントがあるときは ?acct= も）。リンクなので JS なしでも動き、URL を共有できる。
 * 1アカウントのSNSは「Instagram」、複数のSNSは「Instagram（合計）」と「Instagram（アカウント名）」を並べる
 */
export function PlatformSwitch({ platforms, current, allowAll = true, accounts = [], currentAcct = null, totals = true }: {
  platforms: Platform[]; current: Platform | null; allowAll?: boolean;
  accounts?: Account[]; currentAcct?: string | null;
  /** 複数アカウントのSNSで「合計」を出すか（フォロワーの属性など、合計できない画面では false） */
  totals?: boolean;
}) {
  const path = usePathname();
  const sp = useSearchParams();
  const href = (p: Platform | null, acct: string | null = null) => {
    const q = new URLSearchParams(sp.toString());
    if (p) q.set("sns", p);
    else q.delete("sns");
    if (acct) q.set("acct", acct);
    else q.delete("acct");
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  type Option = { key: string; platform: Platform | null; acct: string | null; label: string };
  const options: Option[] = allowAll ? [{ key: "all", platform: null, acct: null, label: "すべて" }] : [];
  for (const p of platforms) {
    const list = accounts.filter((a) => a.platform === p);
    if (list.length <= 1) {
      options.push({ key: p, platform: p, acct: null, label: PLATFORM_LABELS[p] });
      continue;
    }
    if (totals) options.push({ key: p, platform: p, acct: null, label: `${PLATFORM_LABELS[p]}（合計）` });
    for (const a of list) options.push({ key: a.id, platform: p, acct: a.id, label: `${PLATFORM_LABELS[p]}（${a.name}）` });
  }
  return (
    <nav className="tabs platform-switch" aria-label="SNS・アカウントの切り替え">
      {options.map((o) => (
        <Link key={o.key} className="tab" href={href(o.platform, o.acct)} scroll={false}
          aria-current={o.platform === current && (o.acct ?? null) === (currentAcct ?? null) ? "page" : undefined}>
          {o.platform && <i className="dot" style={{ background: `var(--c-${o.platform})` }} aria-hidden="true" />}{o.label}
        </Link>
      ))}
    </nav>
  );
}
