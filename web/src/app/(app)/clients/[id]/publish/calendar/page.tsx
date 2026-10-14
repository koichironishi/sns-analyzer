import type { Metadata } from "next";
import Link from "next/link";
import { publishContext } from "@/lib/publish-page";
import { listScheduledPosts, ownPostsBetween, type PostStatus, type ScheduledPost } from "@/lib/sns/store";
import { addDays, todayIn, toLocal, PLATFORM_LABELS, type Platform } from "@/lib/sns/models";
import { platformsOf } from "@/lib/sns/publish/targets";
import { truncate } from "@/lib/format";
import { PageHead } from "@/components/report-ui";
import { PublishViewSwitch } from "@/components/publish-view-switch";

export const metadata: Metadata = { title: "投稿カレンダー" };

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const STATUS: Partial<Record<PostStatus, [string, string]>> = {
  pending: ["承認待ち", "info"], scheduled: ["予約", "info"], publishing: ["投稿中", "info"], published: ["投稿済み", "good"],
  partial: ["一部失敗", "warn"], failed: ["失敗", "warn"], draft: ["下書き", ""], rejected: ["差し戻し", "warn"],
};

type Item = { key: string; time: string; platforms: Platform[]; title: string; href: string; external: boolean; badge?: [string, string]; note?: string };

