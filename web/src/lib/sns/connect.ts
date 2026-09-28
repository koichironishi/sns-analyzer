/**
 * 各SNSとの接続（Python 版 connect.py の移植、Web の OAuth 用に調整）。
 *
 * Meta（Facebook / Instagram）：Facebook ログイン → 認可コード → 短期ユーザートークン
 *   → 長期ユーザートークン（約60日）→ ページアクセストークン（期限なし）を両SNSで使う。
 * Threads：OAuth → 認可コード → 短期トークン → 長期トークン（60日）。期限前に refresh で延長。
 * X：開発者ポータルの Bearer Token を検証して保存する。
 */
import { ApiError, HttpClient, num, str, type HttpOptions } from "./collectors/http.ts";
import type { Platform } from "./models.ts";

export const META_SCOPES = [
  "pages_show_list", "pages_read_engagement", "read_insights",
  "instagram_basic", "instagram_manage_insights", "business_management",
];
export const THREADS_SCOPES = ["threads_basic", "threads_manage_insights"];
export const REFRESH_BEFORE_DAYS = 10;

export class ConnectError extends Error {}

export const expiresAt = (seconds: unknown, now = Date.now()): string | null => {
  const s = num(typeof seconds === "string" ? Number(seconds) : seconds);
  return s ? new Date(now + s * 1000).toISOString() : null;
};

export function daysLeft(expires: string | null, now = Date.now()): number | null {
  if (!expires) return null;
  return (new Date(expires).getTime() - now) / 86_400_000;
}

export type MetaApp = { appId: string; appSecret: string; graphVersion: string };
export type ThreadsApp = { appId: string; appSecret: string };

// ---- Meta ---------------------------------------------------------------------

export function metaAuthorizeUrl(app: MetaApp, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: app.appId, redirect_uri: redirectUri, state, response_type: "code", scope: META_SCOPES.join(","),
  });
  return `https://www.facebook.com/${app.graphVersion}/dialog/oauth?${q}`;
}

export type MetaPage = { pageId: string; name: string; accessToken: string; igUserId: string; igUsername: string };

export async function metaExchangeCode(app: MetaApp, code: string, redirectUri: string, http?: HttpOptions) {
  const c = new HttpClient(`https://graph.facebook.com/${app.graphVersion}`, http);
  const short = await c.get("oauth/access_token", {
    client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code,
  });
  // 短期ユーザートークン → 長期ユーザートークン
  const long = await c.get("oauth/access_token", {
    grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret,
    fb_exchange_token: str(short.access_token),
  });
  const userToken = str(long.access_token);
  const me = await c.get("me", { fields: "id", access_token: userToken });
  const resp = await c.get<{ data?: Record<string, unknown>[] }>("me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}", limit: 100, access_token: userToken,
  });
  const pages: MetaPage[] = (resp.data ?? []).map((p) => {
    const ig = (p.instagram_business_account ?? {}) as Record<string, unknown>;
    return { pageId: str(p.id), name: str(p.name), accessToken: str(p.access_token), igUserId: str(ig.id), igUsername: str(ig.username) };
  });
  return { userId: str(me.id), pages };
}

// ---- Threads ------------------------------------------------------------------

/** profileDiscovery：競合のフォロワー数を取るための threads_profile_discovery も求める（アプリレビューで承認済みの場合のみ） */
export function threadsAuthorizeUrl(app: ThreadsApp, redirectUri: string, state: string, profileDiscovery = false): string {
  const scopes = profileDiscovery ? [...THREADS_SCOPES, "threads_profile_discovery"] : THREADS_SCOPES;
  const q = new URLSearchParams({
    client_id: app.appId, redirect_uri: redirectUri, scope: scopes.join(","), response_type: "code", state,
  });
  return `https://threads.com/oauth/authorize?${q}`;
}

export async function threadsExchangeCode(app: ThreadsApp, code: string, redirectUri: string, http?: HttpOptions) {
  const c = new HttpClient("https://graph.threads.net", http);
  const short = await c.post("https://graph.threads.com/oauth/access_token", {
    client_id: app.appId, client_secret: app.appSecret, grant_type: "authorization_code",
    redirect_uri: redirectUri, code: code.split("#")[0], // 末尾に #_ が付くことがある
  });
  const long = await c.get("access_token", {
    grant_type: "th_exchange_token", client_secret: app.appSecret, access_token: str(short.access_token),
  });
  const token = str(long.access_token);
  const prof = await c.get("v1.0/me", { fields: "id,username", access_token: token });
  return {
    userId: str(prof.id) || String(short.user_id ?? ""),
    username: str(prof.username),
    accessToken: token,
    expiresAt: expiresAt(long.expires_in),
  };
}

