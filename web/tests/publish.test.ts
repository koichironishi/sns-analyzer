import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/lib/sns/collectors/http.ts";
import { pkcePair, xAuthorizeUrl, xNeedsRefresh } from "../src/lib/sns/connect.ts";
import { isPermissionError, publishErrorMessage, publishFacebook, publishInstagram, publishThreads, publishX } from "../src/lib/sns/publish/publishers.ts";
import { validatePost, xLength } from "../src/lib/sns/publish/rules.ts";
import { overallStatus, textFor } from "../src/lib/sns/publish/run.ts";

type Call = { method: string; path: string; query: URLSearchParams; body: string | FormData | undefined; headers: Record<string, string> };

function fake(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const c: Call = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, body: init.body as string | FormData | undefined, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    const r = handler(c);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? {}), { status: 200 });
  }) as typeof fetch;
  return { deps: { http: { fetch: fn, sleep: async () => {} }, sleep: async () => {} }, calls };
}
const form = (c: Call) => new URLSearchParams(String(c.body ?? ""));
const cfg = (platform: "instagram" | "facebook" | "threads" | "x") => ({ platform, externalId: "ID1", accessToken: "TOKEN", username: "brand" });

test("文字数：X は日本語を2、URL を23と数える", () => {
  assert.equal(xLength("abc"), 3);
  assert.equal(xLength("あいう"), 6);
  assert.equal(xLength("見て https://example.com/very/long/path?x=1"), 4 + 1 + 23);
  assert.deepEqual(validatePost(["x"], () => "あ".repeat(141), 0), ["X：本文が長すぎます（282 / 280。日本語は1文字を2と数えます）"]);
  assert.match(validatePost(["instagram"], () => "本文", 0)[0], /画像が1枚以上/);
  assert.match(validatePost(["x"], () => "a", 5)[0], /4枚まで/);
  assert.deepEqual(validatePost(["threads", "facebook"], () => "ok", 2), []);
  assert.match(validatePost([], () => "", 0)[0], /1つ以上/);
});

test("Instagram：1枚はコンテナ→公開、複数枚はカルーセル", async () => {
  const { deps, calls } = fake((c) => {
    if (c.path.endsWith("/ID1/media") && c.method === "POST") return { id: form(c).get("media_type") === "CAROUSEL" ? "CAR" : `C${calls.length}` };
    if (c.path.endsWith("/media_publish")) return { id: "MEDIA9" };
    if (c.method === "GET" && c.query.get("fields") === "status_code") return { status_code: "FINISHED" };
    if (c.method === "GET") return { permalink: "https://instagram.com/p/x" };
  });
  const r = await publishInstagram(cfg("instagram"), { text: "本文 #tag", imageUrls: ["https://img/1.jpg", "https://img/2.jpg"] }, deps);
  assert.deepEqual(r, { externalId: "MEDIA9", permalink: "https://instagram.com/p/x" });
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(form(posts[0]).get("is_carousel_item"), "true");
  assert.equal(form(posts[2]).get("media_type"), "CAROUSEL");
  assert.equal(form(posts[2]).get("caption"), "本文 #tag");
  assert.equal(form(posts[3]).get("creation_id"), "CAR");
  await assert.rejects(publishInstagram(cfg("instagram"), { text: "x", imageUrls: [] }, deps), /画像が必要/);
});

test("Facebook：本文だけ／1枚／複数枚", async () => {
  const { deps, calls } = fake((c) => {
    if (c.path.endsWith("/ID1/photos")) return form(c).get("published") === "false" ? { id: `P${calls.length}` } : { id: "PH", post_id: "ID1_1" };
    if (c.path.endsWith("/ID1/feed")) return { id: "ID1_2" };
    return { permalink_url: "https://facebook.com/x" };
  });
  assert.equal((await publishFacebook(cfg("facebook"), { text: "告知", imageUrls: [] }, deps)).externalId, "ID1_2");
  assert.equal((await publishFacebook(cfg("facebook"), { text: "告知", imageUrls: ["u1"] }, deps)).externalId, "ID1_1");
  calls.length = 0;
  await publishFacebook(cfg("facebook"), { text: "まとめ", imageUrls: ["u1", "u2"] }, deps);
  const feed = form(calls.find((c) => c.path.endsWith("/feed"))!);
  assert.equal(feed.get("message"), "まとめ");
  assert.match(feed.get("attached_media[1]")!, /media_fbid/);
});

test("Threads：テキスト投稿と、処理待ちのエラー", async () => {
  const { deps, calls } = fake((c) => {
    if (c.path.endsWith("/ID1/threads")) return { id: "CT" };
    if (c.path.endsWith("/threads_publish")) return { id: "T1" };
    if (c.query.get("fields")?.startsWith("status")) return { status: "FINISHED" };
    return { permalink: "https://threads.net/t/1" };
  });
  const r = await publishThreads(cfg("threads"), { text: "こんにちは", imageUrls: [] }, deps);
  assert.equal(r.externalId, "T1");
  assert.equal(form(calls[0]).get("media_type"), "TEXT");
  const bad = fake((c) => (c.path.endsWith("/threads") ? { id: "CT" } : { status: "ERROR", error_message: "bad image" }));
  await assert.rejects(publishThreads(cfg("threads"), { text: "x", imageUrls: ["u"] }, bad.deps), /bad image/);
});

