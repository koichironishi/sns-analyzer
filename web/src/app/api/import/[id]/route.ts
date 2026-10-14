import { json } from "@/lib/http";
import { importAuth } from "@/lib/import-auth";
import { getClient, listConnections } from "@/lib/sns/store";

/** 接続の確認（外部ツールの --check 用）。クライアント名と、投稿できる SNS・アカウントを返す */
export async function GET(req: Request, ctx: RouteContext<"/api/import/[id]">) {
  const { id } = await ctx.params;
  const { admin, denied } = await importAuth(req, id);
  if (denied) return denied;
  const client = await getClient(admin, id);
  const conns = await listConnections(admin, id);
  const ok = conns.filter((c) => c.can_publish);
  // publishable：投稿できる SNS（重複なし。以前の形）／accounts：投稿できるアカウント（同じSNSの複数アカウントを見分ける）
  return json({
    client: client?.name ?? null,
    publishable: [...new Set(ok.map((c) => c.platform))],
    accounts: ok.map((c) => ({ platform: c.platform, username: c.username, external_id: c.external_id })),
  });
}
