/**
 * データ収集の実行。cron（1日数回）と「今すぐ収集」から呼ぶ。
 * サーバーレスの実行時間に収めるため、締め切り時刻までに処理できた接続だけ進め、
 * 残りは次回へ回す（前回の実行が古い順に処理する）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError, createCollector, XCollector } from "./collectors/index.ts";
import { isTokenError, needsRefresh, threadsRefresh } from "./connect.ts";
import { cleanHandle } from "./collectors/types.ts";
import { PLATFORM_LABELS, addDays, toLocal, todayIn, type Platform } from "./models.ts";
import {
  deletePosts, getAppSettings, getConnectionSecrets, xPostsToVerify, listCollectState, listCompetitors, purgeExpired, saveCollected, setCollectState,
  updateConnection, type ConnectionSecret,
} from "./store.ts";

export type CollectLog = { clientId: string; platform: Platform; ok: boolean; message: string };

/** 1接続あたりに確保したい残り時間（ms）。これを切ったら次回へ回す */
const MIN_TIME_PER_CONNECTION = 25_000;

async function collectConnection(admin: SupabaseClient, conn: ConnectionSecret, deadline: number): Promise<CollectLog> {
  const settings = await getAppSettings(admin);
  const platform = conn.platform;
  const label = PLATFORM_LABELS[platform];
  let token = conn.access_token;
  const warnings: string[] = [];

  // Threads の長期トークンは期限前に延長する
  if (platform === "threads" && needsRefresh(conn.token_expires_at)) {
    try {
      const r = await threadsRefresh(token);
      token = r.accessToken;
      await updateConnection(admin, conn.client_id, platform, { access_token: r.accessToken, token_expires_at: r.expiresAt });
    } catch (e) {
      warnings.push(`トークンを延長できませんでした（${e instanceof Error ? e.message : "不明なエラー"}）`);
    }
  }

  const collector = createCollector(
    { platform, externalId: conn.external_id, username: conn.username ?? "", accessToken: token },
    { graphVersion: settings.graph_api_version },
  );
  const since = new Date(`${addDays(todayIn(), -settings.collect_days)}T00:00:00+09:00`).toISOString();
  const opts = { since, maxPosts: settings.max_posts_per_run, deadline: deadline - 5_000 };

  let saved = 0;
  let removed = 0;
  try {
    const own = await collector.collect(opts);
    // 取得が途中で打ち切られていなければ、SNS上で削除された投稿を同期して消す
    const complete = !own.warnings.some((w) => w.includes("次回")) && own.posts.length < opts.maxPosts;
    const r = await saveCollected(admin, conn.client_id, own, { reconcileSince: complete ? since : null });
    saved += r.posts;
    removed += r.removed;
    warnings.push(...own.warnings);
    await updateConnection(admin, conn.client_id, platform, { status: "connected", last_error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "不明なエラー";
    const full = isTokenError(e) ? `${msg}（トークンが無効です。もう一度連携してください）` : msg;
    await updateConnection(admin, conn.client_id, platform, { status: isTokenError(e) ? "error" : "connected", last_error: full.slice(0, 500) });
    await setCollectState(admin, conn.client_id, platform, false, full.slice(0, 500), null);
    return { clientId: conn.client_id, platform, ok: false, message: `${label}：${full}` };
  }

  // 競合（自社の接続を使って公開データを取得）
  const competitors = await listCompetitors(admin, conn.client_id);
  for (const c of competitors) {
    const handle = cleanHandle(c.handles?.[platform] ?? "");
    if (!handle) continue;
    if (Date.now() > deadline - 10_000) { warnings.push("時間内に取得しきれなかった競合があります。次回の収集で取得します。"); break; }
    try {
      const r = await collector.collectCompetitor(handle, { ...opts, maxPosts: Math.min(100, opts.maxPosts) });
      const done = !r.warnings.some((w) => w.includes("次回")) && r.posts.length < Math.min(100, opts.maxPosts);
      await saveCollected(admin, conn.client_id, r, { competitorId: c.id, reconcileSince: done && r.posts.length ? since : null });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      warnings.push(`競合「${c.name}」：${e.message}`);
    }
  }

  // X：対象期間より前の保存済み投稿も少しずつ照会し、X上で削除・非公開化されたものを削除する（X の開発者ポリシー）
  if (collector instanceof XCollector && Date.now() < deadline - 10_000) {
    try {
      const olds = await xPostsToVerify(admin, conn.client_id, since);
      if (olds.length) {
        const missing = await collector.missingIds(olds.map((o) => o.external_id));
        const ids = olds.filter((o) => missing.has(o.external_id)).map((o) => o.id);
        await deletePosts(admin, ids);
        removed += ids.length;
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      warnings.push(`過去の投稿の照会に失敗しました（${e.message}）`);
    }
  }

  const summary = `${label}：投稿 ${saved}件を保存${removed ? `・SNS上で削除された ${removed}件を削除` : ""}`;
  const note = warnings.length ? `${summary}（注意：${warnings.join(" / ")}）` : summary;
  await setCollectState(admin, conn.client_id, platform, true, warnings.length ? warnings.join(" / ").slice(0, 500) : null, saved);
  return { clientId: conn.client_id, platform, ok: true, message: note };
}

/** すべての接続を、前回の実行が古い順に締め切りまで処理する（cron 用） */
export async function runScheduledCollection(admin: SupabaseClient, deadline: number): Promise<{ logs: CollectLog[]; remaining: number; purge: string | null }> {
  const settings = await getAppSettings(admin);
  const purge = await purgeExpired(admin, settings.retention_days);
  const conns = await getConnectionSecrets(admin);
  const state = new Map((await listCollectState(admin)).map((s) => [`${s.client_id}:${s.platform}`, s.last_run_at ?? ""]));
  // 今日すでに成功しているものは後回し（1日1回以上は取り直さない）
  conns.sort((a, b) => (state.get(`${a.client_id}:${a.platform}`) ?? "").localeCompare(state.get(`${b.client_id}:${b.platform}`) ?? ""));
  const today = todayIn();
  const todo = conns.filter((c) => {
    const last = state.get(`${c.client_id}:${c.platform}`);
    return !last || toLocal(last).date !== today;
  });
  const logs: CollectLog[] = [];
  let i = 0;
  for (; i < todo.length; i++) {
    if (deadline - Date.now() < MIN_TIME_PER_CONNECTION) break;
    logs.push(await collectConnection(admin, todo[i], deadline));
  }
  return { logs, remaining: todo.length - i, purge };
}

/** 1クライアントのすべての接続を収集する（「今すぐ収集」用） */
export async function collectClient(admin: SupabaseClient, clientId: string, deadline: number, platform?: Platform): Promise<{ logs: CollectLog[]; skipped: Platform[] }> {
  const conns = (await getConnectionSecrets(admin, clientId)).filter((c) => !platform || c.platform === platform);
  const logs: CollectLog[] = [];
  const skipped: Platform[] = [];
  for (const c of conns) {
    if (deadline - Date.now() < MIN_TIME_PER_CONNECTION) { skipped.push(c.platform); continue; }
    logs.push(await collectConnection(admin, c, deadline));
  }
  return { logs, skipped };
}
