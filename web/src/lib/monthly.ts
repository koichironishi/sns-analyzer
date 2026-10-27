import "server-only";
import { getReport, type Report } from "@/lib/report";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMeoLink, meoMonthly, type MeoMonthly } from "@/lib/meo-summary";
import { latestAudience, type StoredAi } from "@/lib/sns/store";
import { ageShares, onlineSummary } from "@/lib/insights-view";
import { addDays, todayIn, PLATFORM_LABELS, type Platform } from "@/lib/sns/models";
import type { PlatformSummary } from "@/lib/sns/analysis";
import { PRIORITY_LABELS, platformLabel } from "@/lib/sns/ai";
import { fmtNum, fmtPct, fmtSigned, slash, truncate } from "@/lib/format";

/** 月次レポートの対象月（YYYY-MM）。指定がなければ先月。今月は今日までの途中経過 */
export function parseMonth(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  const thisMonth = todayIn().slice(0, 7);
  if (s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && s <= thisMonth && s >= "2024-01") return s;
  return addDays(`${thisMonth}-01`, -1).slice(0, 7);
}

export const monthLabel = (m: string) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;

/** 直近12か月（新しい順） */
export function recentMonths(n = 12): string[] {
  const out: string[] = [];
  let d = `${todayIn().slice(0, 7)}-01`;
  for (let i = 0; i < n; i++) {
    out.push(d.slice(0, 7));
    d = `${addDays(d, -1).slice(0, 7)}-01`;
  }
  return out;
}

/** その月の1日〜末日（今月なら今日まで）。前期間は同じ日数だけさかのぼる（前月とほぼ同じ） */
export function monthRange(month: string): { start: string; end: string; days: number; partial: boolean } {
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const today = todayIn();
  const end = last > today ? today : last;
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  return { start, end, days, partial: end !== last };
}

/**
 * 月次レポートのデータ。AI分析は「最新の1件」ではなく、この月を対象に実行したもの（期間の終わりがこの月の中）を載せる
 * （月初に自動で実行したあと、別の期間で画面から実行しても、月次レポートの内容が変わらないように）
 */
export async function monthlyReport(clientId: string, month: string): Promise<Report> {
  const { start, end, days } = monthRange(month);
  const r = await getReport(clientId, days, end);
  const q = (await createClient()).from("sns_ai_results").select("id,period_end,days,result,model,created_at,created_by")
    .eq("client_id", clientId).gte("period_end", start).lte("period_end", end).order("created_at", { ascending: false }).limit(1);
  const { data } = await q.maybeSingle();
  return { ...r, ai: (data as StoredAi | null) ?? null };
}

