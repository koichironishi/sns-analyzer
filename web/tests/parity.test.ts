/** Python 版と TypeScript 版の分析結果が一致することを確認する（同じデモデータで比較）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze } from "../src/lib/sns/analysis.ts";
import { compare, type CompetitorAccount } from "../src/lib/sns/compare.ts";
import type { FollowerSeries, Post } from "../src/lib/sns/models.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/python-parity.json", import.meta.url), "utf8"));
const posts = fx.posts as Post[];
const followers = fx.followers as FollowerSeries;
const a = analyze(posts, followers, { days: 30, end: fx.end });
const e = fx.expected;

const close = (x: number | null, y: number | null, msg: string) => {
  if (x === null || y === null) return assert.equal(x, y, msg);
  assert.ok(Math.abs(x - y) < 1e-9 * Math.max(1, Math.abs(y)), `${msg}: ${x} != ${y}`);
};

test("SNS別サマリーが一致", () => {
  assert.deepEqual(a.platforms, Object.keys(e.summary));
  for (const [p, s] of Object.entries<Record<string, number | null>>(e.summary)) {
    const t = a.summary[p as keyof typeof a.summary]!;
    assert.equal(t.posts, s.posts, `${p} posts`);
    assert.equal(t.engagements, s.engagements, `${p} engagements`);
    assert.equal(t.views, s.views, `${p} views`);
    assert.equal(t.followers, s.followers, `${p} followers`);
    assert.equal(t.followersDelta, s.followers_delta, `${p} delta`);
    close(t.erFollowers, s.er_followers, `${p} erFollowers`);
    close(t.erViews, s.er_views, `${p} erViews`);
    close(t.avgEngagements, s.avg_engagements, `${p} avg`);
  }
});

test("合計と前期間比が一致", () => {
  assert.equal(a.total.posts, e.total.posts);
  assert.equal(a.total.engagements, e.total.engagements);
  assert.equal(a.total.views, e.total.views);
  for (const k of ["posts", "engagements", "views"] as const) close(a.total.change[k] ?? null, e.change[k], k);
});

test("曜日×時間帯（全体）が一致", () => {
  a.heatmap.all!.score.forEach((row, w) => row.forEach((v, s) => close(v, e.heat_all.score[w][s], `${w},${s}`)));
  assert.deepEqual(a.heatmap.all!.count, e.heat_all.count);
});

test("形式別・ハッシュタグ・上位投稿が一致", () => {
  assert.deepEqual(a.media.map((m) => [m.platform, m.mediaType, m.count]), e.media.map((m: unknown[]) => m.slice(0, 3)));
  a.media.forEach((m, i) => close(m.score, e.media[i][3], `media ${i}`));
  assert.deepEqual(a.hashtags.map((h) => [h.tag, h.count]), e.hashtags.map((h: unknown[]) => h.slice(0, 2)));
  a.topPosts.forEach((t, i) => close(t.score, e.top_scores[i], `top ${i}`));
});

test("自動コメントの文章が一致", () => {
  assert.deepEqual(a.insights.map((i) => i.text), e.insights);
});

test("競合比較が一致", () => {
  const c = compare(posts, followers, fx.competitors as CompetitorAccount[], { days: 30, end: fx.end });
  for (const [p, rows] of Object.entries<unknown[][]>(e.compare_rows)) {
    const t = c.platforms[p as keyof typeof c.platforms]!.rows;
    assert.equal(t.length, rows.length, p);
    t.forEach((r, i) => {
      const [name, followers, n, er, ppw, best, slot] = rows[i];
      assert.equal(r.name, name);
      assert.equal(r.followers, followers);
      assert.equal(r.posts, n);
      close(r.erFollowers, er as number | null, `${p} ${name} er`);
      close(r.postsPerWeek, ppw as number | null, `${p} ${name} ppw`);
      assert.equal(r.bestType, best, `${p} ${name} best`);
      assert.equal(r.topSlot, slot, `${p} ${name} slot`);
    });
  }
  assert.deepEqual(c.insights.map((i) => i.text), e.compare_insights);
  assert.deepEqual(c.topPosts.map((t) => t.competitor), e.compare_top.map((t: unknown[]) => t[0]));
});
