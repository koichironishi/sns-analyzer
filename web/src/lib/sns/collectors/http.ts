/**
 * API クライアントの共通部品（Python 版 collectors/base.py の移植）。
 * エラーメッセージには URL を含めない（アクセストークンがクエリに入るため）。
 */
import { emptyMetrics, type MediaType, type Metrics, type Platform } from "../models.ts";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class ApiError extends Error {
  status: number | null;
  payload: unknown;
  constructor(message: string, status: number | null = null, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

type Params = Record<string, string | number | undefined>;

export type HttpOptions = {
  queryAuth?: Record<string, string>;
  headers?: Record<string, string>;
  maxRetries?: number;
  /** サーバーレスの実行時間に収めるため、1回の待ちの上限（秒） */
  maxWaitSeconds?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function toQuery(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

export function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const err = p.error;
    if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
      return `HTTP ${status}: ${(err as Record<string, string>).message}`;
    }
    if (typeof err === "string" && typeof p.error_description === "string") return `HTTP ${status}: ${p.error_description}`;
    for (const key of ["detail", "title", "message"]) {
      if (typeof p[key] === "string" && p[key]) return `HTTP ${status}: ${p[key]}`;
    }
  }
  return `HTTP ${status}`;
}

export class HttpClient {
  readonly baseUrl: string;
  private opts: Required<Omit<HttpOptions, "queryAuth" | "headers">> & Pick<HttpOptions, "queryAuth" | "headers">;

  constructor(baseUrl: string, opts: HttpOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.opts = {
      maxRetries: 2, maxWaitSeconds: 20, timeoutMs: 20_000,
      fetch: globalThis.fetch.bind(globalThis), sleep: defaultSleep, ...opts,
    };
  }

  get<T = Record<string, unknown>>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  /** application/x-www-form-urlencoded で POST（トークン交換用） */
  post<T = Record<string, unknown>>(path: string, form: Params = {}, params: Params = {}): Promise<T> {
    return this.request<T>("POST", path, params, form);
  }

  private buildUrl(path: string, params: Params): string {
    let url: string;
    let query: string;
    if (/^https?:\/\//.test(path)) {
      url = path; // ページングの next URL（認証情報を含む）など
      query = toQuery(params);
    } else {
      url = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
      query = toQuery({ ...params, ...(this.opts.queryAuth ?? {}) });
    }
    return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
  }

  private async request<T>(method: string, path: string, params: Params, form?: Params): Promise<T> {
    const url = this.buildUrl(path, params);
    const headers: Record<string, string> = { "User-Agent": "sns-analyzer/2.0", Accept: "application/json", ...(this.opts.headers ?? {}) };
    let body: string | undefined;
    if (form) {
      body = toQuery(form);
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const { maxRetries, sleep } = this.opts;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.opts.fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs), cache: "no-store" });
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
        const reason = e instanceof Error && e.name === "TimeoutError" ? "タイムアウト" : "接続できませんでした";
        throw new ApiError(`接続エラー：${reason}`);
      }
      const raw = await res.text();
      let payload: unknown = raw;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        /* JSON でない応答はそのまま */
      }
      if (res.ok) {
        if (typeof payload !== "object" || payload === null) throw new ApiError("応答を読み取れませんでした", res.status);
        return payload as T;
      }
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        const wait = retryWait(res.headers, attempt);
        if (wait <= this.opts.maxWaitSeconds) {
          await sleep(wait * 1000);
          continue;
        }
      }
      throw new ApiError(errorMessage(payload, res.status), res.status, payload);
    }
  }
}

export function retryWait(headers: Headers, attempt: number, now = Date.now()): number {
  const ra = headers.get("retry-after");
  if (ra && /^\d+$/.test(ra)) return Math.min(Number(ra), 120);
  const reset = headers.get("x-rate-limit-reset"); // X API（UNIX秒）
  if (reset && /^\d+$/.test(reset)) return Math.max(1, Math.min(Number(reset) - now / 1000, 900));
  return 2 ** (attempt + 1);
}

