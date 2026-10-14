import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { monthLabel, monthRange, monthlyAccounts, monthlyAi, monthlyMailLines, monthlyMeo, monthlyReport, monthlyTotals, parseMonth, recentMonths } from "@/lib/monthly";
import type { PlatformSummary } from "@/lib/sns/analysis";
import { siteUrl } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { listViewers } from "@/lib/sns/store";
import { PLATFORM_LABELS } from "@/lib/sns/models";
import { PRIORITY_LABELS, platformLabel } from "@/lib/sns/ai";
import { fmtDateTime, fmtNum, fmtPct, fmtSigned, slash, truncate } from "@/lib/format";
import { Chip, Delta, Insights, PageHead } from "@/components/report-ui";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { EmptyState } from "@/components/empty-state";
import { Legend, Sparkline, StackedDaily } from "@/components/charts";
import { sendMonthlyReport } from "./actions";

export const metadata: Metadata = { title: "月次レポート" };

/**
 * 月次レポート：1か月の結果を1枚にまとめる（印刷・PDF保存と、クライアントへのメール送付）。
 * 主要な数字 → ポイント → SNS別 → 反応の良かった投稿 → 競合 → AIのまとめ、の順（報告の場で読む順）
 */
export default async function MonthlyPage({ params, searchParams }: PageProps<"/clients/[id]/monthly">) {
  const { id } = await params;
  const sp = await searchParams;
  const month = parseMonth(sp.month);
  const range = monthRange(month);
  const r = await monthlyReport(id, month);
  const v = await getViewer();
  const isStaff = v?.kind === "staff";
  const d = r.analysis;
  const [accts, meo] = await Promise.all([monthlyAccounts(r, month), monthlyMeo(id, month)]);
  const admin = createAdminClient();
  const [viewers, sent] = isStaff
    ? await Promise.all([
      listViewers(admin, id),
      admin.from("sns_audit").select("at,actor_email,detail").eq("client_id", id).eq("action", "monthly.sent").like("detail", `${month}：%`).order("at", { ascending: false }).limit(5),
    ])
    : [[], { data: [] }];
  const to = viewers.filter((u) => u.is_active && u.email);
  const history = (sent.data ?? []) as { at: string; actor_email: string | null; detail: string }[];
  // AI分析は、この月を対象に実行したもの（期間の終わりがこの月の中にあるもの）だけを載せる
  const ai = monthlyAi(r, month);
  const comp = r.competitors;

  return (
    <>
      <PageHead lead="1か月の結果を1枚にまとめます。印刷・PDF保存や、クライアントへのメール送付に使えます。" />
      <form className="no-print monthly-pick" action="" aria-label="対象の月">
        <label htmlFor="month-pick">対象の月</label>
        <select id="month-pick" name="month" defaultValue={month}>
          {recentMonths().map((m, i) => <option key={m} value={m}>{monthLabel(m)}{i === 0 ? "（今月・途中）" : ""}</option>)}
        </select>
        <button type="submit" className="btn">表示</button>
        <span className="small muted">印刷・PDF保存は、右上の「PDFで保存・印刷」から</span>
      </form>

      <article className="monthly" aria-labelledby="h-monthly">
        <header className="monthly-head">
          <p className="monthly-kicker">{meo ? "SNS・Googleマップ レポート" : "SNSレポート"}</p>
          <h2 id="h-monthly">{r.client.name}　{monthLabel(month)}</h2>
          <p className="muted small">対象：{slash(range.start)}〜{slash(range.end)}{range.partial && "（今月の途中経過）"}・比較は直前の{range.days}日間</p>
        </header>

        {d.platforms.length === 0 ? (
          <EmptyState title="この月のデータはありません" body="SNSを連携して収集すると、月ごとのレポートが作れます。" />
        ) : (
          <>
            <section aria-labelledby="h-m-kpi">
              <h3 id="h-m-kpi">主な数字</h3>
              <div className="hero">
                {monthlyTotals(r).map((x) => (
                  <div className="stat" key={x.label}>
                    <div className="stat-label">{x.label}</div>
                    <div className="stat-value">{x.value}</div>
                    {x.change !== null ? <Delta value={x.change} label="前月比 " /> : <span className="muted small">{x.note}</span>}
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="h-m-ins">
              <h3 id="h-m-ins">この月のポイント</h3>
              <div className="card"><Insights items={d.insights} visible={99} /></div>
            </section>

            <section aria-labelledby="h-m-sns">
              <h3 id="h-m-sns">SNS別</h3>
              <div className="card flush scroll">
                <table>
                  <caption className="sr-only">SNS別の結果</caption>
                  <thead><tr>
                    <th scope="col">SNS</th><th scope="col" className="num">フォロワー</th><th scope="col" className="num">増減</th>
                    <th scope="col">フォロワーの推移</th>
                    <th scope="col" className="num">投稿</th><th scope="col" className="num">エンゲージメント</th><th scope="col" className="num">ER（フォロワー比）</th>
                  </tr></thead>
                  <tbody>
                    {d.platforms.flatMap((p) => {
                      const subs = accts[p] ?? [];
                      // 同じSNSに複数アカウントがあるときは、合計の行のあとにアカウントごとの行を続ける
                      const row = (key: string, head: React.ReactNode, who: string, s: PlatformSummary, vals: (number | null)[], sub = false) => {
                        const known = vals.filter((v): v is number => v !== null);
                        return (
                          <tr key={key} className={sub ? "sub-row" : undefined}>
                            <th scope="row">{head}</th>
                            <td className="num">{fmtNum(s.followers)}</td>
                            <td className="num">{fmtSigned(s.followersDelta)}</td>
                            <td className="monthly-spark">
                              <Sparkline values={vals} platform={p}
                                label={`${who}のフォロワー推移：${known.length ? `${fmtNum(known[0])}人から${fmtNum(known.at(-1))}人` : "データなし"}`} />
                            </td>
                            <td className="num">{fmtNum(s.posts)}<Delta value={s.change.posts} /></td>
                            <td className="num">{fmtNum(s.engagements)}<Delta value={s.change.engagements} /></td>
                            <td className="num">{fmtPct(s.erFollowers)}</td>
                          </tr>
                        );
                      };
                      const s = d.summary[p]!;
                      return [
                        row(p, <><Chip platform={p} /> <span className="small muted">{subs.length ? "合計" : s.account}</span></>, PLATFORM_LABELS[p], s, d.daily.byPlatform[p]?.followers ?? []),
                        ...subs.map((a) => row(a.id, <span className="sub-name">{a.name}</span>, `${PLATFORM_LABELS[p]}（${a.name}）`, a.summary, a.followers, true)),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="h-m-daily">
              <h3 id="h-m-daily">日別の反応</h3>
              <div className="card">
                <Legend platforms={d.platforms} />
                <StackedDaily dates={d.daily.dates} label={`${monthLabel(month)}の日別エンゲージメント（SNS別の積み上げ）。合計 ${fmtNum(d.total.engagements)}`}
                  series={d.platforms.map((p) => ({ platform: p, values: d.daily.byPlatform[p]?.engagements ?? [] }))} />
                <p className="small muted" style={{ marginBottom: 0 }}>投稿日ごとのエンゲージメント（いいね・コメント・シェア・保存など）の合計です。</p>
              </div>
            </section>

            {d.topPosts.length > 0 && (
              <section aria-labelledby="h-m-top">
                <h3 id="h-m-top">反応の良かった投稿</h3>
                <ol className="card monthly-top">
                  {d.topPosts.slice(0, 5).map((t, i) => (
                    <li key={i}>
                      <span className="monthly-rank" aria-hidden="true">{i + 1}</span>
                      <div>
                        <p className="small muted" style={{ margin: 0 }}><Chip platform={t.platform} /> {slash(t.date)}・{t.media}</p>
                        <p style={{ margin: "2px 0" }}>{truncate(t.text.replace(/\s+/g, " "), 80) || "（本文なし）"}</p>
                        <p className="small" style={{ margin: 0 }}>
                          エンゲージメント {fmtNum(t.engagements)}・指数 {fmtNum(t.score)}
                          {t.permalink && <span className="no-print">・<a href={t.permalink} target="_blank" rel="noopener noreferrer">SNSで見る<span className="sr-only">（新しいタブで開きます）</span></a></span>}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {comp && (
              <section aria-labelledby="h-m-comp">
                <h3 id="h-m-comp">競合との比較</h3>
                {Object.entries(comp.platforms).map(([p, x]) => (
                  <div className="card flush scroll" key={p} style={{ marginBottom: 12 }}>
                    <table>
                      <caption>{PLATFORM_LABELS[p as keyof typeof PLATFORM_LABELS]}</caption>
                      <thead><tr>
                        <th scope="col">アカウント</th><th scope="col" className="num">フォロワー</th><th scope="col" className="num">この月の増減</th>
                        <th scope="col" className="num">投稿</th><th scope="col" className="num">平均エンゲージメント</th><th scope="col" className="num">ER（フォロワー比）</th>
                      </tr></thead>
                      <tbody>
                        {x!.rows.map((row) => (
                          <tr key={row.name} className={row.isOwn ? "own" : undefined}>
                            <th scope="row">{row.isOwn ? r.client.name : row.name}</th>
                            <td className="num">{fmtNum(row.followers)}</td>
                            <td className="num">{fmtSigned(row.followersDelta)}</td>
                            <td className="num">{fmtNum(row.posts)}</td>
                            <td className="num">{fmtNum(row.avgEng, 1)}</td>
                            <td className="num">{fmtPct(row.erFollowers)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
                {comp.insights.length > 0 && <div className="card"><Insights items={comp.insights} visible={99} /></div>}
              </section>
            )}

            {meo && (
              <section aria-labelledby="h-m-meo">
                <h3 id="h-m-meo">Googleマップ（{meo.locations}店舗）</h3>
                <div className="hero">
                  <div className="stat"><div className="stat-label">この月の口コミ</div><div className="stat-value">{fmtNum(meo.newReviews)}件</div>
                    <span className="muted small">{meo.newAvg !== null ? `平均 ★${meo.newAvg.toFixed(1)}` : "—"}</span></div>
                  <div className="stat"><div className="stat-label">口コミの合計</div><div className="stat-value">{fmtNum(meo.totalReviews)}件</div>
                    <span className="muted small">{meo.totalAvg !== null ? `平均 ★${meo.totalAvg.toFixed(1)}` : "—"}</span></div>
                  <div className="stat"><div className="stat-label">Google の投稿</div><div className="stat-value">{fmtNum(meo.posts)}件</div>
                    <span className="muted small">この月に公開</span></div>
                  <div className="stat"><div className="stat-label">未返信の口コミ</div><div className="stat-value">{fmtNum(meo.unreplied)}件</div>
                    <span className="muted small">今の時点</span></div>
                </div>
                {meo.keywords.length > 0 && (
                  <div className="card flush scroll" style={{ marginTop: 12 }}>
                    <table>
                      <caption>検索で表示されたキーワード（上位5件）</caption>
                      <thead><tr><th scope="col">キーワード</th><th scope="col" className="num">表示回数</th></tr></thead>
                      <tbody>{meo.keywords.map((k) => <tr key={k.keyword}><th scope="row">{k.keyword}</th><td className="num">{fmtNum(k.impressions)}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
                <p className="small muted">Google での閲覧数・電話・経路検索の回数は、MEO のレポートでご覧いただけます。</p>
              </section>
            )}

            <section aria-labelledby="h-m-ai">
              <h3 id="h-m-ai">AIのまとめと来月の提案</h3>
              {ai ? (
                <div className="card">
                  <p className="ai-headline" style={{ marginTop: 0 }}>{ai.headline}</p>
                  <p>{ai.summary}</p>
                  {ai.recommendations.length > 0 && (
                    <ol className="monthly-recs">
                      {[...ai.recommendations].sort((a, b) => ["high", "medium", "low"].indexOf(a.priority) - ["high", "medium", "low"].indexOf(b.priority)).slice(0, 3).map((x, i) => (
                        <li key={i}><strong>{x.action}</strong><span className="small muted">（優先度 {PRIORITY_LABELS[x.priority]}・{platformLabel(x.platform)}）</span><br /><span className="small">{x.reason}</span></li>
                      ))}
                    </ol>
                  )}
                </div>
              ) : (
                <p className="muted">
                  この月を対象にしたAI分析はまだありません。
                  {isStaff && <> 「<Link href={`/clients/${id}/ai?days=${range.days}&end=${range.end}`}>AI分析</Link>」で、期間をこの月にして実行すると、ここに載ります。</>}
                </p>
              )}
            </section>
          </>
        )}
      </article>

      {isStaff && d.platforms.length > 0 && (
        <section className="card no-print" aria-labelledby="h-m-send" style={{ marginTop: 24 }}>
          <h2 id="h-m-send" style={{ fontSize: "var(--fs-lg)", marginTop: 0 }}>クライアントにメールで送る</h2>
          {to.length === 0 ? (
            <p className="muted">送り先がありません。「<Link href={`/clients/${id}/settings/users`}>利用者管理</Link>」でクライアントの利用者を登録すると送れます。</p>
          ) : (
            <ActionForm action={sendMonthlyReport}>
              <input type="hidden" name="client_id" value={id} />
              <input type="hidden" name="month" value={month} />
              <p style={{ marginTop: 0 }}>送り先：{to.map((u) => `${u.name}（${u.email}）`).join("、")}</p>
              <p className="hint">主な数字・ポイント・SNS別・反応の良かった投稿・競合との比較・来月の提案をメールの本文に書き、ログインしなくても読めるようにします。グラフと詳しい表は、添えるリンク先（ログインが必要）で見られます。1人ずつ別のメールで送ります。</p>
              <details className="more">
                <summary>メールの文面を見る</summary>
                <pre className="mail-preview">{monthlyMailLines(r, month, `${siteUrl()}/clients/${id}/monthly?month=${month}`, accts, meo).join("\n")}</pre>
              </details>
              <label className="check"><input type="checkbox" name="confirm" required />上のレポートとメールの文面を確認しました</label>
              <div className="form-actions"><SubmitButton pendingText="送っています…">{monthLabel(month)}のレポートを送る</SubmitButton></div>
            </ActionForm>
          )}
          {history.length > 0 && (
            <>
              <h3 style={{ fontSize: "var(--fs-md)" }}>この月の送付記録</h3>
              <ul className="small">{history.map((h) => <li key={h.at}>{fmtDateTime(h.at)}　{h.actor_email ?? "—"} が送付（{h.detail.replace(`${month}：`, "")}）</li>)}</ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
