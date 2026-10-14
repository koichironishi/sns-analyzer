import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze, bestTimes } from "../src/lib/sns/analysis.ts";
import { checkConnection, isTokenError, metaExchangeCode, needsRefresh, threadsExchangeCode, xVerify } from "../src/lib/sns/connect.ts";
import { ApiError } from "../src/lib/sns/collectors/http.ts";
import { aiMarkdown, crc32, downloads, toCsv, zip, type DownloadName } from "../src/lib/sns/export.ts";
import { parseCsv, parseDateTime, readCsv } from "../src/lib/sns/importers.ts";
import { CONSENT_VERSION, consentState, parseSignedRequest } from "../src/lib/sns/privacy.ts";
import { emptyMetrics, nextWeekdayAt, type Post } from "../src/lib/sns/models.ts";
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

test("SNSの絞り込み：選んだSNSの投稿・フォロワー・競合だけ残す", async () => {
  const { filterReportData, reportPlatforms } = await import("../src/lib/sns/store.ts");
  const post = (id: string, platform: Post["platform"], postedAt: string): Post => ({
    id, accountId: `a-${platform}`, platform, externalId: id, postedAt, text: "", mediaType: "image", permalink: null, metrics: emptyMetrics(),
  });
  const data = {
    ownPosts: [post("1", "instagram", "2026-10-01T00:00:00Z"), post("2", "facebook", "2026-10-02T00:00:00Z")],
    ownStories: [{ ...post("s1", "x", "2026-10-03T00:00:00Z"), contentType: "story" as const }],
    ownFollowers: { instagram: [["2026-10-01", 100]], facebook: [["2026-10-01", 50]] } as never,
    ownNames: { instagram: "ig", facebook: "fb", threads: "th" },
    competitors: [{ id: "c1", platform: "instagram" as const, competitorName: "A", username: "a", series: [], posts: [] },
      { id: "c2", platform: "x" as const, competitorName: "B", username: "b", series: [], posts: [] }],
    competitorList: [], hasData: true, lastPostDate: "2026-10-02",
    ownAccounts: [{ id: "a-instagram", platform: "instagram" as const, name: "ig" }, { id: "a-facebook", platform: "facebook" as const, name: "fb" }],
    ownFollowersByAccount: { "a-instagram": [["2026-10-01", 100]], "a-facebook": [["2026-10-01", 50]] } as never,
  };
  assert.deepEqual(reportPlatforms(data), ["instagram", "facebook", "threads", "x"]);
  assert.equal(filterReportData(data, null), data);
  const ig = filterReportData(data, "instagram");
  assert.deepEqual(ig.ownPosts.map((p) => p.id), ["1"]);
  assert.deepEqual(ig.ownStories, []);
  assert.equal(filterReportData(data, "x").hasData, true);
  assert.deepEqual(Object.keys(ig.ownFollowers), ["instagram"]);
  assert.deepEqual(ig.ownNames, { instagram: "ig" });
  assert.deepEqual(ig.competitors.map((c) => c.id), ["c1"]);
  assert.equal(ig.lastPostDate, "2026-10-01");
  const th = filterReportData(data, "threads");
  assert.equal(th.hasData, false);
});

test("複数アカウント：アカウントで絞り込むと、そのアカウントの投稿とフォロワーだけ残す", async () => {
  const { filterReportData } = await import("../src/lib/sns/store.ts");
  const post = (id: string, accountId: string): Post => ({
    id, accountId, platform: "instagram", externalId: id, postedAt: "2026-10-01T00:00:00Z", text: "", mediaType: "image", permalink: null, metrics: emptyMetrics(),
  });
  const data = {
    ownPosts: [post("1", "A"), post("2", "B"), post("3", "A")], ownStories: [],
    ownFollowers: { instagram: [["2026-10-01", 300]] } as never, ownNames: { instagram: "2アカウント" },
    ownAccounts: [{ id: "A", platform: "instagram" as const, name: "shop_a" }, { id: "B", platform: "instagram" as const, name: "shop_b" }],
    ownFollowersByAccount: { A: [["2026-10-01", 100]], B: [["2026-10-01", 200]] } as never,
    competitors: [], competitorList: [], hasData: true, lastPostDate: "2026-10-01",
  };
  const all = filterReportData(data, "instagram");
  assert.equal(all.ownPosts.length, 3);
  assert.deepEqual(all.ownFollowers.instagram, [["2026-10-01", 300]]);
  const b = filterReportData(data, "instagram", "B");
  assert.deepEqual(b.ownPosts.map((p) => p.id), ["2"]);
  assert.deepEqual(b.ownFollowers.instagram, [["2026-10-01", 200]]);
  assert.deepEqual(b.ownNames, { instagram: "shop_b" });
  // 別のSNSのアカウントを指定されたら、SNS全体として扱う
  assert.equal(filterReportData(data, "instagram", "nope").ownPosts.length, 3);
});

