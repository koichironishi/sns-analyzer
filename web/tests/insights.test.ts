import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpClient } from "../src/lib/sns/collectors/http.ts";
import { endTimeToDate, facebookInsights, instagramInsights, onlineHours } from "../src/lib/sns/collectors/insights.ts";

type Hit = { status?: number; body: unknown } | undefined;
function client(route: (u: URL) => Hit) {
  const calls: URL[] = [];
  const fetch = (async (input: string | URL) => {
    const u = new URL(String(input));
    calls.push(u);
    const hit = route(u);
    return new Response(JSON.stringify(hit?.body ?? { error: { message: "not found" } }), { status: hit ? hit.status ?? 200 : 404 });
  }) as typeof globalThis.fetch;
  return { http: new HttpClient("https://graph.test", { fetch, sleep: async () => {} }), calls };
}
const req = (start: string, end: string, have: string[] = []) => ({ start, end, have: new Set(have), deadline: Date.now() + 60_000 });
const err = (status = 400) => ({ status, body: { error: { message: "(#100) The value must be a valid insights metric" } } });

test("endTimeToDate: その日の終わり（翌日0時・太平洋時間）を、その日の日付にする", () => {
  assert.equal(endTimeToDate("2026-10-14T07:00:00+0000"), "2026-10-13");
});

test("Facebook: 日別の指標を保存名にそろえ、提供されていない指標は飛ばす", async () => {
  const { http } = client((u) => {
    const m = u.searchParams.get("metric");
    if (m === "page_media_view") return { body: { data: [{ name: m, values: [
      { value: 10, end_time: "2026-10-12T07:00:00+0000" }, { value: 20, end_time: "2026-10-13T07:00:00+0000" },
      { value: 99, end_time: "2026-10-20T07:00:00+0000" }, // 期間外
    ] }] } };
    if (m === "page_follows_city") return { body: { data: [{ values: [{ value: { "Otsu, Shiga": 40, x: 0 } }] }] } };
    return err();
  });
  const r = await facebookInsights(http, "p1", req("2026-10-11", "2026-10-12"));
  assert.deepEqual(r.daily, [{ date: "2026-10-11", metric: "views", value: 10 }, { date: "2026-10-12", metric: "views", value: 20 }]);
  assert.deepEqual(r.audience, { city: { "Otsu, Shiga": 40 } });
  assert.deepEqual(r.warnings, []);
});

test("Facebook: どの指標も取れなければ権限の確認を促す", async () => {
  const { http } = client(() => err());
  const r = await facebookInsights(http, "p1", req("2026-10-11", "2026-10-12"));
  assert.equal(r.daily.length, 0);
  assert.equal(r.audience, null);
  assert.match(r.warnings[0], /read_insights/);
});

test("Instagram: 1日ずつの合計・リーチの時系列・属性を取り、保存済みの古い日は取り直さない", async () => {
  const { http, calls } = client((u) => {
    const m = u.searchParams.get("metric")!;
    if (m === "reach") return { body: { data: [{ name: "reach", values: [{ value: 5, end_time: "2026-10-13T07:00:00+0000" }] }] } };
    if (m === "follower_count") return err();
    if (m === "follower_demographics") {
      const b = u.searchParams.get("breakdown");
      if (b === "gender,age") return { body: { data: [{ total_value: { breakdowns: [{ dimension_keys: ["age", "gender"], results: [{ dimension_values: ["25-34", "F"], value: 12 }] }] } }] } };
      if (b === "city") return { body: { data: [{ total_value: { breakdowns: [{ dimension_keys: ["city"], results: [{ dimension_values: ["Otsu, Shiga"], value: 30 }] }] } }] } };
      return err();
    }
    // total_value：profile_links_taps は提供されていない想定
    if (m.split(",").includes("profile_links_taps")) return err();
    return { body: { data: m.split(",").map((name) => ({ name, total_value: { value: name === "views" ? 100 : 3 } })) } };
  });
  const r = await instagramInsights(http, "ig1", req("2026-10-08", "2026-10-12", ["2026-10-08", "2026-10-12"]));
  const views = r.daily.filter((d) => d.metric === "views").map((d) => d.date).sort();
  // 10-08 は保存済みなので取らない。10-12 は保存済みでも直近なので取り直す
  assert.deepEqual(views, ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
  assert.ok(r.daily.some((d) => d.metric === "viewers" && d.date === "2026-10-12" && d.value === 5));
  assert.ok(!r.daily.some((d) => d.metric === "link_clicks"));
  assert.deepEqual(r.audience, { genderAge: { F: { "25-34": 12 } }, city: { "Otsu, Shiga": 30 } }); // 反応した人の年代・オンラインの時間帯は提供なし（err）の想定
  // 提供されていない指標を見つけたあとは、まとめて問い合わせる指標から外す
  const later = calls.filter((u) => u.searchParams.get("metric_type") === "total_value" && !["follower_demographics", "engaged_audience_demographics"].includes(u.searchParams.get("metric")!)).at(-1)!;
  assert.equal(later.searchParams.get("metric"), "views,total_interactions,accounts_engaged");
});

test("オンラインの時間帯：太平洋時間の時を日本時間の日付・時に直す（夏時間と冬時間）", () => {
  // 2026-10-20 07:00 UTC＝太平洋夏時間の 10/20 0時。その前日（10/19）の分
  const pdt = onlineHours("2026-10-20T07:00:00+0000", { "0": 5, "8": 12, "23": 3 });
  assert.deepEqual(pdt, [
    { date: "2026-10-19", hour: 16, count: 5 },   // 10/19 0時（PDT, UTC-7）＝10/19 16時（JST）
    { date: "2026-10-20", hour: 0, count: 12 },   // 10/19 8時（PDT）＝10/20 0時（JST）
    { date: "2026-10-20", hour: 15, count: 3 },   // 10/19 23時（PDT）＝10/20 15時（JST）
  ]);
  // 冬時間（PST, UTC-8）：12/10 08:00 UTC＝12/10 0時（PST）。その前日（12/9）の分
  assert.deepEqual(onlineHours("2026-12-10T08:00:00+0000", { "0": 1 }), [{ date: "2026-12-09", hour: 17, count: 1 }]);
});

test("Instagram: 反応した人の年代とオンラインの時間帯を属性に入れる（24時間そろった日だけ）", async () => {
  const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), h + 1]));
  const { http } = client((u) => {
    const m = u.searchParams.get("metric")!;
    if (m === "engaged_audience_demographics") return { body: { data: [{ total_value: { breakdowns: [{ dimension_keys: ["age"], results: [{ dimension_values: ["25-34"], value: 40 }, { dimension_values: ["35-44"], value: 10 }] }] } }] } };
    if (m === "online_followers") return { body: { data: [{ values: [
      { value: hours, end_time: "2026-10-19T07:00:00+0000" }, { value: hours, end_time: "2026-10-20T07:00:00+0000" }, { value: hours, end_time: "2026-10-21T07:00:00+0000" },
    ] }] } };
    return err();
  });
  const r = await instagramInsights(http, "ig1", req("2026-10-20", "2026-10-21"));
  assert.deepEqual(r.audience?.engagedAge, { "25-34": 40, "35-44": 10 });
  // 太平洋時間の3日分（10/18〜10/20）は、日本時間では 10/18 16時〜10/21 15時。24時間そろうのは 10/19 と 10/20
  assert.deepEqual(r.audience?.online?.map((d) => d.date), ["2026-10-19", "2026-10-20"]);
  assert.equal(Object.keys(r.audience!.online![0].hours).length, 24);
});
