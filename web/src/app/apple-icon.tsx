import { ImageResponse } from "next/og";

/** ホーム画面に追加したときのアイコン（タブのアイコンと同じ「S」のマーク） */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#be185d", color: "#fff", fontSize: 110, fontWeight: 800 }}>
        S
      </div>
    ),
    size,
  );
}
