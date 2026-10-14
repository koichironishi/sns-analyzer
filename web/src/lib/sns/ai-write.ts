/**
 * 投稿の本文を、SNSごとに書き分ける（Claude API）。
 *
 * 入力は投稿画面の「本文」（下書きでも、伝えたいことのメモでもよい）と、クライアントの事業内容。
 * 過去の投稿や指標は送らない。書いた文章はそのまま公開せず、画面の「SNSごとの本文」に入れて人が直す前提。
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AIError, DEFAULT_MODEL } from "./ai.ts";
import { PLATFORM_LABELS, type Platform } from "./models.ts";
import { LIMITS, hashtagCount, textLength } from "./publish/rules.ts";

/** SNSごとの書き方。文字数の上限は投稿のきまり（LIMITS）より少し短めに指示する */
const STYLE: Record<Platform, string> = {
  instagram: "Instagram：冒頭1〜2行で興味を引く。改行と絵文字を適度に使い読みやすく。末尾にハッシュタグを5〜10個（#付き・半角スペース区切り）。全体2,000字以内。",
  facebook: "Facebook：丁寧で落ち着いた文体。段落で区切る。ハッシュタグは使わないか2個まで。全体1,000字程度まで。",
  threads: "Threads：会話のような軽い文体で短く。ハッシュタグは1個まで。全体450字以内。",
  x: "X：要点だけを短く。日本語は全角130字以内（URLは23字として数える）。ハッシュタグは2個まで。",
};

const OutputSchema = z.object({
  texts: z.object({
    instagram: z.string().optional(),
    facebook: z.string().optional(),
    threads: z.string().optional(),
    x: z.string().optional(),
  }),
});

export type AiWriteInput = { clientName: string; brandContext: string; source: string; platforms: Platform[] };
export type AiWriteResult = { texts: Partial<Record<Platform, string>>; warnings: string[]; model: string };

const SYSTEM = `あなたは日本の企業・店舗の SNS 投稿を書くコピーライターです。
担当者が書いた「本文の下書き・メモ」をもとに、指定された SNS ごとに、そのSNSの文字数と習慣に合わせた投稿文を書きます。

守ること：
- 下書き・メモにない事実（価格・日付・数字・キャンペーン・実績・お客様の声など）を作らない。分からないことは書かない。
- 事業内容に書かれた禁止事項・表現の注意があれば必ず守る。誇大な表現（必ず・絶対・No.1 など根拠のない言い切り）は使わない。
- 各SNSの文章は、それだけで意味が通るように書く（「Instagramを見てね」のような他SNSへの誘導は、メモにある場合だけ）。
- 出力は JSON のみ。指定されていない SNS のキーは出さない。`;

export function buildWritePrompt(input: AiWriteInput): string {
  return [
    `# クライアント\n${input.clientName}`,
    input.brandContext.trim() ? `# 事業内容・表現の注意（スタッフが登録）\n${input.brandContext.trim()}` : "",
    `# 本文の下書き・メモ\n${input.source.trim()}`,
    `# 書き分けるSNSと書き方\n${input.platforms.map((p) => `- ${STYLE[p]}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

/** 書いた文章が投稿のきまりに収まっているか（収まらないものは注意を返す。文章は人が直す） */
export function checkWritten(texts: Partial<Record<Platform, string>>, platforms: Platform[]): string[] {
  const warnings: string[] = [];
  for (const p of platforms) {
    const t = texts[p];
    if (!t) { warnings.push(`${PLATFORM_LABELS[p]}：文章を作れませんでした`); continue; }
    if (textLength(p, t) > LIMITS[p].maxText) warnings.push(`${PLATFORM_LABELS[p]}：文字数の上限を超えています。短くしてください`);
    const max = LIMITS[p].maxHashtags;
    if (max && hashtagCount(t) > max) warnings.push(`${PLATFORM_LABELS[p]}：ハッシュタグが${max}個を超えています`);
  }
  return warnings;
}

export async function writePerPlatform(input: AiWriteInput, client?: Anthropic): Promise<AiWriteResult> {
  if (!process.env.ANTHROPIC_API_KEY && !client) throw new AIError("AI機能が設定されていません（ANTHROPIC_API_KEY）。担当者にお問い合わせください。");
  const api = client ?? new Anthropic();
  let message: Anthropic.Messages.Message;
  try {
    message = await api.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: "medium", format: zodOutputFormat(OutputSchema) },
      messages: [{ role: "user", content: buildWritePrompt(input) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new AIError("AIの利用が混み合っています。しばらく待ってから、もう一度お試しください。");
    if (e instanceof Anthropic.APIError) throw new AIError(`AIに接続できませんでした（${e.status ?? "接続エラー"}）。時間をおいて、もう一度お試しください。`);
    throw e;
  }
  if (message.stop_reason === "refusal") throw new AIError("AIが文章の作成を控えました。本文の内容を見直してください。");
  const raw = message.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("");
  let parsed: z.infer<typeof OutputSchema>;
  try {
    parsed = OutputSchema.parse(JSON.parse(raw));
  } catch {
    throw new AIError("AIの応答を読み取れませんでした。もう一度お試しください。");
  }
  const texts: Partial<Record<Platform, string>> = {};
  for (const p of input.platforms) {
    const t = parsed.texts[p]?.trim();
    if (t) texts[p] = t;
  }
  return { texts, warnings: checkWritten(texts, input.platforms), model: message.model };
}
