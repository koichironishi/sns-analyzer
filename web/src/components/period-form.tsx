"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { addDays } from "@/lib/sns/models";

/*
 * 期間の切り替え（MEO と同じボタン型：7日・30日・90日・今月・先月・日付指定）。
 * URL は今までどおり ?days=（日数）&end=（終了日）で持つので、共有したリンクやダウンロードもそのまま使える。
 */
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

function presets(today: string) {
  const [y, m, d] = today.split("-").map(Number);
  const lastPrev = new Date(Date.UTC(y, m - 1, 0)); // 先月の末日
  const lpEnd = ymd(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth() + 1, lastPrev.getUTCDate());
  return [
    { key: "7d", label: "7日", days: 7, end: today },
    { key: "30d", label: "30日", days: 30, end: today },
    { key: "90d", label: "90日", days: 90, end: today },
    { key: "thisMonth", label: "今月", days: d, end: today },
    { key: "lastMonth", label: "先月", days: lastPrev.getUTCDate(), end: lpEnd },
  ];
}

export function PeriodForm({ today }: { today: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const router = useRouter();
  const days = Number(sp.get("days") ?? "30") || 30;
  const end = sp.get("end") ?? today;
  const list = presets(today);
  const active = list.find((p) => p.days === days && p.end === end)?.key ?? "custom";
  const [open, setOpen] = useState(active === "custom");
  const [from, setFrom] = useState(addDays(end, -(days - 1)));
  const [to, setTo] = useState(end);
  const stripRef = useRef<HTMLDivElement>(null);

  // 選んでいる期間が横スクロールの外にあると、何を見ているか分からなくなる
  useEffect(() => {
    const strip = stripRef.current;
    const cur = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (strip && cur) strip.scrollLeft = Math.max(0, cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2);
  }, [active]);

  const go = (d: number, e: string) => {
    const q = new URLSearchParams(sp.toString());
    if (d === 30) q.delete("days"); else q.set("days", String(d));
    if (e === today) q.delete("end"); else q.set("end", e);
    const s = q.toString();
    router.push(s ? `${path}?${s}` : path);
  };

  const customOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to && to <= today;

  return (
    <div className="period-bar">
      <div className="period-row">
        <span className="period-label" id="period-label">期間</span>
        <div className="period-strip" ref={stripRef} role="group" aria-labelledby="period-label">
          {list.map((p) => (
            <button key={p.key} type="button" className="period-pill" aria-pressed={active === p.key}
              onClick={() => { setOpen(false); go(p.days, p.end); }}>{p.label}</button>
          ))}
          <button type="button" className="period-pill" aria-pressed={active === "custom"} aria-expanded={open}
            onClick={() => setOpen((v) => !v)}>日付指定</button>
        </div>
      </div>
      {open && (
        <form className="period-custom" onSubmit={(e) => { e.preventDefault(); if (customOk) go(daysBetween(from, to), to); }}>
          <div>
            <label htmlFor="period-from">開始日</label>
            <input id="period-from" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor="period-to">終了日</label>
            <input id="period-to" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button type="submit" className="btn primary" disabled={!customOk}>表示</button>
        </form>
      )}
    </div>
  );
}
