"use client";
import { useEffect, useRef } from "react";

/** 操作の結果。表示されたらフォーカスを移して、読み上げと目視の両方で気づけるようにする */
export function Flash({ kind, children }: { kind: "ok" | "error"; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className={`msg ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>
  );
}
