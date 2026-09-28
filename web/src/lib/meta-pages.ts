import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Viewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import type { MetaPage } from "@/lib/sns/connect";
import { audit, saveConnection } from "@/lib/sns/store";

/** 選んだページで Facebook（と、紐づく Instagram）の接続を保存する */
export async function saveMetaPage(admin: SupabaseClient, v: Viewer, clientId: string, page: MetaPage, metaUserId: string) {
  await saveConnection(admin, clientId, "facebook", {
    externalId: page.pageId, username: page.name, accessToken: page.accessToken, expiresAt: null, connectedUserId: metaUserId,
  });
  if (page.igUserId) {
    await saveConnection(admin, clientId, "instagram", {
      externalId: page.igUserId, username: page.igUsername, accessToken: page.accessToken, expiresAt: null, connectedUserId: metaUserId,
    });
  }
  await audit(admin, v, "connect.meta", clientId, `ページ「${page.name}」${page.igUserId ? `・Instagram @${page.igUsername}` : "（Instagram の紐づけなし）"}`, await clientIp());
}
