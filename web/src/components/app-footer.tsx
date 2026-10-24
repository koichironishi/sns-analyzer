import Link from "next/link";

/** 画面の下の注記（3製品共通の形）。クライアントの画面では本文（main.content）の一番下に入れる */
export function AppFooter() {
  return (
    <footer className="rw-footer footer no-print">
      <span>© Rhythmos</span>
      <Link href="/privacy">プライバシーポリシー</Link>
      <Link href="/terms">利用規約</Link>
      <span>本サービスは Meta Platforms, Inc. および X Corp. が提供・承認するものではありません。</span>
    </footer>
  );
}
