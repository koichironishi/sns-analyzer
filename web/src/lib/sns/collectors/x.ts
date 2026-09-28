/**
 * X API v2。Bearer Token（アプリ認証）で公開指標 public_metrics を取得する。
 * X API は従量課金のため、max_posts_per_run で取得件数を抑えること。
 */
import type { MediaType } from "../models.ts";
import { HttpClient, metrics, num, parseTime, str, type CollectedPost, type CollectResult } from "./http.ts";
import { cleanHandle, overDeadline, DEADLINE_WARNING, type CollectOptions, type Collector, type CollectorDeps, type ConnectionConfig } from "./types.ts";

export function mediaType(tweet: Record<string, unknown>, mediaIndex: Map<string, string>): MediaType {
  const keys = ((tweet.attachments ?? {}) as { media_keys?: string[] }).media_keys ?? [];
  const types = keys.map((k) => mediaIndex.get(k) ?? "");
  if (types.length > 1) return "carousel";
  if (types.length) return ({ photo: "image", video: "video", animated_gif: "video" } as Record<string, MediaType>)[types[0]] ?? "other";
  if (((tweet.entities ?? {}) as { urls?: unknown[] }).urls?.length) return "link";
  return "text";
}

type User = { id: string; username?: string; public_metrics?: Record<string, number> };
type TweetsPage = {
  data?: Record<string, unknown>[];
  includes?: { media?: { media_key: string; type?: string }[] };
  meta?: { next_token?: string };
};

export class XCollector implements Collector {
  private http: HttpClient;
  private cfg: ConnectionConfig;
  constructor(cfg: ConnectionConfig, deps: CollectorDeps = {}) {
    this.cfg = cfg;
    this.http = new HttpClient("https://api.x.com/2", { ...deps.http, headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  }

  async lookup(usernameOrId: { username?: string; id?: string }): Promise<User> {
    const params = { "user.fields": "public_metrics,username" };
    const path = usernameOrId.id ? `users/${usernameOrId.id}` : `users/by/username/${encodeURIComponent(usernameOrId.username ?? "")}`;
    return (await this.http.get<{ data: User }>(path, params)).data;
  }

  private async collectUser(user: User, opts: CollectOptions): Promise<CollectResult> {
    const pm = user.public_metrics ?? {};
    const account = {
      platform: "x" as const, externalId: user.id, username: user.username ?? "",
      followers: num(pm.followers_count), following: num(pm.following_count), postsCount: num(pm.post_count ?? pm.tweet_count),
    };
    const posts: CollectedPost[] = [];
    const warnings: string[] = [];
    const query: Record<string, string | number> = {
      max_results: 100,
      start_time: new Date(opts.since).toISOString().replace(/\.\d{3}Z$/, "Z"),
      exclude: "retweets,replies",
      "tweet.fields": "created_at,public_metrics,entities,attachments",
      expansions: "attachments.media_keys",
      "media.fields": "type",
    };
    while (posts.length < opts.maxPosts) {
      if (overDeadline(opts)) { warnings.push(DEADLINE_WARNING); break; }
      const resp = await this.http.get<TweetsPage>(`users/${user.id}/tweets`, query);
      const mediaIndex = new Map((resp.includes?.media ?? []).map((m) => [m.media_key, m.type ?? ""]));
      for (const t of resp.data ?? []) {
        const m = (t.public_metrics ?? {}) as Record<string, number>;
        posts.push({
          externalId: str(t.id), postedAt: parseTime(str(t.created_at)), text: str(t.text),
          mediaType: mediaType(t, mediaIndex), permalink: `https://x.com/${account.username}/status/${str(t.id)}`,
          metrics: metrics({
            views: num(m.impression_count), likes: m.like_count ?? 0, comments: m.reply_count ?? 0,
            shares: m.retweet_count ?? 0, quotes: m.quote_count ?? 0, saves: m.bookmark_count ?? 0,
          }),
        });
      }
      const token = resp.meta?.next_token;
      if (!token) break;
      query.pagination_token = token;
    }
    return { account, posts: posts.slice(0, opts.maxPosts), warnings };
  }

  async collect(opts: CollectOptions): Promise<CollectResult> {
    const user = await this.lookup(this.cfg.externalId ? { id: this.cfg.externalId } : { username: this.cfg.username });
    return this.collectUser(user, opts);
  }

  async collectCompetitor(handle: string, opts: CollectOptions): Promise<CollectResult> {
    return this.collectUser(await this.lookup({ username: cleanHandle(handle) }), opts);
  }

  /**
   * 保存済みの投稿IDのうち、X上で削除・非公開化されて取得できないものを返す（100件ずつ照会）。
   * X の開発者ポリシーでは、削除・非公開化されたコンテンツは保存データからも削除する必要がある。
   */
  async missingIds(postIds: string[]): Promise<Set<string>> {
    const missing = new Set<string>();
    for (let i = 0; i < postIds.length; i += 100) {
      const batch = postIds.slice(i, i + 100);
      const resp = await this.http.get<{ data?: { id: string }[]; errors?: { resource_id?: string; value?: string }[] }>(
        "tweets", { ids: batch.join(","), "tweet.fields": "id" });
      const found = new Set((resp.data ?? []).map((t) => t.id));
      const reported = new Set((resp.errors ?? []).map((e) => String(e.resource_id ?? e.value ?? "")));
      for (const id of batch) if (!found.has(id) && reported.has(id)) missing.add(id);
    }
    return missing;
  }
}
