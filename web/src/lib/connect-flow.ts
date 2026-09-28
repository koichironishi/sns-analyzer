import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { seal, unseal } from "@/lib/seal";
import type { MetaPage } from "@/lib/sns/connect";

const STATE_COOKIE = "sns_oauth";
export const PAGES_COOKIE = "sns_meta_pages";
const secure = process.env.NODE_ENV === "production";

type OAuthState = { state: string; clientId: string; service: "meta" | "threads"; userId: string };

export async function startOAuth(service: OAuthState["service"], clientId: string, userId: string): Promise<string> {
  const state = randomBytes(16).toString("base64url");
  (await cookies()).set(STATE_COOKIE, seal({ state, clientId, service, userId } satisfies OAuthState, 600), {
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

type PendingPages = { clientId: string; userId: string; metaUserId: string; pages: MetaPage[] };

export async function stashPages(p: PendingPages) {
  (await cookies()).set(PAGES_COOKIE, seal(p, 900), { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 900 });
}

export async function readPages(): Promise<PendingPages | null> {
  return unseal<PendingPages>((await cookies()).get(PAGES_COOKIE)?.value);
}

export async function clearPages() {
  (await cookies()).delete(PAGES_COOKIE);
}

export function metaApp() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : null;
}

export function threadsApp() {
  const appId = process.env.THREADS_APP_ID;
  const appSecret = process.env.THREADS_APP_SECRET;
  return appId && appSecret ? { appId, appSecret } : null;
}
