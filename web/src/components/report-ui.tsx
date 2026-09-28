import type { Insight } from "@/lib/sns/analysis";
import { PLATFORM_LABELS, type Platform } from "@/lib/sns/models";

export function Chip({ platform }: { platform: Platform }) {
  return (
    <span className="chip">
      <i className="dot" style={{ background: `var(--c-${platform})` }} aria-hidden="true" />
      {PLATFORM_LABELS[platform]}
    </span>
  );
}

/** 前期間比の増減。色だけに頼らず矢印と読み上げ用の語を添える */
export function Delta({ value, label = "" }: { value: number | null | undefined; label?: string }) {
  if (value === null || value === undefined) return <span className="delta flat">{label}—</span>;
  const cls = value > 0.005 ? "up" : value < -0.005 ? "down" : "flat";
  const arrow = { up: "▲", down: "▼", flat: "→" }[cls];
  const word = { up: "増", down: "減", flat: "横ばい" }[cls];
  return (
    <span className={`delta ${cls}`} title={`前期間比 ${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`}>
      {label}
      <span aria-hidden="true">{arrow}</span> {Math.abs(value * 100).toFixed(1)}%<span className="sr-only">{word}</span>
    </span>
  );
}

const KIND = { good: ["✓", "好調"], warn: ["!", "要注意"], info: ["i", "示唆"] } as const;
const ORDER = { warn: 0, good: 1, info: 2 } as const;

function InsightItem({ i }: { i: Insight }) {
  const [icon, label] = KIND[i.kind];
  return (
    <li className={`ins ${i.kind}`}>
      <span className={`badge ${i.kind}`}><span aria-hidden="true">{icon}</span>{label}</span>
      <span className="ins-text">{i.text}</span>
    </li>
  );
}

/** 自動コメント。注意 → 好調 → 示唆 の順に並べ、先頭だけ見せる */
export function Insights({ items, visible = 4 }: { items: Insight[]; visible?: number }) {
  if (!items.length) return <p className="muted">データが不足しています。</p>;
  const sorted = [...items].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const rest = sorted.slice(visible);
  return (
    <>
      <ul className="insights">{sorted.slice(0, visible).map((i, n) => <InsightItem key={n} i={i} />)}</ul>
      {rest.length > 0 && (
        <details className="more">
          <summary>ほか{rest.length}件を表示</summary>
          <ul className="insights">{rest.map((i, n) => <InsightItem key={n} i={i} />)}</ul>
        </details>
      )}
    </>
  );
}

export function Bar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  return (
    <>
      <span className="bar" style={{ width: `${Math.max(0, (value / (max || 1)) * 100).toFixed(1)}%`, background: color }} aria-hidden="true" />
      <span className="bar-val">{label}</span>
    </>
  );
}

export function PageHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }) {
  return (
    <header className="page-head">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
    </header>
  );
}

export function Message({ kind = "info", children }: { kind?: "info" | "ok" | "error"; children: React.ReactNode }) {
  return <div className={`msg ${kind === "info" ? "" : kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}
