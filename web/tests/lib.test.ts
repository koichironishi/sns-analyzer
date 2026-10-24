import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze, bestTimes } from "../src/lib/sns/analysis.ts";
import { monthlyReminder, prepWindow, tokenStage, tokenWindowDays } from "../src/lib/sns/alert-rules.ts";
import { addUtm, hasLink } from "../src/lib/sns/publish/utm.ts";
import { readBulkCsv } from "../src/lib/sns/publish/bulk.ts";
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

test("予約時刻のおすすめ：5件以上あって普段より良い枠だけを、良い順に選ぶ", () => {
  const grid = <T,>(v: T) => Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => v));
  const score = grid<number | null>(null), count = grid(0);
  score[2][6] = 150; count[2][6] = 6; // 水 18〜21時
  score[5][4] = 130; count[5][4] = 5; // 土 12〜15時
  score[0][3] = 270; count[0][3] = 3; // 件数不足（3件の「2.7倍」は偶然の差かもしれない）
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

test("知らせのメール：期限の段階と、月次レポートの送り忘れの知らせの日", () => {
  assert.equal(tokenStage(null), null);
  assert.equal(tokenStage(10), null);
  assert.equal(tokenStage(6.5), "7");
  assert.equal(tokenStage(2.9), "3");
  assert.equal(tokenStage(0.5), "1");
  assert.equal(tokenStage(-3), "expired");
  assert.equal(tokenWindowDays("expired"), 7);
  assert.equal(tokenWindowDays("3"), 30);
  assert.deepEqual(monthlyReminder("2026-11-01"), { month: "2026-10", round: "first" });
  assert.deepEqual(monthlyReminder("2026-11-05"), { month: "2026-10", round: "second" });
  assert.deepEqual(monthlyReminder("2027-01-03"), { month: "2026-12", round: "first" });
  assert.equal(monthlyReminder("2026-10-14"), null);
});

test("月初の準備：1日は朝の収集のあと（8時から）、5日まで先月分を進める", () => {
  assert.equal(prepWindow("2026-11-01", 7), null);
  assert.deepEqual(prepWindow("2026-11-01", 8), { month: "2026-10" });
  assert.deepEqual(prepWindow("2026-11-03", 2), { month: "2026-10" });
  assert.deepEqual(prepWindow("2027-01-05", 23), { month: "2026-12" });
  assert.equal(prepWindow("2026-11-06", 9), null);
});

test("リンクに計測用の印（UTM）を付ける：SNSごと・既存の印は残す・句読点やかっこは含めない", () => {
  const id = "1234abcd-0000-0000-0000-000000000000";
  assert.equal(addUtm("詳しくは https://example.com/a?x=1 へ", "x", id),
    "詳しくは https://example.com/a?x=1&utm_source=x&utm_medium=social&utm_campaign=sns_post&utm_content=1234abcd へ");
  assert.equal(addUtm("（https://example.com/）。", "threads", id),
    "（https://example.com/?utm_source=threads&utm_medium=social&utm_campaign=sns_post&utm_content=1234abcd）。");
  assert.equal(addUtm("見てね https://example.com/#top.", "facebook", id),
    "見てね https://example.com/?utm_source=facebook&utm_medium=social&utm_campaign=sns_post&utm_content=1234abcd#top.");
  assert.equal(addUtm("https://example.com/?utm_source=lp", "x", id), "https://example.com/?utm_source=lp");
  assert.equal(addUtm("https://example.com/", "instagram", id), "https://example.com/");
  assert.equal(addUtm("リンクなし", "x", id), "リンクなし");
  assert.equal(hasLink("詳しくは https://example.com"), true);
  assert.equal(hasLink("詳しくはプロフィールから"), false);
});

test("ハッシュタグは小文字にそろえて数え、いちばん多く使われた書き方で出す", () => {
  const mk = (id: string, text: string, day: number): Post => ({
    id, accountId: "a", platform: "instagram", externalId: id, postedAt: `2026-09-${String(day).padStart(2, "0")}T03:00:00Z`, text,
    mediaType: "image", permalink: null, metrics: { ...emptyMetrics(), likes: 10 }, contentType: "post",
  });
  const posts = [mk("1", "新作 #Web制作", 1), mk("2", "実績 #Web制作", 2), mk("3", "告知 #web制作", 3)];
  const a = analyze(posts, {}, { days: 30, end: "2026-09-30" });
  const h = a.hashtags.find((x) => x.tag === "web制作")!;
  assert.equal(h.count, 3);
  assert.equal(h.display, "Web制作");
});

test("CSV一括予約：見出し・改行入りの本文・日本時間・過去や空欄のエラー・同じ日時の注意", () => {
  const now = new Date("2026-10-24T09:00:00+09:00").getTime();
  const csv = "配信日時,本文\r\n2026/11/01 12:00,\"1行目\r\n2行目\"\r\n2026/10/01 12:00,過去\r\n,日時なし\r\n2026/11/01 12:00,\r\n2026-11-01 12:00,同じ日時\r\nあした,読めない\r\n";
  const rows = readBulkCsv(new TextEncoder().encode(csv), now);
  assert.equal(rows.length, 6);
  assert.deepEqual([rows[0].line, rows[0].local, rows[0].text, rows[0].errors], [2, "2026-11-01T12:00", "1行目\n2行目", []]);
  assert.equal(rows[0].at, "2026-11-01T03:00:00.000Z");
  assert.match(rows[1].errors[0], /過去/);
  assert.match(rows[2].errors[0], /配信日時がありません/);
  assert.match(rows[3].errors.join(), /本文がありません/);
  assert.deepEqual(rows[4].errors, []);
  assert.match(rows[4].warnings[0], /2行目と同じ日時/);
  assert.match(rows[5].errors[0], /読み取れません/);
});

test("CSV一括予約：見出しがなければ1列目＝日時・2列目＝本文。見出しが片方だけならエラー", () => {
  const now = new Date("2026-10-24T09:00:00+09:00").getTime();
  const rows = readBulkCsv(new TextEncoder().encode("2026/11/02 08:30,朝の投稿\n"), now);
  assert.deepEqual([rows[0].line, rows[0].local, rows[0].text], [1, "2026-11-02T08:30", "朝の投稿"]);
  assert.throws(() => readBulkCsv(new TextEncoder().encode("配信日時,メモ\n2026/11/02 08:30,x\n"), now), /両方/);
});
