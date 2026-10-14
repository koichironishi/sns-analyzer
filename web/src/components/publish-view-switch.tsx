import Link from "next/link";

/** 投稿画面の「一覧」と「カレンダー」の切り替え */
export function PublishViewSwitch({ clientId, current }: { clientId: string; current: "list" | "calendar" }) {
  return (
    <nav className="tabs" aria-label="投稿の表示の切り替え" style={{ marginBottom: 16 }}>
      <Link className="tab" href={`/clients/${clientId}/publish`} aria-current={current === "list" ? "page" : undefined}>一覧</Link>
      <Link className="tab" href={`/clients/${clientId}/publish/calendar`} aria-current={current === "calendar" ? "page" : undefined}>カレンダー</Link>
    </nav>
  );
}
