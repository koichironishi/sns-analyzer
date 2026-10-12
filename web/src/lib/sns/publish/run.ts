/**
 * 投稿の実行。「今すぐ投稿」と、数分おきの予約投稿の処理（cron）の両方から呼ぶ。
 *
 * - SNSごとに順に投稿し、1つ成功するたびに結果を保存する（途中で止まっても、出せたSNSに二重に出さない）
 * - 失敗したSNSだけを、あとから再投稿できる
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { needsRefresh, threadsRefresh, xNeedsRefresh, xRefresh, type XApp } from "../connect.ts";
import type { Platform } from "../models.ts";
import {
  claimScheduledPost, duePostIds, getAppSettings, getConnectionSecrets, getScheduledPost, stalePublishing, updateConnection,
  updateScheduledPost, type PlatformResult, type PostStatus, type ScheduledPost,
} from "../store.ts";
import { publishErrorMessage, publishTo, type PublishDeps } from "./publishers.ts";

export type RunDeps = PublishDeps & { xApp?: XApp | null };

/** SNSごとの本文（個別の文があればそれを使う） */
export const textFor = (post: Pick<ScheduledPost, "text" | "platform_texts">, p: Platform) =>
  (post.platform_texts?.[p] ?? "").trim() ? post.platform_texts[p]! : post.text;

export function overallStatus(platforms: Platform[], results: Partial<Record<Platform, PlatformResult>>): PostStatus {
  const ok = platforms.filter((p) => results[p]?.state === "published").length;
  return ok === platforms.length ? "published" : ok > 0 ? "partial" : "failed";
}

/** 確保済み（status = publishing）の投稿を、まだ出していないSNSへ投稿する */
export async function publishClaimedPost(admin: SupabaseClient, post: ScheduledPost, deps: RunDeps = {}): Promise<ScheduledPost> {
  const [conns, settings] = await Promise.all([getConnectionSecrets(admin, post.client_id), getAppSettings(admin)]);
  const results: Partial<Record<Platform, PlatformResult>> = { ...post.results };
  const imageUrls = post.media.map((m) => m.url);

  for (const p of post.platforms) {
    if (results[p]?.state === "published") continue;
    const at = new Date().toISOString();
    const conn = conns.find((c) => c.platform === p);
    try {
      if (!conn) throw new Error("このSNSは連携されていません。「設定・連携」で連携してください");
      if (!conn.can_publish) throw new Error("投稿の許可がありません。「設定・連携」で、投稿の許可を含めてもう一度連携してください");
      let token = conn.access_token;
      if (p === "x" && conn.refresh_token && xNeedsRefresh(conn.token_expires_at)) {
        if (!deps.xApp) throw new Error("X アプリの設定（X_CLIENT_ID / X_CLIENT_SECRET）がありません");
        const t = await xRefresh(deps.xApp, conn.refresh_token, deps.http);
        token = t.accessToken;
        await updateConnection(admin, post.client_id, "x", { access_token: t.accessToken, refresh_token: t.refreshToken || conn.refresh_token, token_expires_at: t.expiresAt });
      } else if (p === "threads" && needsRefresh(conn.token_expires_at)) {
        const t = await threadsRefresh(token, deps.http).catch(() => null);
        if (t) {
          token = t.accessToken;
          await updateConnection(admin, post.client_id, "threads", { access_token: t.accessToken, token_expires_at: t.expiresAt });
        }
      }
      const r = await publishTo(
        { platform: p, externalId: conn.external_id, accessToken: token, username: conn.username ?? "" },
        { text: textFor(post, p), imageUrls },
        { ...deps, graphVersion: settings.graph_api_version },
      );
      results[p] = { state: "published", id: r.externalId, permalink: r.permalink, error: null, at };
    } catch (e) {
      results[p] = { state: "failed", id: null, permalink: null, error: publishErrorMessage(e).slice(0, 500), at };
    }
    // 1つ終わるごとに保存する（途中で処理が止まっても、出せたSNSに二重に出さない）
    await updateScheduledPost(admin, post.id, { results });
  }

  const status = overallStatus(post.platforms, results);
  const publishedAt = Object.values(results).some((r) => r?.state === "published") ? (post.published_at ?? new Date().toISOString()) : post.published_at;
  await updateScheduledPost(admin, post.id, { status, results, locked_at: null, published_at: publishedAt });
  return { ...post, status, results, locked_at: null, published_at: publishedAt };
}

/** 1件を確保して投稿する（今すぐ投稿・再投稿）。すでに処理中なら null */
export async function publishNow(admin: SupabaseClient, postId: string, deps: RunDeps = {}): Promise<ScheduledPost | null> {
  const post = await claimScheduledPost(admin, postId);
  return post ? publishClaimedPost(admin, post, deps) : null;
}

/** 途中で止まった投稿を「失敗」として閉じる（自動ではやり直さない。二重投稿を避けるため、画面で再投稿してもらう） */
export async function closeStalePosts(admin: SupabaseClient): Promise<number> {
  const stale = await stalePublishing(admin);
  for (const post of stale) {
    const results = { ...post.results };
    for (const p of post.platforms) {
      if (results[p]?.state !== "published") {
        results[p] = { state: "failed", error: "処理が途中で止まりました。SNS上で投稿されていないか確認してから、再投稿してください", at: new Date().toISOString() };
      }
    }
    await updateScheduledPost(admin, post.id, { status: overallStatus(post.platforms, results), results, locked_at: null });
  }
  return stale.length;
}

/** 予約時刻を過ぎた投稿を、締め切りまで順に処理する（cron 用） */
export async function runDuePosts(admin: SupabaseClient, deadline: number, deps: RunDeps = {}) {
  const closed = await closeStalePosts(admin);
  const ids = await duePostIds(admin);
  const done: { id: string; status: PostStatus }[] = [];
  for (const id of ids) {
    // 1件あたり最大1分ほどかかる（画像の処理待ち）ため、残り時間が少なければ次回へ回す
    if (deadline - Date.now() < 70_000) break;
    const r = await publishNow(admin, id, deps);
    if (r) done.push({ id, status: r.status });
  }
  return { processed: done, remaining: ids.length - done.length, closed };
}

export { getScheduledPost };
