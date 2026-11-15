import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * SNS の連携トークン（Instagram・Facebook のページトークン、Threads・X のトークン）を、
 * データベースに入れる前に暗号化する（AES-256-GCM。MEO の secret-box と同じ形式。2026-11-16）。
 *
 * **守れるのは「データベースだけが漏れたとき」。**
 * 鍵は Vercel の環境変数（TOKEN_ENCRYPTION_KEY）に置き、データベースには入れない。
 * そのため service_role キーが漏れても、トークンそのものは読めない。
 * Vercel の環境変数ごと漏れれば鍵も一緒に出るので守れない。
 * Supabase Vault を使わないのは、鍵が Supabase の中に置かれ、守りたい事態に効かないため。
 *
 * **鍵を失っても致命傷にはならない。** 連携し直せば回復できる。
 *
 * 移行中は平文と暗号文が混ざる。`v1.` で始まるものだけを復号し、それ以外は平文として扱う。
 * 既存の値は scripts/encrypt-tokens.mjs で一度だけ包み直す。
 */
const PREFIX = "v1.";

/** 鍵。未設定なら null（今までどおり平文で扱う。止めるほうが害が大きいため。状態は全体設定に出す） */
function key(): Buffer | null {
  const raw = (process.env.TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  // 短い鍵で動いてしまうと、暗号化したつもりで弱いまま運用が続く
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY は base64 で 32 バイトにしてください");
  return buf;
}

/** 暗号化が有効か（鍵が正しく入っているか） */
export function secretsEncrypted(): boolean {
  try {
    return key() !== null;
  } catch {
    return false;
  }
}

/** 保存する直前に通す。鍵がなければ素通し（平文のまま） */
export function sealSecret(plain: string): string;
export function sealSecret(plain: string | null | undefined): string | null;
export function sealSecret(plain: string | null | undefined): string | null {
  if (!plain) return plain ?? null;
  const k = key();
  if (!k || plain.startsWith(PREFIX)) return plain; // 二重に包まない
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  // base64url は "." を含まないので、区切りに使っても衝突しない
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

/** 読み出した直後に通す。平文（移行前）はそのまま返す。復号できなければ null（「連携し直す」で回復する） */
export function openSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored;
  const k = key();
  if (!k) {
    // 暗号化して保存したあとに鍵を外した状態。黙って暗号文を API に送らない
    console.error("TOKEN_ENCRYPTION_KEY が未設定のため、暗号化されたトークンを読めません");
    return null;
  }
  try {
    const [, ivB, tagB, ctB] = stored.split(".");
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(ivB, "base64url"));
    d.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8");
  } catch (e) {
    console.error("トークンの復号に失敗しました:", e instanceof Error ? e.message : e);
    return null;
  }
}
