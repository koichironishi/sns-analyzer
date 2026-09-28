/**
 * Threads API（graph.threads.net）。
 * 必要な権限：threads_basic, threads_manage_insights（競合は threads_profile_discovery）
 */
import type { MediaType } from "../models.ts";
import { ApiError, HttpClient, InsightsFetcher, graphPaginate, metrics, num, parseInsights, parseTime, str, type CollectedPost, type CollectResult } from "./http.ts";
import { DEADLINE_WARNING, cleanHandle, overDeadline, type CollectOptions, type Collector, type CollectorDeps, type ConnectionConfig } from "./types.ts";

const POST_FIELDS = "id,text,media_type,permalink,timestamp";
export const DEFAULT_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"];
const MEDIA_MAP: Record<string, MediaType> = {
  TEXT_POST: "text", IMAGE: "image", VIDEO: "video", CAROUSEL_ALBUM: "carousel", AUDIO: "other",
};

export class ThreadsCollector implements Collector {
  private http: HttpClient;
  private insights: InsightsFetcher;
  private cfg: ConnectionConfig;
  constructor(cfg: ConnectionConfig, deps: CollectorDeps = {}) {
    this.cfg = cfg;
    this.http = new HttpClient("https://graph.threads.net/v1.0", { ...deps.http, queryAuth: { access_token: cfg.accessToken } });
    this.insights = new InsightsFetcher(this.http, DEFAULT_METRICS);
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const prof = await this.http.get(this.cfg.externalId || "me", { fields: "id,username" });
    const uid = str(prof.id);
    const warnings: string[] = [];
    let followers: number | null = null;
    try {
      followers = parseInsights(await this.http.get(`${uid}/threads_insights`, { metric: "followers_count" })).followers_count ?? null;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      warnings.push(`Threads のフォロワー数を取得できませんでした（${e.message}）`);
    }
    const account = { platform: "threads" as const, externalId: uid, username: str(prof.username), followers, following: null, postsCount: null };
    const posts: CollectedPost[] = [];
    const since = Math.floor(new Date(opts.since).getTime() / 1000);
    for await (const t of graphPaginate(this.http, `${uid}/threads`, { fields: POST_FIELDS, limit: 50, since })) {
      if (t.media_type === "REPOST_FACADE") continue; // 他人の投稿のリポストは分析対象外
      const postedAt = parseTime(str(t.timestamp));
      if (postedAt < opts.since) break;
      if (overDeadline(opts)) { warnings.push(DEADLINE_WARNING); break; }
      const kind = MEDIA_MAP[str(t.media_type)] ?? "other";
      const ins = await this.insights.fetch(str(t.id), kind);
      posts.push({
        externalId: str(t.id), postedAt, text: str(t.text), mediaType: kind, permalink: str(t.permalink) || null,
        metrics: metrics({
          views: ins.views ?? null, likes: ins.likes ?? 0, comments: ins.replies ?? 0,
          shares: (ins.reposts ?? 0) + (ins.shares ?? 0), quotes: ins.quotes ?? 0,
        }),
      });
      if (posts.length >= opts.maxPosts) break;
    }
    return { account, posts, warnings: [...warnings, ...this.insights.warnings] };
  }

  /** profile_lookup。公式 API では他アカウントの投稿単位のデータは取れないため、フォロワー数のみ記録する */
  async collectCompetitor(handle: string): Promise<CollectResult> {
    const username = cleanHandle(handle);
    const prof = await this.http.get("profile_lookup", { username, fields: "id,username,follower_count" });
    return {
      account: { platform: "threads", externalId: str(prof.id) || `th_${username}`, username: str(prof.username) || username,
        followers: num(prof.follower_count), following: null, postsCount: null },
      posts: [], warnings: [],
    };
  }
}
