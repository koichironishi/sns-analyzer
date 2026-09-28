import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, HttpClient, parseInsights, parseTime } from "../src/lib/sns/collectors/http.ts";
import { createCollector, XCollector } from "../src/lib/sns/collectors/index.ts";

type Route = (url: URL, init: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> } | undefined;

function fakeFetch(routes: Route[]) {
  const calls: string[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: hit.headers });
    }
    return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
  }) as typeof fetch;
  return { fn, calls };
}
const deps = (fn: typeof fetch) => ({ http: { fetch: fn, sleep: async () => {} } });
const opts = { since: "2026-09-01T00:00:00.000Z", maxPosts: 100 };

test("parseTime: +0000 形式とZ", () => {
  assert.equal(parseTime("2026-09-10T03:04:05+0000"), "2026-09-10T03:04:05.000Z");
  assert.equal(parseTime("2026-09-10T12:00:00+09:00"), "2026-09-10T03:00:00.000Z");
  assert.equal(parseTime("2026-09-10T03:04:05Z"), "2026-09-10T03:04:05.000Z");
});

test("parseInsights: values / total_value / 内訳", () => {
  assert.deepEqual(parseInsights({ data: [
    { name: "views", values: [{ value: 1 }, { value: 5 }] },
    { name: "reach", total_value: { value: 3 } },
    { name: "clicks", values: [{ value: { a: 2, b: 3 } }] },
  ] }), { views: 5, reach: 3, clicks: 5 });
});

test("HttpClient: 429 は再試行し、エラーにトークンを含めない", async () => {
  let n = 0;
  const { fn } = fakeFetch([() => (++n < 2 ? { status: 429, body: {}, headers: { "retry-after": "1" } } : undefined)]);
  const http = new HttpClient("https://api.test", { fetch: fn, sleep: async () => {}, queryAuth: { access_token: "SECRET" } });
  await assert.rejects(http.get("x"), (e: ApiError) => e.status === 404 && !e.message.includes("SECRET"));
  assert.equal(n, 2);
});

test("Instagram: 期間内の投稿だけ、インサイトは非対応指標を記憶", async () => {
  let insightCalls = 0;
  const { fn } = fakeFetch([
    (u) => u.pathname.endsWith("/ig1") ? { body: { id: "ig1", username: "shop", followers_count: 1000, follows_count: 10, media_count: 50 } } : undefined,
    (u) => u.pathname.endsWith("/ig1/media") ? { body: { data: [
      { id: "m1", caption: "新作 #cafe", media_type: "VIDEO", media_product_type: "REELS", timestamp: "2026-09-20T01:00:00+0000", like_count: 10, comments_count: 2, permalink: "https://ig/m1" },
      { id: "m2", media_type: "IMAGE", timestamp: "2026-09-10T01:00:00+0000", like_count: 5 },
      { id: "m3", media_type: "IMAGE", timestamp: "2026-08-01T01:00:00+0000" },
    ] } } : undefined,
    (u) => {
      if (!u.pathname.endsWith("/insights")) return undefined;
      insightCalls++;
      const metric = u.searchParams.get("metric")!;
      if (metric.includes(",") || metric === "total_interactions") return { status: 400, body: { error: { message: "unsupported" } } };
      return { body: { data: [{ name: metric, values: [{ value: 7 }] }] } };
    },
  ]);
  const c = createCollector({ platform: "instagram", externalId: "ig1", username: "", accessToken: "t" }, deps(fn));
  const r = await c.collect(opts);
  assert.equal(r.account.followers, 1000);
  assert.deepEqual(r.posts.map((p) => [p.externalId, p.mediaType]), [["m1", "reel"], ["m2", "image"]]);
  assert.equal(r.posts[0].metrics.saves, 7);
  assert.equal(r.posts[0].metrics.likes, 10);
  assert.ok(r.warnings.some((w) => w.includes("total_interactions")));
  // reel: 一括1 + 個別5、image: 一括1 + 個別5（種別ごとに記憶）
  assert.equal(insightCalls, 12);
});

test("Instagram 競合：Business Discovery", async () => {
  const { fn, calls } = fakeFetch([(u) => u.pathname.endsWith("/ig1") ? { body: { business_discovery: {
    id: "c1", username: "rival", followers_count: 500,
    media: { data: [{ id: "x1", timestamp: "2026-09-15T00:00:00+0000", like_count: 3, comments_count: 1, media_type: "CAROUSEL_ALBUM" }] },
  } } } : undefined]);
  const c = createCollector({ platform: "instagram", externalId: "ig1", username: "", accessToken: "t" }, deps(fn));
  const r = await c.collectCompetitor("@rival", opts);
  assert.equal(r.account.username, "rival");
  assert.equal(r.posts[0].mediaType, "carousel");
  assert.ok(calls[0].includes("business_discovery.username%28rival%29"));
});

