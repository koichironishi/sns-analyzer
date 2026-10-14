/**
 * 依存なしの SVG グラフ（サーバーで描画。外部の配信サービスからスクリプトを読み込まない）。
 * 色だけで区別しないよう、凡例・読み上げ用の説明・表を必ず併記する。
 */
import { PLATFORM_LABELS, type Platform } from "@/lib/sns/models";
import { slash } from "@/lib/format";

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

/**
 * 日別エンゲージメントの積み上げ棒グラフ。
 * 棒は SVG を枠いっぱいに伸ばし、目盛りの文字は HTML で置く（画面幅が狭くても文字が小さくならない）。
 */
export function StackedDaily({ dates, series, label }: {
  dates: string[]; series: { platform: Platform; values: number[] }[]; label: string;
}) {
  const totals = dates.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const n = Math.max(1, dates.length);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.ceil(dates.length / 7);
  return (
    <div className="bars" role="img" aria-label={label}>
      <div className="bars-y" aria-hidden="true">
        {ticks.map((f) => <span key={f} style={{ bottom: `${f * 100}%` }}>{(f * max).toLocaleString("ja-JP")}</span>)}
      </div>
      <div className="bars-plot">
        <svg viewBox={`0 0 ${n * 10} 100`} preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((f) => <line key={f} className="grid-line" x1={0} x2={n * 10} y1={100 - f * 100} y2={100 - f * 100} vectorEffect="non-scaling-stroke" />)}
          {dates.map((d, i) => {
            let acc = 0;
            return series.map((s) => {
              const v = s.values[i] ?? 0;
              if (!v) return null;
              const y0 = 100 - (acc / max) * 100;
              acc += v;
              const y1 = 100 - (acc / max) * 100;
              return <rect key={`${d}-${s.platform}`} x={i * 10 + 1.5} width={7} y={y1} height={Math.max(0, y0 - y1)} fill={`var(--c-${s.platform})`} />;
            });
          })}
        </svg>
        <div className="bars-x" aria-hidden="true">
          {dates.map((d, i) => i % labelEvery === 0 && (
            <span key={d} style={{ left: `${((i + 0.5) / n) * 100}%` }}>{slash(d.slice(5))}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 日別の折れ線（インサイト）。値のない日は線を切る。
 * 目盛りの文字は HTML で置き、日別グラフの棒（StackedDaily）と同じ枠を使う。
 */
export function DailyLine({ dates, values, color, label }: { dates: string[]; values: (number | null)[]; color: string; label: string }) {
  const max = niceMax(Math.max(0, ...values.map((v) => v ?? 0)));
  const n = Math.max(1, dates.length - 1);
  const ticks = [0, 0.5, 1];
  const labelEvery = Math.ceil(dates.length / 6);
  // 値のある日が続く区間ごとに線を引く（1日だけの値は点で出す）
  const runs: [number, number][][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    const pt: [number, number] = [(i / n) * 100, 100 - (v / max) * 100];
    if (i > 0 && values[i - 1] !== null && runs.length) runs[runs.length - 1].push(pt);
    else runs.push([pt]);
  });
  return (
    <div className="bars line" role="img" aria-label={label}>
      <div className="bars-y" aria-hidden="true">
        {ticks.map((f) => <span key={f} style={{ bottom: `${f * 100}%` }}>{(f * max).toLocaleString("ja-JP")}</span>)}
      </div>
      <div className="bars-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((f) => <line key={f} className="grid-line" x1={0} x2={100} y1={100 - f * 100} y2={100 - f * 100} vectorEffect="non-scaling-stroke" />)}
          {runs.map((r, k) => r.length > 1
            ? <polyline key={k} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                points={r.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")} />
            : <line key={k} x1={r[0][0]} x2={r[0][0]} y1={r[0][1]} y2={r[0][1]} stroke={color} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
        </svg>
        <div className="bars-x" aria-hidden="true">
          {dates.map((d, i) => i % labelEvery === 0 && (
            <span key={d} style={{ left: `${(i / n) * 100}%` }}>{slash(d.slice(5))}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** フォロワー推移の小さな折れ線 */
export function Sparkline({ values, platform, label }: { values: (number | null)[]; platform: Platform; label: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return <p className="muted small" style={{ margin: 0 }}>推移のデータがありません</p>;
  const W = 240, H = 40;
  const vs = pts.map((p) => p[1]);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * W;
  const y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <polyline fill="none" stroke={`var(--c-${platform})`} strokeWidth="2" vectorEffect="non-scaling-stroke"
        points={pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} />
    </svg>
  );
}

export function Legend({ platforms }: { platforms: Platform[] }) {
  return (
    <ul className="legend" aria-label="凡例">
      {platforms.map((p) => (
        <li key={p}><i className="dot" style={{ background: `var(--c-${p})` }} aria-hidden="true" />{PLATFORM_LABELS[p]}</li>
      ))}
    </ul>
  );
}
