export const fmtNum = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : v.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtPct = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`;

export const fmtSigned = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toLocaleString("ja-JP")}`;

export const slash = (d: string) => d.replaceAll("-", "/");

/** ISO 日時 → 日本時間の「YYYY/MM/DD HH:MM」 */
export function fmtDateTime(iso: string | null | undefined, tz = "Asia/Tokyo"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
