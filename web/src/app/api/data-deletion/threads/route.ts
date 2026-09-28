import { handleDeletionCallback } from "@/lib/deletion-callback";

/** Threads の「アンインストール」「削除」コールバックの両方にこの URL を設定する */
export async function POST(req: Request) {
  return handleDeletionCallback(req, "threads", process.env.THREADS_APP_SECRET);
}
