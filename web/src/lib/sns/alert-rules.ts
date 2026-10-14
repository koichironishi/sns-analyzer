/**
 * 知らせのメールの「いつ送るか」の決まり（同じ知らせが毎日届いて読まれなくなるのを防ぐ）。
 * 画面やDBに依存しない判定だけを置く（テストしやすくするため）
 */

/** 同じ問題が続いているとき、もう一度知らせるまでの日数 */
export const REPEAT_DAYS = 7;

/** 収集エラーの知らせの単位（接続ごと） */
export const collectKey = (clientId: string, platform: string, externalId: string) => `${clientId}:${platform}:${externalId}`;

/**
 * 連携の期限の段階。7日前・3日前・1日前に1回ずつ、切れたあとは REPEAT_DAYS ごとに知らせる。
 * 期限まで7日より先なら null（知らせない）
 */
export function tokenStage(left: number | null): "7" | "3" | "1" | "expired" | null {
  if (left === null || left > 7) return null;
  if (left <= 0) return "expired";
  if (left <= 1) return "1";
  if (left <= 3) return "3";
  return "7";
}

/** 段階ごとの「同じ知らせを出さない期間」（日）。期限前の段階は1回だけ、切れたあとは週1回 */
export const tokenWindowDays = (stage: NonNullable<ReturnType<typeof tokenStage>>) => (stage === "expired" ? REPEAT_DAYS : 30);

/**
 * 月次レポートの送り忘れの知らせ。月の1日（最初の収集のとき）と5日に、先月分をまだ送っていないクライアントを知らせる。
 * 10日を過ぎたら知らせない（月の途中に公開した直後に、古い月の知らせが出ないように）
 */
export function monthlyReminder(today: string): { month: string; round: "first" | "second" } | null {
  const day = Number(today.slice(8, 10));
  if (day > 10) return null;
  const [y, m] = today.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  return { month: prev, round: day >= 5 ? "second" : "first" };
}
