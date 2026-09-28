import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze } from "../src/lib/sns/analysis.ts";
import { checkConnection, isTokenError, metaExchangeCode, needsRefresh, threadsExchangeCode, xVerify } from "../src/lib/sns/connect.ts";
import { ApiError } from "../src/lib/sns/collectors/http.ts";
import { aiMarkdown, crc32, downloads, toCsv, zip, type DownloadName } from "../src/lib/sns/export.ts";
import { parseCsv, parseDateTime, readCsv } from "../src/lib/sns/importers.ts";
import { CONSENT_VERSION, consentState, parseSignedRequest } from "../src/lib/sns/privacy.ts";
import { emptyMetrics, type Post } from "../src/lib/sns/models.ts";
import type { AiResult } from "../src/lib/sns/ai.ts";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("signed_request: 正しい署名だけ通す", () => {
  const payload = b64url(Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "123" })));
  const sig = b64url(createHmac("sha256", "sec").update(payload).digest());
  assert.equal(parseSignedRequest(`${sig}.${payload}`, "sec").user_id, "123");
  assert.throws(() => parseSignedRequest(`${sig}.${payload}`, "other"), /署名/);
  assert.throws(() => parseSignedRequest("abc", "sec"), /形式/);
  assert.throws(() => parseSignedRequest(`${sig}.${payload}`, ""), /署名/);
});

test("同意の状態：版が古いと再同意が必要", () => {
  const row = { status: "granted" as const, version: CONSENT_VERSION, granted_by: "a", granted_at: null, include_post_text: true, note: null, recorded_by: null, revoked_at: null };
  assert.equal(consentState(row).valid, true);
  assert.equal(consentState({ ...row, version: "old" }).outdated, true);
  assert.equal(consentState(null).status, "unset");
});

