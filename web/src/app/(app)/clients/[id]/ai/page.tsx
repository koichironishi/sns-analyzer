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
const PRI_ORDER = { high: 0, medium: 1, low: 2 } as const;
const PHead = ({ p }: { p: string }) => (isPlatform(p) ? <Chip platform={p} /> : <span className="chip">{platformLabel(p)}</span>);

/** 長い文章を読みやすいよう、2文ずつの段落に分ける */
function sentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？])\s*/).map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 2) out.push(parts.slice(i, i + 2).join(""));
  return out.length ? out : [text];
}

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
  const recs = ai ? [...ai.recommendations].sort((a, b) => PRI_ORDER[a.priority] - PRI_ORDER[b.priority]) : [];
  const toc: [string, string][] = ai ? [
    ["ai-recs-s", "改善提案"], ["ai-sns-s", "SNS別の評価"], ["ai-content-s", "投稿内容から見えたこと"],
    ...(ai.competitor_insights.length ? [["ai-comp-s", "競合から学べること"] as [string, string]] : []),
    ["ai-ideas-s", "投稿アイデア"], ["ai-kpi-s", "KPI目標"],
  ] : [];

  return (
    <ReportPage report={r} title="AI分析" lead="投稿本文と数値をもとに、Claude が改善策と投稿アイデアを提案します。" needsData={false} platformSwitch={false}>
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
        <div className="ai" aria-label="AI分析の結果" role="region">
          {!samePeriod && <div className="msg" role="status">表示しているのは最新の分析結果（{stored!.days}日間・{slash(stored!.period_end)}まで）で、選んでいる期間とは異なります。</div>}

          <div className="card ai-lead">
            <p className="ai-kicker">この期間のまとめ</p>
            <p className="ai-headline">{ai.headline}</p>
            {sentences(ai.summary).map((t, i) => <p className="ai-body" key={i}>{t}</p>)}
          </div>
          {ai.question_answer && (
            <div className="card ai-qa"><h3>ご質問：{meta!.question}</h3>{sentences(ai.question_answer).map((t, i) => <p className="ai-body" key={i}>{t}</p>)}</div>
          )}

          <nav className="ai-toc no-print" aria-label="AI分析の目次">
            {toc.map(([href, label]) => <a key={href} href={`#${href}`}>{label}</a>)}
          </nav>

          <section aria-labelledby="ai-recs" id="ai-recs-s">
            <h2 id="ai-recs">改善提案<span className="ai-count">{recs.length}件</span></h2>
            <p className="sub">優先度の高い順です。</p>
            <ol className="ai-recs">
              {recs.map((x, i) => (
                <li className="card ai-rec" key={i}>
                  <div className="ai-rec-head">
                    <span className={`pri ${PRI_CLASS[x.priority]}`}>優先度 {PRIORITY_LABELS[x.priority]}</span>
                    <PHead p={x.platform} />
                  </div>
                  <h3 className="ai-rec-action">{x.action}</h3>
                  <dl className="ai-rec-why">
                    <div><dt>理由</dt><dd>{x.reason}</dd></div>
                    <div><dt>期待効果</dt><dd>{x.expected_effect}</dd></div>
                  </dl>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="ai-sns" id="ai-sns-s">
            <h2 id="ai-sns">SNS別の評価</h2>
            <div className="ai-grid">
              {ai.platforms.map((p, i) => (
                <article className="card ai-pcard" key={i}>
                  <h3 className="ai-pcard-title"><PHead p={p.platform} /></h3>
                  {sentences(p.assessment).map((t, j) => <p className="ai-body" key={j}>{t}</p>)}
                  {p.strengths.length > 0 && (
                    <div className="ai-pn good">
                      <h4>良い点</h4>
                      <ul>{p.strengths.map((x, j) => <li key={j}>{x}</li>)}</ul>
                    </div>
                  )}
                  {p.issues.length > 0 && (
                    <div className="ai-pn bad">
                      <h4>課題</h4>
                      <ul>{p.issues.map((x, j) => <li key={j}>{x}</li>)}</ul>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section aria-labelledby="ai-content" id="ai-content-s">
            <h2 id="ai-content">投稿内容から見えたこと</h2>
            <div className="ai-grid">
              {ai.content_insights.map((c, i) => (
                <article className="card" key={i}>
                  <h3 className="ai-card-title">{c.title}</h3>
                  {sentences(c.detail).map((t, j) => <p className="ai-body" key={j}>{t}</p>)}
                  <p className="ai-evidence"><span>根拠</span>{c.evidence}</p>
                </article>
              ))}
            </div>
          </section>

          {ai.competitor_insights.length > 0 && (
            <section aria-labelledby="ai-comp" id="ai-comp-s">
              <h2 id="ai-comp">競合から学べること</h2>
              <div className="ai-grid">
                {ai.competitor_insights.map((c, i) => (
                  <article className="card" key={i}>
                    <p className="ai-kicker">{c.competitor}</p>
                    <h3 className="ai-card-title">{c.observation}</h3>
                    <p className="ai-takeaway"><span>自社への活かし方</span>{c.takeaway}</p>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section aria-labelledby="ai-ideas" id="ai-ideas-s">
            <h2 id="ai-ideas">投稿アイデア</h2>
            <div className="ai-grid">
              {ai.post_ideas.map((x, i) => (
                <article className="card idea" key={i}>
                  <div className="ai-rec-head"><PHead p={x.platform} /><span className="tag">{x.format}</span><span className="muted small">{x.suggested_timing}</span></div>
                  <h3 className="ai-card-title">{x.idea}</h3>
                  <p className="ai-kicker">投稿文の例</p>
                  <pre className="copy">{x.sample_copy}</pre>
                </article>
              ))}
            </div>
          </section>

          <section aria-labelledby="ai-kpi" id="ai-kpi-s">
            <h2 id="ai-kpi">次の期間のKPI目標</h2>
            <div className="card flush scroll">
              <table className="ai-kpi">
                <thead><tr><th scope="col">SNS</th><th scope="col">指標</th><th scope="col" className="num">現状</th><th scope="col" className="num">目標</th><th scope="col">根拠</th></tr></thead>
                <tbody>
                  {ai.kpi_targets.map((k, i) => (
                    <tr key={i}><td className="nowrap"><PHead p={k.platform} /></td><td className="strong-text">{k.metric}</td><td className="num">{k.current}</td><td className="num strong">{k.target}</td><td>{k.rationale}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="note">
            {meta!.postTextSent ? "投稿本文と数値" : "数値のみ（投稿本文は送信していません）"}をもとに Claude が分析（{meta!.model}、{fmtDateTime(stored!.created_at)}、投稿{meta!.postsSent}件）。
            {meta!.consentBy && `送信の同意：${meta!.consentBy}（${slash(meta!.consentAt.slice(0, 10))}）。`}
            AI分析の結果は機械的に生成された参考情報です。事実と異なる内容を含む可能性があるため、仮説として確認・検証しながら活用してください。
          </p>
        </div>
      )}
    </ReportPage>
  );
}
