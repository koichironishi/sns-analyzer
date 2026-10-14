/**
 * アカウント全体のインサイト（日別の指標とフォロワーの属性）。Facebook ページと Instagram のみ。
 *
 * 投稿ごとの指標（collect）とは別に取得する。指標の提供状況は API の版で変わるため、
 * 1指標ずつ問い合わせ、取得できない指標は飛ばす（ほかの指標の取得は止めない）。
 */
import { addDays } from "../models.ts";
import { ApiError, num, parseTime, type HttpClient } from "./http.ts";

/** 画面で使う指標の名前（SNSごとの API の指標名をこの名前にそろえて保存する） */
export const INSIGHT_METRICS = ["views", "viewers", "interactions", "visits", "link_clicks", "follows", "unfollows", "video_views", "engaged"] as const;
export type InsightMetric = (typeof INSIGHT_METRICS)[number];

export type DailyValue = { date: string; metric: InsightMetric; value: number };

/** フォロワーの属性。性別は F（女性）/ M（男性）/ U（不明） */
export type Audience = {
  genderAge?: Record<string, Record<string, number>>;
  city?: Record<string, number>;
  country?: Record<string, number>;
};

export type InsightsRequest = {
  /** 取得する期間（日本時間の日付。両端を含む） */
  start: string;
  end: string;
  /** すでに保存済みの日（Instagram の1日ずつ問い合わせる指標で、取り直しを省くため） */
  have: Set<string>;
  /** この時刻（ms）を過ぎたら打ち切る */
  deadline: number;
};

export type InsightsResult = { daily: DailyValue[]; audience: Audience | null; warnings: string[] };

const unix = (date: string) => Math.floor(Date.parse(`${date}T00:00:00+09:00`) / 1000);

/** 日別の値の end_time（その日の終わり＝翌日の0時）を、その日の日付にする */
export const endTimeToDate = (endTime: string) => addDays(parseTime(endTime).slice(0, 10), -1);

/** 存在しない・提供終了した指標のエラーか（このときは飛ばして続ける） */
const isMetricError = (e: unknown) => e instanceof ApiError && (e.status === 400 || e.status === 403);

type InsightItem = { name?: string; values?: { value?: unknown; end_time?: string }[]; total_value?: { value?: unknown; breakdowns?: { dimension_keys?: string[]; results?: { dimension_values?: string[]; value?: unknown }[] }[] } };
type InsightResp = { data?: InsightItem[] };

/** 期間を最大 n 日ずつに分ける（API の期間の上限のため） */
function ranges(start: string, end: string, n: number): [string, string][] {
  const out: [string, string][] = [];
  for (let s = start; s <= end; s = addDays(s, n)) {
    const e = addDays(s, n - 1);
    out.push([s, e < end ? e : end]);
  }
  return out;
}

/** period=day の時系列（values）を日付ごとの値にする */
async function timeSeries(http: HttpClient, path: string, apiMetric: string, metric: InsightMetric, req: InsightsRequest, maxDays: number): Promise<DailyValue[]> {
  const out: DailyValue[] = [];
  for (const [s, e] of ranges(req.start, req.end, maxDays)) {
    if (Date.now() > req.deadline) break;
    const r = await http.get<InsightResp>(path, { metric: apiMetric, period: "day", since: unix(s), until: unix(addDays(e, 1)) });
    for (const v of r.data?.[0]?.values ?? []) {
      const value = num(v.value);
      if (value === null || !v.end_time) continue;
      const date = endTimeToDate(v.end_time);
      if (date >= req.start && date <= req.end) out.push({ date, metric, value });
    }
  }
  return out;
}

// ---- Facebook ページ ----------------------------------------------------------------------------

/** 画面の指標名 → Facebook ページの指標名 */
export const FB_DAILY: [InsightMetric, string][] = [
  ["views", "page_media_view"],
  ["viewers", "page_total_media_view_unique"],
  ["interactions", "page_post_engagements"],
  ["visits", "page_views_total"],
  ["follows", "page_daily_follows_unique"],
  ["unfollows", "page_daily_unfollows_unique"],
  ["video_views", "page_video_views"],
];

export async function facebookInsights(http: HttpClient, pageId: string, req: InsightsRequest): Promise<InsightsResult> {
  const daily: DailyValue[] = [];
  const missing: string[] = [];
  for (const [metric, apiMetric] of FB_DAILY) {
    if (Date.now() > req.deadline) break;
    try {
      daily.push(...await timeSeries(http, `${pageId}/insights`, apiMetric, metric, req, 90));
    } catch (e) {
      if (!isMetricError(e)) throw e;
      missing.push(apiMetric);
    }
  }
  // 属性は市区町村・国のみ（性別・年齢は API で提供されていない）。提供終了していれば何も返らない
  const audience: Audience = {};
  for (const [key, names] of [["city", ["page_follows_city", "page_fans_city"]], ["country", ["page_follows_country", "page_fans_country"]]] as const) {
    for (const name of names) {
      if (Date.now() > req.deadline) break;
      try {
        const r = await http.get<InsightResp>(`${pageId}/insights`, { metric: name, period: "day" });
        const vals = r.data?.[0]?.values ?? [];
        const last = vals[vals.length - 1]?.value;
        if (last && typeof last === "object") {
          audience[key] = countsOf(last as Record<string, unknown>);
          break;
        }
      } catch (e) {
        if (!isMetricError(e)) throw e;
      }
    }
  }
  const warnings = missing.length === FB_DAILY.length ? ["ページのインサイトを取得できませんでした（read_insights の権限をご確認ください）"] : [];
  return { daily, audience: Object.keys(audience).length ? audience : null, warnings };
}

