import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { openSecret, sealSecret, secretsEncrypted } from "../src/lib/secret-box.ts";

const withKey = (k: string | undefined, fn: () => void) => {
  const prev = process.env.TOKEN_ENCRYPTION_KEY;
  if (k === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = k;
  try { fn(); } finally { if (prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = prev; }
};
const KEY = randomBytes(32).toString("base64");

test("暗号化：鍵があれば v1. で包み、開くと元に戻る。同じ値でも毎回ちがう暗号文になる", () => withKey(KEY, () => {
  const a = sealSecret("EAAB-token");
  const b = sealSecret("EAAB-token");
  assert.ok(a.startsWith("v1."));
  assert.notEqual(a, b);
  assert.equal(openSecret(a), "EAAB-token");
  assert.equal(sealSecret(a), a, "二重に包まない");
  assert.equal(secretsEncrypted(), true);
}));

test("暗号化：鍵がなければ平文のまま（止めない）。移行前の平文はそのまま読める", () => withKey(undefined, () => {
  assert.equal(sealSecret("plain"), "plain");
  assert.equal(openSecret("plain"), "plain");
  assert.equal(secretsEncrypted(), false);
}));

test("暗号化：鍵がちがう・鍵を外した・値が壊れたときは null（暗号文を API に送らない）", () => {
  let sealed = "";
  withKey(KEY, () => { sealed = sealSecret("secret"); });
  withKey(randomBytes(32).toString("base64"), () => assert.equal(openSecret(sealed), null));
  withKey(undefined, () => assert.equal(openSecret(sealed), null));
  withKey(KEY, () => assert.equal(openSecret(sealed.slice(0, -4) + "AAAA"), null));
});

test("暗号化：32バイトでない鍵は無効として扱う", () => withKey(Buffer.from("short").toString("base64"), () => {
  assert.equal(secretsEncrypted(), false);
  assert.throws(() => sealSecret("x"), /32 バイト/);
}));
