import Link from "next/link";
import { Suspense } from "react";
import { getViewer } from "@/lib/auth";
import type { InsightsBase } from "@/lib/insights-view";
import { ReportPage } from "./report-shell";
import { InsightsTabs } from "./insights-tabs";
import { EmptyState } from "./empty-state";

/** インサイトの3画面に共通の枠（期間・SNSの選択、表示の切り替え、対応SNSがないときの案内） */
export async function InsightsShell({ base, lead, children, period = true, eyebrow }: {
  base: InsightsBase; lead: string; children: React.ReactNode;
  /** 期間に関係しない表示（オーディエンス）では期間の選択を出さない */
  period?: boolean; eyebrow?: string;
}) {
  const { report, platform, platforms } = base;
  const v = await getViewer();
  const none = platform === null;
  return (
    <ReportPage report={report} lead={lead} sns={platform} switchPlatforms={platforms} needsData={false} period={period} eyebrow={eyebrow}
      empty={none ? (
        <EmptyState title="インサイトは Instagram と Facebook ページで表示できます"
          body={v?.kind === "staff" ? "Instagram か Facebook ページを連携すると、翌日からアカウント全体の数字を集め始めます。" : "Instagram か Facebook ページの連携後に表示されます。"}
          action={v?.kind === "staff" ? <Link className="btn primary" href={`/clients/${report.client.id}/settings/connections`}>SNSを連携する</Link> : undefined} />
      ) : undefined}>
      <Suspense><InsightsTabs base={`/clients/${report.client.id}`} /></Suspense>
      {children}
    </ReportPage>
  );
}
