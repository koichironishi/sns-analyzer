"use client";
import Link from "next/link";
import { Fragment, useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PrintButton } from "./print-button";

/*
 * クライアントの画面の見出しとタブ（MEO と同じ形）。
 *   見出し：「クライアント名 / 画面名」
 *   タブ：画面の切り替え（下線のタブ）。期間とSNSの絞り込みは引き継ぐ
 */
const TABS = [
  { seg: "", label: "ダッシュボード" },
  { seg: "insights", label: "インサイト" },
  { seg: "sns", label: "比較・分析", also: ["timing"] },
  { seg: "competitors", label: "競合比較" },
  { seg: "content", label: "形式・タグ" },
  { seg: "downloads", label: "ダウンロード" },
] as const;

/** タブにない画面（設定・投稿の作成など）の名前 */
function pageLabel(rest: string): string {
  if (rest === "publish/new") return "新しい投稿";
  if (rest === "publish/calendar") return "投稿カレンダー";
  if (rest === "publish/bulk") return "CSVで一括予約";
  if (rest.startsWith("publish/")) return "投稿の編集";
  // 左メニューに置いた作業の画面（レポートのタブには出さない）
  if (rest === "publish") return "投稿";
  if (rest === "ai") return "AI分析";
  if (rest === "monthly") return "月次レポート";
  if (rest === "settings/meta-pages") return "連携するページの選択";
  if (rest === "settings/connections") return "SNS連携";
  if (rest === "settings/users") return "利用者管理";
  if (rest === "settings") return "クライアント情報";
  const seg = rest.split("/")[0];
  const t = TABS.find((x) => x.seg === seg || ("also" in x && (x.also as readonly string[]).includes(seg)));
  return t?.label ?? "";
}

const PDF_PAGES = ["", "insights", "insights/content", "insights/audience", "sns", "timing", "competitors", "content", "ai", "monthly"];

export function ClientHead({ clientId, clientName }: { clientId: string; clientName: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const base = `/clients/${clientId}`;
  const rest = path.startsWith(base) ? path.slice(base.length).replace(/^\//, "") : "";
  const seg = rest.split("/")[0];
  const page = pageLabel(rest);
  // 設定の画面と、左メニューに置いた作業の画面（投稿・AI分析）ではタブを出さない
  const showTabs = !rest.startsWith("settings") && seg !== "publish" && seg !== "ai";
  // レポートの画面・AI分析・月次レポートだけ「PDFをダウンロード」を出す（/api/clients/[id]/pdf で受け付ける画面と同じ）
  const printable = PDF_PAGES.includes(rest);

  const q = new URLSearchParams();
  for (const k of ["days", "end", "sns", "acct"]) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();

  // 画面が狭くタブが横にはみ出すとき、開いているタブが見える位置までずらす
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const cur = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  }, [path]);

  return (
    <div className="client-head">
      <div className="client-head-row">
        <h1 className="client-title">
          {[clientName, page].filter(Boolean).map((t, i, all) => (
            <Fragment key={i}>
              {i > 0 && <span className="client-title-sep" aria-hidden="true">/</span>}
              <span className={i === all.length - 1 ? "client-title-cur" : "client-title-parent"}>{t}</span>
            </Fragment>
          ))}
        </h1>
        {printable && <div className="client-head-actions no-print"><PrintButton clientId={clientId} /></div>}
      </div>
      {showTabs && (
        <nav ref={navRef} className="rw-navtabs client-tabs no-print" aria-label="クライアントの画面">
          {TABS.map((t) => {
            const href = t.seg ? `${base}/${t.seg}` : base;
            const current = t.seg === "" ? rest === "" : seg === t.seg || ("also" in t && (t.also as readonly string[]).includes(seg));
            const keep = !("keepQuery" in t) || t.keepQuery !== false;
            return (
              <Link key={t.seg || "dashboard"} href={keep && qs ? `${href}?${qs}` : href} aria-current={current ? "page" : undefined}>{t.label}</Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
