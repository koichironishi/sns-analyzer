/**
 * Claude による AI分析（Python 版 ai.py の移植）。
 * 集計結果と期間内の投稿本文を Claude に渡し、示唆・改善提案・投稿アイデアを構造化 JSON で受け取る。
 * 投稿本文を送るかどうかは、クライアントの同意（include_post_text）に従う。
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { SLOTS, WEEKDAYS, buildRows, median, type AnalysisResult } from "./analysis.ts";
import type { CompareResult } from "./compare.ts";
import { DEFAULT_TZ, MEDIA_LABELS, PLATFORM_LABELS, type FollowerSeries, type Platform, type Post } from "./models.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const AI_MODELS = ["claude-opus-5-5", "claude-sonnet-5"] as const;
export const AI_EFFORTS = ["low", "medium", "high"] as const;
const MAX_POSTS_IN_PROMPT = 200;
const MAX_TEXT_CHARS = 280;

const SYSTEM_PROMPT = `あなたは日本の企業・ブランドの SNS 運用を支援するシニアアナリストです。
Instagram / Facebook / Threads / X の運用データを読み、担当者が次の1か月で実行できる具体的な改善策を提案します。

分析の前提：
- 「パフォーマンス指数」は投稿のエンゲージメント ÷ 同じSNSの期間中央値 × 100。SNS間の規模差を補正した値で、100が普段の投稿。
- エンゲージメント = いいね + コメント + シェア/リポスト + 保存 + 引用。ER（表示比）= エンゲージメント ÷ 表示回数。
- 件数が少ない区分（目安3件未満）の差は偶然の可能性が高い。断定せず、根拠の件数を添えて「仮説」として扱うこと。
- 数値の傾向だけでなく、投稿本文の内容・切り口・言葉づかい・CTA の違いまで読み取ること。反応の良い投稿と悪い投稿を比べて、何が効いているかを言語化する。
- 各SNSの特性（Instagram=ビジュアルと保存、Threads=会話と共感、X=速報性と拡散、Facebook=既存顧客・地域・長文）を踏まえる。
- 提案は「誰が読んでもそのまま実行できる」粒度で書く。抽象論（「質の高い投稿を」等）は避ける。
- データから言えないことは言わない。数値を引用するときは与えられたデータの値を使う。
- 出力はすべて日本語。`;

const PlatformOrAll = z.enum(["instagram", "facebook", "threads", "x", "all"]);

export const AiOutputSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  question_answer: z.string(),
  platforms: z.array(z.object({
    platform: PlatformOrAll, assessment: z.string(), strengths: z.array(z.string()), issues: z.array(z.string()),
  })),
  competitor_insights: z.array(z.object({ competitor: z.string(), observation: z.string(), takeaway: z.string() })),
  content_insights: z.array(z.object({ title: z.string(), detail: z.string(), evidence: z.string() })),
  recommendations: z.array(z.object({
    priority: z.enum(["high", "medium", "low"]), platform: PlatformOrAll,
    action: z.string(), reason: z.string(), expected_effect: z.string(),
  })),
  post_ideas: z.array(z.object({
    platform: PlatformOrAll, format: z.string(), idea: z.string(), sample_copy: z.string(), suggested_timing: z.string(),
  })),
  kpi_targets: z.array(z.object({
    platform: PlatformOrAll, metric: z.string(), current: z.string(), target: z.string(), rationale: z.string(),
  })),
});
export type AiOutput = z.infer<typeof AiOutputSchema>;

export type AiMeta = {
  model: string; generatedAt: string; question: string; postsSent: number; postTextSent: boolean;
  consentBy: string; consentAt: string; inputTokens: number; outputTokens: number;
};
export type AiResult = AiOutput & { _meta: AiMeta };

export class AIError extends Error {}

export const platformLabel = (p: string) => (p === "all" ? "全体" : PLATFORM_LABELS[p as Platform] ?? p);
export const PRIORITY_LABELS = { high: "高", medium: "中", low: "低" } as const;

const r4 = (v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
const roundObj = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r4(v)]));

/** Claude に渡すデータ。集計値 + 期間内の投稿一覧（指数順） */
export function buildContext(data: AnalysisResult, posts: Post[], followers: FollowerSeries,
  competitors: CompareResult | null, includePostText: boolean, tz = DEFAULT_TZ) {
  const { start, end, days } = data.period;
  let rows = buildRows(posts, followers, tz).filter((r) => r.local.date >= start && r.local.date <= end);
  const med = new Map<Platform, number>();
  for (const p of new Set(rows.map((r) => r.post.platform))) {
    med.set(p, median(rows.filter((r) => r.post.platform === p).map((r) => r.engagements)) || 1);
  }
  const idx = (r: (typeof rows)[number]) => r.engagements / (med.get(r.post.platform) ?? 1);
  rows.sort((a, b) => idx(b) - idx(a));
  if (rows.length > MAX_POSTS_IN_PROMPT) {
    const half = MAX_POSTS_IN_PROMPT / 2; // 上位と下位を優先して残す
    rows = [...rows.slice(0, half), ...rows.slice(-half)];
  }

  const summary: Record<string, unknown> = {};
  for (const [p, s] of Object.entries(data.summary)) {
    if (!s) continue;
    const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !["label", "prev", "change", "account"].includes(k)));
    summary[p] = { ...roundObj(rest), 前期間: roundObj(s.prev), 前期間比: roundObj(s.change) };
  }
  const bestSlots: Record<string, unknown> = {};
  for (const [p, h] of Object.entries(data.heatmap)) {
    if (!h) continue;
    const cells: [number, number, string][] = [];
    for (let w = 0; w < 7; w++) for (let s = 0; s < SLOTS.length; s++) {
      const sc = h.score[w][s];
      if (sc !== null) cells.push([sc, h.count[w][s], `${WEEKDAYS[w]}曜 ${SLOTS[s]}`]);
    }
    cells.sort((a, b) => b[0] - a[0]);
    const fmt = (c: [number, number, string]) => ({ 枠: c[2], 平均指数: Math.round(c[0]), 件数: c[1] });
    bestSlots[p] = cells.slice(0, 5).map(fmt);
    bestSlots[`${p}_下位`] = cells.slice(-3).map(fmt);
  }

  const ctx: Record<string, unknown> = {
    期間: `${start}〜${end}（${days}日間、比較対象は直前の同日数）`,
    SNS別サマリー: summary,
    投稿形式別: data.media.map((m) => roundObj(m)),
    曜日時間帯_上位下位: bestSlots,
    ハッシュタグ: data.hashtags.map((h) => ({ ...h, score: Math.round(h.score * 10) / 10 })),
    投稿一覧_指数順: rows.map((r) => ({
      sns: r.post.platform,
      日時: `${r.local.date}(${WEEKDAYS[r.local.weekday]}) ${String(r.local.hour).padStart(2, "0")}:${String(r.local.minute).padStart(2, "0")}`,
      形式: MEDIA_LABELS[r.post.mediaType] ?? r.post.mediaType,
      本文: includePostText ? r.post.text.slice(0, MAX_TEXT_CHARS) : "（同意の範囲外のため送信しない）",
      指数: Math.round(idx(r) * 100),
      反応: r.engagements, 表示: r.post.metrics.views,
      いいね: r.post.metrics.likes, コメント: r.post.metrics.comments,
      シェア: r.post.metrics.shares, 保存: r.post.metrics.saves,
    })),
  };
  if (competitors && Object.keys(competitors.platforms).length) {
    ctx.競合比較 = {
      注記: "競合は公開値のみ取得可能なため、反応は各SNSの公開指標（反応の定義）で自社・競合をそろえて算出。hasPosts=false のアカウントはフォロワー数のみ。",
      SNS別: Object.fromEntries(Object.entries(competitors.platforms).map(([p, b]) => [p, {
        反応の定義: b!.metricLabel,
        アカウント: b!.rows.map((row) => roundObj(Object.fromEntries(Object.entries(row).filter(([k]) => k !== "rank")))),
      }])),
      競合の反応上位投稿: competitors.topPosts.slice(0, 15).map((t) => ({
        ...t, text: includePostText ? t.text.slice(0, MAX_TEXT_CHARS) : "", permalink: "", erFollowers: r4(t.erFollowers),
      })),
    };
  }
  return ctx;
}

