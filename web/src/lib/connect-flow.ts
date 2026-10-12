import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { seal, unseal } from "@/lib/seal";

const STATE_COOKIE = "sns_oauth";
export const PAGES_COOKIE = "sns_meta_pages";
const secure = process.env.NODE_ENV === "production";

type OAuthState = { state: string; clientId: string; service: "meta" | "threads" | "x"; userId: string; verifier?: string };

export async function startOAuth(service: OAuthState["service"], clientId: string, userId: string, verifier?: string): Promise<string> {
  const state = randomBytes(16).toString("base64url");
  (await cookies()).set(STATE_COOKIE, seal({ state, clientId, service, userId, verifier } satisfies OAuthState, 600), {
    httpOnly: true, secure, sameSite: "lax", path: "/api/connect", maxAge: 600,
  });
  return state;
}

/** コールバックで state を照合する。一致しなければ null */
export async function finishOAuth(service: OAuthState["service"], state: string | null, userId: string): Promise<OAuthState | null> {
  const jar = await cookies();
  const saved = unseal<OAuthState>(jar.get(STATE_COOKIE)?.value);
  jar.delete({ name: STATE_COOKIE, path: "/api/connect" });
  if (!saved || !state || saved.state !== state || saved.service !== service || saved.userId !== userId) return null;
  return saved;
}

/** ページの選択待ち。Cookie は約4KBまでなので、ページごとのトークンではなく利用者のトークンだけを預け、一覧は画面で取り直す */
type PendingPages = { clientId: string; userId: string; metaUserId: string; userToken: string; granted: string[] };

export async function stashPages(p: PendingPages) {
  (await cookies()).set(PAGES_COOKIE, seal(p, 900), { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 900 });
}

export async function readPages(): Promise<PendingPages | null> {
  return unseal<PendingPages>((await cookies()).get(PAGES_COOKIE)?.value);
}

/** 選択待ちの情報を確認する。読めない場合は理由（画面に出して原因を調べるため）を返す */
export async function checkPending(clientId: string, userId: string): Promise<{ ok: true; pending: PendingPages } | { ok: false; reason: string }> {
  const raw = (await cookies()).get(PAGES_COOKIE)?.value;
  if (!raw) return { ok: false, reason: "nocookie" };
  const pending = unseal<PendingPages>(raw);
  if (!pending) return { ok: false, reason: `unseal${raw.length}` };
  if (pending.clientId !== clientId) return { ok: false, reason: "client" };
  if (pending.userId !== userId) return { ok: false, reason: "user" };
  return { ok: true, pending };
}

export async function clearPages() {
  (await cookies()).delete(PAGES_COOKIE);
}

export function metaApp() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  return appId && appSecret ? { appId, appSecret, configId: process.env.META_CONFIG_ID || undefined } : null;
}

export function threadsApp() {
  const appId = process.env.THREADS_APP_ID;
  const appSecret = process.env.THREADS_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : null;
}

export function xApp() {
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
