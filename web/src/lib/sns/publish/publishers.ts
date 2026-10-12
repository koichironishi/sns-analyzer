/**
 * 各SNSへの投稿。
 * 画像は公開URL（Supabase Storage）で渡す。Instagram・Threads は「入れ物（コンテナ）」を作ってから公開する2段階方式。
 */
import { ApiError, HttpClient, str, type HttpOptions } from "../collectors/http.ts";
import type { Platform } from "../models.ts";

export type PublishInput = { text: string; imageUrls: string[] };
export type PublishResult = { externalId: string; permalink: string | null };
export type PublishConfig = { platform: Platform; externalId: string; accessToken: string };
export type PublishDeps = { graphVersion?: string; http?: HttpOptions; sleep?: (ms: number) => Promise<void>; fetchImage?: (url: string) => Promise<Blob> };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 投稿の権限がない（連携し直しが必要な）エラーか */
export function isPermissionError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 401 || e.status === 403) return true;
  const code = Number((e.payload as { error?: { code?: number } } | null)?.error?.code);
  return code === 10 || (code >= 200 && code <= 299) || code === 190;
}

/** 失敗の理由を、画面に出せる文章にする */
export function publishErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : "不明なエラー";
  return isPermissionError(e) ? `${msg}（投稿の権限がありません。「設定・連携」で、投稿の許可を含めてもう一度連携してください）` : msg;
}

/** コンテナの準備ができるまで待つ（Instagram: status_code、Threads: status） */
async function waitReady(http: HttpClient, containerId: string, field: "status_code" | "status", sleep: (ms: number) => Promise<void>, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const r = await http.get(containerId, { fields: field === "status" ? "status,error_message" : "status_code" });
    const st = str(r[field]);
    if (st === "FINISHED" || st === "PUBLISHED") return;
    if (st === "ERROR" || st === "EXPIRED") throw new ApiError(`画像の処理に失敗しました（${str(r.error_message) || st}）`);
    await sleep(2000);
  }
  throw new ApiError("画像の処理に時間がかかっています。しばらくしてから再投稿してください");
}

// ---- Instagram -------------------------------------------------------------------

