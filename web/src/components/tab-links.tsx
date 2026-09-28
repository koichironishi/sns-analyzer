import Link from "next/link";

/** 表示切り替え（リンクで切り替えるので JS なしでも動き、URL を共有できる） */
export function TabLinks({ param, current, options, sp, label }: {
  param: string; current: string; options: { value: string; label: string }[];
  sp: Record<string, string | string[] | undefined>; label: string;
}) {
  const cur = options.find((o) => o.value === current)?.label ?? "";
  return (
    <>
    <p className="sr-only" aria-live="polite">{cur}を表示しています</p>
    <div className="tabs" role="group" aria-label={label}>
      {options.map((o) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== param) q.set(k, v);
        q.set(param, o.value);
        return (
          <Link key={o.value} className="tab" href={`?${q}`} scroll={false}
            aria-current={o.value === current ? "true" : undefined} style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
            {o.label}
          </Link>
        );
      })}
    </div>
    </>
  );
}
