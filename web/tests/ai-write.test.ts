import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { buildWritePrompt, checkWritten, writePerPlatform } from "../src/lib/sns/ai-write.ts";

const fake = (json: unknown, stop = "end_turn") => {
  const calls: unknown[] = [];
  const client = { messages: { create: async (req: unknown) => { calls.push(req); return {
    model: "claude-test", stop_reason: stop, content: [{ type: "text", text: JSON.stringify(json) }],
  }; } } } as unknown as Anthropic;
  return { client, calls };
};
const input = { clientName: "フラット7滋賀", brandContext: "新車カーリース。価格は税込で表記する。", source: "秋の点検キャンペーンのお知らせ。10月末まで。", platforms: ["instagram", "x"] as const };

test("書き分け：指定したSNSの文章だけを返し、頼んでいないSNSは捨てる", async () => {
  const { client, calls } = fake({ texts: { instagram: "秋の点検、受付中です🍁\n#フラット7滋賀", x: "秋の点検、10月末まで受付中。", facebook: "頼んでいない" } });
  const r = await writePerPlatform({ ...input, platforms: [...input.platforms] }, client);
  assert.deepEqual(Object.keys(r.texts).sort(), ["instagram", "x"]);
  assert.deepEqual(r.warnings, []);
  // 事業内容とメモがプロンプトに入る
  const prompt = (calls[0] as { messages: { content: string }[] }).messages[0].content;
  assert.match(prompt, /税込/);
  assert.match(prompt, /10月末/);
});

test("書き分け：Xの文字数超過やハッシュタグの多すぎは注意を返す（文章は人が直す）", () => {
  const long = "あ".repeat(200);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
  const w = checkWritten({ x: long, instagram: tags }, ["x", "instagram", "facebook"]);
  assert.ok(w.some((x) => x.startsWith("X：文字数")));
  assert.ok(w.some((x) => x.startsWith("Instagram：ハッシュタグ")));
  assert.ok(w.some((x) => x.startsWith("Facebook：文章を作れませんでした")));
});

test("書き分け：事業内容が空ならプロンプトに見出しを出さない", () => {
  assert.doesNotMatch(buildWritePrompt({ ...input, brandContext: "", platforms: ["facebook"] }), /事業内容/);
});

test("書き分け：AIが応答を控えたらエラー", async () => {
  const { client } = fake({}, "refusal");
  await assert.rejects(writePerPlatform({ ...input, platforms: ["x"] }, client), /控えました/);
});
