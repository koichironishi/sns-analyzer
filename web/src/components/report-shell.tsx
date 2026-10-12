import Link from "next/link";
import { Suspense } from "react";
import type { Report } from "@/lib/report";
import { getViewer } from "@/lib/auth";
import { slash } from "@/lib/format";
import { todayIn } from "@/lib/sns/models";
import { PeriodForm } from "./period-form";
import { PageHead } from "./report-ui";

/** 各レポートページの見出しと、データがないときの案内 */
export async function ReportPage({ report, title, lead, children, needsData = true }: {
  report: Report; title: string; lead: string; children: React.ReactNode; needsData?: boolean;
}) {
  const { start, end, days } = report.analysis.period;
  const eyebrow = `${report.client.name} ・ ${slash(start)}〜${slash(end)}（${days}日間）`;
  const v = await getViewer();
  const empty = needsData && !report.data.hasData;
  return (
    <>
      <PageHead eyebrow={eyebrow} title={title} lead={lead}>
        <div className="page-period no-print">
          <Suspense><PeriodForm today={todayIn()} /></Suspense>
        </div>
      </PageHead>
      {empty ? (
        <div className="card empty">
          <h2>この期間のデータがありません</h2>
          {v?.kind === "staff" ? (
            <p>「<Link href={`/clients/${report.client.id}/settings`}>設定・連携</Link>」で SNS を連携するか、CSVを取り込んでください。連携後は、毎日自動でデータを収集します。</p>
          ) : (
            <p>データの準備ができるまでお待ちください。期間を変えると表示される場合があります。</p>
          )}
        </div>
      ) : children}
    </>
  );
}
