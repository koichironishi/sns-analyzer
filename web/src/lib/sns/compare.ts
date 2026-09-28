/**
 * 競合アカウントとの比較（Python 版 snsanalyzer/compare.py の移植）。
 *
 * 競合については公開されている数値しか取れないため、自社も同じ条件
 * （＝「公開エンゲージメント」）にそろえて比較する。
 *   Instagram : いいね + コメント（シェア・保存は非公開）
 *   Facebook  : リアクション + コメント + シェア
 *   Threads   : いいね + 返信 + リポスト + 引用
 *   X         : いいね + 返信 + リポスト + 引用
 */
import { HASHTAG_RE, SLOT_HOURS, WEEKDAYS, followerAt, mean, median, type Insight } from "./analysis.ts";
import {
  DEFAULT_TZ, MEDIA_LABELS, PLATFORM_LABELS, PLATFORMS, addDays, todayIn, toLocal,
  type FollowerSeries, type Metrics, type Platform, type Post, type Series,
} from "./models.ts";

const PUBLIC_FIELDS: Record<Platform, (keyof Metrics)[]> = {
  instagram: ["likes", "comments"],
  facebook: ["likes", "comments", "shares"],
  threads: ["likes", "comments", "shares", "quotes"],
  x: ["likes", "comments", "shares", "quotes"],
};

export const PUBLIC_LABEL: Record<Platform, string> = {
  instagram: "いいね＋コメント",
  facebook: "リアクション＋コメント＋シェア",
  threads: "いいね＋返信＋リポスト＋引用",
  x: "いいね＋返信＋リポスト＋引用",
};

export const OWN = "自社";

export const publicEng = (p: Post): number =>
  PUBLIC_FIELDS[p.platform].reduce((s, k) => s + ((p.metrics[k] as number | null) ?? 0), 0);

type RankKey = "erFollowers" | "followers" | "postsPerWeek" | "followersGrowth";

export type AccountStats = {
  name: string;
  isOwn: boolean;
  username: string;
  followers: number | null;
  followersDelta: number | null;
  followersGrowth: number | null;
  posts: number;
  hasPosts: boolean;
  postsPerWeek: number | null;
  avgEng: number | null;
  medianEng: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  erFollowers: number | null;
  mediaMix: Array<[string, number]>; // [形式名, 割合] 多い順
  bestType: string | null;
  topTags: string[];
  topSlot: string | null;
  rank: Partial<Record<RankKey, [number, number]>>;
};

export type CompetitorAccount = {
  id: string;
  platform: Platform;
  competitorName: string;
  username: string;
  series: Series;
  posts: Post[];
};

export type CompareResult = {
  period: { start: string; end: string; days: number };
  platforms: Partial<Record<Platform, { label: string; metricLabel: string; rows: AccountStats[] }>>;
  topPosts: CompetitorPost[];
  allPosts: CompetitorPost[];
  insights: Insight[];
};

export type CompetitorPost = {
  competitor: string; platform: Platform; date: string; media: string; text: string;
  permalink: string | null; engagements: number; erFollowers: number | null;
};