test("Facebook: 反応数とインサイト", async () => {
  const { fn } = fakeFetch([
    (u) => u.pathname.endsWith("/p1") ? { body: { id: "p1", name: "店", followers_count: 300 } } : undefined,
    (u) => u.pathname.endsWith("/p1/posts") ? { body: { data: [{ id: "p1_1", message: "告知", created_time: "2026-09-05T00:00:00+0000",
      reactions: { summary: { total_count: 4 } }, comments: { summary: { total_count: 2 } }, shares: { count: 1 },
      attachments: { data: [{ media_type: "photo" }] } }] } } : undefined,
    (u) => u.pathname.endsWith("/insights") ? { body: { data: [
      { name: "post_media_view", values: [{ value: 100 }] }, { name: "post_clicks", values: [{ value: 3 }] }] } } : undefined,
  ]);
  const r = await createCollector({ platform: "facebook", externalId: "p1", username: "", accessToken: "t" }, deps(fn)).collect(opts);
  assert.deepEqual(r.posts[0].metrics, { views: 100, reach: null, likes: 4, comments: 2, shares: 1, saves: 0, quotes: 0, clicks: 3 });
  assert.equal(r.posts[0].mediaType, "image");
});

test("Threads: リポストを除外、フォロワー取得失敗は警告", async () => {
  const { fn } = fakeFetch([
    (u) => u.pathname.endsWith("/me") ? { body: { id: "t1", username: "me" } } : undefined,
    (u) => u.pathname.endsWith("/threads_insights") ? { status: 400, body: { error: { message: "no" } } } : undefined,
    (u) => u.pathname.endsWith("/t1/threads") ? { body: { data: [
      { id: "r", media_type: "REPOST_FACADE", timestamp: "2026-09-05T00:00:00+0000" },
      { id: "a", media_type: "TEXT_POST", text: "hi", timestamp: "2026-09-05T00:00:00+0000" }] } } : undefined,
    (u) => u.pathname.endsWith("/insights") ? { body: { data: [
      { name: "likes", values: [{ value: 2 }] }, { name: "reposts", values: [{ value: 1 }] }, { name: "shares", values: [{ value: 1 }] }] } } : undefined,
  ]);
  const r = await createCollector({ platform: "threads", externalId: "", username: "", accessToken: "t" }, deps(fn)).collect(opts);
  assert.equal(r.account.followers, null);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].metrics.shares, 2);
  assert.ok(r.warnings[0].includes("フォロワー数"));
});

test("X: ページング・種別・missingIds", async () => {
  const { fn, calls } = fakeFetch([
    (u) => u.pathname === "/2/users/by/username/brand" ? { body: { data: { id: "9", username: "brand", public_metrics: { followers_count: 50 } } } } : undefined,
    (u) => u.pathname === "/2/users/9/tweets" && !u.searchParams.get("pagination_token") ? { body: {
      data: [{ id: "1", text: "a", created_at: "2026-09-02T00:00:00.000Z", attachments: { media_keys: ["k"] }, public_metrics: { like_count: 1 } }],
      includes: { media: [{ media_key: "k", type: "photo" }] }, meta: { next_token: "N" } } } : undefined,
    (u) => u.pathname === "/2/users/9/tweets" ? { body: { data: [{ id: "2", text: "b https://t.co", created_at: "2026-09-03T00:00:00.000Z", entities: { urls: [{}] } }], meta: {} } } : undefined,
    (u) => u.pathname === "/2/tweets" ? { body: { data: [{ id: "1" }], errors: [{ resource_id: "2" }] } } : undefined,
  ]);
  const c = createCollector({ platform: "x", externalId: "", username: "brand", accessToken: "B" }, deps(fn)) as XCollector;
  const r = await c.collect(opts);
  assert.deepEqual(r.posts.map((p) => p.mediaType), ["image", "link"]);
  assert.equal(r.posts[0].permalink, "https://x.com/brand/status/1");
  assert.deepEqual([...await c.missingIds(["1", "2", "3"])], ["2"]);
  assert.ok(!calls.some((c) => c.includes("B")));
});

test("締め切りを過ぎたら打ち切って警告", async () => {
  const { fn } = fakeFetch([
    (u) => u.pathname.endsWith("/ig1") ? { body: { id: "ig1" } } : undefined,
    (u) => u.pathname.endsWith("/media") ? { body: { data: [{ id: "m", timestamp: "2026-09-20T00:00:00+0000" }] } } : undefined,
  ]);
  const r = await createCollector({ platform: "instagram", externalId: "ig1", username: "", accessToken: "t" }, deps(fn))
    .collect({ ...opts, deadline: Date.now() - 1 });
  assert.equal(r.posts.length, 0);
  assert.ok(r.warnings[0].includes("次回"));
});
