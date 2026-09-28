/**
 * 分析ロジック（Python 版 snsanalyzer/analysis.py の移植）。
 *
 * SNSごとに規模が大きく違うため、横断比較には
 * 「パフォーマンス指数」＝ 投稿のエンゲージメント ÷ そのSNSの期間中央値 × 100 を使う。
 * 100 がそのSNSでの“普通の投稿”、200 なら普段の2倍の反応があった投稿。
 */
import {
  DEFAULT_TZ, MEDIA_LABELS, PLATFORM_LABELS, PLATFORMS, addDays, engagementsOf, todayIn, toLocal,
  type FollowerSeries, type LocalTime, type MediaType, type Platform, type Post, type Series,
} from "./models.ts";

export const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
export const SLOT_HOURS = 3;
export const SLOTS = Array.from({ length: 24 / SLOT_HOURS }, (_, i) => `${i * SLOT_HOURS}〜${(i + 1) * SLOT_HOURS}時`);
export const HASHTAG_RE = /[#＃]([\p{L}\p{N}\p{M}_]+)/gu;
/** 傾向を語るのに必要な最低投稿数 */
export const MIN_SAMPLES = 3;

export type Row = {
  post: Post;
  local: LocalTime;
  engagements: number;
  followers: number | null;
  erFollowers: number | null; // エンゲージメント ÷ 投稿時フォロワー
  erViews: number | null; // エンゲージメント ÷ 表示回数
  score: number; // パフォーマンス指数
};

export type PeriodStats = {
  posts: number;
  engagements: number;
  views: number | null;
  avgEngagements: number | null;
  erFollowers: number | null;
  erViews: number | null;
};

export type Change = Partial<Record<"posts" | "engagements" | "views" | "erFollowers" | "erViews", number | null>>;

export type PlatformSummary = PeriodStats & {
  label: string;
  account: string;
  followers: number | null;
  followersDelta: number | null;
  followersGrowth: number | null;
  prev: PeriodStats;
  change: Change;
};

export type Heat = { score: (number | null)[][]; count: number[][] };
export type Insight = { kind: "good" | "warn" | "info"; text: string };

export type AnalysisResult = {
  period: { start: string; end: string; days: number; prevStart: string };
  platforms: Platform[];
  summary: Partial<Record<Platform, PlatformSummary>>;
  total: PeriodStats & { prev: PeriodStats; change: Change };
  daily: {
    dates: string[];
    byPlatform: Partial<Record<Platform, { engagements: number[]; posts: number[]; followers: (number | null)[] }>>;
  };
  media: { platform: Platform; mediaType: MediaType; label: string; count: number;
    avgEngagements: number | null; erViews: number | null; score: number | null }[];
  heatmap: Record<"all" | Platform, Heat | undefined>;
  hashtags: { tag: string; count: number; score: number; platforms: Platform[] }[];
  topPosts: { platform: Platform; date: string; text: string; media: string; permalink: string | null;
    engagements: number; views: number | null; erViews: number | null; score: number }[];
  insights: Insight[];
};

// ---- 小さな統計ヘルパ ---------------------------------------------------------

export function mean(values: Iterable<number | null | undefined>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    sum += v;
    n += 1;
  }
  return n ? sum / n : null;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || !prev) return null;
  return (cur - prev) / prev;
}

/** 指定日時点のフォロワー数（その日以前で最も新しい記録。記録より前なら最初の値） */
export function followerAt(series: Series | undefined, date: string): number | null {
  if (!series || !series.length) return null;
  let found: number | null = null;
  for (const [d, f] of series) {
    if (d <= date) found = f;
    else break;
  }
  return found ?? series[0][1];
}

// ---- 集計 ---------------------------------------------------------------------

export function buildRows(posts: Post[], followers: FollowerSeries, tz = DEFAULT_TZ): Row[] {
  return posts.map((post) => {
    const local = toLocal(post.postedAt, tz);
    const eng = engagementsOf(post.metrics);
    const f = followerAt(followers[post.platform], local.date);
    return {
      post, local, engagements: eng, followers: f,
      erFollowers: f ? eng / f : null,
      erViews: post.metrics.views ? eng / post.metrics.views : null,
      score: 100,
    };
  });
}

/** SNSごとの中央値を基準にパフォーマンス指数を付ける */
export function applyScores(rows: Row[]): void {
  const byPlatform = new Map<Platform, Row[]>();
  for (const r of rows) {
    const list = byPlatform.get(r.post.platform) ?? [];
    list.push(r);
    byPlatform.set(r.post.platform, list);
  }
  for (const items of byPlatform.values()) {
    const engs = items.map((r) => r.engagements);
    const base = median(engs) || mean(engs) || 1;
    for (const r of items) r.score = (r.engagements / base) * 100;
  }
}

function periodStats(rows: Row[]): PeriodStats {
  const views = rows.reduce((s, r) => s + (r.post.metrics.views ?? 0), 0);
  return {
    posts: rows.length,
    engagements: rows.reduce((s, r) => s + r.engagements, 0),
    views: views || null,
    avgEngagements: mean(rows.map((r) => r.engagements)),
    erFollowers: mean(rows.map((r) => r.erFollowers)),
    erViews: mean(rows.map((r) => r.erViews)),
  };
}

