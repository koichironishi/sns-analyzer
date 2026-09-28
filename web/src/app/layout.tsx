import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { ScrollRegions } from "@/components/scroll-regions";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "SNS分析", template: "%s | SNS分析" },
  description: "Instagram・Facebook・Threads・X の運用分析",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja">
      <body>
        <a className="skip" href="#main">本文へスキップ</a>
        {children}
        <Suspense><ScrollRegions /></Suspense>
      </body>
    </html>
  );
}
