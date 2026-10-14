import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpClient } from "../src/lib/sns/collectors/http.ts";
import { endTimeToDate, facebookInsights, instagramInsights } from "../src/lib/sns/collectors/insights.ts";

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
  assert.deepEqual(r.audience, { genderAge: { F: { "25-34": 12 } }, city: { "Otsu, Shiga": 30 } });
  // 提供されていない指標を見つけたあとは、まとめて問い合わせる指標から外す
  const later = calls.filter((u) => u.searchParams.get("metric_type") === "total_value" && u.searchParams.get("metric") !== "follower_demographics").at(-1)!;
  assert.equal(later.searchParams.get("metric"), "views,total_interactions,accounts_engaged");
});
