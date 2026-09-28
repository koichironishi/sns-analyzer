/**
 * Instagram Graph API（Facebook ログイン経由のビジネス／クリエイターアカウント）。
 * 必要な権限：instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement, business_management
 */
import type { MediaType } from "../models.ts";
import { HttpClient, InsightsFetcher, graphPaginate, metrics, num, parseTime, str, type CollectedPost, type CollectResult } from "./http.ts";
import { DEADLINE_WARNING, cleanHandle, overDeadline, type CollectOptions, type Collector, type CollectorDeps, type ConnectionConfig } from "./types.ts";

const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count";
const BD_MEDIA_FIELDS = "id,caption,like_count,comments_count,timestamp,media_type,media_product_type,permalink";
export const DEFAULT_METRICS = ["views", "reach", "saved", "shares", "total_interactions"];

export function mediaType(m: Record<string, unknown>): MediaType {
  if (m.media_product_type === "REELS") return "reel";
  return ({ IMAGE: "image", VIDEO: "video", CAROUSEL_ALBUM: "carousel" } as Record<string, MediaType>)[str(m.media_type)] ?? "other";
}

export class InstagramCollector implements Collector {
  private http: HttpClient;
  private insights: InsightsFetcher;
  private cfg: ConnectionConfig;
  constructor(cfg: ConnectionConfig, deps: CollectorDeps = {}) {
    this.cfg = cfg;
    this.http = new HttpClient(`https://graph.facebook.com/${deps.graphVersion ?? "v26.0"}`,
      { ...deps.http, queryAuth: { access_token: cfg.accessToken } });
    this.insights = new InsightsFetcher(this.http, DEFAULT_METRICS);
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const uid = this.cfg.externalId;
    const prof = await this.http.get(uid, { fields: "id,username,followers_count,follows_count,media_count" });
    const account = {
      platform: "instagram" as const, externalId: str(prof.id), username: str(prof.username),
      followers: num(prof.followers_count), following: num(prof.follows_count), postsCount: num(prof.media_count),
    };
    const posts: CollectedPost[] = [];
    const warnings: string[] = [];
    for await (const m of graphPaginate(this.http, `${uid}/media`, { fields: MEDIA_FIELDS, limit: 50 })) {
      const postedAt = parseTime(str(m.timestamp));
      if (postedAt < opts.since) break; // 新しい順に返るので、期間外に達したら終了
      if (overDeadline(opts)) { warnings.push(DEADLINE_WARNING); break; }
      const kind = mediaType(m);
      const ins = await this.insights.fetch(str(m.id), kind);
      posts.push({
        externalId: str(m.id), postedAt, text: str(m.caption), mediaType: kind, permalink: str(m.permalink) || null,
        metrics: metrics({
          views: ins.views ?? null, reach: ins.reach ?? null,
          likes: num(m.like_count) ?? 0, comments: num(m.comments_count) ?? 0,
          shares: ins.shares ?? 0, saves: ins.saved ?? 0,
        }),
      });
      if (posts.length >= opts.maxPosts) break;
    }
    return { account, posts, warnings: [...warnings, ...this.insights.warnings] };
  }

  /**
   * Business Discovery API。相手がビジネス／クリエイターアカウントである必要がある。
   * 相手が「いいね数を非表示」にしている投稿は like_count が返らない（0として扱う）。
   */
  async collectCompetitor(handle: string, opts: CollectOptions): Promise<CollectResult> {
    const username = cleanHandle(handle);
    const posts: CollectedPost[] = [];
    let after: string | undefined;
    let account: CollectResult["account"] | null = null;
    for (;;) {
      const media = after ? `media.after(${after}).limit(50)` : "media.limit(50)";
      const fields = `business_discovery.username(${username}){id,username,followers_count,follows_count,media_count,${media}{${BD_MEDIA_FIELDS}}}`;
      const bd = (await this.http.get<{ business_discovery: Record<string, unknown> }>(this.cfg.externalId, { fields })).business_discovery;
      account ??= {
        platform: "instagram", externalId: str(bd.id), username: str(bd.username) || username,
        followers: num(bd.followers_count), following: num(bd.follows_count), postsCount: num(bd.media_count),
      };
      const mediaObj = (bd.media ?? {}) as { data?: Record<string, unknown>[]; paging?: { cursors?: { after?: string } } };
      const items = mediaObj.data ?? [];
      let done = false;
      for (const m of items) {
        const postedAt = parseTime(str(m.timestamp));
        if (postedAt < opts.since || posts.length >= opts.maxPosts) { done = true; break; }
        posts.push({
          externalId: str(m.id), postedAt, text: str(m.caption), mediaType: mediaType(m), permalink: str(m.permalink) || null,
          metrics: metrics({ likes: num(m.like_count) ?? 0, comments: num(m.comments_count) ?? 0 }),
        });
      }
      after = mediaObj.paging?.cursors?.after;
      if (done || !after || !items.length || overDeadline(opts)) break;
    }
    return { account: account!, posts, warnings: [] };
  }
}
