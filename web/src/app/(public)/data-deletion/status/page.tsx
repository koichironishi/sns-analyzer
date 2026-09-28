import type { Metadata } from "next";
import { fmtDateTime } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDeletionRequest } from "@/lib/sns/store";

export const metadata: Metadata = { title: "データ削除の状況" };

export default async function DeletionStatusPage({ searchParams }: PageProps<"/data-deletion/status">) {
  const sp = await searchParams;
  const code = typeof sp.code === "string" ? sp.code.trim() : "";
  const valid = /^[0-9a-f]{16}$/.test(code);
  const req = valid ? await getDeletionRequest(createAdminClient(), code).catch(() => null) : null;
  return (
    <article className="policy">
      <h1>データ削除の状況</h1>
      {!req ? (
        <div className="msg error" role="alert">確認コード{code ? `「${code.slice(0, 32)}」` : ""}の削除リクエストは見つかりませんでした。コードをご確認ください。</div>
      ) : (
        <div className="card">
          <dl className="kv-list">
            <dt>確認コード</dt><dd>{req.code}</dd>
            <dt>サービス</dt><dd>{req.service === "meta" ? "Facebook・Instagram" : "Threads"}</dd>
            <dt>受付日時</dt><dd>{fmtDateTime(req.created_at)}</dd>
            <dt>状況</dt><dd>{req.status === "completed" ? "削除が完了しました" : req.status}</dd>
          </dl>
          <p className="note">該当する連携がなかった場合も「削除が完了しました」と表示します（本サービスにはその方のデータが保存されていません）。</p>
        </div>
      )}
    </article>
  );
}