function mostCommon<T>(items: T[]): Array<[T, number]> {
  const m = new Map<T, number>();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  // 同数は先に出てきた順（Python の Counter.most_common と同じ）
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function accountStats(name: string, isOwn: boolean, username: string, posts: Post[], series: Series,
  tz: string, start: string, end: string, days: number): AccountStats {
  const cur = posts.filter((p) => {
    const d = toLocal(p.postedAt, tz).date;
    return d >= start && d <= end;
  });
  const before = addDays(start, -1);
  const fEnd = series.length ? followerAt(series, end) : null;
  const fStart = series.length && series[0][0] <= before ? followerAt(series, before) : null;
  const engs = cur.map(publicEng);
  const avg = mean(engs);
  const byType = new Map<string, number[]>();
  for (const p of cur) {
    const list = byType.get(p.mediaType) ?? [];
    list.push(publicEng(p));
    byType.set(p.mediaType, list);
  }
  let bestType: string | null = null;
  let bestAvg = -Infinity;
  for (const [t, v] of byType) {
    const a = mean(v) ?? 0;
    if (v.length >= 2 && a > bestAvg) { bestAvg = a; bestType = t; }
  }
  const tags = mostCommon(cur.flatMap((p) => [...new Set([...p.text.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()))]));
  const slots = mostCommon(cur.map((p) => {
    const l = toLocal(p.postedAt, tz);
    return `${WEEKDAYS[l.weekday]}曜 ${Math.floor(l.hour / SLOT_HOURS) * SLOT_HOURS}時台`;
  }));
  return {
    name, isOwn, username,
    followers: fEnd,
    followersDelta: fEnd !== null && fStart !== null ? fEnd - fStart : null,
    followersGrowth: fEnd && fStart ? (fEnd - fStart) / fStart : null,
    posts: cur.length,
    hasPosts: posts.length > 0,
    postsPerWeek: posts.length ? (cur.length / days) * 7 : null,
    avgEng: avg,
    medianEng: engs.length ? median(engs) : null,
    avgLikes: mean(cur.map((p) => p.metrics.likes)),
    avgComments: mean(cur.map((p) => p.metrics.comments)),
    erFollowers: avg !== null && fEnd ? avg / fEnd : null,
    mediaMix: cur.length ? mostCommon(cur.map((p) => p.mediaType)).map(([t, n]) => [MEDIA_LABELS[t] ?? t, n / cur.length]) : [],
    bestType: bestType ? MEDIA_LABELS[bestType as keyof typeof MEDIA_LABELS] ?? bestType : null,
    topTags: tags.slice(0, 3).map(([t]) => t),
    topSlot: slots[0]?.[0] ?? null,
    rank: {},
  };
}

export type CompareOptions = { days?: number; end?: string; tz?: string; ownNames?: Partial<Record<Platform, string>> };

export function compare(ownPosts: Post[], ownFollowers: FollowerSeries, competitors: CompetitorAccount[],
  opts: CompareOptions = {}): CompareResult {
  const tz = opts.tz ?? DEFAULT_TZ;
  const days = opts.days ?? 30;
  const end = opts.end ?? todayIn(tz);
  const start = addDays(end, -(days - 1));

  // 同じ競合・同じSNSのアカウントが複数ある場合（API取得分と手動記録分など）はまとめる
  const grouped = new Map<string, CompetitorAccount[]>();
  for (const a of competitors) {
    const key = `${a.platform}\u0000${a.competitorName}`;
    grouped.set(key, [...(grouped.get(key) ?? []), a]);
  }

  const platforms: CompareResult["platforms"] = {};
  for (const platform of PLATFORMS) {
    const rows: AccountStats[] = [];
    const ownP = ownPosts.filter((p) => p.platform === platform);
    const ownSeries = ownFollowers[platform] ?? [];
    if (ownP.length || ownSeries.length) {
      rows.push(accountStats(OWN, true, opts.ownNames?.[platform] ?? "", ownP, ownSeries, tz, start, end, days));
    }
    const keys = [...grouped.keys()].filter((k) => k.startsWith(`${platform}\u0000`)).sort();
    for (const key of keys) {
      const accts = grouped.get(key)!;
      const posts = accts.flatMap((a) => a.posts);
      const series = accts.find((a) => a.series.length)?.series ?? [];
      if (!posts.length && !series.length) continue;
      rows.push(accountStats(accts[0].competitorName, false, accts.find((a) => a.username)?.username ?? "",
        posts, series, tz, start, end, days));
    }
    if (rows.length < 2 || !rows.some((r) => !r.isOwn)) continue;
    for (const key of ["erFollowers", "followers", "postsPerWeek", "followersGrowth"] as RankKey[]) {
      const ranked = rows.filter((r) => r[key] !== null).sort((a, b) => (b[key] as number) - (a[key] as number));
      ranked.forEach((r, i) => { r.rank[key] = [i + 1, ranked.length]; });
    }
    platforms[platform] = { label: PLATFORM_LABELS[platform], metricLabel: PUBLIC_LABEL[platform], rows };
  }

  const allPosts: CompetitorPost[] = [];
  for (const a of competitors) {
    for (const p of a.posts) {
      const l = toLocal(p.postedAt, tz);
      if (l.date < start || l.date > end) continue;
      const f = followerAt(a.series, l.date);
      const eng = publicEng(p);
      allPosts.push({
        competitor: a.competitorName, platform: p.platform,
        date: `${l.date} ${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`,
        media: MEDIA_LABELS[p.mediaType] ?? p.mediaType, text: p.text, permalink: p.permalink,
        engagements: eng, erFollowers: f ? eng / f : null,
      });
    }
  }
  allPosts.sort((a, b) => (b.erFollowers ?? 0) - (a.erFollowers ?? 0));

  const result: CompareResult = { period: { start, end, days }, platforms, topPosts: allPosts.slice(0, 10), allPosts, insights: [] };
  result.insights = compareInsights(result);
  return result;
}

const pct1 = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v * 100).toFixed(1)}%`;

export function compareInsights(c: CompareResult): Insight[] {
  const out: Insight[] = [];
  for (const blk of Object.values(c.platforms)) {
    if (!blk) continue;
    const own = blk.rows.find((r) => r.isOwn);
    const comps = blk.rows.filter((r) => !r.isOwn);
    if (!own || !comps.length) continue;
    const label = blk.label;
    const compEr = comps.map((r) => r.erFollowers).filter((v): v is number => v !== null);
    if (own.erFollowers !== null && compEr.length && own.rank.erFollowers) {
      const ratio = own.erFollowers / (mean(compEr) as number);
      const [rank, n] = own.rank.erFollowers;
      const kind = ratio >= 1.1 ? "good" : ratio <= 0.9 ? "warn" : "info";
      out.push({ kind, text: `${label}のフォロワーあたり反応は競合平均の${ratio.toFixed(1)}倍（${n}アカウント中${rank}位）。` });
    }
    const freq = comps.filter((r) => r.postsPerWeek !== null);
    if (own.postsPerWeek !== null && freq.length) {
      const top = freq.reduce((a, b) => (b.postsPerWeek! > a.postsPerWeek! ? b : a));
      if (top.postsPerWeek! >= own.postsPerWeek * 1.5 && top.postsPerWeek! >= 1) {
        out.push({ kind: "info", text:
          `${label}では${top.name}が週${top.postsPerWeek!.toFixed(1)}本投稿（自社は週${own.postsPerWeek.toFixed(1)}本）。投稿量の差が露出差につながっている可能性があります。` });
      }
    }
    const grow = comps.filter((r) => r.followersGrowth !== null);
    if (own.followersGrowth !== null && grow.length) {
      const top = grow.reduce((a, b) => (b.followersGrowth! > a.followersGrowth! ? b : a));
      if (top.followersGrowth! > own.followersGrowth) {
        out.push({ kind: "warn", text:
          `${label}のフォロワー増加率は${top.name}（${pct1(top.followersGrowth!)}）が自社（${pct1(own.followersGrowth)}）を上回っています。` });
      }
    }
    for (const r of comps) {
      if (!r.bestType || !r.mediaMix.length) continue;
      const share = r.mediaMix.find(([t]) => t === r.bestType)?.[1] ?? 0;
      if (share >= 0.5 && r.bestType !== own.bestType) {
        out.push({ kind: "info", text:
          `${r.name}（${label}）は「${r.bestType}」が投稿の${Math.round(share * 100)}%を占め、反応も最も高い形式です。` });
      }
    }
  }
  return out;
}
