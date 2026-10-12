/**
 * Facebook ページ（Graph API）。
 * 必要な権限：pages_read_engagement, read_insights（ページアクセストークンを使用）
 * 反応数・コメント数の取得には pages_read_user_content も必要。ない場合は、反応数をインサイトで補い、コメント数は 0 とする。
 */
import type { MediaType } from "../models.ts";
import { ApiError, HttpClient, InsightsFetcher, graphPaginate, metrics, num, parseTime, str, type CollectedPost, type CollectResult } from "./http.ts";
import { DEADLINE_WARNING, cleanHandle, overDeadline, type CollectOptions, type Collector, type CollectorDeps, type ConnectionConfig } from "./types.ts";

const BASIC_FIELDS = "id,message,created_time,permalink_url,shares,attachments{media_type}";
const POST_FIELDS = `${BASIC_FIELDS},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)`;
// post_impressions / post_impressions_unique は Graph API v25 以降で提供終了
export const DEFAULT_METRICS = ["post_media_view", "post_total_media_view_unique", "post_clicks", "post_reactions_by_type_total"];

export const USER_CONTENT_WARNING = "コメント数を取得する権限（pages_read_user_content）がないため、コメント数は 0 として記録しました。"
  + "反応数はインサイトから取得しています。Meta アプリの構成に権限を追加し、もう一度連携すると取得できます";

/** reactions / comments の取得に pages_read_user_content が必要というエラーか */
const isUserContentError = (e: unknown) => e instanceof ApiError && /pages_read_user_content/.test(e.message);

export function mediaType(p: Record<string, unknown>): MediaType {
  const att = ((p.attachments ?? {}) as { data?: Record<string, unknown>[] }).data ?? [];
  if (!att.length) return "text";
  return ({ photo: "image", video: "video", album: "carousel", link: "link", share: "link" } as Record<string, MediaType>)[
    str(att[0].media_type).toLowerCase()] ?? "other";
}

const summaryCount = (v: unknown): number =>
  num(((v ?? {}) as { summary?: { total_count?: unknown } }).summary?.total_count) ?? 0;

export class FacebookCollector implements Collector {
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
    const pid = this.cfg.externalId;
    const page = await this.http.get(pid, { fields: "id,name,followers_count,fan_count" });
    const account = {
      platform: "facebook" as const, externalId: str(page.id), username: str(page.name),
      followers: num(page.followers_count) || num(page.fan_count), following: null, postsCount: null,
    };
    const posts: CollectedPost[] = [];
    const warnings: string[] = [];
    const since = Math.floor(new Date(opts.since).getTime() / 1000);
    let limited = false;
    const http = this.http;
    // 権限がなければ、反応数・コメント数を除いた項目で取り直す（最初のページで失敗するため、取りこぼしはない）
    async function* listPosts() {
      let yielded = false;
      try {
        for await (const p of graphPaginate(http, `${pid}/posts`, { fields: POST_FIELDS, limit: 50, since })) { yielded = true; yield p; }
      } catch (e) {
        if (yielded || !isUserContentError(e)) throw e;
        limited = true;
        warnings.push(USER_CONTENT_WARNING);
        yield* graphPaginate(http, `${pid}/posts`, { fields: BASIC_FIELDS, limit: 50, since });
      }
    }
    for await (const p of listPosts()) {
      const postedAt = parseTime(str(p.created_time));
      if (postedAt < opts.since) break;
      if (overDeadline(opts)) { warnings.push(DEADLINE_WARNING); break; }
      const kind = mediaType(p);
      const ins = await this.insights.fetch(str(p.id), kind);
      posts.push({
        externalId: str(p.id), postedAt, text: str(p.message), mediaType: kind, permalink: str(p.permalink_url) || null,
        metrics: metrics({
          views: ins.post_media_view ?? null, reach: ins.post_total_media_view_unique ?? null, clicks: ins.post_clicks ?? null,
          likes: limited ? (ins.post_reactions_by_type_total ?? 0) : summaryCount(p.reactions), comments: summaryCount(p.comments),
          shares: num(((p.shares ?? {}) as { count?: unknown }).count) ?? 0,
        }),
      });
      if (posts.length >= opts.maxPosts) break;
    }
    return { account, posts, warnings: [...warnings, ...this.insights.warnings] };
  }

  /** 他社ページのデータは「Page Public Content Access」の審査が必要。未通過ならエラーになる */
  async collectCompetitor(handle: string): Promise<CollectResult> {
    const id = cleanHandle(handle);
    let page: Record<string, unknown>;
    try {
      page = await this.http.get(id, { fields: "id,name,followers_count,fan_count" });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      throw new ApiError(`${e.message}（他社ページの取得には Page Public Content Access の審査が必要です。CSV取り込みかフォロワー数の手動記録で登録してください）`, e.status, e.payload);
    }
    return {
      account: { platform: "facebook", externalId: str(page.id), username: str(page.name) || id,
        followers: num(page.followers_count) || num(page.fan_count), following: null, postsCount: null },
      posts: [], warnings: [],
    };
  }
}
