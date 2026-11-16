import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "@supabase/supabase-js";
import { cleanCode, mfaState, readAal, safeNext } from "../src/lib/mfa.ts";

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const user = (factors: { status: string }[]) => ({ factors }) as unknown as User;

test("多要素認証：登録していない人は今までどおり通す", () => {
  assert.deepEqual(mfaState(user([]), jwt({ aal: "aal1" })), { enrolled: false, satisfied: true });
  assert.deepEqual(mfaState(user([{ status: "unverified" }]), jwt({ aal: "aal1" })), { enrolled: false, satisfied: true }, "設定の途中（未確認）は登録に数えない");
});

test("多要素認証：登録した人は aal2 でなければ止める", () => {
  assert.deepEqual(mfaState(user([{ status: "verified" }]), jwt({ aal: "aal1" })), { enrolled: true, satisfied: false });
  assert.deepEqual(mfaState(user([{ status: "verified" }]), jwt({ aal: "aal2" })), { enrolled: true, satisfied: true });
});

test("多要素認証：トークンの aal を読む（壊れていれば null）", () => {
  assert.equal(readAal(jwt({ aal: "aal2" })), "aal2");
  assert.equal(readAal("broken"), null);
  assert.equal(readAal(null), null);
});

test("多要素認証：確認コードは全角・空白・ハイフンを直して6桁に", () => {
  assert.equal(cleanCode("１２３ ４５６"), "123456");
  assert.equal(cleanCode("123-456"), "123456");
  assert.equal(cleanCode("1234567"), "123456");
});

test("多要素認証：戻り先は自サイトの中だけ", () => {
  assert.equal(safeNext("/clients/x"), "/clients/x");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext(undefined), "/");
});
