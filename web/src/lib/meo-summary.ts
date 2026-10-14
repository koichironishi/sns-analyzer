import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * MEO（Googleマップ）の月の結果。同じ Supabase にある MEO の表を読むだけ（書き込まない）。
 * Google の閲覧数・電話の回数は MEO がその都度 Google から取るため、ここでは扱わない（MEO のレポートで見る）
 */
export type MeoMonthly = {
  clientName: string;
  locations: number;
  /** この月に増えた口コミの数と、その平均評価 */
  newReviews: number;
  newAvg: number | null;
  /** 月末時点の口コミの合計と平均評価 */
  totalReviews: number;
  totalAvg: number | null;
  /** まだ返信していない口コミ（今の時点） */
  unreplied: number;
  /** この月に公開した Google の投稿 */
  posts: number;
  /** 検索キーワードの表示回数（この月・上位5件）。MEO の月次の集計がまだなら空 */
  keywords: { keyword: string; impressions: number }[];
};

type Db = SupabaseClient;

export async function meoClients(admin: Db): Promise<{ id: string; name: string }[]> {
  const { data } = await admin.from("clients").select("id,name").order("name");
  return (data ?? []) as { id: string; name: string }[];
}

export async function getMeoLink(admin: Db, snsClientId: string): Promise<string | null> {
  const { data } = await admin.from("sns_clients").select("meo_client_id").eq("id", snsClientId).maybeSingle();
  return (data as { meo_client_id: string | null } | null)?.meo_client_id ?? null;
}

/** start・end は日本時間の日付（YYYY-MM-DD、両端を含む） */
export async function meoMonthly(admin: Db, meoClientId: string, start: string, end: string): Promise<MeoMonthly | null> {
  const { data: c } = await admin.from("clients").select("name").eq("id", meoClientId).maybeSingle();
  if (!c) return null;
  const { data: locs } = await admin.from("locations").select("id").eq("client_id", meoClientId);
  const ids = ((locs ?? []) as { id: string }[]).map((l) => l.id);
  const from = new Date(`${start}T00:00:00+09:00`).toISOString();
  const to = new Date(new Date(`${end}T00:00:00+09:00`).getTime() + 86_400_000).toISOString();
  if (!ids.length) {
    return { clientName: (c as { name: string }).name, locations: 0, newReviews: 0, newAvg: null, totalReviews: 0, totalAvg: null, unreplied: 0, posts: 0, keywords: [] };
  }
  const [reviews, posts, kws] = await Promise.all([
    admin.from("reviews").select("rating,reply_status,review_created_at").in("location_id", ids).limit(10000),
    admin.from("posts").select("id", { count: "exact", head: true }).in("location_id", ids).eq("status", "published").gte("published_at", from).lt("published_at", to),
    admin.from("keywords_monthly").select("keyword,impressions").in("location_id", ids).eq("month", `${start.slice(0, 7)}-01`),
  ]);
  const rows = (reviews.data ?? []) as { rating: number; reply_status: string; review_created_at: string | null }[];
  const upToEnd = rows.filter((r) => !r.review_created_at || r.review_created_at < to);
  const inMonth = rows.filter((r) => r.review_created_at && r.review_created_at >= from && r.review_created_at < to);
  const avg = (xs: { rating: number }[]) => (xs.length ? Math.round((xs.reduce((s, r) => s + r.rating, 0) / xs.length) * 100) / 100 : null);
  const kw = new Map<string, number>();
  for (const k of (kws.data ?? []) as { keyword: string; impressions: number }[]) kw.set(k.keyword, (kw.get(k.keyword) ?? 0) + k.impressions);
  return {
    clientName: (c as { name: string }).name,
    locations: ids.length,
    newReviews: inMonth.length, newAvg: avg(inMonth),
    totalReviews: upToEnd.length, totalAvg: avg(upToEnd),
    unreplied: rows.filter((r) => r.reply_status !== "replied").length,
    posts: posts.count ?? 0,
    keywords: [...kw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([keyword, impressions]) => ({ keyword, impressions })),
  };
}
