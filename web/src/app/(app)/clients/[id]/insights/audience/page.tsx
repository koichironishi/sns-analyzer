import type { Metadata } from "next";
import { InsightsShell } from "@/components/insights-shell";
import { Bar } from "@/components/report-ui";
import { EmptyState } from "@/components/empty-state";
import { AGE_ORDER, GENDER_LABELS, audienceView, countryName, insightsBase, topShare } from "@/lib/insights-view";
import { fmtNum, fmtPct, slash } from "@/lib/format";

export const metadata: Metadata = { title: "インサイト" };

/** Meta のインサイト「オーディエンス」にあたる表示（フォロワーの性別・年齢・地域） */
export default async function InsightsAudiencePage({ params, searchParams }: PageProps<"/clients/[id]/insights/audience">) {
  const { id } = await params;
  const base = await insightsBase(id, await searchParams);
  const a = await audienceView(id, base.platform);
  const color = base.platform ? `var(--c-${base.platform})` : "var(--seq)";

  const ga = a?.data.genderAge ?? {};
  const genders = ["F", "M", "U"].filter((g) => ga[g]);
  const ages = [...new Set([...AGE_ORDER, ...Object.values(ga).flatMap((x) => Object.keys(x))])]
    .filter((age) => genders.some((g) => (ga[g]?.[age] ?? 0) > 0));
  const gTotal = (g: string) => Object.values(ga[g] ?? {}).reduce((s, v) => s + v, 0);
  const all = genders.reduce((s, g) => s + gTotal(g), 0);
  const ageTotal = (age: string) => genders.reduce((s, g) => s + (ga[g]?.[age] ?? 0), 0);
  const maxAge = Math.max(0, ...ages.map(ageTotal)) || 1;
  const cities = topShare(a?.data.city);
  const countries = topShare(a?.data.country, 5);

  const why = base.platform === "facebook"
    ? "Facebook ページの性別・年齢は、Meta が API で提供していないため表示できません。市区町村・国も、Meta の提供状況によっては表示されません。"
    : "フォロワーが100人未満のアカウントは、Meta が属性を提供しないため表示されません。";

  return (
    <InsightsShell base={base} lead="フォロワーの性別・年齢・地域です（期間に関係なく、最新の集計を表示します）。">
      {!a ? <EmptyState title="フォロワーの属性はまだありません" body={why} /> : (
        <>
          <p className="note-top">{slash(a.date)} 時点の集計。{why}</p>
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
                    {genders.map((g) => <th scope="col" className="num" key={g}>{GENDER_LABELS[g] ?? g}</th>)}
                  </tr></thead>
                  <tbody>
                    {ages.map((age) => (
                      <tr key={age}>
                        <th scope="row">{age}歳</th>
                        <td className="bar-cell"><Bar value={ageTotal(age)} max={maxAge} color={color} label={fmtPct(ageTotal(age) / all, 1)} /></td>
                        {genders.map((g) => <td className="num" key={g}>{fmtNum(ga[g]?.[age] ?? 0)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
