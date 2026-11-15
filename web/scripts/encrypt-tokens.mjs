#!/usr/bin/env node
/**
 * データベースに平文で入っている SNS の連携トークンを、一度だけ暗号化し直す（2026-11-16）。
 *
 * アプリは保存時に暗号化・読み出し時に復号するようになったが、それより前に保存された値は
 * 平文のまま残る。これを包み直す。何度実行しても安全（"v1." で始まるものは飛ばす）。
 *
 * 使い方（web フォルダで）:
 *   export NEXT_PUBLIC_SUPABASE_URL='https://xxxx.supabase.co'
 *   export SUPABASE_SERVICE_ROLE_KEY='...'
 *   export TOKEN_ENCRYPTION_KEY='...'      # Vercel（sns-analyzer）に入れたものと同じ値
 *   node scripts/encrypt-tokens.mjs
 *
 * **Vercel に入れる鍵と同じものを使うこと。** 違う鍵で包むと、アプリから復号できなくなる
 * （連携し直せば復旧はする）。鍵の作り方: openssl rand -base64 32
 */
import { createCipheriv, randomBytes } from "node:crypto";

function must(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) { console.error(`${name} が未設定です`); process.exit(1); }
  return v;
}
const URL_ = must("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE = must("SUPABASE_SERVICE_ROLE_KEY");
const KEY = Buffer.from(must("TOKEN_ENCRYPTION_KEY"), "base64");
if (KEY.length !== 32) { console.error("TOKEN_ENCRYPTION_KEY は base64 で 32 バイトにしてください"); process.exit(1); }

const PREFIX = "v1.";
function seal(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
async function rest(path, init) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const COLS = ["access_token", "refresh_token"];
const rows = await rest(`sns_connections?select=client_id,platform,external_id,${COLS.join(",")}`);
let done = 0, skipped = 0;
for (const row of rows) {
  const patch = {};
  for (const col of COLS) {
    const v = row[col];
    if (!v) continue;
    if (String(v).startsWith(PREFIX)) { skipped++; continue; }
    patch[col] = seal(String(v));
  }
  if (!Object.keys(patch).length) continue;
  const q = ["client_id", "platform", "external_id"].map((k) => `${k}=eq.${encodeURIComponent(row[k])}`).join("&");
  await rest(`sns_connections?${q}`, { method: "PATCH", body: JSON.stringify(patch) });
  done += Object.keys(patch).length;
}
console.log(`sns_connections: ${done}件を暗号化、${skipped}件は暗号化済み（${rows.length}アカウント）`);
console.log("\n完了。SNS の「全体設定」で暗号化が「有効」になっていること、各クライアントの収集・投稿が動くことを確かめてください。");