const countsOf = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, num(v) ?? 0]).filter(([, v]) => (v as number) > 0)) as Record<string, number>;

// ---- Instagram ---------------------------------------------------------------------------------

/** 1日ごとの合計（total_value）で取る指標。時系列で取れないため、1日ずつ問い合わせる */
export const IG_TOTAL: [InsightMetric, string][] = [
  ["views", "views"],
  ["interactions", "total_interactions"],
  ["link_clicks", "profile_links_taps"],
  ["engaged", "accounts_engaged"],
];
/** 1回の収集でさかのぼる日数の上限（1日1回の問い合わせになるため、数日かけて埋める） */
const IG_DAYS_PER_RUN = 14;

export async function instagramInsights(http: HttpClient, userId: string, req: InsightsRequest): Promise<InsightsResult> {
  const path = `${userId}/insights`;
  const daily: DailyValue[] = [];
  const warnings: string[] = [];

  // リーチ（時系列で取れる。期間は30日まで）
  try {
    daily.push(...await timeSeries(http, path, "reach", "viewers", req, 30));
  } catch (e) {
    if (!isMetricError(e)) throw e;
    warnings.push(`リーチを取得できませんでした（${(e as ApiError).message}）`);
  }
  // 新しいフォロワー（直近30日だけ・フォロワー100人以上のアカウントのみ）
  try {
    const recent = { ...req, start: req.start > addDays(req.end, -29) ? req.start : addDays(req.end, -29) };
    daily.push(...await timeSeries(http, path, "follower_count", "follows", recent, 30));
  } catch (e) {
    if (!isMetricError(e)) throw e;
  }

  // 閲覧数・インタラクションなどは1日ずつ（新しい日から。保存済みの日は、直近2日を除いて取り直さない）
  const recentEdge = addDays(req.end, -1);
  let wanted = IG_TOTAL.map(([, m]) => m);
  let fetched = 0;
  for (let d = req.end; d >= req.start && fetched < IG_DAYS_PER_RUN; d = addDays(d, -1)) {
    if (Date.now() > req.deadline) break;
    if (req.have.has(d) && d < recentEdge) continue;
    let r: InsightResp;
    try {
      r = await http.get<InsightResp>(path, { metric: wanted.join(","), metric_type: "total_value", period: "day", since: unix(d), until: unix(addDays(d, 1)) });
    } catch (e) {
      if (!isMetricError(e) || wanted.length === 1) throw e;
      // 提供されていない指標がある。1つずつ確かめて、取れるものだけにする
      const ok: string[] = [];
      for (const m of wanted) {
        try {
          await http.get(path, { metric: m, metric_type: "total_value", period: "day", since: unix(d), until: unix(addDays(d, 1)) });
          ok.push(m);
        } catch (e2) {
          if (!isMetricError(e2)) throw e2;
        }
      }
      if (!ok.length) { warnings.push("閲覧数などのインサイトを取得できませんでした"); break; }
      wanted = ok;
      d = addDays(d, 1); // 同じ日をもう一度
      continue;
    }
    fetched++;
    for (const item of r.data ?? []) {
      const pair = IG_TOTAL.find(([, m]) => m === item.name);
      const value = num(item.total_value?.value);
      if (pair && value !== null) daily.push({ date: d, metric: pair[0], value });
    }
  }

  return { daily, audience: await instagramAudience(http, path, req), warnings };
}

async function instagramAudience(http: HttpClient, path: string, req: InsightsRequest): Promise<Audience | null> {
  const get = async (breakdown: string) => {
    if (Date.now() > req.deadline) return [];
    try {
      const r = await http.get<InsightResp>(path, { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", timeframe: "this_month", breakdown });
      const b = r.data?.[0]?.total_value?.breakdowns?.[0];
      const keys = b?.dimension_keys ?? breakdown.split(",");
      // 次元の並びは応答の dimension_keys に従う（要求した順と同じとは限らない）
      return (b?.results ?? []).map((x) => ({ dims: Object.fromEntries(keys.map((k, i) => [k, x.dimension_values?.[i] ?? ""])), value: num(x.value) }));
    } catch (e) {
      // フォロワー100人未満などで提供されない
      if (!isMetricError(e)) throw e;
      return [];
    }
  };
  const audience: Audience = {};
  const ga: Record<string, Record<string, number>> = {};
  for (const x of await get("gender,age")) {
    const { gender: g, age } = x.dims;
    if (!g || !age || x.value === null) continue;
    (ga[g] ??= {})[age] = x.value;
  }
  if (Object.keys(ga).length) audience.genderAge = ga;
  for (const key of ["city", "country"] as const) {
    const rows = await get(key);
    if (rows.length) audience[key] = Object.fromEntries(rows.map((x) => [x.dims[key] ?? "", x.value ?? 0]).filter(([k, v]) => k && (v as number) > 0));
  }
  return Object.keys(audience).length ? audience : null;
}
