/**
 * Supabase への読み書き。
 * - 読み取り（レポート表示）は、呼び出し側が渡す「利用者の権限の」クライアントで行う（RLS が効く）
 * - 書き込み・トークンの読み出しは service_role のクライアントで行う。呼ぶ前に必ず権限を確認すること
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompetitorAccount } from "./compare.ts";
import type { CollectResult } from "./collectors/http.ts";
import { DEFAULT_TZ, PLATFORMS, addDays, isPlatform, todayIn, type FollowerSeries, type MediaType, type Platform, type Post, type Series } from "./models.ts";
import type { ConsentRow, DeletionService } from "./privacy.ts";
import { DELETION_PLATFORMS } from "./privacy.ts";
import type { AiResult } from "./ai.ts";

type Db = SupabaseClient;

export class StoreError extends Error {}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new StoreError(`${what}に失敗しました：${res.error.message}`);
  return res.data;
}

/** PostgREST の1回あたりの上限（既定 1000 行）を超えて全件読む */
async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const rows = check(await build(from, from + size - 1), what) ?? [];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

const chunks = <T>(arr: T[], n: number): T[][] => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// ---- 設定 ---------------------------------------------------------------------

export type AppSettings = {
  retention_days: number; collect_days: number; max_posts_per_run: number;
  ai_model: string; ai_effort: "low" | "medium" | "high"; graph_api_version: string;
  legal: Record<string, string>;
};

export async function getAppSettings(db: Db): Promise<AppSettings> {
  const row = check(await db.from("sns_app_settings").select("retention_days,collect_days,max_posts_per_run,ai_model,ai_effort,graph_api_version,legal").eq("id", 1).maybeSingle(), "設定の読み込み");
  return {
    retention_days: 400, collect_days: 60, max_posts_per_run: 300, ai_model: "claude-opus-5-5", ai_effort: "high",
    graph_api_version: "v26.0", legal: {}, ...(row ?? {}),
  } as AppSettings;
}

// ---- クライアント ---------------------------------------------------------------

export type ClientRow = { id: string; name: string; status: string | null };

export async function listClients(db: Db): Promise<ClientRow[]> {
  return check(await db.from("clients").select("id,name,status").order("name"), "クライアント一覧の読み込み") as ClientRow[];
}

export async function getClient(db: Db, id: string): Promise<ClientRow | null> {
  return check(await db.from("clients").select("id,name,status").eq("id", id).maybeSingle(), "クライアントの読み込み") as ClientRow | null;
}

export async function getBrandContext(db: Db, clientId: string): Promise<string> {
  const row = check(await db.from("sns_client_settings").select("brand_context").eq("client_id", clientId).maybeSingle(), "クライアント設定の読み込み");
  return (row as { brand_context?: string } | null)?.brand_context ?? "";
}

export async function setBrandContext(admin: Db, clientId: string, text: string): Promise<void> {
  check(await admin.from("sns_client_settings").upsert({ client_id: clientId, brand_context: text }, { onConflict: "client_id" }), "クライアント設定の保存");
}

// ---- レポート用データ ------------------------------------------------------------

type PostRow = {
  id: string; account_id: string; platform: string; external_id: string; posted_at: string; text: string;
  media_type: string; permalink: string | null; views: number | null; reach: number | null; likes: number;
  comments: number; shares: number; saves: number; quotes: number; clicks: number | null;
};
type AccountRow = { id: string; platform: string; external_id: string; username: string | null; competitor_id: string | null; source: string; updated_at: string };
type SnapshotRow = { account_id: string; date: string; followers: number | null };
export type CompetitorRow = { id: string; name: string; handles: Partial<Record<Platform, string>>; created_at: string };

const toPost = (r: PostRow): Post => ({
  id: r.id, accountId: r.account_id, platform: r.platform as Platform, externalId: r.external_id,
  postedAt: new Date(r.posted_at).toISOString(), text: r.text ?? "", mediaType: r.media_type as MediaType, permalink: r.permalink,
  metrics: { views: r.views, reach: r.reach, likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves, quotes: r.quotes, clicks: r.clicks },
});

