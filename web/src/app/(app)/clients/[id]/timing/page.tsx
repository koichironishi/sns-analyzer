import type { Metadata } from "next";
import { reportFromSearch } from "@/lib/report";
import { ReportPage } from "@/components/report-shell";
import { TabLinks } from "@/components/tab-links";
import { SLOTS, WEEKDAYS } from "@/lib/sns/analysis";
import { PLATFORM_LABELS, isPlatform } from "@/lib/sns/models";

export const metadata: Metadata = { title: "投稿時間" };

const heatClass = (s: number | null) => {
  if (s === null) return "h0";
  const i = [60, 80, 100, 120, 150, 200].findIndex((th) => s < th);
  return i === -1 ? "h7" : `h${i + 1}`;
};

export default async function TimingPage({ params, searchParams }: PageProps<"/clients/[id]/timing">) {
  const { id } = await params;
  const sp = await searchParams;
  const r = await reportFromSearch(id, sp);
  const d = r.analysis;
  const key = typeof sp.sns === "string" && isPlatform(sp.sns) && d.heatmap[sp.sns] ? sp.sns : "all";
  const h = d.heatmap[key];
  const name = key === "all" ? "全体" : PLATFORM_LABELS[key];
  return (
    <ReportPage report={r} title="投稿時間" lead="どの曜日・時間帯の投稿が反応を得ているか。">
      <section aria-labelledby="h-heat">
        <h2 id="h-heat">曜日 × 時間帯</h2>
        <p className="sub">パフォーマンス指数の平均（100＝そのSNSの普段の投稿、200＝2倍の反応）。空欄は投稿なし。</p>
        <div className="card">
          <TabLinks param="sns" current={key} sp={sp} label="SNSを選択"
            options={[{ value: "all", label: "全体" }, ...d.platforms.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))]} />
          {h ? (
            <div className="scroll">
              <table className="heatmap">
                <caption className="sr-only">{name}：曜日×時間帯のパフォーマンス指数</caption>
                <thead><tr><td />{SLOTS.map((s) => <th scope="col" key={s}>{s}</th>)}</tr></thead>
                <tbody>
                  {WEEKDAYS.map((wd, w) => (
                    <tr key={wd}>
                      <th scope="row">{wd}</th>
                      {SLOTS.map((slot, s) => {
                        const sc = h.score[w][s];
                        const n = h.count[w][s];
                        return (
                          <td key={slot} className={`heat ${heatClass(sc)}`} title={`${wd}曜 ${slot}：${sc === null ? "投稿なし" : `指数 ${Math.round(sc)}（${n}件）`}`}>
                            {sc === null ? <span className="sr-only">投稿なし</span> : <>{Math.round(sc)}<span className="sr-only">（{n}件）</span></>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">投稿がありません。</p>}
          <div className="heat-legend">指数：
            {([["h1", "〜60"], ["h2", "60〜80"], ["h3", "80〜100"], ["h4", "100〜120"], ["h5", "120〜150"], ["h6", "150〜200"], ["h7", "200〜"]] as const).map(([c, t]) => (
              <span key={c}><i className={`heat ${c}`} aria-hidden="true" />{t}</span>
            ))}
          </div>
        </div>
      </section>
    </ReportPage>
  );
}
