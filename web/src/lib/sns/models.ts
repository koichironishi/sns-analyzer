/**
 * 共通データモデル。各SNSの値はここで定義した共通形式に正規化して扱う。
 * （このフォルダのファイルは Node のテストからも直接読むため、相対 import に拡張子 .ts を付ける）
 */

export const PLATFORMS = ["instagram", "facebook", "threads", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  x: "X",
};

export const MEDIA_TYPES = ["image", "video", "reel", "carousel", "text", "link", "other"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEDIA_LABELS: Record<MediaType, string> = {
  image: "画像",
  video: "動画",
  reel: "リール",
  carousel: "カルーセル",
  text: "テキスト",
  link: "リンク",
  other: "その他",
};

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}

/** 投稿の反応指標。取得できない値は null（views / reach / clicks）または 0。 */
export type Metrics = {
  views: number | null; // 表示回数（インプレッション／閲覧数）
  reach: number | null; // リーチ（ユニーク）
  likes: number; // いいね・リアクション
  comments: number; // コメント・返信
  shares: number; // シェア・リポスト
  saves: number; // 保存・ブックマーク
  quotes: number; // 引用
  clicks: number | null; // リンククリック（エンゲージメントには含めない）
};

export const emptyMetrics = (): Metrics => ({
  views: null, reach: null, likes: 0, comments: 0, shares: 0, saves: 0, quotes: 0, clicks: null,
});

/** SNS横断で比較できるエンゲージメント合計 */
export const engagementsOf = (m: Metrics): number => m.likes + m.comments + m.shares + m.saves + m.quotes;

export type Post = {
  id: string; // DB上のID（取り込み前は外部IDでよい）
  accountId: string;
  platform: Platform;
  externalId: string;
  postedAt: string; // ISO 8601（UTC）
  text: string;
  mediaType: MediaType;
  permalink: string | null;
  metrics: Metrics;
};

/** 日付（YYYY-MM-DD）→ フォロワー数 の昇順リスト */
export type Series = Array<[string, number]>;
export type FollowerSeries = Partial<Record<Platform, Series>>;

// ---- 日付（日本時間などのタイムゾーンで扱う） ----------------------------------

export const DEFAULT_TZ = "Asia/Tokyo";

export type LocalTime = { date: string; weekday: number; hour: number; minute: number };

const partsCache = new Map<string, Intl.DateTimeFormat>();

/** ISO日時 → 指定タイムゾーンでの日付・曜日（月=0）・時 */
export function toLocal(iso: string, tz = DEFAULT_TZ): LocalTime {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: wd, hour: Number(p.hour), minute: Number(p.minute) };
}

/** 今日の日付（指定タイムゾーン） */
export const todayIn = (tz = DEFAULT_TZ): string => toLocal(new Date().toISOString(), tz).date;

/** YYYY-MM-DD に日数を足す */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → YYYY/MM/DD（画面表示用） */
export const slashDate = (date: string): string => date.replaceAll("-", "/");