export function buildPrompt(context: Record<string, unknown>, brandContext: string, question: string, includePostText: boolean): string {
  let brand = brandContext.trim();
  if (!includePostText) {
    brand += "\n（注：今回は同意の範囲により投稿本文を含まない。本文に基づく分析は行わず、数値・形式・時間帯から分析すること）";
  }
  const parts: string[] = [];
  if (brand.trim()) parts.push(`<brand>\n${brand.trim()}\n</brand>`);
  parts.push(`<data>\n${JSON.stringify(context, null, 1)}\n</data>`);
  parts.push([
    "上のデータを分析してください。",
    "- platforms はデータにある各SNSについて1件ずつ。",
    "- content_insights は投稿本文の比較から読み取れる「何が効いているか」を3〜5件。evidence には根拠となる投稿や数値を具体的に。",
    "- competitor_insights は「競合比較」がある場合に、競合ごとの特徴的な打ち手と自社が取り入れるべき点を2〜5件。競合データがなければ空配列。",
    "- recommendations は優先度順に5〜8件。",
    "- post_ideas は来月すぐ使える投稿案を4〜6件（sample_copy は実際に投稿できる文面）。",
    "- kpi_targets は、次の同じ長さの期間で目指す現実的な目標を各SNS1〜2件。",
    question ? `- 次の質問に question_answer で答えてください：${question}` : "- question_answer は空文字にしてください。",
  ].join("\n"));
  return parts.join("\n\n");
}

