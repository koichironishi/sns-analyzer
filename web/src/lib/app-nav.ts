import type { Viewer } from "./auth";

/** 上バー（PC）とメニュー（スマホ）で共通の、全体のメニュー */
export const appNavItems = (v: Viewer) => [
  ...(v.kind === "staff"
    ? [{ href: "/", label: "クライアント" }, ...(v.isAdmin ? [{ href: "/admin", label: "全体設定" }, { href: "/admin/audit", label: "操作ログ" }] : [])]
    : [{ href: `/clients/${v.clientId}`, label: "ダッシュボード" }]),
  { href: "/help", label: "ご利用ガイド" },
];
