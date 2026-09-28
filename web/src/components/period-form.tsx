"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const DAYS = [7, 14, 30, 60, 90];

/** 集計期間の切り替え（JS が無効でも GET フォームとして動く） */
export function PeriodForm({ today }: { today: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const router = useRouter();
  const days = sp.get("days") ?? "30";
  const end = sp.get("end") ?? today;
  return (
    <form className="period" action={path} method="get" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const q = new URLSearchParams();
      if (f.get("days") !== "30") q.set("days", String(f.get("days")));
      if (f.get("end") && f.get("end") !== today) q.set("end", String(f.get("end")));
      router.push(q.size ? `${path}?${q}` : path);
    }}>
      <div>
        <label htmlFor="days">期間</label>
        <select id="days" name="days" defaultValue={days} key={days}>
          {DAYS.map((d) => <option key={d} value={d}>{d}日間</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="end">終了日</label>
        <input id="end" name="end" type="date" max={today} defaultValue={end} key={end} />
      </div>
      <button type="submit" className="btn sm">表示</button>
    </form>
  );
}
