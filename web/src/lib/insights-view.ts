import "server-only";
import { cache } from "react";
import { reportFromSearch, type Report } from "@/lib/report";
import { createClient } from "@/lib/supabase/server";
import { addDays, engagementsOf, isPlatform, type Platform, type Post } from "@/lib/sns/models";
import { latestAudience, loadInsights, type InsightRow } from "@/lib/sns/store";
import type { Audience, InsightMetric } from "@/lib/sns/collectors/insights";

/** インサイトを表示できる SNS（アカウント全体の指標を API で取れるもの） */
export const INSIGHT_PLATFORMS: Platform[] = ["instagram", "facebook"];

type SP = Record<string, string | string[] | undefined>;

/** 期間内の日付（両端を含む） */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export type InsightsBase = {
  report: Report;
  /** 表示中の SNS（インサイトに対応する SNS がなければ null） */
  platform: Platform | null;
  platforms: Platform[];
  /** 表示中のアカウント（同じSNSに複数あるとき。null はそのSNSの合計） */
  acct: string | null;
};

/** 期間・SNS の選択。インサイトには「すべて」がないため、指定がなければ Instagram → Facebook の順で選ぶ */
export const insightsBase = cache(async (clientId: string, sp: SP): Promise<InsightsBase> => {
  const report = await reportFromSearch(clientId, sp);
  const platforms = INSIGHT_PLATFORMS.filter((p) => report.platforms.includes(p));
  const want = Array.isArray(sp.sns) ? sp.sns[0] : sp.sns;
  const platform = isPlatform(want) && platforms.includes(want) ? want : platforms[0] ?? null;
  return { report, platform, platforms, acct: platform && report.period.sns === platform ? report.period.acct : null };
});

// ---- 結果（日別の指標のカード） --------------------------------------------------------------------

export type MetricCard = {
  key: string;
  title: string;
  /** 見出しの数字の意味（合計・1日平均） */
  how: "sum" | "avg";
  note?: string;
  total: number | null;
  prev: number | null;
  daily: (number | null)[];
  /** カードの下に添える補足の数字 */
  extra?: { label: string; value: number | null }[];
};

type CardDef = { metric: InsightMetric | "post_clicks"; title: string; how: "sum" | "avg"; note?: string };

const CARDS: Record<"facebook" | "instagram", CardDef[]> = {
  facebook: [
    { metric: "views", title: "閲覧数", how: "sum", note: "コンテンツが表示された回数" },
    { metric: "viewers", title: "閲覧者", how: "avg", note: "コンテンツを見た人数。Meta の画面の「期間の合計人数」とは数え方が違います" },
    { metric: "interactions", title: "コンテンツでのインタラクション", how: "sum", note: "リアクション・コメント・シェアなど" },
    { metric: "visits", title: "アクセス", how: "sum", note: "Facebookページが見られた回数" },
    { metric: "post_clicks", title: "リンククリック", how: "sum", note: "投稿のクリック数の合計（投稿日で集計）" },
    { metric: "video_views", title: "3秒再生数", how: "sum", note: "動画が3秒以上再生された回数" },
    { metric: "follows", title: "フォロー", how: "sum", note: "新しくフォローした人数" },
  ],
  instagram: [
    { metric: "views", title: "閲覧数", how: "sum", note: "コンテンツが表示された回数" },
    { metric: "viewers", title: "リーチ", how: "avg", note: "コンテンツを見たアカウント数。Meta の画面の「期間の合計」とは数え方が違います" },
    { metric: "interactions", title: "コンテンツでのインタラクション", how: "sum", note: "いいね・コメント・保存・シェアなど" },
    { metric: "engaged", title: "反応したアカウント", how: "avg", note: "反応したアカウント数。Meta の画面の「期間の合計」とは数え方が違います" },
    { metric: "link_clicks", title: "プロフィールのリンクのタップ", how: "sum", note: "プロフィールのリンク・ボタンが押された回数" },
    { metric: "follows", title: "フォロー", how: "sum", note: "新しいフォロワー（直近30日のみ。フォロワー100人以上のアカウント）" },
  ],
};

function summarize(values: (number | null)[], how: "sum" | "avg"): number | null {
  const have = values.filter((v): v is number => v !== null);
  if (!have.length) return null;
  const sum = have.reduce((s, v) => s + v, 0);
  return how === "sum" ? sum : sum / have.length;
}

/** 投稿のクリック数を投稿日ごとに合計する（Facebook にはページ全体のリンククリックの指標がないため） */
function clicksByDate(posts: Post[], dates: string[]): (number | null)[] {
  const map = new Map<string, number>();
  let any = false;
  for (const p of posts) {
    if (p.metrics.clicks === null) continue;
    any = true;
    const d = new Date(p.postedAt).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    map.set(d, (map.get(d) ?? 0) + p.metrics.clicks);
  }
  return any ? dates.map((d) => map.get(d) ?? 0) : dates.map(() => null);
}

