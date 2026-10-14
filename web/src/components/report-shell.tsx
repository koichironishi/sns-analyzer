import Link from "next/link";
import { Suspense } from "react";
import type { Report } from "@/lib/report";
import { getViewer } from "@/lib/auth";
import { slash } from "@/lib/format";
import { todayIn } from "@/lib/sns/models";
import { PeriodForm } from "./period-form";
import { PlatformSwitch } from "./platform-switch";
import { PLATFORM_LABELS, type Platform } from "@/lib/sns/models";
import { EmptyState } from "./empty-state";
import { CollectButton } from "./collect-button";
import { createAdminClient } from "@/lib/supabase/admin";
import { listConnections } from "@/lib/sns/store";
import { PageHead } from "./report-ui";

/** 各レポートページの見出しと、データがないときの案内 */
export async function ReportPage({ report, lead, children, needsData = true, platformSwitch = true, sns: snsOverride, switchPlatforms, empty: emptyOverride, period = true, eyebrow: eyebrowOverride, acct: acctOverride, totals = true }: {
  report: Report;
  /** 画面の名前（見出しはレイアウトの ClientHead が出すため、ここでは表示しない） */
  title?: string;
  lead: string; children: React.ReactNode; needsData?: boolean;
  /** SNSごとの切り替えを出すか（AI分析など、SNSで絞り込まないページは false） */
  platformSwitch?: boolean;
  /** 「すべて」を持たない画面（インサイトなど）で、表示中のSNSと選べるSNSを指定する */
  sns?: Platform | null;
  switchPlatforms?: Platform[];
  /** データがないときの案内を差し替える */
  empty?: React.ReactNode;
  /** 期間の選択を出すか（期間に関係しない画面＝オーディエンスなどは false） */
  period?: boolean;
  /** 見出しの上の小さな文字（既定は「SNS ・ 期間」） */
  eyebrow?: string;
  /** 表示中のアカウント（同じSNSに複数あるとき。既定は URL の acct） */
  acct?: string | null;
  /** 複数アカウントのSNSで「合計」を選べるか */
  totals?: boolean;
}) {
  const { start, end, days } = report.analysis.period;
  const sns = platformSwitch ? (snsOverride !== undefined ? snsOverride : report.period.sns) : null;
  const choices = switchPlatforms ?? report.platforms;
  const acct = platformSwitch ? (acctOverride !== undefined ? acctOverride : report.period.acct) : null;
  const acctName = acct ? report.accounts.find((a) => a.id === acct)?.name : undefined;
  // 同じSNSに複数のアカウントがあれば、SNSが1つでも切り替えを出す
  const multi = choices.some((p) => report.accounts.filter((a) => a.platform === p).length > 1);
  const eyebrow = eyebrowOverride ?? `${sns ? `${PLATFORM_LABELS[sns]}${acctName ? `（${acctName}）` : ""} ・ ` : ""}${slash(start)}〜${slash(end)}（${days}日間）`;
  const v = await getViewer();
  const empty = needsData && !report.data.hasData;
  // 連携済みなのにデータがない＝まだ収集が終わっていない。その場で収集できるようにする（スタッフのみ）
  const connected = empty && v?.kind === "staff" ? (await listConnections(createAdminClient(), report.client.id)).length > 0 : false;
  return (
    <>
      {/* 見出し（クライアント名 / 画面名）はレイアウトの ClientHead が出す。title は画面の名前としてだけ受け取る */}
      <PageHead eyebrow={eyebrow} lead={lead}>
        <div className="page-period no-print">
          {period && <Suspense><PeriodForm today={todayIn()} /></Suspense>}
          {platformSwitch && (choices.length > (switchPlatforms ? 0 : 1) || multi) && (
            <Suspense><PlatformSwitch platforms={choices} current={sns} allowAll={!switchPlatforms} accounts={report.accounts} currentAcct={acct} totals={totals} /></Suspense>
          )}
        </div>
      </PageHead>
      {emptyOverride ?? (empty && connected ? (
        <EmptyState title="まだデータを収集していません"
          body="SNSは連携済みです。連携の直後は自動で収集が始まり、数分で表示されます。すぐに見たいときは、ここから収集してください（期間を変えると表示される場合もあります）。"
          action={<CollectButton clientId={report.client.id} disabled={false} />} />
      ) : empty ? (
        <EmptyState title="この期間のデータがありません"
          body={v?.kind === "staff"
            ? "SNSを連携するか、CSVを取り込むと表示されます。連携後は、毎日自動でデータを収集します。"
            : "データの準備ができるまでお待ちください。期間を変えると表示される場合があります。"}
          action={v?.kind === "staff" ? <Link className="btn primary" href={`/clients/${report.client.id}/settings/connections`}>SNSを連携する</Link> : undefined} />
      ) : children)}
    </>
  );
}