const CHANGE_KEYS = ["posts", "engagements", "views", "erFollowers", "erViews"] as const;

export type AnalyzeOptions = { days?: number; end?: string; tz?: string; accountNames?: Partial<Record<Platform, string>> };

export function analyze(posts: Post[], followers: FollowerSeries, opts: AnalyzeOptions = {}): AnalysisResult {
  const tz = opts.tz ?? DEFAULT_TZ;
  const days = opts.days ?? 30;
  const end = opts.end ?? todayIn(tz);
  const start = addDays(end, -(days - 1));
  const prevStart = addDays(start, -days);

  const rowsAll = buildRows(posts, followers, tz);
  const cur = rowsAll.filter((r) => r.local.date >= start && r.local.date <= end);
  const prev = rowsAll.filter((r) => r.local.date >= prevStart && r.local.date < start);
  applyScores(cur);

  const platforms = PLATFORMS.filter((p) => cur.some((r) => r.post.platform === p) || (followers[p]?.length ?? 0) > 0);

  // ---- サマリー ----
  const summary: AnalysisResult["summary"] = {};
  for (const p of platforms) {
    const c = periodStats(cur.filter((r) => r.post.platform === p));
    const pv = periodStats(prev.filter((r) => r.post.platform === p));
    const series = followers[p];
    const fEnd = followerAt(series, end);
    const fStart = followerAt(series, addDays(start, -1));
    summary[p] = {
      label: PLATFORM_LABELS[p],
      account: opts.accountNames?.[p] ?? "",
      followers: fEnd,
      followersDelta: fEnd !== null && fStart !== null ? fEnd - fStart : null,
      followersGrowth: pctChange(fEnd, fStart),
      ...c,
      prev: pv,
      change: Object.fromEntries(CHANGE_KEYS.map((k) => [k, pctChange(c[k], pv[k])])),
    };
  }
  const totalCur = periodStats(cur);
  const totalPrev = periodStats(prev);

  // ---- 日次推移 ----
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const byPlatform: AnalysisResult["daily"]["byPlatform"] = {};
  for (const p of platforms) {
    const eng = new Map<string, number>();
    const cnt = new Map<string, number>();
    for (const r of cur) {
      if (r.post.platform !== p) continue;
      eng.set(r.local.date, (eng.get(r.local.date) ?? 0) + r.engagements);
      cnt.set(r.local.date, (cnt.get(r.local.date) ?? 0) + 1);
    }
    const series = followers[p];
    byPlatform[p] = {
      engagements: dates.map((d) => eng.get(d) ?? 0),
      posts: dates.map((d) => cnt.get(d) ?? 0),
      followers: dates.map((d) => (series?.length && series[0][0] <= d ? followerAt(series, d) : null)),
    };
  }

  // ---- 投稿形式別 ----
  const media: AnalysisResult["media"] = [];
  for (const p of platforms) {
    const groups = new Map<MediaType, Row[]>();
    for (const r of cur) {
      if (r.post.platform !== p) continue;
      const list = groups.get(r.post.mediaType) ?? [];
      list.push(r);
      groups.set(r.post.mediaType, list);
    }
    const entries = [...groups.entries()].sort(
      (a, b) => (mean(b[1].map((x) => x.score)) ?? 0) - (mean(a[1].map((x) => x.score)) ?? 0));
    for (const [mt, items] of entries) {
      media.push({
        platform: p, mediaType: mt, label: MEDIA_LABELS[mt] ?? mt, count: items.length,
        avgEngagements: mean(items.map((x) => x.engagements)),
        erViews: mean(items.map((x) => x.erViews)),
        score: mean(items.map((x) => x.score)),
      });
    }
  }

  // ---- 曜日×時間帯 ----
  const heat = (items: Row[]): Heat => {
    const cells = new Map<string, number[]>();
    for (const r of items) {
      const key = `${r.local.weekday}:${Math.floor(r.local.hour / SLOT_HOURS)}`;
      const list = cells.get(key) ?? [];
      list.push(r.score);
      cells.set(key, list);
    }
    const grid = <T,>(f: (v: number[]) => T) =>
      WEEKDAYS.map((_, w) => SLOTS.map((_, s) => f(cells.get(`${w}:${s}`) ?? [])));
    return { score: grid((v) => mean(v)), count: grid((v) => v.length) };
  };
  const heatmap = { all: heat(cur) } as AnalysisResult["heatmap"];
  for (const p of platforms) heatmap[p] = heat(cur.filter((r) => r.post.platform === p));

  // ---- ハッシュタグ ----
  const tagRows = new Map<string, Row[]>();
  for (const r of cur) {
    const tags = new Set([...r.post.text.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()));
    for (const t of tags) {
      const list = tagRows.get(t) ?? [];
      list.push(r);
      tagRows.set(t, list);
    }
  }
  const hashtags = [...tagRows.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([tag, items]) => ({
      tag, count: items.length, score: mean(items.map((x) => x.score)) ?? 0,
      platforms: PLATFORMS.filter((p) => items.some((x) => x.post.platform === p)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  // ---- 上位投稿 ----
  const topPosts = [...cur].sort((a, b) => b.score - a.score).slice(0, 10).map((r) => ({
    platform: r.post.platform,
    date: `${r.local.date} ${String(r.local.hour).padStart(2, "0")}:${String(r.local.minute).padStart(2, "0")}`,
    text: r.post.text, media: MEDIA_LABELS[r.post.mediaType] ?? r.post.mediaType,
    permalink: r.post.permalink, engagements: r.engagements, views: r.post.metrics.views,
    erViews: r.erViews, score: r.score,
  }));

  const result: AnalysisResult = {
    period: { start, end, days, prevStart },
    platforms,
    summary,
    total: {
      ...totalCur, prev: totalPrev,
      change: Object.fromEntries((["posts", "engagements", "views"] as const).map((k) => [k, pctChange(totalCur[k], totalPrev[k])])),
    },
    daily: { dates, byPlatform },
    media,
    heatmap,
    hashtags,
    topPosts,
    insights: [],
  };
  result.insights = generateInsights(result);
  return result;
}

// ---- 自動コメント ---------------------------------------------------------------

const signed = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toLocaleString("ja-JP")}`;
const fmtPct = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v * 100).toFixed(1)}%`;

/** 数値から読み取れる示唆を文章化する */
export function generateInsights(d: AnalysisResult): Insight[] {
  const out: Insight[] = [];
  const s = d.summary;
  const plats = d.platforms.filter((p) => s[p]);

  const ranked = plats.filter((p) => s[p]!.erFollowers !== null).sort((a, b) => s[b]!.erFollowers! - s[a]!.erFollowers!);
  if (ranked.length >= 2) {
    const best = s[ranked[0]]!;
    const worst = s[ranked[ranked.length - 1]]!;
    out.push({ kind: "good", text:
      `フォロワーあたりの反応が最も高いのは${best.label}（1投稿平均 ${(best.erFollowers! * 100).toFixed(2)}%）。` +
      `最も低い${worst.label}（${(worst.erFollowers! * 100).toFixed(2)}%）とは投稿の役割を分けて考えるのが有効です。` });
  }

  const growth = plats.filter((p) => s[p]!.followersGrowth !== null);
  if (growth.length) {
    const p = growth.reduce((a, b) => (s[b]!.followersGrowth! > s[a]!.followersGrowth! ? b : a));
    const g = s[p]!.followersGrowth!;
    out.push({ kind: g > 0 ? "good" : "warn", text:
      `フォロワーの伸びが最も大きいのは${s[p]!.label}（${signed(s[p]!.followersDelta ?? 0)}人、${fmtPct(g)}）。` });
  }

  for (const p of plats) {
    const x = s[p]!;
    const er = x.change.erFollowers;
    if (er !== null && er !== undefined && er <= -0.2 && x.posts >= MIN_SAMPLES) {
      out.push({ kind: "warn", text:
        `${x.label}のエンゲージメント率が前期間から${fmtPct(er)}と大きく低下しています。投稿形式・時間帯・内容の変化を確認してください。` });
    }
    const pc = x.change.posts;
    if (pc !== null && pc !== undefined && pc <= -0.3) {
      out.push({ kind: "warn", text: `${x.label}の投稿数が前期間の${x.prev.posts}件から${x.posts}件に減っています。` });
    }
  }

  for (const p of d.platforms) {
    const h = d.heatmap[p];
    if (!h) continue;
    let best: [number, number, number, number] | null = null;
    h.score.forEach((row, w) => row.forEach((sc, sl) => {
      const n = h.count[w][sl];
      if (sc !== null && n >= MIN_SAMPLES && (!best || sc > best[0])) best = [sc, w, sl, n];
    }));
    const b = best as [number, number, number, number] | null;
    if (b && b[0] >= 120) {
      out.push({ kind: "info", text:
        `${PLATFORM_LABELS[p]}は${WEEKDAYS[b[1]]}曜 ${SLOTS[b[2]]}の投稿が普段の${(b[0] / 100).toFixed(1)}倍の反応（${b[3]}件）。この枠を優先すると効果的です。` });
    }
  }

  for (const p of d.platforms) {
    const items = d.media.filter((m) => m.platform === p && m.count >= MIN_SAMPLES);
    if (items.length >= 2) {
      const top = items[0];
      const low = items[items.length - 1];
      if (top.score && low.score && top.score / low.score >= 1.3) {
        out.push({ kind: "info", text:
          `${PLATFORM_LABELS[p]}では「${top.label}」が「${low.label}」の${(top.score / low.score).toFixed(1)}倍の反応。形式の配分を見直す余地があります。` });
      }
    }
  }

  const h = d.hashtags[0];
  if (h && h.score >= 110 && h.count >= MIN_SAMPLES) {
    out.push({ kind: "info", text: `ハッシュタグ「#${h.tag}」付きの投稿は平均指数 ${Math.round(h.score)}（${h.count}件）と反応が良好です。` });
  }
  return out;
}