const titleOf = (text: string) => truncate(text.split("\n").map((l) => l.trim()).find(Boolean) ?? "", 28) || "（本文なし）";
const hhmm = (iso: string) => { const t = toLocal(iso); return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`; };

/** 投稿の日時：投稿済みは投稿した時刻、それ以外は予約（希望）の時刻。時刻のない下書きはカレンダーに出さない */
const whenOf = (p: ScheduledPost) => (p.published_at ?? p.scheduled_at);

/**
 * 投稿カレンダー：この画面で作った投稿（予約・承認待ち・投稿済み）と、SNS 上に直接出した投稿を、月のカレンダーで見る。
 * Rhythmos AI から入れた投稿と、クライアントが自分で出した投稿の重なりも、ここで分かる
 */
export default async function PublishCalendarPage({ params, searchParams }: PageProps<"/clients/[id]/publish/calendar">) {
  const { id } = await params;
  const sp = await searchParams;
  const { admin } = await publishContext(id);
  const today = todayIn();
  const want = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : today.slice(0, 7);
  const first = `${want}-01`;
  const [y, m] = want.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const prevMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const last = addDays(`${nextMonth}-01`, -1);
  // 月曜はじまりで、前後の月の日も埋めて6週以内に並べる
  const lead = toLocal(`${first}T12:00:00+09:00`).weekday;
  const start = addDays(first, -lead);
  const days: string[] = [];
  for (let d = start; d <= last || days.length % 7; d = addDays(d, 1)) days.push(d);

  const startIso = new Date(`${start}T00:00:00+09:00`).toISOString();
  const endIso = new Date(`${addDays(days.at(-1)!, 1)}T00:00:00+09:00`).toISOString();
  const [posts, collected] = await Promise.all([listScheduledPosts(admin, id, 1000), ownPostsBetween(admin, id, startIso, endIso)]);

  const byDay = new Map<string, Item[]>();
  const add = (iso: string, item: Item) => {
    const d = toLocal(iso).date;
    byDay.set(d, [...(byDay.get(d) ?? []), item]);
  };
  // この画面から出した投稿の SNS 上の ID（収集した投稿と二重に並べない）
  const ours = new Set<string>();
  for (const p of posts) {
    for (const r of Object.values(p.results ?? {})) if (r?.id) ours.add(r.id);
    const when = whenOf(p);
    if (!when || !STATUS[p.status] || when < startIso || when >= endIso) continue;
    const editable = ["draft", "pending", "rejected", "scheduled"].includes(p.status);
    add(when, {
      key: p.id, time: hhmm(when), platforms: p.targets?.length ? platformsOf(p.targets) : p.platforms, title: titleOf(p.text), external: false,
      href: editable ? `/clients/${id}/publish/${p.id}` : `/clients/${id}/publish#post-${p.id}`,
      badge: STATUS[p.status], note: p.status === "pending" ? "希望の時刻" : undefined,
    });
  }
  for (const c of collected) {
    if (ours.has(c.externalId)) continue;
    add(c.postedAt, {
      key: c.id, time: hhmm(c.postedAt), platforms: [c.platform], title: c.story ? "ストーリーズ" : titleOf(c.text),
      href: c.permalink ?? `/clients/${id}?sns=${c.platform}#posts`, external: Boolean(c.permalink), note: "SNSで直接投稿",
    });
  }
  for (const list of byDay.values()) list.sort((a, b) => a.time.localeCompare(b.time));
  const count = [...byDay.entries()].filter(([d]) => d.startsWith(want)).reduce((s, [, l]) => s + l.length, 0);

  return (
    <>
      <PageHead lead="この画面で作った投稿（予約・承認待ち・投稿済み）と、SNSで直接出した投稿を、月ごとに並べます。SNSで直接出した投稿は毎日の収集で集めるため、前日までの分が並びます。" />
      <PublishViewSwitch clientId={id} current="calendar" />
      <div className="cal-head">
        <Link className="btn" href={`?month=${prevMonth}`} scroll={false}>‹ 前の月</Link>
        <h2 className="cal-title" aria-live="polite">{y}年{m}月<span className="muted small">（{count}件）</span></h2>
        <Link className="btn" href={`?month=${nextMonth}`} scroll={false}>次の月 ›</Link>
        {want !== today.slice(0, 7) && <Link className="btn" href="?" scroll={false}>今月</Link>}
      </div>
      <ul className="cal-legend small" aria-label="凡例">
        <li><span className="badge info">予約・承認待ち</span></li>
        <li><span className="badge good">投稿済み</span></li>
        <li><span className="badge warn">失敗・差し戻し</span></li>
        <li><span className="cal-direct">SNSで直接投稿</span><span className="muted">（前日までの収集分）</span></li>
      </ul>
      <ol className="cal-grid" aria-label={`${y}年${m}月の投稿`}>
        {WEEKDAYS.map((w, i) => <li key={w} className={`cal-wd${i >= 5 ? " weekend" : ""}`} aria-hidden="true">{w}</li>)}
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          const out = !d.startsWith(want);
          const [, mm, dd] = d.split("-").map(Number);
          return (
            <li key={d} className={`cal-day${out ? " out" : ""}${d === today ? " today" : ""}${items.length ? "" : " empty"}`}>
              <span className="cal-date">
                <span aria-hidden="true">{dd}</span>
                <span className="sr-only">{mm}月{dd}日（{WEEKDAYS[toLocal(`${d}T12:00:00+09:00`).weekday]}）{items.length ? `${items.length}件` : "投稿なし"}</span>
                {d === today && <span className="cal-today-tag">今日</span>}
              </span>
              {items.length > 0 && (
                <ul className="cal-items">
                  {items.map((it) => (
                    <li key={it.key}>
                      <Link href={it.href} className={`cal-item${it.badge ? ` ${it.badge[1] || "plain"}` : " direct"}`}
                        {...(it.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                        <span className="cal-time">{it.time}</span>
                        <span className="cal-dots" aria-hidden="true">{it.platforms.map((p) => <i key={p} className="dot" style={{ background: `var(--c-${p})` }} />)}</span>
                        <span className="cal-text">{it.title}</span>
                        <span className="sr-only">（{it.platforms.map((p) => PLATFORM_LABELS[p]).join("・")}・{it.badge?.[0] ?? it.note}{it.badge && it.note ? `・${it.note}` : ""}{it.external ? "・新しいタブで開きます" : ""}）</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
