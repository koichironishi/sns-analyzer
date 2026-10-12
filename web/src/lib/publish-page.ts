import "server-only";
import { notFound } from "next/navigation";
import { requireClientAccess } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLATFORMS } from "@/lib/sns/models";
import { getClient, listConnections } from "@/lib/sns/store";
import type { ComposerConnection } from "@/components/post-composer";

/** 投稿画面の共通準備（権限の確認と、投稿できるSNSの一覧） */
export async function publishContext(clientId: string) {
  const v = await requireClientAccess(clientId);
  if (v.kind === "client" && v.mustChangePassword) notFound();
  const admin = createAdminClient();
  const client = await getClient(admin, clientId);
  if (!client) notFound();
  const conns = await listConnections(admin, clientId);
  const connections: ComposerConnection[] = PLATFORMS.map((p) => {
    const c = conns.find((x) => x.platform === p);
    return { platform: p, connected: Boolean(c), canPublish: Boolean(c?.can_publish), username: c?.username ?? null };
  });
  return { v, admin, client, connections };
}
