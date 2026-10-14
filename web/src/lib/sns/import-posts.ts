/**
 * 外部ツール（Rhythmos AI のカルーセル制作など）から、投稿を「承認待ち」で登録する。
 *
 * 認証はクライアントごとの合言葉（Bearer）。合言葉そのものは保存せず SHA-256 の値だけを持つ。
 * 登録した投稿は必ず承認待ちにし、スタッフが SNS分析で中身を見て承認するまで公開しない。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlatform, PLATFORM_LABELS, type Platform } from "./models.ts";
import { validatePost } from "./publish/rules.ts";

type Db = SupabaseClient;

export const IMPORT_ACTOR = "Rhythmos AI（外部ツール）";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** 合言葉を作る。画面に一度だけ表示し、保存するのは SHA-256 の値と末尾4文字だけ */
export function newImportKey(): { key: string; hash: string; hint: string } {
  const key = `rsk_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashKey(key), hint: key.slice(-4) };
}

export type ImportKeyInfo = { key_hint: string; created_by_name: string | null; created_at: string; last_used_at: string | null };

export async function getImportKey(admin: Db, clientId: string): Promise<ImportKeyInfo | null> {
  const { data, error } = await admin.from("sns_import_keys").select("key_hint,created_by_name,created_at,last_used_at").eq("client_id", clientId).maybeSingle();
  if (error) throw new Error(`合言葉の読み込みに失敗しました：${error.message}`);
  return data as ImportKeyInfo | null;
}

export async function saveImportKey(admin: Db, clientId: string, hash: string, hint: string, by: string) {
  const { error } = await admin.from("sns_import_keys").upsert(
    { client_id: clientId, key_hash: hash, key_hint: hint, created_by_name: by, created_at: new Date().toISOString(), last_used_at: null },
    { onConflict: "client_id" });
  if (error) throw new Error(`合言葉の保存に失敗しました：${error.message}`);
}

export async function deleteImportKey(admin: Db, clientId: string) {
  const { error } = await admin.from("sns_import_keys").delete().eq("client_id", clientId);
  if (error) throw new Error(`合言葉の削除に失敗しました：${error.message}`);
}

/** Authorization: Bearer の合言葉が、そのクライアントのものか（時間差で推測されないよう一定時間で比べる） */
export async function verifyImportKey(admin: Db, clientId: string, authorization: string | null): Promise<boolean> {
  const m = /^Bearer\s+(rsk_[A-Za-z0-9_-]{20,100})$/.exec(authorization ?? "");
  if (!m) return false;
  const { data } = await admin.from("sns_import_keys").select("key_hash").eq("client_id", clientId).maybeSingle();
  const stored = (data as { key_hash?: string } | null)?.key_hash;
  if (!stored) return false;
  const a = Buffer.from(hashKey(m[1]), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  await admin.from("sns_import_keys").update({ last_used_at: new Date().toISOString() }).eq("client_id", clientId);
  return true;
}

// ---- 投稿の登録 ---------------------------------------------------------------------------------

export type ImportPostInput = {
  /** 外部ツール側の識別子（同じ値で送り直すと、承認前なら内容を差し替える） */
  ref: string;
  text: string;
  platforms: string[];
  /** ISO 8601（タイムゾーン付き）。例 2026-10-26T21:00:00+09:00 */
  scheduledAt: string;
  /** /uploads で受け取った画像の置き場所（順番どおり） */
  mediaPaths: string[];
};

export type ImportPostResult = { ok: true; id: string; action: "created" | "updated" | "unchanged"; message: string } | { ok: false; errors: string[] };

/** 入力の形と投稿のきまり（文字数・画像枚数・連携）を確かめる。問題がなければ null */
export function checkImportInput(clientId: string, input: ImportPostInput, now = Date.now()): { errors: string[]; platforms: Platform[]; scheduledAt: string | null } {
  const errors: string[] = [];
  const ref = String(input.ref ?? "");
  if (!/^[\p{L}\p{N} ._:/#()（）\-]{1,200}$/u.test(ref)) errors.push("ref（投稿の識別子）が正しくありません");
  const platforms = [...new Set((input.platforms ?? []).map(String))].filter(isPlatform);
  if (!platforms.length || platforms.length !== (input.platforms ?? []).length) errors.push("投稿先（platforms）が正しくありません");
  const paths = (input.mediaPaths ?? []).map(String);
  if (paths.some((p) => !new RegExp(`^${clientId}/[0-9a-f-]{36}\\.jpg$`).test(p))) errors.push("画像の指定が正しくありません");
  const t = Date.parse(String(input.scheduledAt ?? ""));
  let scheduledAt: string | null = null;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(String(input.scheduledAt ?? "")) || Number.isNaN(t)) errors.push("掲載日時（scheduledAt）はタイムゾーン付きで指定してください");
  else if (t < now + 10 * 60_000) errors.push("掲載日時が過去か、10分以内です（承認の時間が取れないため登録しません）");
  else if (t > now + 366 * 86_400_000) errors.push("掲載日時は1年先までです");
  else scheduledAt = new Date(t).toISOString();
  errors.push(...validatePost(platforms, () => String(input.text ?? ""), paths.length));
  return { errors, platforms, scheduledAt };
}

/**
 * 承認待ちで登録する。同じ ref がすでにあれば、承認前（承認待ち・差し戻し・下書き）なら差し替え、
 * 承認後（予約中・投稿済みなど）なら触らずにそのまま返す（承認済みの内容を外から書き換えない）。
 */
export async function importPost(admin: Db, clientId: string, input: ImportPostInput, mediaUrl: (path: string) => string): Promise<ImportPostResult> {
  const { errors, platforms, scheduledAt } = checkImportInput(clientId, input);
  const { data: conns } = await admin.from("sns_connections").select("platform,can_publish").eq("client_id", clientId);
  for (const p of platforms) {
    const c = (conns ?? []).find((x: { platform: string }) => x.platform === p) as { can_publish: boolean } | undefined;
    if (!c) errors.push(`${PLATFORM_LABELS[p]}：連携されていません`);
    else if (!c.can_publish) errors.push(`${PLATFORM_LABELS[p]}：投稿の許可がありません（SNS分析の「SNS連携」で連携し直してください）`);
  }
  if (errors.length) return { ok: false, errors };

  const media = input.mediaPaths.map((path) => ({ path, url: mediaUrl(path) }));
  const row = {
    text: String(input.text), platform_texts: {}, platforms, media, status: "pending", scheduled_at: scheduledAt,
    requested_mode: "schedule", results: {}, review_note: null, reviewed_by: null, reviewed_by_name: null, reviewed_at: null,
  };
  const { data: cur } = await admin.from("sns_scheduled_posts").select("id,status,media").eq("client_id", clientId).eq("import_ref", input.ref).maybeSingle();
  const existing = cur as { id: string; status: string; media: { path: string }[] } | null;
  if (existing) {
    if (!["pending", "rejected", "draft"].includes(existing.status)) {
      return { ok: true, id: existing.id, action: "unchanged", message: "承認済み（または投稿済み）のため、変更しませんでした" };
    }
    const { error } = await admin.from("sns_scheduled_posts").update(row).eq("id", existing.id);
    if (error) return { ok: false, errors: [`投稿の更新に失敗しました：${error.message}`] };
    // 差し替えで使わなくなった画像を消す
    const old = existing.media.map((m) => m.path).filter((p) => !input.mediaPaths.includes(p));
    if (old.length) await admin.storage.from("sns-media").remove(old);
    return { ok: true, id: existing.id, action: "updated", message: "承認待ちの投稿を差し替えました" };
  }
  const { data, error } = await admin.from("sns_scheduled_posts")
    .insert({ ...row, client_id: clientId, import_ref: input.ref, created_by: null, created_by_name: IMPORT_ACTOR }).select("id").single();
  if (error || !data) return { ok: false, errors: [`投稿の登録に失敗しました：${error?.message ?? "不明なエラー"}`] };
  return { ok: true, id: (data as { id: string }).id, action: "created", message: "承認待ちで登録しました" };
}