/** 長期トークンを延長（発行から24時間以上・期限切れ前のみ可能） */
export async function threadsRefresh(token: string, http?: HttpOptions) {
  const c = new HttpClient("https://graph.threads.net", http);
  const resp = await c.get("refresh_access_token", { grant_type: "th_refresh_token", access_token: token });
  return { accessToken: str(resp.access_token), expiresAt: expiresAt(resp.expires_in) };
}

export const needsRefresh = (expires: string | null, now = Date.now()) => {
  const left = daysLeft(expires, now);
  return left !== null && left > 0 && left < REFRESH_BEFORE_DAYS;
};

// ---- X ------------------------------------------------------------------------

export async function xVerify(bearerToken: string, username: string, http?: HttpOptions) {
  const c = new HttpClient("https://api.x.com/2", { ...http, headers: { Authorization: `Bearer ${bearerToken}` } });
  const handle = username.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new ConnectError("X のユーザー名は、英数字と「_」の15文字以内で入力してください");
  const user = (await c.get<{ data: Record<string, unknown> }>(`users/by/username/${handle}`, { "user.fields": "public_metrics" })).data;
  return { userId: str(user.id), username: str(user.username) };
}

// ---- 接続確認 -----------------------------------------------------------------

/** Meta のトークン失効系エラーか */
export function isTokenError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401) return true;
  const err = (e.payload as { error?: { code?: number } } | null)?.error;
  return typeof err === "object" && err !== null && [190, 102, 463, 467].includes(Number(err.code));
}

export type CheckResult = { ok: boolean; account: string; followers: number | null; message: string };

/** 軽量なプロフィール取得で接続を確認する。投稿は取得しない */
export async function checkConnection(
  platform: Platform, cfg: { externalId: string; username: string; accessToken: string; expiresAt: string | null },
  graphVersion: string, http?: HttpOptions,
): Promise<CheckResult> {
  try {
    let account = "";
    let followers: number | null = null;
    if (platform === "instagram" || platform === "facebook") {
      const c = new HttpClient(`https://graph.facebook.com/${graphVersion}`, { ...http, queryAuth: { access_token: cfg.accessToken } });
      if (platform === "instagram") {
        const r = await c.get(cfg.externalId, { fields: "username,followers_count" });
        account = str(r.username);
        followers = num(r.followers_count);
      } else {
        const r = await c.get(cfg.externalId, { fields: "name,followers_count,fan_count" });
        account = str(r.name);
        followers = num(r.followers_count) || num(r.fan_count);
      }
    } else if (platform === "threads") {
      const c = new HttpClient("https://graph.threads.net/v1.0", { ...http, queryAuth: { access_token: cfg.accessToken } });
      account = str((await c.get(cfg.externalId || "me", { fields: "username" })).username);
    } else {
      const c = new HttpClient("https://api.x.com/2", { ...http, headers: { Authorization: `Bearer ${cfg.accessToken}` } });
      const path = cfg.externalId ? `users/${cfg.externalId}` : `users/by/username/${cfg.username}`;
      const r = (await c.get<{ data: Record<string, unknown> }>(path, { "user.fields": "public_metrics" })).data;
      account = str(r.username);
      followers = num((r.public_metrics as Record<string, unknown> | undefined)?.followers_count);
    }
    const left = daysLeft(cfg.expiresAt);
    let message = left === null ? "正常に連携できています" : `正常に連携できています（トークンの有効期限まであと${Math.max(0, Math.floor(left))}日）`;
    if (left !== null && left < REFRESH_BEFORE_DAYS) message += "。まもなく期限が切れるため、自動で延長を試みます";
    return { ok: true, account, followers, message };
  } catch (e) {
    let message = e instanceof Error ? e.message : "確認できませんでした";
    if (isTokenError(e)) message += "（トークンが無効です。もう一度連携してください）";
    return { ok: false, account: cfg.username, followers: null, message };
  }
}
