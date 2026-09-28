/**
 * AI分析の同意と、Meta / Threads のデータ削除リクエスト（Python 版 privacy.py の移植）。
 * DB への読み書きは store.ts が行い、ここは純粋な処理だけを置く。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 説明文を変えたら版を上げる。版が変わると再同意が必要になる。
export const CONSENT_VERSION = "2026-09-28.2";

export function consentText(includePostText = true): string[] {
  const sent = includePostText ? "集計した指標と投稿本文" : "集計した指標（投稿本文は含まない）";
  return [
    `AI分析では、${sent}を Anthropic, PBC（米国）が提供する Claude API に送信します。`,
    "Anthropic の商用APIでは、送信データは既定でAIの学習に使われません。"
      + "送信データは原則30日以内に Anthropic 側で削除されます（利用ポリシー違反と判定された場合は最長2年保存されるなど、一部例外があります）。",
    "競合アカウントの公開投稿が含まれる場合があります。",
    "同意はいつでも撤回できます。撤回すると、保存済みのAI分析結果を削除します。",
  ];
}

export type ConsentRow = {
  status: "granted" | "revoked";
  version: string;
  granted_by: string | null;
  granted_at: string | null;
  include_post_text: boolean;
  note: string | null;
  recorded_by: string | null;
  revoked_at: string | null;
};

export type ConsentState = {
  status: "unset" | "granted" | "revoked";
  valid: boolean; // 現行の版で同意済み
  outdated: boolean; // 同意済みだが説明の版が古い
  row: ConsentRow | null;
};

export function consentState(row: ConsentRow | null): ConsentState {
  const status = row?.status ?? "unset";
  return {
    status,
    valid: status === "granted" && row?.version === CONSENT_VERSION,
    outdated: status === "granted" && row?.version !== CONSENT_VERSION,
    row,
  };
}

export function consentProblem(c: ConsentState): string | null {
  if (c.valid) return null;
  if (c.outdated) return "AI分析の説明内容が更新されています。設定の「AI分析の同意」で改めて同意を記録してください。";
  return "AI分析の同意が記録されていません。クライアントの同意を得てから、設定の「AI分析の同意」で記録してください。";
}

// ---- Meta / Threads のデータ削除リクエスト --------------------------------------

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Meta の signed_request を検証して中身を返す。署名が合わなければ例外 */
export function parseSignedRequest(signedRequest: string, appSecret: string): Record<string, unknown> {
  const [sigB64, payloadB64, extra] = signedRequest.split(".");
  if (!sigB64 || !payloadB64 || extra !== undefined) throw new Error("signed_request の形式が不正です");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(b64url(payloadB64).toString("utf8"));
  } catch {
    throw new Error("signed_request の形式が不正です");
  }
  if (String(data.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") throw new Error("未対応の署名方式です");
  if (!appSecret) throw new Error("署名を検証できません");
  const expected = createHmac("sha256", appSecret).update(payloadB64).digest();
  const sig = b64url(sigB64);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw new Error("署名を検証できません");
  return data;
}

export const newConfirmationCode = () => randomBytes(8).toString("hex");

/** 削除リクエストのサービス → 対象SNS */
export const DELETION_PLATFORMS = { meta: ["facebook", "instagram"], threads: ["threads"] } as const;
export type DeletionService = keyof typeof DELETION_PLATFORMS;
