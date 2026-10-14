import assert from "node:assert/strict";
import { test } from "node:test";
import { checkImportInput, hashKey, newImportKey } from "../src/lib/sns/import-posts.ts";

const CID = "10000000-0000-0000-0000-00000000000a";
const img = (n: number) => Array.from({ length: n }, (_, i) => `${CID}/00000000-0000-0000-0000-00000000000${i}.jpg`);
const NOW = Date.parse("2026-10-14T00:00:00Z");
const base = { ref: "rhythmos-ai:flat7:2026-10-26:第11弾", text: "本文 #フラット7滋賀", platforms: ["instagram", "facebook"], scheduledAt: "2026-10-26T21:00:00+09:00", mediaPaths: img(6) };

test("合言葉：形式と、保存する値（SHA-256）が合言葉と一致すること", () => {
  const k = newImportKey();
  assert.match(k.key, /^rsk_[A-Za-z0-9_-]{43}$/);
  assert.equal(k.hash, hashKey(k.key));
  assert.equal(k.hint, k.key.slice(-4));
  assert.notEqual(newImportKey().key, k.key);
});

test("登録の入力：正しい入力は通り、掲載日時を UTC にそろえる", () => {
  const r = checkImportInput(CID, base, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.scheduledAt, "2026-10-26T12:00:00.000Z");
  assert.deepEqual(r.platforms, ["instagram", "facebook"]);
});

test("登録の入力：過去の日時・タイムゾーンなし・他社の画像・知らないSNS・画像なしは弾く", () => {
  const errs = (patch: object) => checkImportInput(CID, { ...base, ...patch }, NOW).errors;
  assert.ok(errs({ scheduledAt: "2026-10-01T21:00:00+09:00" }).some((e) => e.includes("過去")));
  assert.ok(errs({ scheduledAt: "2026-10-26T21:00:00" }).some((e) => e.includes("タイムゾーン")));
  assert.ok(errs({ mediaPaths: ["20000000-0000-0000-0000-00000000000b/00000000-0000-0000-0000-000000000000.jpg"] }).some((e) => e.includes("画像")));
  assert.ok(errs({ platforms: ["instagram", "tiktok"] }).some((e) => e.includes("投稿先")));
  // Instagram は画像が1枚以上必要
  assert.ok(errs({ mediaPaths: [] }).length > 0);
  assert.ok(errs({ ref: "" }).some((e) => e.includes("ref")));
});