/** "2026-01-02T03:04:05+0000" のような形式も受け付けて ISO（UTC）にそろえる */
export function parseTime(value: string): string {
  const fixed = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const hasZone = /(Z|[+-]\d{2}:\d{2})$/.test(fixed);
  const d = new Date(hasZone ? fixed : `${fixed}Z`);
  if (Number.isNaN(d.getTime())) throw new ApiError(`日時を読み取れません：${value}`);
  return d.toISOString();
}

type GraphPage = { data?: Record<string, unknown>[]; paging?: { next?: string } };

/** Meta Graph API（Instagram / Facebook / Threads）のカーソルページング */
export async function* graphPaginate(http: HttpClient, path: string, params: Params): AsyncGenerator<Record<string, unknown>> {
  let resp = await http.get<GraphPage>(path, params);
  for (;;) {
    for (const item of resp.data ?? []) yield item;
    const next = resp.paging?.next;
    if (!next) return;
    resp = await http.get<GraphPage>(next);
  }
}

export function parseInsights(resp: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (resp as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return out;
  for (const item of data as Record<string, unknown>[]) {
    const name = item.name;
    let val: unknown = null;
    const tv = item.total_value;
    const values = item.values;
    if (tv && typeof tv === "object") val = (tv as Record<string, unknown>).value;
    else if (Array.isArray(values) && values.length) val = (values[values.length - 1] as Record<string, unknown>)?.value;
    if (val && typeof val === "object") {
      // 内訳付きの値は合計する
      val = Object.values(val as Record<string, unknown>).reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
    }
    if (typeof name === "string" && typeof val === "number") out[name] = Math.trunc(val);
  }
  return out;
}

/**
 * Graph API のインサイト取得。
 * 指標の対応状況は投稿種別や API バージョンで変わるため、まとめて要求して 400 が返ったら
 * 1指標ずつ再試行し、非対応の指標は種別ごとに記憶して以後スキップする。
 */
export class InsightsFetcher {
  private unsupported = new Map<string, Set<string>>();
  readonly warnings: string[] = [];
  private http: HttpClient;
  private metrics: string[];
  private endpoint: string;
  constructor(http: HttpClient, metrics: string[], endpoint = "insights") {
    this.http = http;
    this.metrics = metrics;
    this.endpoint = endpoint;
  }

  async fetch(objectId: string, kind = "default"): Promise<Record<string, number>> {
    let skip = this.unsupported.get(kind);
    if (!skip) this.unsupported.set(kind, (skip = new Set()));
    const wanted = this.metrics.filter((m) => !skip.has(m));
    if (!wanted.length) return {};
    try {
      return parseInsights(await this.http.get(`${objectId}/${this.endpoint}`, { metric: wanted.join(",") }));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 400) throw e;
    }
    const result: Record<string, number> = {};
    for (const m of wanted) {
      try {
        Object.assign(result, parseInsights(await this.http.get(`${objectId}/${this.endpoint}`, { metric: m })));
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 400) throw e;
        skip.add(m);
        this.warnings.push(`指標 ${m} は ${kind} で取得できないため、以後スキップします（${e.message}）`);
      }
    }
    return result;
  }
}

// ---- 収集結果の共通形式 --------------------------------------------------------

export type AccountSnapshot = {
  platform: Platform;
  externalId: string;
  username: string;
  followers: number | null;
  following: number | null;
  postsCount: number | null;
};

export type CollectedPost = {
  externalId: string;
  postedAt: string; // ISO（UTC）
  text: string;
  mediaType: MediaType;
  permalink: string | null;
  metrics: Metrics;
};

export type CollectResult = { account: AccountSnapshot; posts: CollectedPost[]; warnings: string[] };

export const metrics = (m: Partial<Metrics>): Metrics => ({ ...emptyMetrics(), ...m });

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
