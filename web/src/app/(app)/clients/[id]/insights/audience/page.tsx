import type { Metadata } from "next";
import { InsightsShell } from "@/components/insights-shell";
import { Bar } from "@/components/report-ui";
import { EmptyState } from "@/components/empty-state";
import { AGE_ORDER, GENDER_LABELS, ageShares, audienceView, countryName, insightsBase, onlineSummary, topShare } from "@/lib/insights-view";
import { fmtNum, fmtPct, slash } from "@/lib/format";
import { PLATFORM_LABELS } from "@/lib/sns/models";

export const metadata: Metadata = { title: "インサイト" };

/** Meta のインサイト「オーディエンス」にあたる表示（フォロワーの性別・年齢・地域） */
export default async function InsightsAudiencePage({ params, searchParams }: PageProps<"/clients/[id]/insights/audience">) {
  const { id } = await params;
  const base = await insightsBase(id, await searchParams);
  const a = await audienceView(base);
  const acctName = a?.account ? base.report.accounts.find((x) => x.id === a.account)?.name : undefined;
  const color = base.platform ? `var(--c-${base.platform})` : "var(--seq)";

  const ga = a?.data.genderAge ?? {};
  const genders = ["F", "M", "U"].filter((g) => ga[g]);
  const ages = [...new Set([...AGE_ORDER, ...Object.values(ga).flatMap((x) => Object.keys(x))])]
    .filter((age) => genders.some((g) => (ga[g]?.[age] ?? 0) > 0));
  const gTotal = (g: string) => Object.values(ga[g] ?? {}).reduce((s, v) => s + v, 0);
  const all = genders.reduce((s, g) => s + gTotal(g), 0);
  const ageTotal = (age: string) => genders.reduce((s, g) => s + (ga[g]?.[age] ?? 0), 0);
  const maxAge = Math.max(0, ...ages.map(ageTotal)) || 1;
  // 反応した人（いいね・保存などをしたアカウント）の年代の割合。フォロワーの年代と並べて比べる
  const engaged = ageShares(a?.data.engagedAge);
  const hasEngaged = Object.keys(engaged).length > 0;
  const engagedAges = ages.length ? ages : AGE_ORDER.filter((age) => engaged[age]);
  const online = onlineSummary(a?.data.online);
  const maxOnline = online ? Math.max(1, ...online.days.flatMap((d) => d.hours)) : 1;
  const wd = (date: string) => "日月火水木金土"[new Date(`${date}T12:00:00+09:00`).getDay()];
  const cities = topShare(a?.data.city);
  const countries = topShare(a?.data.country, 5);

  const why = base.platform === "facebook"
    ? "Facebook ページの性別・年齢は、Meta が API で提供していないため表示できません。市区町村・国も、Meta の提供状況によっては表示されません。"
    : "フォロワーが100人未満のアカウントは、Meta が属性を提供しないため表示されません。";

  return (
    <InsightsShell base={base} period={false} acct={a?.account ?? null} totals={false}
      eyebrow={`${base.platform ? `${PLATFORM_LABELS[base.platform]}${acctName ? `（${acctName}）` : ""} ・ ` : ""}${a ? `${slash(a.date)} 時点` : "集計前"}`}
      lead="フォロワー全体の性別・年齢・地域です。Meta が通算の値として提供するため、期間では変わりません（毎日の収集で最新の集計に更新します）。">
      {!a ? <EmptyState title="フォロワーの属性はまだありません" body={why} /> : (
        <>
          <p className="note-top">{why}</p>
          {all > 0 && (
            <section aria-labelledby="h-ga">
              <h2 id="h-ga">性別・年齢</h2>
              <div className="hero">
                {genders.map((g) => (
                  <div className="stat" key={g}><div className="stat-label">{GENDER_LABELS[g] ?? g}</div><div className="stat-value">{fmtPct(gTotal(g) / all, 1)}</div></div>
                ))}
              </div>
              <div className="card flush scroll" style={{ marginTop: "var(--s4)" }}>
                <table>
                  <thead><tr>
                    <th scope="col">年齢</th><th scope="col">割合</th>
                    {hasEngaged && <th scope="col" className="num">反応した人の割合</th>}
                    {genders.map((g) => <th scope="col" className="num" key={g}>{GENDER_LABELS[g] ?? g}</th>)}
                  </tr></thead>
                  <tbody>
                    {ages.map((age) => (
                      <tr key={age}>
                        <th scope="row">{age}歳</th>
                        <td className="bar-cell"><Bar value={ageTotal(age)} max={maxAge} color={color} label={fmtPct(ageTotal(age) / all, 1)} /></td>
                        {hasEngaged && <td className="num">{engaged[age] !== undefined ? fmtPct(engaged[age], 1) : "—"}</td>}
                        {genders.map((g) => <td className="num" key={g}>{fmtNum(ga[g]?.[age] ?? 0)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {hasEngaged && all === 0 && (
            <section aria-labelledby="h-engaged">
              <h2 id="h-engaged">反応した人の年代</h2>
              <div className="card flush scroll">
                <table>
                  <tbody>
                    {engagedAges.filter((age) => engaged[age]).map((age) => (
                      <tr key={age}><th scope="row">{age}歳</th><td className="bar-cell"><Bar value={engaged[age]} max={Math.max(...Object.values(engaged))} color={color} label={fmtPct(engaged[age], 1)} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {hasEngaged && <p className="small muted">「反応した人の割合」は、今月いいね・コメント・保存・シェアなどをしたアカウント（フォロワー以外も含む）の年代の割合です。フォロワーの割合と比べると、どの年代に響いているかが分かります。</p>}

          {online && (
            <section aria-labelledby="h-online">
              <h2 id="h-online">フォロワーがオンラインの時間帯</h2>
              <p className="sub">
                Instagram を開いていたフォロワーの数（1時間ごと・日本時間・直近{online.days.length}日）。
                最も多いのは <strong>{online.peaks.map((h) => `${h}時台`).join("・")}</strong> です。年代別の時間帯は Meta が提供していないため、フォロワー全体の数です。
              </p>
              <div className="card flush scroll">
                <table className="online-table">
                  <caption className="sr-only">日ごと・時間帯ごとの、オンラインだったフォロワーの数</caption>
                  <thead><tr><th scope="col">日</th>{online.avg.map((_, h) => <th scope="col" key={h} className="num">{h}</th>)}</tr></thead>
                  <tbody>
                    {online.days.map((d) => (
                      <tr key={d.date}>
                        <th scope="row" className="nowrap">{slash(d.date.slice(5))}（{wd(d.date)}）</th>
                        {d.hours.map((v, h) => (
                          <td key={h} className="num online-cell" style={{ background: `color-mix(in srgb, ${color} ${Math.round((v / maxOnline) * 70)}%, var(--surface))` }}>
                            {fmtNum(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr className="online-avg">
                      <th scope="row">平均</th>
                      {online.avg.map((v, h) => <td key={h} className={`num${online.peaks.includes(h) ? " strong" : ""}`}>{fmtNum(v)}</td>)}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="small muted">
                色が濃いほど多い時間帯です。投稿は、この時間の少し前に出すと見られやすくなります。
                Meta は時刻を太平洋時間で返すとみられるため、日本時間に直しています。フォロワーが100人未満のアカウントでは表示されません。
              </p>
            </section>
          )}

          <div className="insight-grid">
            {([["h-city", "上位の市区町村", cities, (k: string) => k], ["h-country", "上位の国", countries, countryName]] as const).map(([hid, title, list, name]) => (
              <section aria-labelledby={hid} key={hid}>
                <h2 id={hid}>{title}</h2>
                <div className="card flush scroll">
                  {!list.length ? <p className="muted" style={{ padding: 24 }}>データがありません。</p> : (
                    <table>
                      <tbody>
                        {list.map((x) => (
                          <tr key={x.key}>
                            <th scope="row">{name(x.key)}</th>
                            <td className="bar-cell"><Bar value={x.share} max={list[0].share} color={color} label={fmtPct(x.share, 1)} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </InsightsShell>
  );
}
