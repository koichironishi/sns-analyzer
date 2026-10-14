import "server-only";
import { notFound } from "next/navigation";
import { requireClientAccess } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLATFORMS } from "@/lib/sns/models";
import { getClient, getRequireApproval, listConnections, loadReportData } from "@/lib/sns/store";
import { analyze, bestTimes, type BestTime } from "@/lib/sns/analysis";
import { todayIn } from "@/lib/sns/models";
import { targetKey } from "@/lib/sns/publish/targets";
import type { ComposerConnection } from "@/components/post-composer";

/** 投稿画面の共通準備（権限の確認と、投稿できるSNSの一覧） */
export async function publishContext(clientId: string) {
  const v = await requireClientAccess(clientId);
  if (v.kind === "client" && v.mustChangePassword) notFound();
  const admin = createAdminClient();
  const client = await getClient(admin, clientId);
  if (!client) notFound();
  const conns = await listConnections(admin, clientId);
  // 投稿先の候補は1アカウント＝1件（同じSNSの複数アカウント）。未連携のSNSも「未連携」として1件出す
  const connections: ComposerConnection[] = PLATFORMS.flatMap((p): ComposerConnection[] => {
    const list = conns.filter((x) => x.platform === p).sort((a, b) => a.connected_at.localeCompare(b.connected_at));
    return list.length
      ? list.map((c) => ({ key: targetKey(p, c.external_id), platform: p, connected: true, canPublish: c.can_publish, username: c.username, nickname: c.nickname }))
      : [{ key: null, platform: p, connected: false, canPublish: false, username: null }];
  });
  // クライアントの利用者で、承認が必要な設定か
  const needsApproval = v.kind === "client" && (await getRequireApproval(admin, clientId));
  return { v, admin, client, connections, needsApproval };
}

/** 予約時刻のおすすめ：直近90日の曜日×時間帯の結果から、SNS ごとに反応の良い枠を選ぶ。失敗しても投稿の作成は止めない */
export async function publishBestTimes(clientId: string): Promise<BestTime[]> {
  try {
    const data = await loadReportData(createAdminClient(), clientId, { days: 90, end: todayIn() });
    const a = analyze(data.ownPosts, data.ownFollowers, { days: 90, end: todayIn(), accountNames: data.ownNames });
    return bestTimes(a.heatmap, PLATFORMS);
  } catch {
    return [];
  }
}
