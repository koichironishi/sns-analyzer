/** Rhythmos の製品（上バーの切り替えに使う）。URL は環境変数で差し替えられる */
export const PRODUCTS = [
  { key: "meo", label: "MEO", url: process.env.NEXT_PUBLIC_MEO_URL || "https://meo.rhythmos-works.jp" },
  { key: "sns", label: "SNS分析", url: "/" },
  // 記事作成ツール（WordPress への記事の下書き投稿）。「WordPress」は他社の商標のため製品名には使わない
  { key: "wp", label: "記事作成", url: process.env.NEXT_PUBLIC_WP_TOOL_URL || "https://wp-auto-post.rhythmos-works.jp" },
] as const;