export async function publishInstagram(cfg: PublishConfig, input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  const http = new HttpClient(`https://graph.facebook.com/${deps.graphVersion ?? "v26.0"}`, { ...deps.http, queryAuth: { access_token: cfg.accessToken } });
  const sleep = deps.sleep ?? defaultSleep;
  const ig = cfg.externalId;
  if (!input.imageUrls.length) throw new ApiError("Instagram には画像が必要です");
  let creationId: string;
  if (input.imageUrls.length === 1) {
    creationId = str((await http.post(`${ig}/media`, { image_url: input.imageUrls[0], caption: input.text })).id);
  } else {
    const children: string[] = [];
    for (const url of input.imageUrls) {
      children.push(str((await http.post(`${ig}/media`, { image_url: url, is_carousel_item: "true" })).id));
    }
    for (const c of children) await waitReady(http, c, "status_code", sleep);
    creationId = str((await http.post(`${ig}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: input.text })).id);
  }
  await waitReady(http, creationId, "status_code", sleep);
  const id = str((await http.post(`${ig}/media_publish`, { creation_id: creationId })).id);
  const permalink = await http.get(id, { fields: "permalink" }).then((r) => str(r.permalink) || null).catch(() => null);
  return { externalId: id, permalink };
}

// ---- Facebook ページ ----------------------------------------------------------------

export async function publishFacebook(cfg: PublishConfig, input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  const http = new HttpClient(`https://graph.facebook.com/${deps.graphVersion ?? "v26.0"}`, { ...deps.http, queryAuth: { access_token: cfg.accessToken } });
  const page = cfg.externalId;
  let postId: string;
  if (input.imageUrls.length === 1) {
    const r = await http.post(`${page}/photos`, { url: input.imageUrls[0], caption: input.text, published: "true" });
    postId = str(r.post_id) || str(r.id);
  } else if (input.imageUrls.length > 1) {
    // 複数枚は、非公開の写真として上げてから1つの投稿にまとめる
    const form: Record<string, string> = { message: input.text };
    for (let i = 0; i < input.imageUrls.length; i++) {
      const photo = await http.post(`${page}/photos`, { url: input.imageUrls[i], published: "false" });
      form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: str(photo.id) });
    }
    postId = str((await http.post(`${page}/feed`, form)).id);
  } else {
    postId = str((await http.post(`${page}/feed`, { message: input.text })).id);
  }
  const permalink = await http.get(postId, { fields: "permalink_url" }).then((r) => str(r.permalink_url) || null).catch(() => null);
  return { externalId: postId, permalink };
}

// ---- Threads -----------------------------------------------------------------------

export async function publishThreads(cfg: PublishConfig, input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  const http = new HttpClient("https://graph.threads.net/v1.0", { ...deps.http, queryAuth: { access_token: cfg.accessToken } });
  const sleep = deps.sleep ?? defaultSleep;
  const uid = cfg.externalId || "me";
  let creationId: string;
  if (input.imageUrls.length === 0) {
    creationId = str((await http.post(`${uid}/threads`, { media_type: "TEXT", text: input.text })).id);
  } else if (input.imageUrls.length === 1) {
    creationId = str((await http.post(`${uid}/threads`, { media_type: "IMAGE", image_url: input.imageUrls[0], text: input.text })).id);
  } else {
    const children: string[] = [];
    for (const url of input.imageUrls) {
      children.push(str((await http.post(`${uid}/threads`, { media_type: "IMAGE", image_url: url, is_carousel_item: "true" })).id));
    }
    for (const c of children) await waitReady(http, c, "status", sleep);
    creationId = str((await http.post(`${uid}/threads`, { media_type: "CAROUSEL", children: children.join(","), text: input.text })).id);
  }
  await waitReady(http, creationId, "status", sleep);
  const id = str((await http.post(`${uid}/threads_publish`, { creation_id: creationId })).id);
  const permalink = await http.get(id, { fields: "permalink" }).then((r) => str(r.permalink) || null).catch(() => null);
  return { externalId: id, permalink };
}

// ---- X -----------------------------------------------------------------------------

/** X に投稿する（ユーザーとして連携したトークンが必要。アプリの Bearer Token では投稿できない） */
export async function publishX(cfg: PublishConfig & { username: string }, input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  const http = new HttpClient("https://api.x.com/2", { ...deps.http, headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  const fetchImage = deps.fetchImage ?? (async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new ApiError(`画像を読み込めませんでした（HTTP ${res.status}）`);
    return res.blob();
  });
  const mediaIds: string[] = [];
  for (const url of input.imageUrls) {
    const form = new FormData();
    form.set("media", await fetchImage(url), "image.jpg");
    form.set("media_category", "tweet_image");
    const r = await http.postMultipart<{ data?: { id?: string }; media_id_string?: string }>("media/upload", form);
    const id = r.data?.id ?? r.media_id_string;
    if (!id) throw new ApiError("画像をアップロードできませんでした");
    mediaIds.push(id);
  }
  const body: Record<string, unknown> = { text: input.text };
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  const r = await http.postJson<{ data?: { id?: string } }>("tweets", body);
  const id = r.data?.id;
  if (!id) throw new ApiError("投稿の結果を確認できませんでした");
  return { externalId: id, permalink: `https://x.com/${cfg.username || "i"}/status/${id}` };
}

export async function publishTo(cfg: PublishConfig & { username: string }, input: PublishInput, deps: PublishDeps = {}): Promise<PublishResult> {
  switch (cfg.platform) {
    case "instagram": return publishInstagram(cfg, input, deps);
    case "facebook": return publishFacebook(cfg, input, deps);
    case "threads": return publishThreads(cfg, input, deps);
    case "x": return publishX(cfg, input, deps);
  }
}
