/** Rhythmos の製品（上バーの切り替えに使う）。URL は環境変数で差し替えられる */
export const PRODUCTS = [
  { key: "meo", label: "MEO", url: process.env.NEXT_PUBLIC_MEO_URL || "https://meo.rhythmos-works.jp" },
  { key: "sns", label: "SNS分析", url: "/" },
  { key: "wp", label: "WordPress", url: process.env.NEXT_PUBLIC_WP_TOOL_URL || "https://rhythmos-works.sakura.ne.jp/wp-auto-post/" },
] as const;