export type RunAiOptions = {
  model?: string; effort?: (typeof AI_EFFORTS)[number]; brandContext?: string; question?: string;
  includePostText: boolean; consentBy: string; consentAt: string; tz?: string;
  client?: Anthropic;
};

export async function runAiAnalysis(data: AnalysisResult, posts: Post[], followers: FollowerSeries,
  competitors: CompareResult | null, opts: RunAiOptions): Promise<AiResult> {
  if (!process.env.ANTHROPIC_API_KEY && !opts.client) {
    throw new AIError("Anthropic API の認証情報がありません。環境変数 ANTHROPIC_API_KEY を設定してください。");
  }
  const tz = opts.tz ?? DEFAULT_TZ;
  const question = (opts.question ?? "").trim();
  const context = buildContext(data, posts, followers, competitors, opts.includePostText, tz);
  const prompt = buildPrompt(context, opts.brandContext ?? "", question, opts.includePostText);
  const client = opts.client ?? new Anthropic();
  let message: Anthropic.Messages.Message;
  try {
    message = await client.messages.stream({
      model: opts.model || DEFAULT_MODEL,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort ?? "high", format: zodOutputFormat(AiOutputSchema) },
      messages: [{ role: "user", content: prompt }],
    }).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError("Anthropic API の認証に失敗しました。ANTHROPIC_API_KEY を確認してください。");
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError("APIキーに権限がありません。");
    if (e instanceof Anthropic.RateLimitError) throw new AIError("Anthropic API の利用上限に達しました。しばらく待ってから実行してください。");
    if (e instanceof Anthropic.BadRequestError) throw new AIError(`リクエストエラー：${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new AIError("Anthropic API に接続できません。時間をおいて、もう一度お試しください。");
    if (e instanceof Anthropic.APIError) throw new AIError(`Anthropic API エラー（${e.status ?? "不明"}）`);
    throw e;
  }
  if (message.stop_reason === "refusal") throw new AIError("Claude が応答を控えました。投稿データの内容を確認してください。");
  if (message.stop_reason === "max_tokens") throw new AIError("出力が上限に達して途中で切れました。分析期間を短くして、もう一度お試しください。");
  const text = message.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("");
  let parsed: AiOutput;
  try {
    parsed = AiOutputSchema.parse(JSON.parse(text));
  } catch {
    throw new AIError("AIの応答を解釈できませんでした。もう一度お試しください。");
  }
  const now = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(new Date());
  return {
    ...parsed,
    _meta: {
      model: message.model, generatedAt: now, question,
      postsSent: (context.投稿一覧_指数順 as unknown[]).length, postTextSent: opts.includePostText,
      consentBy: opts.consentBy, consentAt: opts.consentAt,
      inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens,
    },
  };
}