export async function resultCards(clientId: string, base: InsightsBase): Promise<{ dates: string[]; cards: MetricCard[]; hasData: boolean }> {
  const { report, platform, acct } = base;
  const { start, end, days } = report.analysis.period;
  const dates = datesBetween(start, end);
  if (platform !== "facebook" && platform !== "instagram") return { dates, cards: [], hasData: false };
  const prevStart = addDays(start, -days);
  // アカウントを選んでいればそのアカウントだけ、なければそのSNSの全アカウントの合計
  const rows = (await loadInsights(await createClient(), clientId, platform, prevStart, end)).filter((r) => !acct || r.account_id === acct);
  const series = (metric: InsightMetric, ds: string[]) => {
    const m = new Map<string, number>();
    for (const r of rows.filter((x: InsightRow) => x.metric === metric)) m.set(r.date, (m.get(r.date) ?? 0) + Number(r.value));
    return ds.map((d) => m.get(d) ?? null);
  };
  const prevDates = datesBetween(prevStart, addDays(start, -1));
  const posts = report.data.ownPosts.filter((p) => p.platform === platform && (!acct || p.accountId === acct));
  const cards = CARDS[platform].map((c): MetricCard => {
    if (c.metric === "post_clicks") {
      const daily = clicksByDate(posts, dates);
      return { key: c.metric, title: c.title, how: c.how, note: c.note, daily, total: summarize(daily, "sum"), prev: null };
    }
    const daily = series(c.metric, dates);
    const card: MetricCard = {
      key: c.metric, title: c.title, how: c.how, note: c.note, daily,
      total: summarize(daily, c.how), prev: summarize(series(c.metric, prevDates), c.how),
    };
    if (platform === "facebook" && c.metric === "follows") {
      const un = summarize(series("unfollows", dates), "sum");
      card.extra = [{ label: "フォローをやめた数", value: un }, { label: "純増", value: card.total !== null && un !== null ? card.total - un : null }];
    }
    return card;
  });
  return { dates, cards, hasData: rows.some((r) => r.date >= start) };
}

// ---- コンテンツ（形式別の内訳） ---------------------------------------------------------------------

export type FormatRow = { key: string; label: string; count: number; views: number | null; interactions: number };

const FORMAT_LABELS: Record<string, string> = {
  image: "写真", carousel: "複数の写真", video: "動画", reel: "リール", link: "リンク", text: "テキスト", other: "その他", story: "ストーリーズ",
};

export function contentBreakdown(base: InsightsBase) {
  const { report, platform, acct } = base;
  const all = [...report.data.ownPosts, ...report.data.ownStories].filter((p) => p.platform === platform && (!acct || p.accountId === acct));
  const rows = new Map<string, FormatRow>();
  for (const p of all) {
    const key = p.contentType === "story" ? "story" : p.mediaType;
    const row = rows.get(key) ?? { key, label: FORMAT_LABELS[key] ?? key, count: 0, views: null, interactions: 0 };
    row.count++;
    if (p.metrics.views !== null) row.views = (row.views ?? 0) + p.metrics.views;
    row.interactions += engagementsOf(p.metrics);
    rows.set(key, row);
  }
  const list = [...rows.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0) || b.count - a.count);
  // フォロワーからの閲覧（取得できる SNS のみ。Facebook）
  const withFollower = all.filter((p) => p.followerViews !== null && p.followerViews !== undefined && p.metrics.views !== null);
  const fv = withFollower.reduce((s, p) => s + (p.followerViews ?? 0), 0);
  const tv = withFollower.reduce((s, p) => s + (p.metrics.views ?? 0), 0);
  return {
    rows: list,
    totals: {
      count: all.length,
      views: list.some((r) => r.views !== null) ? list.reduce((s, r) => s + (r.views ?? 0), 0) : null,
      interactions: list.reduce((s, r) => s + r.interactions, 0),
    },
    followerShare: tv > 0 ? { followers: fv / tv, others: 1 - fv / tv } : null,
  };
}

// ---- オーディエンス（フォロワーの属性） -------------------------------------------------------------

export const AGE_ORDER = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
export const GENDER_LABELS: Record<string, string> = { F: "女性", M: "男性", U: "不明" };

/**
 * フォロワーの属性はアカウントごと（合計できない）。同じSNSに複数アカウントがあり、選ばれていなければ最初のアカウントを出す
 */
export async function audienceView(base: InsightsBase): Promise<{ date: string; data: Audience; account: string | null } | null> {
  const { report, platform } = base;
  if (!platform) return null;
  const list = report.accounts.filter((a) => a.platform === platform);
  const acct = base.acct ?? (list.length > 1 ? list[0].id : null);
  const r = await latestAudience(await createClient(), report.client.id, platform, acct);
  return r ? { ...r, account: acct } : null;
}

/** 国コード（JP など）を日本語の国名にする */
export function countryName(code: string): string {
  try {
    return /^[A-Z]{2}$/.test(code) ? new Intl.DisplayNames(["ja"], { type: "region" }).of(code) ?? code : code;
  } catch {
    return code;
  }
}

/** 値の大きい順に上位 n 件と、全体に占める割合 */
export function topShare(counts: Record<string, number> | undefined, n = 10) {
  const entries = Object.entries(counts ?? {}).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return entries.sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, value]) => ({ key, value, share: total ? value / total : 0 }));
}