test("X：画像をアップロードしてから JSON で投稿", async () => {
  const { deps, calls } = fake((c) => (c.path === "/2/media/upload" ? { data: { id: "M1" } } : { data: { id: "99" } }));
  const r = await publishX(cfg("x"), { text: "新商品", imageUrls: ["https://img/1.jpg"] }, { ...deps, fetchImage: async () => new Blob(["jpg"]) });
  assert.deepEqual(r, { externalId: "99", permalink: "https://x.com/brand/status/99" });
  assert.ok(calls[0].body instanceof FormData);
  assert.deepEqual(JSON.parse(String(calls[1].body)), { text: "新商品", media: { media_ids: ["M1"] } });
  assert.equal(calls[1].headers.Authorization, "Bearer TOKEN");
});

test("権限エラーの判定と、再連携を促す文", () => {
  const e = new ApiError("HTTP 403: (#200) permission", 403, { error: { code: 200 } });
  assert.equal(isPermissionError(e), true);
  assert.match(publishErrorMessage(e), /もう一度連携/);
  assert.equal(isPermissionError(new ApiError("HTTP 500", 500)), false);
});

test("結果のまとめと、SNSごとの本文", () => {
  assert.equal(overallStatus(["x", "threads"], { x: { state: "published" }, threads: { state: "published" } }), "published");
  assert.equal(overallStatus(["x", "threads"], { x: { state: "published" }, threads: { state: "failed" } }), "partial");
  assert.equal(overallStatus(["x"], { x: { state: "failed" } }), "failed");
  assert.equal(textFor({ text: "共通", platform_texts: { x: "短く" } }, "x"), "短く");
  assert.equal(textFor({ text: "共通", platform_texts: { x: "  " } }, "x"), "共通");
});

test("X の連携：PKCE とトークン期限", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && challenge.length === 43);
  const url = new URL(xAuthorizeUrl({ clientId: "cid", clientSecret: "s" }, "https://app/cb", "st", challenge));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope")!, /tweet\.write/);
  assert.equal(xNeedsRefresh(new Date(Date.now() + 60_000).toISOString()), true);
  assert.equal(xNeedsRefresh(new Date(Date.now() + 3600_000).toISOString()), false);
});

test("Facebook ログイン：構成ID があれば config_id、なければ scope で権限を指定", async () => {
  const { metaAuthorizeUrl } = await import("../src/lib/sns/connect.ts");
  const a = new URL(metaAuthorizeUrl({ appId: "1", appSecret: "s", graphVersion: "v26.0", configId: "999" }, "https://app/cb", "st"));
  assert.equal(a.searchParams.get("config_id"), "999");
  assert.equal(a.searchParams.get("scope"), null);
  const b = new URL(metaAuthorizeUrl({ appId: "1", appSecret: "s", graphVersion: "v26.0" }, "https://app/cb", "st"));
  assert.match(b.searchParams.get("scope")!, /pages_manage_posts/);
});

test("複数アカウント：投稿先はアカウントごと。以前の投稿は各SNSの最初の連携アカウントに、SNS名のキーで出す", async () => {
  const { resolveTargets, parseTargetKey, platformsOf, targetKey } = await import("../src/lib/sns/publish/targets.ts");
  const conns = [
    { platform: "instagram" as const, external_id: "ig2", connected_at: "2026-10-02" },
    { platform: "instagram" as const, external_id: "ig1", connected_at: "2026-10-01" },
    { platform: "x" as const, external_id: "x1", connected_at: "2026-10-01" },
  ];
  // 新しい投稿：選んだアカウントだけ。結果のキーは "SNS:アカウント"
  assert.deepEqual(resolveTargets({ targets: [{ platform: "instagram", external_id: "ig2" }], platforms: ["instagram"] }, conns),
    [{ key: "instagram:ig2", platform: "instagram", externalId: "ig2" }]);
  // 以前の投稿：SNS名のキーのまま、最初に連携したアカウントへ
  assert.deepEqual(resolveTargets({ targets: [], platforms: ["instagram", "threads"] }, conns), [
    { key: "instagram", platform: "instagram", externalId: "ig1" },
    { key: "threads", platform: "threads", externalId: null },
  ]);
  assert.deepEqual(parseTargetKey(targetKey("instagram", "17841:abc")), { platform: "instagram", external_id: "17841:abc" });
  assert.equal(parseTargetKey("tiktok:1"), null);
  assert.deepEqual(platformsOf([{ platform: "instagram", external_id: "a" }, { platform: "instagram", external_id: "b" }, { platform: "x", external_id: "c" }]), ["instagram", "x"]);
  assert.equal(overallStatus(["instagram:ig1", "instagram:ig2"], { "instagram:ig1": { state: "published" }, "instagram:ig2": { state: "failed" } }), "partial");
});

test("複数アカウント：外部ツールからの登録は、同じSNSに複数あると accounts の指定が必要", async () => {
  const { resolveImportTargets } = await import("../src/lib/sns/import-posts.ts");
  const conns = [
    { platform: "instagram" as const, external_id: "ig1", username: "shop_a", can_publish: true },
    { platform: "instagram" as const, external_id: "ig2", username: "shop_b", can_publish: true },
    { platform: "facebook" as const, external_id: "fb1", username: "Shop", can_publish: true },
  ];
  const none = resolveImportTargets(["instagram", "facebook"], undefined, conns);
  assert.ok(none.errors.some((e) => e.includes("accounts")));
  const ok = resolveImportTargets(["instagram", "facebook"], [{ platform: "instagram", username: "@Shop_B" }], conns);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.targets, [{ platform: "instagram", external_id: "ig2" }, { platform: "facebook", external_id: "fb1" }]);
  assert.ok(resolveImportTargets(["instagram"], [{ platform: "instagram", username: "nope" }], conns).errors[0].includes("nope"));
});