function fake(routes: Record<string, unknown>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => `${url.host}${url.pathname}`.endsWith(k));
    if (!key) return new Response(JSON.stringify({ error: { message: "nf", code: 190 } }), { status: 400 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { http: { fetch: fn, sleep: async () => {} }, calls };
}

test("Meta: コード→長期トークン→ページ一覧", async () => {
  let n = 0;
  const { http, calls } = fake({
    "/oauth/access_token": { get access_token() { return ++n === 1 ? "short" : "long"; } },
    "/me": { id: "u1" },
    "/me/accounts": { data: [{ id: "p1", name: "店", access_token: "pt", instagram_business_account: { id: "ig1", username: "shop" } }] },
  });
  const r = await metaExchangeCode({ appId: "a", appSecret: "s", graphVersion: "v26.0" }, "code", "https://x/cb", http);
  assert.equal(r.userId, "u1");
  assert.deepEqual(r.pages[0], { pageId: "p1", name: "店", accessToken: "pt", igUserId: "ig1", igUsername: "shop" });
  assert.equal(calls[1].url.searchParams.get("fb_exchange_token"), "short");
});

test("Threads: コード交換は POST、#_ を除去", async () => {
  const { http, calls } = fake({
    "graph.threads.com/oauth/access_token": { access_token: "s", user_id: 5 },
    "/access_token": { access_token: "L", expires_in: 5184000 },
    "/v1.0/me": { id: "5", username: "me" },
  });
  const r = await threadsExchangeCode({ appId: "a", appSecret: "s" }, "abc#_", "https://x/cb", http);
  assert.equal(r.accessToken, "L");
  assert.ok(r.expiresAt);
  assert.equal(calls[0].init.method, "POST");
  assert.match(String(calls[0].init.body), /code=abc(&|$)/);
});

test("X: ユーザー名の検証", async () => {
  const { http } = fake({ "/2/users/by/username/brand": { data: { id: "9", username: "brand" } } });
  assert.deepEqual(await xVerify("B", "@brand", http), { userId: "9", username: "brand" });
  await assert.rejects(xVerify("B", "bad name!", http), /ユーザー名/);
});

test("接続確認：トークン失効を判別", async () => {
  const { http } = fake({});
  const r = await checkConnection("instagram", { externalId: "1", username: "u", accessToken: "t", expiresAt: null }, "v26.0", http);
  assert.equal(r.ok, false);
  assert.match(r.message, /もう一度連携/);
  assert.equal(isTokenError(new ApiError("x", 401)), true);
  assert.equal(needsRefresh(new Date(Date.now() + 3 * 86400000).toISOString()), true);
  assert.equal(needsRefresh(new Date(Date.now() + 30 * 86400000).toISOString()), false);
});

test("CSV：エスケープと数式インジェクション対策", () => {
  assert.equal(toCsv(["a", "b"], [["x,y", '=HYPERLINK("z")'], [null, 3]]), 'a,b\r\n"x,y","\'=HYPERLINK(""z"")"\r\n,3\r\n');
});

test("取り込み：Shift_JIS・日本語列名・タイムゾーン", () => {
  const csv = "投稿日時,本文,いいね数,種類,インプレッション\r\n2026/09/01 09:00,\"こんにちは, 世界\",\"1,234\",リール,500\r\n";
  const sjis = new Uint8Array(execFileSync("iconv", ["-f", "UTF-8", "-t", "SHIFT_JIS"], { input: csv }));
  const posts = readCsv(sjis, "Asia/Tokyo");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].postedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(posts[0].text, "こんにちは, 世界");
  assert.equal(posts[0].metrics.likes, 1234);
  assert.equal(posts[0].mediaType, "reel");
  assert.equal(posts[0].metrics.views, 500);
  assert.equal(parseDateTime("2026-09-01T00:00:00+0900"), "2026-08-31T15:00:00.000Z");
  assert.equal(parseDateTime("09/01/2026 12:00", "UTC"), "2026-09-01T12:00:00.000Z");
  assert.deepEqual(parseCsv('a,"b\r\nc"\n\n1,2'), [["a", "b\r\nc"], ["1", "2"]]);
  assert.throws(() => readCsv(new TextEncoder().encode("foo,bar\n1,2")), /日時の列/);
});

test("ZIP：unzip で検証でき、日本語名と BOM 付き CSV を含む", () => {
  const post: Post = { id: "1", accountId: "a", platform: "instagram", externalId: "p1", postedAt: "2026-09-10T00:00:00.000Z",
    text: "hi #tag", mediaType: "image", permalink: null, metrics: { ...emptyMetrics(), likes: 5 } };
  const data = analyze([post], { instagram: [["2026-09-01", 100]] }, { days: 30, end: "2026-09-20" });
  const ai = { headline: "見出し", summary: "要約", question_answer: "", platforms: [], competitor_insights: [], content_insights: [],
    recommendations: [{ priority: "high", platform: "all", action: "a|b", reason: "r", expected_effect: "e" }], post_ideas: [], kpi_targets: [],
    _meta: { model: "m", generatedAt: "", question: "", postsSent: 1, postTextSent: true, consentBy: "", consentAt: "", inputTokens: 0, outputTokens: 0 } } as AiResult;
  const files = downloads(data, [post], { instagram: [["2026-09-01", 100]] }, null, ai, "店");
  assert.deepEqual(Object.keys(files).sort(), ["ai_analysis.md", "hashtags.csv", "media_types.csv", "posts.csv", "summary.csv"] satisfies DownloadName[]);
  assert.ok(files["posts.csv"]!.startsWith("﻿SNS,"));
  assert.match(aiMarkdown(ai, data), /a\\\|b/);
  const dir = mkdtempSync(join(tmpdir(), "zip"));
  writeFileSync(join(dir, "r.zip"), zip({ ...files, "日本語.txt": "テスト" }));
  const out = execFileSync("unzip", ["-t", join(dir, "r.zip")]).toString();
  assert.match(out, /No errors detected/);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});
