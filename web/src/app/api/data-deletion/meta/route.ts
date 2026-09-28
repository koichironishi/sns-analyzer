import { handleDeletionCallback } from "@/lib/deletion-callback";

export async function POST(req: Request) {
  return handleDeletionCallback(req, "meta", process.env.META_APP_SECRET);
}
