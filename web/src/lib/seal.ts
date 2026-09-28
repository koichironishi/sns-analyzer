import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * 短時間だけブラウザに預けるデータ（OAuth の state、選択前のページ一覧など）を暗号化する。
 * 鍵は service_role キーから導出するため、追加の環境変数は不要。
 */
function key(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("SUPABASE_SERVICE_ROLE_KEY が設定されていません");
  return createHash("sha256").update(`sns-analyzer-seal:${secret}`).digest();
}

export function seal(data: unknown, ttlSeconds: number): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify({ d: data, exp: Date.now() + ttlSeconds * 1000 }), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(token: string | undefined): T | null {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, "base64url");
    const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as { d: T; exp: number };
    return obj.exp > Date.now() ? obj.d : null;
  } catch {
    return null;
  }
}