export type ReportData = {
  ownPosts: Post[];
  ownFollowers: FollowerSeries;
  ownNames: Partial<Record<Platform, string>>;
  competitors: CompetitorAccount[];
  competitorList: CompetitorRow[];
  hasData: boolean;
  lastPostDate: string | null;
};

export async function loadReportData(db: Db, clientId: string, opts: { days: number; end: string; tz?: string }): Promise<ReportData> {
  const start = addDays(opts.end, -(opts.days - 1));
  const from = `${addDays(start, -opts.days - 1)}T00:00:00Z`; // 前期間の比較用にさかのぼる
  const to = `${addDays(opts.end, 2)}T00:00:00Z`;
  const [accounts, competitorList, posts, snaps] = await Promise.all([
    selectAll<AccountRow>((a, b) => db.from("sns_accounts").select("id,platform,external_id,username,competitor_id,source,updated_at").eq("client_id", clientId).order("id").range(a, b), "アカウントの読み込み"),
    selectAll<CompetitorRow>((a, b) => db.from("sns_competitors").select("id,name,handles,created_at").eq("client_id", clientId).order("name").range(a, b), "競合の読み込み"),
    selectAll<PostRow>((a, b) => db.from("sns_posts_latest")
      .select("id,account_id,platform,external_id,posted_at,text,media_type,permalink,views,reach,likes,comments,shares,saves,quotes,clicks")
      .eq("client_id", clientId).gte("posted_at", from).lt("posted_at", to).order("posted_at").order("id").range(a, b), "投稿の読み込み"),
    selectAll<SnapshotRow>((a, b) => db.from("sns_snapshots").select("account_id,date,followers").eq("client_id", clientId)
      .lte("date", opts.end).not("followers", "is", null).order("date").order("account_id").range(a, b), "フォロワー数の読み込み"),
  ]);

  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  const seriesOf = new Map<string, Series>();
  for (const s of snaps) {
    const list = seriesOf.get(s.account_id) ?? [];
    list.push([s.date, s.followers as number]);
    seriesOf.set(s.account_id, list);
  }

  const ownPosts: Post[] = [];
  const compPosts = new Map<string, Post[]>();
  for (const r of posts) {
    const acc = byAccount.get(r.account_id);
    if (!acc) continue;
    if (acc.competitor_id) {
      const list = compPosts.get(acc.id) ?? [];
      list.push(toPost(r));
      compPosts.set(acc.id, list);
    } else ownPosts.push(toPost(r));
  }

  // 自社：SNSごとにフォロワー推移を1本にまとめる（接続し直したアカウントは新しいものを優先）
  const ownFollowers: FollowerSeries = {};
  const ownNames: Partial<Record<Platform, string>> = {};
  const own = accounts.filter((a) => !a.competitor_id && isPlatform(a.platform)).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  for (const p of PLATFORMS) {
    const merged = new Map<string, number>();
    for (const a of own.filter((x) => x.platform === p)) {
      for (const [d, f] of seriesOf.get(a.id) ?? []) merged.set(d, f);
      if (a.username) ownNames[p] = a.username;
    }
    if (merged.size) ownFollowers[p] = [...merged.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }

  const compName = new Map(competitorList.map((c) => [c.id, c.name]));
  const competitors: CompetitorAccount[] = accounts
    .filter((a) => a.competitor_id && isPlatform(a.platform) && compName.has(a.competitor_id))
    .map((a) => ({
      id: a.id, platform: a.platform as Platform, competitorName: compName.get(a.competitor_id!)!,
      username: a.username ?? "", series: seriesOf.get(a.id) ?? [], posts: compPosts.get(a.id) ?? [],
    }));

  return {
    ownPosts, ownFollowers, ownNames, competitors, competitorList,
    hasData: ownPosts.length > 0 || Object.keys(ownFollowers).length > 0,
    lastPostDate: ownPosts.length ? ownPosts[ownPosts.length - 1].postedAt.slice(0, 10) : null,
  };
}

// ---- 収集結果の保存 --------------------------------------------------------------

export type SaveOptions = {
  competitorId?: string | null;
  source?: "api" | "csv" | "manual";
  /** この日時以降の保存済み投稿のうち、今回の結果にないものを削除する（SNS上で削除された投稿の同期） */
  reconcileSince?: string | null;
  tz?: string;
};

export type SaveCounts = { posts: number; removed: number };

export async function saveCollected(admin: Db, clientId: string, result: CollectResult, opts: SaveOptions = {}): Promise<SaveCounts> {
  const { account } = result;
  const today = todayIn(opts.tz ?? DEFAULT_TZ);
  const acc = check(await admin.from("sns_accounts").upsert({
    client_id: clientId, platform: account.platform, external_id: account.externalId, username: account.username || null,
    competitor_id: opts.competitorId ?? null, ...(opts.source ? { source: opts.source } : {}),
  }, { onConflict: "client_id,platform,external_id" }).select("id").single(), "アカウントの保存") as { id: string };

  if (account.followers !== null || account.following !== null || account.postsCount !== null) {
    check(await admin.from("sns_snapshots").upsert({
      account_id: acc.id, client_id: clientId, date: today,
      followers: account.followers, following: account.following, posts_count: account.postsCount,
    }, { onConflict: "account_id,date" }), "フォロワー数の保存");
  }

  let saved = 0;
  for (const batch of chunks(result.posts, 500)) {
    const rows = check(await admin.from("sns_posts").upsert(batch.map((p) => ({
      account_id: acc.id, client_id: clientId, platform: account.platform, external_id: p.externalId,
      posted_at: p.postedAt, text: p.text, media_type: p.mediaType, permalink: p.permalink,
    })), { onConflict: "account_id,external_id" }).select("id,external_id"), "投稿の保存") as { id: string; external_id: string }[];
    const idOf = new Map(rows.map((r) => [r.external_id, r.id]));
    check(await admin.from("sns_post_metrics").upsert(batch.filter((p) => idOf.has(p.externalId)).map((p) => ({
      post_id: idOf.get(p.externalId), client_id: clientId, fetched_date: today, ...p.metrics,
    })), { onConflict: "post_id,fetched_date" }), "指標の保存");
    saved += rows.length;
  }

  let removed = 0;
  if (opts.reconcileSince) {
    const keep = new Set(result.posts.map((p) => p.externalId));
    const existing = await selectAll<{ id: string; external_id: string }>((a, b) => admin.from("sns_posts").select("id,external_id")
      .eq("account_id", acc.id).gte("posted_at", opts.reconcileSince!).order("id").range(a, b), "投稿の照合");
    const gone = existing.filter((r) => !keep.has(r.external_id)).map((r) => r.id);
    for (const ids of chunks(gone, 100)) {
      check(await admin.from("sns_posts").delete().in("id", ids), "削除された投稿の同期");
      removed += ids.length;
    }
  }
  return { posts: saved, removed };
}

/** 同じ SNS・同じユーザー名のアカウント（API で取得済みのものを含む）を探す */
export async function findAccount(admin: Db, clientId: string, platform: Platform, username: string, competitorId: string | null) {
  let q = admin.from("sns_accounts").select("id,external_id").eq("client_id", clientId).eq("platform", platform)
    .ilike("username", username.replace(/[\\%_]/g, "\\$&"));
  q = competitorId ? q.eq("competitor_id", competitorId) : q.is("competitor_id", null);
  const rows = check(await q.limit(1), "アカウントの検索") as { id: string; external_id: string }[];
  return rows[0] ?? null;
}

/** フォロワー数の手動記録（API で取れない競合など） */
export async function recordFollowers(admin: Db, clientId: string, platform: Platform, username: string, followers: number,
  date: string, competitorId: string | null): Promise<void> {
  let accountId = (await findAccount(admin, clientId, platform, username, competitorId))?.id;
  if (!accountId) {
    accountId = (check(await admin.from("sns_accounts").upsert({
      client_id: clientId, platform, external_id: `manual:${username.toLowerCase()}`, username, competitor_id: competitorId, source: "manual",
    }, { onConflict: "client_id,platform,external_id" }).select("id").single(), "アカウントの保存") as { id: string }).id;
  }
  check(await admin.from("sns_snapshots").upsert({ account_id: accountId, client_id: clientId, date, followers },
    { onConflict: "account_id,date" }), "フォロワー数の保存");
}

// ---- 接続 -----------------------------------------------------------------------

export type ConnectionInfo = {
  platform: Platform; external_id: string; username: string | null; token_expires_at: string | null;
  status: "connected" | "error"; last_error: string | null; connected_at: string; updated_at: string;
};
export type ConnectionSecret = ConnectionInfo & { client_id: string; access_token: string; connected_user_id: string | null };

/** 画面表示用。トークンは返さない */
export async function listConnections(admin: Db, clientId: string): Promise<ConnectionInfo[]> {
  return check(await admin.from("sns_connections")
    .select("platform,external_id,username,token_expires_at,status,last_error,connected_at,updated_at")
    .eq("client_id", clientId), "接続情報の読み込み") as ConnectionInfo[];
}

export async function getConnectionSecrets(admin: Db, clientId?: string): Promise<ConnectionSecret[]> {
  let q = admin.from("sns_connections").select("*");
  if (clientId) q = q.eq("client_id", clientId);
  return check(await q, "接続情報の読み込み") as ConnectionSecret[];
}

export async function saveConnection(admin: Db, clientId: string, platform: Platform, c: {
  externalId: string; username: string; accessToken: string; expiresAt: string | null; connectedUserId: string | null;
}): Promise<void> {
  check(await admin.from("sns_connections").upsert({
    client_id: clientId, platform, external_id: c.externalId, username: c.username || null, access_token: c.accessToken,
    token_expires_at: c.expiresAt, connected_user_id: c.connectedUserId, status: "connected", last_error: null,
    connected_at: new Date().toISOString(),
  }, { onConflict: "client_id,platform" }), "接続情報の保存");
}

export async function updateConnection(admin: Db, clientId: string, platform: Platform, patch: Partial<{
  access_token: string; token_expires_at: string | null; status: "connected" | "error"; last_error: string | null;
}>): Promise<void> {
  check(await admin.from("sns_connections").update(patch).eq("client_id", clientId).eq("platform", platform), "接続情報の更新");
}

export async function deleteConnection(admin: Db, clientId: string, platform: Platform): Promise<void> {
  check(await admin.from("sns_connections").delete().eq("client_id", clientId).eq("platform", platform), "接続の解除");
  check(await admin.from("sns_collect_state").delete().eq("client_id", clientId).eq("platform", platform), "収集状況の削除");
}

// ---- 収集の実行状況 -----------------------------------------------------------------

export type CollectState = { client_id: string; platform: Platform; last_run_at: string | null; last_success_at: string | null; last_error: string | null; posts_saved: number | null };

export async function listCollectState(db: Db, clientId?: string): Promise<CollectState[]> {
  let q = db.from("sns_collect_state").select("*");
  if (clientId) q = q.eq("client_id", clientId);
  return check(await q, "収集状況の読み込み") as CollectState[];
}

export async function setCollectState(admin: Db, clientId: string, platform: Platform, ok: boolean, error: string | null, postsSaved: number | null) {
  const now = new Date().toISOString();
  check(await admin.from("sns_collect_state").upsert({
    client_id: clientId, platform, last_run_at: now, last_error: error, posts_saved: postsSaved,
    ...(ok ? { last_success_at: now } : {}),
  }, { onConflict: "client_id,platform" }), "収集状況の保存");
}

// ---- 競合 ------------------------------------------------------------------------

export async function listCompetitors(db: Db, clientId: string): Promise<CompetitorRow[]> {
  return check(await db.from("sns_competitors").select("id,name,handles,created_at").eq("client_id", clientId).order("name"), "競合の読み込み") as CompetitorRow[];
}

export async function saveCompetitor(admin: Db, clientId: string, name: string, handles: Partial<Record<Platform, string>>, id?: string): Promise<void> {
  if (id) {
    check(await admin.from("sns_competitors").update({ name, handles }).eq("id", id).eq("client_id", clientId), "競合の保存");
  } else {
    check(await admin.from("sns_competitors").insert({ client_id: clientId, name, handles }), "競合の保存");
  }
}

// ---- 削除 ------------------------------------------------------------------------

export type DeleteCounts = { posts: number; snapshots: number };

const fmtCounts = (c: DeleteCounts) => `投稿 ${c.posts.toLocaleString()}件・フォロワー記録 ${c.snapshots.toLocaleString()}件`;

async function countFor(admin: Db, accountIds: string[]): Promise<DeleteCounts> {
  if (!accountIds.length) return { posts: 0, snapshots: 0 };
  let posts = 0;
  let snapshots = 0;
  for (const ids of chunks(accountIds, 100)) {
    const p = await admin.from("sns_posts").select("id", { count: "exact", head: true }).in("account_id", ids);
    const s = await admin.from("sns_snapshots").select("date", { count: "exact", head: true }).in("account_id", ids);
    posts += p.count ?? 0;
    snapshots += s.count ?? 0;
  }
  return { posts, snapshots };
}

/** 分析結果（AI）は削除したデータから作られているため、あわせて削除する */
async function invalidateAi(admin: Db, clientId: string) {
  check(await admin.from("sns_ai_results").delete().eq("client_id", clientId), "AI分析結果の削除");
}

export async function deletePlatformData(admin: Db, clientId: string, platform: Platform, scope: "own" | "competitor" | "all", disconnect: boolean): Promise<string> {
  let q = admin.from("sns_accounts").select("id").eq("client_id", clientId).eq("platform", platform);
  if (scope === "own") q = q.is("competitor_id", null);
  if (scope === "competitor") q = q.not("competitor_id", "is", null);
  const ids = (check(await q, "アカウントの検索") as { id: string }[]).map((r) => r.id);
  const counts = await countFor(admin, ids);
  for (const batch of chunks(ids, 100)) check(await admin.from("sns_accounts").delete().in("id", batch), "データの削除");
  if (disconnect) await deleteConnection(admin, clientId, platform);
  await invalidateAi(admin, clientId);
  const target = { own: "自社", competitor: "競合", all: "自社・競合" }[scope];
  return `${platform === "x" ? "X" : platform[0].toUpperCase() + platform.slice(1)}（${target}）のデータを削除しました：${fmtCounts(counts)}`;
}

export async function deleteCompetitor(admin: Db, clientId: string, competitorId: string): Promise<string> {
  const comp = check(await admin.from("sns_competitors").select("name").eq("id", competitorId).eq("client_id", clientId).maybeSingle(), "競合の検索") as { name: string } | null;
  if (!comp) throw new StoreError("競合が見つかりません");
  const ids = (check(await admin.from("sns_accounts").select("id").eq("competitor_id", competitorId), "アカウントの検索") as { id: string }[]).map((r) => r.id);
  const counts = await countFor(admin, ids);
  check(await admin.from("sns_competitors").delete().eq("id", competitorId).eq("client_id", clientId), "競合の削除");
  await invalidateAi(admin, clientId);
  return `競合「${comp.name}」とそのデータを削除しました：${fmtCounts(counts)}`;
}

/** クライアントの SNS データをすべて削除（MEO のクライアント自体は残す） */
export async function deleteAllClientData(admin: Db, clientId: string): Promise<string> {
  const ids = (check(await admin.from("sns_accounts").select("id").eq("client_id", clientId), "アカウントの検索") as { id: string }[]).map((r) => r.id);
  const counts = await countFor(admin, ids);
  for (const t of ["sns_accounts", "sns_competitors", "sns_connections", "sns_collect_state", "sns_ai_results", "sns_ai_consents", "sns_client_settings"]) {
    check(await admin.from(t).delete().eq("client_id", clientId), "データの削除");
  }
  return `このクライアントのSNSデータをすべて削除しました：${fmtCounts(counts)}`;
}

/** 保存期間を過ぎたデータを全クライアントから削除する。0 なら何もしない */
export async function purgeExpired(admin: Db, retentionDays: number, tz = DEFAULT_TZ): Promise<string | null> {
  if (retentionDays <= 0) return null;
  const cutoff = addDays(todayIn(tz), -retentionDays);
  const del = async (t: string, col: string, v: string) =>
    (await admin.from(t).delete({ count: "exact" }).lt(col, v)).count ?? 0;
  const posts = await del("sns_posts", "posted_at", `${cutoff}T00:00:00Z`);
  const metrics = await del("sns_post_metrics", "fetched_date", cutoff);
  const snapshots = await del("sns_snapshots", "date", cutoff);
  const ai = await del("sns_ai_results", "created_at", `${cutoff}T00:00:00Z`);
  await del("sns_deletion_requests", "created_at", `${cutoff}T00:00:00Z`);
  return `${cutoff.replaceAll("-", "/")}より前のデータを削除しました：投稿 ${posts}件・指標 ${metrics}件・フォロワー記録 ${snapshots}件・AI分析 ${ai}件`;
}

// ---- Meta / Threads のデータ削除リクエスト ------------------------------------------------

export async function handleDeletionRequest(admin: Db, service: DeletionService, userId: string, code: string): Promise<string[]> {
  const platforms = DELETION_PLATFORMS[service] as readonly Platform[];
  const rows = check(await admin.from("sns_connections").select("client_id,platform,connected_user_id,external_id")
    .in("platform", [...platforms]), "接続情報の検索") as { client_id: string; platform: Platform; connected_user_id: string | null; external_id: string }[];
  const done: string[] = [];
  for (const r of rows) {
    const owner = r.connected_user_id || (r.platform === "threads" ? r.external_id : "");
    if (owner && owner === userId) {
      await deletePlatformData(admin, r.client_id, r.platform, "all", true);
      done.push(`${r.client_id}:${r.platform}`);
    }
  }
  check(await admin.from("sns_deletion_requests").insert({
    code, service, user_id: userId, status: "completed", detail: done.length ? `${done.length}件の接続とデータを削除` : "該当する接続なし",
  }), "削除リクエストの記録");
  return done;
}

export async function getDeletionRequest(admin: Db, code: string) {
  return check(await admin.from("sns_deletion_requests").select("code,service,status,detail,created_at").eq("code", code).maybeSingle(), "削除リクエストの確認") as
    { code: string; service: string; status: string; detail: string | null; created_at: string } | null;
}

// ---- AI分析の同意と結果 --------------------------------------------------------------

export async function getConsentRow(db: Db, clientId: string): Promise<ConsentRow | null> {
  return check(await db.from("sns_ai_consents").select("status,version,granted_by,granted_at,include_post_text,note,recorded_by,revoked_at")
    .eq("client_id", clientId).maybeSingle(), "同意の読み込み") as ConsentRow | null;
}

export async function grantConsent(admin: Db, clientId: string, c: { version: string; grantedBy: string; includePostText: boolean; note: string; recordedBy: string }) {
  check(await admin.from("sns_ai_consents").upsert({
    client_id: clientId, status: "granted", version: c.version, granted_by: c.grantedBy, granted_at: new Date().toISOString(),
    include_post_text: c.includePostText, note: c.note || null, recorded_by: c.recordedBy, revoked_at: null,
  }, { onConflict: "client_id" }), "同意の記録");
}

/** 同意を撤回し、保存済みのAI分析結果を削除する */
export async function revokeConsent(admin: Db, clientId: string, version: string, recordedBy: string): Promise<number> {
  check(await admin.from("sns_ai_consents").upsert({
    client_id: clientId, status: "revoked", version, granted_by: null, granted_at: null, include_post_text: false,
    note: null, recorded_by: recordedBy, revoked_at: new Date().toISOString(),
  }, { onConflict: "client_id" }), "同意の撤回");
  const res = await admin.from("sns_ai_results").delete({ count: "exact" }).eq("client_id", clientId);
  check(res, "AI分析結果の削除");
  return res.count ?? 0;
}

export type StoredAi = { id: string; period_end: string; days: number; result: AiResult; model: string | null; created_at: string };

export async function latestAiResult(db: Db, clientId: string): Promise<StoredAi | null> {
  return check(await db.from("sns_ai_results").select("id,period_end,days,result,model,created_at").eq("client_id", clientId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle(), "AI分析結果の読み込み") as StoredAi | null;
}

export async function saveAiResult(admin: Db, clientId: string, periodEnd: string, days: number, result: AiResult, createdBy: string) {
  check(await admin.from("sns_ai_results").upsert({
    client_id: clientId, period_end: periodEnd, days, result, model: result._meta.model, created_by: createdBy, created_at: new Date().toISOString(),
  }, { onConflict: "client_id,period_end,days" }), "AI分析結果の保存");
}

// ---- 操作ログ --------------------------------------------------------------------

export async function audit(admin: Db, actor: { id: string; email: string } | null, action: string, clientId: string | null, detail = "", ip = "") {
  // 操作ログの失敗で本来の操作を止めない
  await admin.from("sns_audit").insert({
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, ip: ip || null, action, client_id: clientId, detail: detail.slice(0, 500),
  });
}

export type AuditRow = { id: number; at: string; actor_email: string | null; ip: string | null; action: string; client_id: string | null; detail: string | null };

export async function listAudit(db: Db, limit = 300): Promise<AuditRow[]> {
  return check(await db.from("sns_audit").select("id,at,actor_email,ip,action,client_id,detail").order("at", { ascending: false }).limit(limit), "操作ログの読み込み") as AuditRow[];
}

/** クライアント一覧用：全クライアントの接続状況（トークンは返さない） */
export async function connectionOverview(admin: Db): Promise<{ client_id: string; platform: Platform; status: string; username: string | null }[]> {
  return check(await admin.from("sns_connections").select("client_id,platform,status,username"), "接続情報の読み込み") as
    { client_id: string; platform: Platform; status: string; username: string | null }[];
}

/**
 * X の投稿のうち収集の対象期間より前のものを、日ごとにずらして最大 limit 件返す
 * （X上で削除・非公開化された投稿を定期的に照会するため）
 */
export async function xPostsToVerify(admin: Db, clientId: string, before: string, limit = 100): Promise<{ id: string; external_id: string }[]> {
  const head = await admin.from("sns_posts").select("id", { count: "exact", head: true })
    .eq("client_id", clientId).eq("platform", "x").lt("posted_at", before);
  const total = head.count ?? 0;
  if (!total) return [];
  const day = Math.floor(Date.now() / 86_400_000);
  const offset = total <= limit ? 0 : (day * limit) % total;
  return check(await admin.from("sns_posts").select("id,external_id").eq("client_id", clientId).eq("platform", "x")
    .lt("posted_at", before).order("posted_at").order("id").range(offset, offset + limit - 1), "X の投稿の照会") as { id: string; external_id: string }[];
}

export async function deletePosts(admin: Db, ids: string[]): Promise<void> {
  for (const batch of chunks(ids, 100)) check(await admin.from("sns_posts").delete().in("id", batch), "投稿の削除");
}
