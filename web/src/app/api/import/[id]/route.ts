import { json } from "@/lib/http";
import { importAuth } from "@/lib/import-auth";
import { getClient, listConnections } from "@/lib/sns/store";

/** 接続の確認（外部ツールの --check 用）。クライアント名と、投稿できる SNS を返す */
export async function GET(req: Request, ctx: RouteContext<"/api/import/[id]">) {
  const { id } = await ctx.params;
  const { admin, denied } = await importAuth(req, id);
  if (denied) return denied;
  const client = await getClient(admin, id);
  const conns = await listConnections(admin, id);
  return json({ client: client?.name ?? null, publishable: conns.filter((c) => c.can_publish).map((c) => c.platform) });
}