test("複数アカウント：フォロワー推移の合計は、収集日のずれを前の値で埋めて足す", async () => {
  const { sumSeries } = await import("../src/lib/sns/store.ts");
  assert.deepEqual(sumSeries([[["2026-10-01", 100], ["2026-10-03", 110]], [["2026-10-02", 50], ["2026-10-03", 60]]]),
    [["2026-10-01", 100], ["2026-10-02", 150], ["2026-10-03", 170]]);
  assert.deepEqual(sumSeries([[["2026-10-01", 5]]]), [["2026-10-01", 5]]);
});

test("この期間のポイント：フォロワーが±0人のときは「伸びが最も大きい」「要対応」と書かない", async () => {
  const { generateInsights } = await import("../src/lib/sns/analysis.ts");
  const sum = (label: string, delta: number, growth: number) => ({ label, followersDelta: delta, followersGrowth: growth, erFollowers: null, change: {}, posts: 0 });
  const make = (summary: Record<string, unknown>) => ({ platforms: Object.keys(summary), summary, heatmap: {}, media: [], hashtags: [], topPosts: [], total: { change: {} } } as never);
  const flat = generateInsights(make({ instagram: sum("Instagram", 0, 0), facebook: sum("Facebook", 0, 0) }));
  assert.ok(!flat.some((i) => i.text.includes("フォロワー")));
  const mixed = generateInsights(make({ instagram: sum("Instagram", 30, 0.05), facebook: sum("Facebook", -4, -0.02) }));
  assert.ok(mixed.some((i) => i.kind === "good" && i.text.includes("最も大きいのはInstagram（+30人")));
  assert.ok(mixed.some((i) => i.kind === "warn" && i.text.includes("Facebookのフォロワーが減っています（-4人")));
  const one = generateInsights(make({ instagram: sum("Instagram", 12, 0.01) }));
  assert.ok(one.some((i) => i.text.startsWith("Instagramのフォロワーが伸びました（+12人")));
});

test("予約時刻のおすすめ：件数が足りて普段より良い枠だけを、良い順に選ぶ", () => {
  const grid = <T,>(v: T) => Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => v));
  const score = grid<number | null>(null), count = grid(0);
  score[2][6] = 150; count[2][6] = 4; // 水 18〜21時
  score[5][4] = 130; count[5][4] = 3; // 土 12〜15時
  score[0][3] = 200; count[0][3] = 2; // 件数不足
  score[1][7] = 105; count[1][7] = 9; // 普段とほぼ同じ
  const r = bestTimes({ all: undefined, instagram: { score, count } } as never, ["instagram", "x"]);
  assert.deepEqual(r.map((b) => [b.label, b.hour, b.ratio]), [["水曜 18〜21時", 18, 1.5], ["土曜 12〜15時", 12, 1.3]]);
});

test("次のその曜日・時刻（日本時間）を返し、間に合わなければ翌週にする", () => {
  const now = new Date("2026-10-14T08:00:00+09:00").getTime(); // 水曜 8:00
  assert.equal(nextWeekdayAt(2, 18, now), "2026-10-14T18:00");
  assert.equal(nextWeekdayAt(2, 6, now), "2026-10-21T06:00");
  assert.equal(nextWeekdayAt(2, 8, now), "2026-10-21T08:00");
  assert.equal(nextWeekdayAt(5, 12, now), "2026-10-17T12:00");
});
