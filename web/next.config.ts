import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

/*
  レスポンスヘッダでブラウザ側の防御を効かせる（MEO と同じ考え方。2026-11-16）。
  CSP があれば、万一どこかにスクリプトを差し込まれても、許していない宛先へはデータが出ていかない。

  **緩めてあるところには理由がある。**
  - script-src の 'unsafe-inline' … Next.js がインラインの起動スクリプトを出すため。nonce を配る仕組みを入れるまで外せない。
  - img-src の https: … 投稿の画像（Supabase Storage）と、収集した投稿のサムネイル（Instagram・Facebook の CDN）を表示する。
    CDN のホストは事前に決めきれない。
  - connect-src の supabase.co … 画像のアップロード（署名付き URL へ直接送る）と認証。
  - challenges.cloudflare.com … ログイン前の人間確認（Turnstile）。**script / frame / connect の3つとも要る。**
  - frame-ancestors 'none' … どのサイトの枠にも埋め込ませない（これまでの X-Frame-Options: DENY と同じ）。
*/
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // 開発中だけ 'unsafe-eval' を許す（Turbopack が使う）。本番では外す
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https:${process.env.NODE_ENV === "production" ? "" : " http://127.0.0.1:54321"}`,
  "font-src 'self' data:",
  // 開発・テストでは偽の Supabase（http://127.0.0.1:54321）にもつなぐ
  `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://challenges.cloudflare.com${process.env.NODE_ENV === "production" ? "" : " http://127.0.0.1:54321 ws://localhost:*"}`,
  "frame-src https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  // このディレクトリを起点にする（親フォルダまで探索させない）
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // CSP の frame-ancestors を読めない古いブラウザ向けの保険
          { key: "X-Frame-Options", value: "DENY" },
          // 外部サイトへは URL を一切送らない（クライアントの ID や投稿の ID が漏れないように）
          { key: "Referrer-Policy", value: "same-origin" },
          // 使っていない装置の権限を閉じる。clipboard は閉じない（「コピー」ボタンが動かなくなる）
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          // 2年・サブドメインも。preload は付けない（上位ドメイン側の対応が要り、外すのに時間がかかる）
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
