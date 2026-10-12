import Link from "next/link";
import { Suspense } from "react";
import type { Report } from "@/lib/report";
import { getViewer } from "@/lib/auth";
import { slash } from "@/lib/format";
import { todayIn } from "@/lib/sns/models";
import { PeriodForm } from "./period-form";
import { PlatformSwitch } from "./platform-switch";
import { PLATFORM_LABELS } from "@/lib/sns/models";
import { PageHead } from "./report-ui";

/** 各レポートページの見出しと、データがないときの案内 */
export async function ReportPage({ report, title, lead, children, needsData = true, platformSwitch = true }: {
  report: Report; title: string; lead: string; children: React.ReactNode; needsData?: boolean;
  /** SNSごとの切り替えを出すか（AI分析など、SNSで絞り込まないページは false） */
  platformSwitch?: boolean;
}) {
  const { start, end, days } = report.analysis.period;
  const sns = platformSwitch ? report.period.sns : null;
  const eyebrow = `${report.client.name}${sns ? ` ・ ${PLATFORM_LABELS[sns]}` : ""} ・ ${slash(start)}〜${slash(end)}（${days}日間）`;
  const v = await getViewer();
  const empty = needsData && !report.data.hasData;
  return (
    <>
      <PageHead eyebrow={eyebrow} title={title} lead={lead}>
        <div className="page-period no-print">
          <Suspense><PeriodForm today={todayIn()} /></Suspense>
          {platformSwitch && report.platforms.length > 1 && <Suspense><PlatformSwitch platforms={report.platforms} current={sns} /></Suspense>}
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
