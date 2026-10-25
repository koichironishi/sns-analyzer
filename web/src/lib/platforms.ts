import "server-only";
import { PLATFORMS, type Platform } from "@/lib/sns/models";

/**
 * 画面に出すSNS。X は API が従量課金で費用がかかるため使わない（2026-10-25）。
 * X の欄は出さない。ただし、すでに X の連携・競合の登録があるクライアントでは、そのデータを扱えるように出す。
 * 使うことになったら環境変数 ENABLE_X=1 で、すべてのクライアントに出す
 */
export const xEnabled = () => process.env.ENABLE_X === "1";

export function visiblePlatforms(hasX = false): Platform[] {
  return PLATFORMS.filter((p) => p !== "x" || hasX || xEnabled());
}
