import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { reportFromSearch } from "@/lib/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { consentProblem, consentState } from "@/lib/sns/privacy";
import { getConsentRow } from "@/lib/sns/store";
import { PRIORITY_LABELS, platformLabel } from "@/lib/sns/ai";
import { isPlatform } from "@/lib/sns/models";
import { ReportPage } from "@/components/report-shell";
import { Chip } from "@/components/report-ui";
import { fmtDateTime, slash } from "@/lib/format";
import { AiRunner } from "./ai-runner";

export const metadata: Metadata = { title: "AI分析" };

const PRI_CLASS = { high: "warn", medium: "info", low: "flat" } as const;

export default async function AiPage({ params, searchParams }: PageProps<"/clients/[id]/ai">) {
  const { id } = await params;
  const r = await reportFromSearch(id, await searchParams);
  const v = await getViewer();
  const stored = r.ai;
  const ai = stored?.result;
  let disabled: string | null = null;
  if (v?.kind === "staff") {
    const consent = consentState(await getConsentRow(createAdminClient(), id));
    disabled = consentProblem(consent);
  }
  const meta = ai?._meta;
  const samePeriod = stored && stored.period_end === r.period.end && stored.days === r.period.days;
  const PHead = ({ p }: { p: string }) => (isPlatform(p) ? <Chip platform={p} /> : <>全体</>);

  return (
    <ReportPage report={r} title="AI分析" lead="投稿本文と数値をもとに、Claude が改善策と投稿アイデアを提案します。" needsData={false}>
      {v?.kind === "staff" && (
        <>
          <AiRunner clientId={id} days={r.period.days} end={r.period.end} disabledReason={disabled} />
          {disabled && <p className="note">同意は「<Link href={`/clients/${id}/settings#consent`}>設定・連携</Link>」で記録できます。</p>}
        </>
      )}
      {!ai ? (
        <div className="card empty" style={{ marginTop: 16 }}><h2>AI分析の結果はまだありません</h2>
          <p>{v?.kind === "staff" ? "上のボタンから実行できます。" : "担当者がAI分析を実行すると、ここに表示されます。"}</p></div>
      ) : (
        <section className="ai" aria-label="AI分析の結果">
          {!samePeriod && <div className="msg" role="status">表示しているのは最新の分析結果（{stored!.days}日間・{slash(stored!.period_end)}まで）で、選んでいる期間とは異なります。</div>}
          <p className="note-top">
            {meta!.postTextSent ? "投稿本文と数値" : "数値のみ（投稿本文は送信していません）"}をもとに Claude が分析（{meta!.model}、{fmtDateTime(stored!.created_at)}、投稿{meta!.postsSent}件）。
            {meta!.consentBy && `送信の同意：${meta!.consentBy}（${slash(meta!.consentAt.slice(0, 10))}）。`}提案は仮説として検証しながら活用してください。
          </p>
          <div className="card ai-lead"><p className="ai-headline">{ai.headline}</p><p>{ai.summary}</p></div>
          {ai.question_answer && <div className="card ai-qa"><h3>ご質問：{meta!.question}</h3><p>{ai.question_answer}</p></div>}

          <h2 className="h3">SNS別の評価</h2>
          <div className="grid wide">
            {ai.platforms.map((p, i) => (
              <div className="card" key={i}>
                <h3><PHead p={p.platform} /></h3>
                <p>{p.assessment}</p>
                <ul className="pn">
                  {p.strengths.map((x, j) => <li className="plus" key={`s${j}`}><span aria-label="強み">＋</span>{x}</li>)}
                  {p.issues.map((x, j) => <li className="minus" key={`i${j}`}><span aria-label="課題">－</span>{x}</li>)}
                </ul>
              </div>
            ))}
          </div>

          <h2 className="h3">投稿内容から見えたこと</h2>
          <div className="grid wide">
            {ai.content_insights.map((c, i) => (
              <div className="card" key={i}><h3>{c.title}</h3><p>{c.detail}</p><p className="evidence">根拠：{c.evidence}</p></div>
            ))}
          </div>

          {ai.competitor_insights.length > 0 && (
            <>
              <h2 className="h3">競合から学べること</h2>
              <div className="grid wide">
                {ai.competitor_insights.map((c, i) => (
                  <div className="card" key={i}><div className="idea-head">{c.competitor}</div><h3>{c.observation}</h3><p>→ {c.takeaway}</p></div>
                ))}
              </div>
            </>
          )}

          <h2 className="h3">改善提案</h2>
          <div className="card scroll">
            <table>
              <thead><tr><th scope="col">優先度</th><th scope="col">SNS</th><th scope="col">アクション</th><th scope="col">理由</th><th scope="col">期待効果</th></tr></thead>
              <tbody>
                {ai.recommendations.map((x, i) => (
                  <tr key={i}>
                    <td><span className={`pri ${PRI_CLASS[x.priority]}`}>{PRIORITY_LABELS[x.priority]}</span></td>
                    <td className="nowrap">{platformLabel(x.platform)}</td><td className="strong-text">{x.action}</td><td>{x.reason}</td><td>{x.expected_effect}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="h3">投稿アイデア</h2>
          <div className="grid wide">
            {ai.post_ideas.map((x, i) => (
              <div className="card idea" key={i}>
                <div className="idea-head">{platformLabel(x.platform)} ・ {x.format}<span className="muted"> ／ {x.suggested_timing}</span></div>
                <h3>{x.idea}</h3>
                <pre className="copy">{x.sample_copy}</pre>
              </div>
            ))}
          </div>

          <h2 className="h3">次の期間のKPI目標</h2>
          <div className="card scroll">
            <table>
              <thead><tr><th scope="col">SNS</th><th scope="col">指標</th><th scope="col" className="num">現状</th><th scope="col" className="num">目標</th><th scope="col">根拠</th></tr></thead>
              <tbody>
                {ai.kpi_targets.map((k, i) => (
                  <tr key={i}><td className="nowrap">{platformLabel(k.platform)}</td><td>{k.metric}</td><td className="num">{k.current}</td><td className="num strong">{k.target}</td><td>{k.rationale}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">AI分析の結果は機械的に生成された参考情報です。事実と異なる内容を含む可能性があるため、内容を確認してから活用してください。</p>
        </section>
      )}
    </ReportPage>
  );
}