/** AI分析の作り方の説明（「2026/11/01 月初に自動で作成」「2026/10/20 スタッフが作成」） */
export function aiMadeBy(ai: StoredAi | null): string | null {
  if (!ai) return null;
  const at = new Date(ai.created_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
  return `${at} ${ai.created_by ? "スタッフが作成" : "月初に自動で作成"}`;
}

export type AccountBreakdown = { id: string; name: string; summary: PlatformSummary; followers: (number | null)[] };

/**
 * 同じSNSに複数のアカウントがあるときの、アカウントごとの結果（「本店」「支店」それぞれの報告のため）。
 * 1アカウントだけのSNSは含めない
 */
export async function monthlyAccounts(r: Report, month: string): Promise<Partial<Record<Platform, AccountBreakdown[]>>> {
  const { days, end } = monthRange(month);
  const out: Partial<Record<Platform, AccountBreakdown[]>> = {};
  for (const p of r.analysis.platforms) {
    const list = r.accounts.filter((a) => a.platform === p);
    if (list.length < 2) continue;
    out[p] = (await Promise.all(list.map(async (a) => {
      const one = await getReport(r.client.id, days, end, p, a.id);
      const s = one.analysis.summary[p];
      return s ? { id: a.id, name: a.name, summary: s, followers: one.analysis.daily.byPlatform[p]?.followers ?? [] } : null;
    }))).filter((x): x is AccountBreakdown => x !== null);
  }
  return out;
}

export type MonthlyAudience = { account: string; peaks: number[]; days: number; followerAges: [string, number][]; engagedAges: [string, number][] };

/**
 * Instagram の「見られている時間と年代」（最新の集計）。フォロワーがオンラインの時間帯の上位と、
 * フォロワー・反応した人それぞれの多い年代。年代別の時間帯は Meta が提供していないため、別々に出す
 */
export async function monthlyAudience(r: Report): Promise<MonthlyAudience | null> {
  if (!r.analysis.platforms.includes("instagram")) return null;
  const acct = r.accounts.find((a) => a.platform === "instagram");
  const latest = await latestAudience(await createClient(), r.client.id, "instagram", acct?.id ?? null).catch(() => null);
  if (!latest) return null;
  const online = onlineSummary(latest.data.online);
  const fol: Record<string, number> = {};
  for (const byAge of Object.values(latest.data.genderAge ?? {})) for (const [age, v] of Object.entries(byAge)) fol[age] = (fol[age] ?? 0) + v;
  const top = (m: Record<string, number>) => Object.entries(ageShares(m)).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const out = { account: acct?.name ?? "Instagram", peaks: online?.peaks ?? [], days: online?.days.length ?? 0, followerAges: top(fol), engagedAges: top(latest.data.engagedAge ?? {}) };
  return out.peaks.length || out.followerAges.length || out.engagedAges.length ? out : null;
}

/** 「見られている時間と年代」の文（画面とメールで使う） */
export function audienceLines(a: MonthlyAudience): string[] {
  const ages = (xs: [string, number][]) => xs.map(([age, s]) => `${age}歳（${fmtPct(s, 0)}）`).join("・");
  return [
    ...(a.peaks.length ? [`・フォロワーが多くオンラインの時間帯：${a.peaks.map((h) => `${h}時台`).join("・")}（直近${a.days}日の平均）`] : []),
    ...(a.followerAges.length ? [`・フォロワーに多い年代：${ages(a.followerAges)}`] : []),
    ...(a.engagedAges.length ? [`・反応した人に多い年代：${ages(a.engagedAges)}`] : []),
  ];
}

/** 結び付けた MEO クライアントの、この月の Googleマップの結果（結び付けていなければ null） */
export async function monthlyMeo(clientId: string, month: string): Promise<MeoMonthly | null> {
  const admin = createAdminClient();
  const link = await getMeoLink(admin, clientId).catch(() => null);
  if (!link) return null;
  const { start, end } = monthRange(month);
  return meoMonthly(admin, link, start, end).catch(() => null);
}

/** Googleマップの結果の文（画面の補足とメールで使う） */
export function meoLines(m: MeoMonthly): string[] {
  return [
    `・口コミ：この月 ${fmtNum(m.newReviews)}件${m.newAvg !== null ? `（平均 ★${m.newAvg.toFixed(1)}）` : ""}／合計 ${fmtNum(m.totalReviews)}件${m.totalAvg !== null ? `（平均 ★${m.totalAvg.toFixed(1)}）` : ""}`,
    ...(m.unreplied ? [`・まだ返信していない口コミ：${fmtNum(m.unreplied)}件`] : []),
    `・Google の投稿：${fmtNum(m.posts)}件`,
    ...(m.keywords.length ? [`・検索で表示されたキーワード：${m.keywords.map((k) => `「${k.keyword}」${fmtNum(k.impressions)}回`).join("、")}`] : []),
  ];
}

/**
 * 前月と比べてよいか。前月の投稿が少ない（運用を始めた月の翌月など）と、「+700%」のような誤解を招く割合になるため、
 * MIN_PREV_POSTS 件未満なら割合を出さない
 */
export const MIN_PREV_POSTS = 3;
export const comparable = (prev: { posts: number }) => prev.posts >= MIN_PREV_POSTS;
export const NOT_COMPARABLE = "前月はほぼ投稿がないため比較なし";

/** 主要な数字（画面とメールで同じものを出す）。フォロワーの記録がない月は、フォロワーの項目を出さない */
export function monthlyTotals(r: Report) {
  const d = r.analysis;
  const t = d.total;
  const fol = d.platforms.map((p) => d.summary[p]!.followers).filter((v): v is number => v !== null);
  const fdel = d.platforms.map((p) => d.summary[p]!.followersDelta).filter((v): v is number => v !== null);
  const folSum = fol.reduce((a, b) => a + b, 0);
  const delSum = fdel.reduce((a, b) => a + b, 0);
  const ok = comparable(t.prev);
  const item = (label: string, value: string, v: number | null | undefined) => {
    const change = ok && v !== null && v !== undefined ? v : null;
    return { label, value, change, note: change !== null ? `前月比 ${change > 0 ? "+" : ""}${fmtPct(change, 1)}` : ok ? "前月のデータなし" : NOT_COMPARABLE };
  };
  return [
    item("エンゲージメント", fmtNum(t.engagements), t.change.engagements),
    item("表示回数", fmtNum(t.views), t.change.views),
    item("投稿数", fmtNum(t.posts), t.change.posts),
    ...(fol.length ? [{ label: "フォロワー合計", value: `${fmtNum(folSum)}人`, change: null, note: fdel.length ? `この月 ${fmtSigned(delSum)}人` : "増減の記録なし" }] : []),
  ];
}

/** この月を対象に実行したAI分析（期間の終わりがこの月の中にあるもの）。なければ null */
export function monthlyAi(r: Report, month: string) {
  const { start } = monthRange(month);
  return r.ai && r.ai.period_end >= start && r.ai.period_end <= `${month}-31` ? r.ai.result : null;
}

const PRI = ["high", "medium", "low"] as const;

/**
 * クライアントへ送るメールの本文。ログインしなくても報告として読めるように、画面の主な内容を文章で載せる
 * （パスワードを覚えていない担当者がリンクの先に進めなくても、メールだけで中身が分かるように）
 */
export function monthlyMailLines(r: Report, month: string, url: string, accounts: Partial<Record<Platform, AccountBreakdown[]>> = {}, meo: MeoMonthly | null = null, aud: MonthlyAudience | null = null): string[] {
  const d = r.analysis;
  const ins = [...d.insights].sort((a, b) => (a.kind === "good" ? -1 : 0) - (b.kind === "good" ? -1 : 0)).slice(0, 4);
  const ai = monthlyAi(r, month);
  const recs = ai ? [...ai.recommendations].sort((a, b) => PRI.indexOf(a.priority) - PRI.indexOf(b.priority)).slice(0, 3) : [];
  const comp = r.competitors ? Object.entries(r.competitors.platforms).flatMap(([p, x]) => {
    const rows = x!.rows.filter((row) => row.erFollowers !== null);
    const i = rows.findIndex((row) => row.isOwn);
    return i >= 0 && rows.length > 1
      ? [`・${PLATFORM_LABELS[p as keyof typeof PLATFORM_LABELS]}：フォロワーあたりの反応は${rows.length}アカウント中${[...rows].sort((a, b) => b.erFollowers! - a.erFollowers!).indexOf(rows[i]) + 1}位`]
      : [];
  }) : [];
  const { start, end } = monthRange(month);
  return [
    `${r.client.name} ご担当者さま`,
    "",
    `${monthLabel(month)}のSNSレポートをお送りします（対象：${slash(start)}〜${slash(end)}）。`,
    "",
    "■ 主な数字",
    ...monthlyTotals(r).map((x) => `・${x.label}：${x.value}（${x.note}）`),
    ...(ai ? ["", "■ まとめ", ai.headline, ai.summary] : []),
    ...(ins.length ? ["", "■ この月のポイント", ...ins.map((i) => `・${i.text}`)] : []),
    "", "■ SNS別",
    ...d.platforms.flatMap((p) => {
      const line = (s: PlatformSummary) => `フォロワー ${fmtNum(s.followers)}人（${fmtSigned(s.followersDelta)}）／投稿 ${fmtNum(s.posts)}件／エンゲージメント ${fmtNum(s.engagements)}／ER ${fmtPct(s.erFollowers)}`;
      const subs = accounts[p] ?? [];
      return [
        `・${PLATFORM_LABELS[p]}${subs.length ? "（合計）" : ""}：${line(d.summary[p]!)}`,
        ...subs.map((a) => `　└ ${a.name}：${line(a.summary)}`),
      ];
    }),
    ...(d.topPosts.length ? ["", "■ 反応の良かった投稿",
      ...d.topPosts.slice(0, 3).map((t, i) => `${i + 1}. ${PLATFORM_LABELS[t.platform]} ${slash(t.date)}「${truncate(t.text.replace(/\s+/g, " ").trim(), 40) || "本文なし"}」エンゲージメント ${fmtNum(t.engagements)}${t.permalink ? `\n   ${t.permalink}` : ""}`)] : []),
    ...(comp.length ? ["", "■ 競合との比較", ...comp] : []),
    ...(aud ? ["", `■ 見られている時間と年代（Instagram）`, ...audienceLines(aud)] : []),
    ...(meo ? ["", `■ Googleマップ（${meo.locations}店舗）`, ...meoLines(meo)] : []),
    ...(recs.length ? ["", "■ 来月の提案", ...recs.map((x, i) => `${i + 1}. ${x.action}（優先度 ${PRIORITY_LABELS[x.priority]}・${platformLabel(x.platform)}）`)] : []),
    "",
    "グラフや競合との比較の詳しい表は、こちらのページでご覧いただけます（ログインが必要です）。",
    url,
    "",
    "ご不明な点があれば、このメールにご返信ください。",
    "Rhythmos",
  ];
}
