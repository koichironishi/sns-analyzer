import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectClient } from "@/lib/sns/collect";
import { audit } from "@/lib/sns/store";

/**
 * SNS を連携した直後に、そのクライアントの収集を始める（画面の移動は待たせない）。
 * 連携しても翌日の自動収集までデータが空のままになり、「連携したのに表示されない」となるため。
 * maxSeconds は呼び出したルートの maxDuration（その範囲で収集し、残りは次回へ回す）。
 */
export function collectSoon(clientId: string, maxSeconds: number) {
  after(async () => {
    const admin = createAdminClient();
    try {
      const { logs } = await collectClient(admin, clientId, Date.now() + (maxSeconds - 20) * 1000);
      await audit(admin, null, "collect.after_connect", clientId, logs.map((l) => l.message).join(" / ").slice(0, 500));
    } catch (e) {
      console.error("連携直後の収集に失敗", e instanceof Error ? e.message : e);
    }
  });
}
