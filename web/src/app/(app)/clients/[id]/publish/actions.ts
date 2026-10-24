"use server";
/**
 * SNSへの投稿（作成・予約・取り消し・削除・再投稿の準備）。
 * スタッフと、そのクライアントの利用者が使える。Server Action は外部から直接呼べるため、毎回権限を確認する。
 */
import { randomUUID } from "node:crypto";
import { addUtm } from "@/lib/sns/publish/utm";
import { revalidatePath } from "next/cache";
import { getViewer, UUID_RE, type Viewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { zonedToUtc } from "@/lib/sns/importers";
import { DEFAULT_TZ, isPlatform, PLATFORM_LABELS, type Platform } from "@/lib/sns/models";
import { LIMITS, validatePost } from "@/lib/sns/publish/rules";
import { BULK_MAX_ROWS, readBulkCsv, type BulkRow } from "@/lib/sns/publish/bulk";
import { parseTargetKey, platformsOf, resolveTargets, type Target } from "@/lib/sns/publish/targets";
import { AIError } from "@/lib/sns/ai";
import { writePerPlatform } from "@/lib/sns/ai-write";
import { consentState } from "@/lib/sns/privacy";
import {
  audit, deleteScheduledPost, getBrandContext, getClient, getConsentRow, getRequireApproval, getScheduledPost, insertScheduledPost, listConnections, MEDIA_BUCKET,
  removeMedia, updateScheduledPost, type MediaItem, type PostStatus,
} from "@/lib/sns/store";

/** 編集できる状態（下書き・承認待ち・差し戻し・予約中・取り消し） */
const EDITABLE: PostStatus[] = ["draft", "pending", "rejected", "scheduled", "canceled"];

type Result<T = object> = ({ ok: true } & T) | { ok: false; errors: string[] };

/** そのクライアントの投稿を扱えるか（スタッフ、または自社の利用者） */
async function poster(clientId: string): Promise<{ v: Viewer; admin: ReturnType<typeof createAdminClient> }> {
  const v = await getViewer();
  if (!v || !UUID_RE.test(clientId)) throw new Error("権限がありません");
  if (v.kind === "client" && (v.clientId !== clientId || v.mustChangePassword)) throw new Error("権限がありません");
  const admin = createAdminClient();
  if (!(await getClient(admin, clientId))) throw new Error("クライアントが見つかりません");
  return { v, admin };
}

const fail = (e: unknown): { ok: false; errors: string[] } => ({ ok: false, errors: [e instanceof Error ? e.message : "処理に失敗しました"] });

/** 画像をブラウザから直接アップロードするための、一時的なアップロード先を発行する */
export async function createUploadTarget(clientId: string): Promise<Result<{ path: string; signedUrl: string; publicUrl: string }>> {
  try {
    const { admin } = await poster(clientId);
    const path = `${clientId}/${randomUUID()}.jpg`;
    const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
    if (error || !data) return { ok: false, errors: [`アップロードの準備に失敗しました：${error?.message ?? "不明なエラー"}`] };
    const publicUrl = admin.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
    return { ok: true, path, signedUrl: data.signedUrl, publicUrl };
  } catch (e) {
    return fail(e);
  }
}

export type SavePostInput = {
  clientId: string;
  id?: string;
  text: string;
  platformTexts: Partial<Record<Platform, string>>;
  /** 投稿先のアカウント（"instagram:<external_id>" のキー） */
  targets: string[];
  mediaPaths: string[];
  /** mediaPaths のうち、別の投稿の画像（「これをもとに作る」）。保存時に複製して、元の投稿と画像を共有しない */
  copyMedia?: string[];
  /** リンクに計測用の印（UTM）を付けて投稿する */
  addUtm?: boolean;
  mode: "draft" | "schedule" | "now";
  scheduledLocal?: string; // "YYYY-MM-DDTHH:mm"（日本時間）
};

/** 下書き保存・予約・今すぐ投稿（今すぐの場合は、保存後に画面から公開の処理を呼ぶ）。
 *  承認が必要なクライアントの利用者の場合は、予約・今すぐ投稿の代わりに「承認待ち」にする */
export async function savePost(input: SavePostInput): Promise<Result<{ id: string; publishNow: boolean; pending: boolean }>> {
  try {
    const { v, admin } = await poster(input.clientId);
    // 投稿先はアカウント単位。連携しているアカウントだけを受け付ける
    const conns = await listConnections(admin, input.clientId);
    const targets: Target[] = [];
    for (const k of new Set((input.targets ?? []).map(String))) {
      const t = parseTargetKey(k);
      if (t && conns.some((c) => c.platform === t.platform && c.external_id === t.external_id)) targets.push(t);
    }
    const platforms = platformsOf(targets);
    const text = String(input.text ?? "");
    const platformTexts: Partial<Record<Platform, string>> = {};
    for (const p of platforms) {
      const t = String(input.platformTexts?.[p] ?? "");
      if (t.trim()) platformTexts[p] = t;
    }
    // 画像はこのクライアントのフォルダにあるものだけを受け付ける
    const mediaPaths = (input.mediaPaths ?? []).map(String);
    if (mediaPaths.length > 10) return { ok: false, errors: ["画像は10枚までです"] };
    if (mediaPaths.some((p) => !new RegExp(`^${input.clientId}/[0-9a-f-]{36}\\.jpg$`).test(p))) return { ok: false, errors: ["画像の指定が正しくありません"] };
    const toMedia = (paths: string[]): MediaItem[] => paths.map((path) => ({ path, url: admin.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl }));
    let media = toMedia(mediaPaths);

    const errors: string[] = [];
    if (input.mode !== "draft") {
      // 文字数は、計測用の印を付けたあとの本文で確かめる（Threads などは URL も文字数に入るため）
      const addUtmOn = Boolean(input.addUtm);
      errors.push(...validatePost(platforms, (p) => (addUtmOn ? addUtm(platformTexts[p] ?? text, p, "00000000") : platformTexts[p] ?? text), media.length));
      for (const t of targets) {
        const c = conns.find((x) => x.platform === t.platform && x.external_id === t.external_id);
        if (c && !c.can_publish) errors.push(`${PLATFORM_LABELS[t.platform]}（${c.username ?? t.external_id}）：投稿の許可がありません（スタッフが「SNS連携」で連携し直す必要があります）`);
      }
    } else if (!targets.length) {
      errors.push("投稿先のアカウントを1つ以上選んでください");
    }

    let scheduledAt: string | null = null;
    if (input.mode === "schedule") {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input.scheduledLocal ?? "");
      if (!m) errors.push("予約する日時を入力してください");
      else {
        const t = zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 0, DEFAULT_TZ);
        if (t < Date.now() + 60_000) errors.push("予約する日時は、今から1分以上あとにしてください");
        else if (t > Date.now() + 366 * 86_400_000) errors.push("予約できるのは1年先までです");
        else scheduledAt = new Date(t).toISOString();
      }
    } else if (input.mode === "now") {
      scheduledAt = new Date().toISOString();
    }
    if (errors.length) return { ok: false, errors };

    // 別の投稿の画像は複製する（元の投稿を削除・編集したときに、こちらの画像まで消えないように）
    const copy = new Set((input.copyMedia ?? []).map(String));
    if (copy.size) {
      for (let i = 0; i < mediaPaths.length; i++) {
        if (!copy.has(mediaPaths[i])) continue;
        const to = `${input.clientId}/${randomUUID()}.jpg`;
        const { error } = await admin.storage.from(MEDIA_BUCKET).copy(mediaPaths[i], to);
        if (error) return { ok: false, errors: ["画像を複製できませんでした。画像を入れ直してください。"] };
        mediaPaths[i] = to;
      }
      media = toMedia(mediaPaths);
    }

    // クライアントの利用者の投稿は、設定に応じてスタッフの承認を待つ
    const needsApproval = input.mode !== "draft" && v.kind === "client" && (await getRequireApproval(admin, input.clientId));
    const status: PostStatus = input.mode === "draft" ? "draft" : needsApproval ? "pending" : "scheduled";
    const requestedMode = needsApproval ? (input.mode === "now" ? "now" : "schedule") : null;
    if (needsApproval && input.mode === "now") scheduledAt = null;
    let id = input.id;
    if (id) {
      if (!UUID_RE.test(id)) return { ok: false, errors: ["投稿の指定が正しくありません"] };
      const cur = await getScheduledPost(admin, id);
      if (!cur || cur.client_id !== input.clientId) return { ok: false, errors: ["投稿が見つかりません"] };
      if (!EDITABLE.includes(cur.status)) return { ok: false, errors: ["投稿済み・処理中の投稿は編集できません"] };
      // 外した画像は削除する
      await removeMedia(admin, cur.media.map((m) => m.path).filter((p) => !mediaPaths.includes(p)));
      await updateScheduledPost(admin, id, {
        text, platform_texts: platformTexts, platforms, targets, media, status, scheduled_at: scheduledAt, results: {}, requested_mode: requestedMode,
        add_utm: Boolean(input.addUtm),
        // 依頼し直したら、前回の差し戻しの記録は消す（下書き保存のときは、理由を見ながら直せるよう残す）
        ...(status !== "draft" ? { review_note: null, reviewed_by: null, reviewed_by_name: null, reviewed_at: null } : {}),
      });
    } else {
      id = await insertScheduledPost(admin, {
        client_id: input.clientId, text, platform_texts: platformTexts, platforms, targets, media, status, scheduled_at: scheduledAt,
        add_utm: Boolean(input.addUtm),
        created_by: v.id, created_by_name: v.name || v.email, requested_mode: requestedMode,
      });
    }
    const what = needsApproval ? `承認を依頼（${input.mode === "now" ? "今すぐ" : `予約 ${scheduledAt}`}）` : { draft: "下書き保存", schedule: `予約（${scheduledAt}）`, now: "今すぐ投稿" }[input.mode];
    await audit(admin, v, "post.save", input.clientId, `${what}・${targets.map((t) => `${t.platform}:${t.external_id}`).join(",")}・画像${media.length}枚`, await clientIp());
    revalidatePath(`/clients/${input.clientId}/publish`);
    return { ok: true, id: id!, publishNow: input.mode === "now" && !needsApproval, pending: needsApproval };
  } catch (e) {
    return fail(e);
  }
}

async function ownPost(clientId: string, postId: string) {
  const ctx = await poster(clientId);
  if (!UUID_RE.test(postId)) throw new Error("投稿の指定が正しくありません");
  const post = await getScheduledPost(ctx.admin, postId);
  if (!post || post.client_id !== clientId) throw new Error("投稿が見つかりません");
  return { ...ctx, post };
}

export async function cancelPost(clientId: string, postId: string): Promise<Result> {
  try {
    const { v, admin, post } = await ownPost(clientId, postId);
    if (!["scheduled", "pending"].includes(post.status)) return { ok: false, errors: ["予約中・承認待ちの投稿だけ取り消せます"] };
    await updateScheduledPost(admin, postId, { status: "canceled" });
    await audit(admin, v, "post.cancel", clientId, postId, await clientIp());
    revalidatePath(`/clients/${clientId}/publish`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** 失敗したSNSだけ、もう一度投稿する準備（このあと画面から公開の処理を呼ぶ） */
export async function prepareRetry(clientId: string, postId: string): Promise<Result> {
  try {
    const { v, admin, post } = await ownPost(clientId, postId);
    if (!["failed", "partial"].includes(post.status)) return { ok: false, errors: ["失敗した投稿だけ再投稿できます"] };
    await updateScheduledPost(admin, postId, { status: "scheduled", scheduled_at: new Date().toISOString() });
    await audit(admin, v, "post.retry", clientId, postId, await clientIp());
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** 投稿の記録と画像を削除する（SNS上の投稿は消えない） */
export async function deletePost(clientId: string, postId: string): Promise<Result> {
  try {
    const { v, admin, post } = await ownPost(clientId, postId);
    if (post.status === "publishing") return { ok: false, errors: ["投稿の処理中は削除できません"] };
    await removeMedia(admin, post.media.map((m) => m.path));
    await deleteScheduledPost(admin, postId);
    await audit(admin, v, "post.delete", clientId, `${postId}（${post.status}）`, await clientIp());
    revalidatePath(`/clients/${clientId}/publish`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ---- 承認（スタッフのみ） -------------------------------------------------------------

async function reviewer(clientId: string, postId: string) {
  const ctx = await ownPost(clientId, postId);
  if (ctx.v.kind !== "staff") throw new Error("承認・差し戻しはスタッフだけが行えます");
  if (ctx.post.status !== "pending") throw new Error("承認待ちの投稿ではありません");
  return ctx;
}

/** 承認する。依頼が「今すぐ」か、予約日時を過ぎている場合は、このあと画面から公開の処理を呼ぶ */
export async function approvePost(clientId: string, postId: string): Promise<Result<{ publishNow: boolean }>> {
  try {
    const { v, admin, post } = await reviewer(clientId, postId);
    const due = post.requested_mode === "now" || !post.scheduled_at || new Date(post.scheduled_at).getTime() <= Date.now() + 60_000;
    // 承認の時点でも、投稿先の連携と投稿の許可を確かめる
    const conns = await listConnections(admin, clientId);
    const missing = resolveTargets(post, conns).filter((t) => !conns.find((c) => c.platform === t.platform && c.external_id === t.externalId)?.can_publish);
    if (missing.length) return { ok: false, errors: [`${missing.map((t) => PLATFORM_LABELS[t.platform]).join("・")}：連携されていないか、投稿の許可がありません`] };
    await updateScheduledPost(admin, postId, {
      status: "scheduled", scheduled_at: due ? new Date().toISOString() : post.scheduled_at,
      reviewed_by: v.id, reviewed_by_name: v.name || v.email, reviewed_at: new Date().toISOString(), review_note: null,
    });
    await audit(admin, v, "post.approve", clientId, `${postId}${due ? "（すぐに投稿）" : `（予約 ${post.scheduled_at}）`}`, await clientIp());
    revalidatePath(`/clients/${clientId}/publish`);
    return { ok: true, publishNow: due };
  } catch (e) {
    return fail(e);
  }
}

/** 差し戻す（理由を付けて、クライアントに直してもらう） */
export async function rejectPost(clientId: string, postId: string, note: string): Promise<Result> {
  try {
    const { v, admin } = await reviewer(clientId, postId);
    const reason = String(note ?? "").trim();
    if (!reason) return { ok: false, errors: ["差し戻しの理由を入力してください"] };
    if (reason.length > 500) return { ok: false, errors: ["差し戻しの理由は500文字以内で入力してください"] };
    await updateScheduledPost(admin, postId, {
      status: "rejected", review_note: reason, reviewed_by: v.id, reviewed_by_name: v.name || v.email, reviewed_at: new Date().toISOString(),
    });
    await audit(admin, v, "post.reject", clientId, `${postId}：${reason.slice(0, 100)}`, await clientIp());
    revalidatePath(`/clients/${clientId}/publish`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * 本文（下書き・メモ）をもとに、AI が SNSごとの本文を書く。
 * 公開はしない。結果は画面の「SNSごとの本文」に入れ、人が確認して直す。
 * AI に文章を送るため、そのクライアントの AI 利用の同意がある場合だけ使える。
 */
export async function aiWritePost(clientId: string, source: string, platformList: string[]): Promise<Result<{ texts: Partial<Record<Platform, string>>; warnings: string[] }>> {
  try {
    const { v, admin } = await poster(clientId);
    const platforms = [...new Set(platformList)].filter(isPlatform);
    const text = String(source ?? "").trim();
    if (!platforms.length) return { ok: false, errors: ["投稿先のSNSを1つ以上選んでください"] };
    if (text.length < 5) return { ok: false, errors: ["本文に、伝えたいこと（下書きやメモ）を書いてください。それをもとにSNSごとの文章を作ります"] };
    if (text.length > 3000) return { ok: false, errors: ["本文が長すぎます（3,000字まで）"] };
    const consent = consentState(await getConsentRow(admin, clientId));
    if (!consent.valid) {
      return { ok: false, errors: [v.kind === "staff"
        ? "このクライアントは AI 利用の同意がないため使えません。「クライアント情報」で同意を記録してください"
        : "AI の利用の同意がまだないため使えません。担当者にお問い合わせください"] };
    }
    const client = await getClient(admin, clientId);
    const r = await writePerPlatform({ clientName: client?.name ?? "", brandContext: await getBrandContext(admin, clientId), source: text, platforms });
    await audit(admin, v, "post.ai_write", clientId, `${platforms.join(",")}・${r.model}`, await clientIp());
    return { ok: true, texts: r.texts, warnings: r.warnings };
  } catch (e) {
    if (e instanceof AIError) return { ok: false, errors: [e.message] };
    return fail(e);
  }
}

// ---- CSV一括予約 ----------------------------------------------------------------

export type BulkPreviewRow = BulkRow & { draft: boolean };

/** 選んだ投稿先のうち、画像が要るSNS（Instagram）と、本文だけで出せるSNSに分ける */
function splitByImage(platforms: Platform[]) {
  return { needImage: platforms.filter((p) => LIMITS[p].minImages > 0), textOnly: platforms.filter((p) => LIMITS[p].minImages === 0) };
}

async function bulkTargets(admin: ReturnType<typeof createAdminClient>, clientId: string, keys: string[]) {
  const conns = await listConnections(admin, clientId);
  const targets: Target[] = [];
  for (const k of new Set(keys.map(String))) {
    const t = parseTargetKey(k);
    const c = t && conns.find((x) => x.platform === t.platform && x.external_id === t.external_id);
    if (t && c && c.can_publish) targets.push(t);
  }
  return targets;
}

/** 行ごとの、SNSのきまり（文字数など）の確認。画像が要るSNSがあれば、その投稿は下書きで入る */
function checkBulkRow(row: BulkRow, platforms: Platform[], addUtmOn: boolean): BulkPreviewRow {
  const { needImage, textOnly } = splitByImage(platforms);
  const errors = [...row.errors];
  if (row.text) {
    const textOf = (p: Platform) => (addUtmOn ? addUtm(row.text, p, "00000000") : row.text);
    // validatePost は投稿先が空だと「選んでください」を返すため、選んだSNSがあるときだけ確かめる
    if (textOnly.length) errors.push(...validatePost(textOnly, textOf, 0));
    // 画像が要るSNSは画像以外（文字数など）だけを確かめる
    if (needImage.length) errors.push(...validatePost(needImage, textOf, 1).filter((e) => !e.includes("画像")));
  }
  return { ...row, errors, draft: needImage.length > 0 };
}

/** CSV を読み、取り込む前の確認用の一覧を返す（まだ保存しない） */
export async function previewBulk(form: FormData): Promise<Result<{ rows: BulkPreviewRow[] }>> {
  try {
    const clientId = String(form.get("client_id") ?? "");
    const { admin } = await poster(clientId);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return { ok: false, errors: ["CSV ファイルを選んでください"] };
    if (file.size > 1_000_000) return { ok: false, errors: ["CSV が大きすぎます（1MB まで）"] };
    const targets = await bulkTargets(admin, clientId, form.getAll("targets").map(String));
    if (!targets.length) return { ok: false, errors: ["投稿先のアカウントを1つ以上選んでください"] };
    const rows = readBulkCsv(new Uint8Array(await file.arrayBuffer()));
    const platforms = platformsOf(targets);
    return { ok: true, rows: rows.map((r) => checkBulkRow(r, platforms, form.get("add_utm") === "on")) };
  } catch (e) {
    return fail(e);
  }
}

export type BulkCommitInput = { clientId: string; targets: string[]; rows: { local: string; text: string }[]; mode: "schedule" | "draft"; addUtm: boolean };

/**
 * 確認した行を保存する。予約を選んだときも、画像が要るSNS（Instagram）を含む投稿は下書きで入れる（画面で画像を足して予約する）。
 * クライアントの利用者で承認が必要な設定なら、予約の代わりに承認待ちにする
 */
export async function commitBulk(input: BulkCommitInput): Promise<Result<{ scheduled: number; drafts: number; pending: number }>> {
  try {
    const { v, admin } = await poster(input.clientId);
    const targets = await bulkTargets(admin, input.clientId, input.targets ?? []);
    if (!targets.length) return { ok: false, errors: ["投稿先のアカウントを1つ以上選んでください"] };
    const rows = (input.rows ?? []).slice(0, BULK_MAX_ROWS + 1);
    if (!rows.length) return { ok: false, errors: ["取り込む行がありません"] };
    if (rows.length > BULK_MAX_ROWS) return { ok: false, errors: [`一度に取り込めるのは${BULK_MAX_ROWS}件までです`] };
    const platforms = platformsOf(targets);
    const addUtmOn = Boolean(input.addUtm);
    // 画面から届いた行を、もう一度同じきまりで確かめる（画面を通さない呼び出しにも備える）
    const checked = rows.map((r, i) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(r.local ?? ""));
      const at = m ? new Date(zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 0, DEFAULT_TZ)).toISOString() : null;
      const text = String(r.text ?? "").trim();
      const errors: string[] = [];
      if (!at) errors.push("配信日時が正しくありません");
      else if (Date.parse(at) < Date.now() + 60_000) errors.push("配信日時が過去です");
      if (!text) errors.push("本文がありません");
      return checkBulkRow({ line: i + 1, local: String(r.local), at, text, errors, warnings: [] }, platforms, addUtmOn);
    });
    const bad = checked.filter((r) => r.errors.length);
    if (bad.length) return { ok: false, errors: bad.slice(0, 5).map((r) => `${r.local.replace("T", " ")}：${r.errors[0]}`) };
    const needsApproval = v.kind === "client" && (await getRequireApproval(admin, input.clientId));
    let scheduled = 0, drafts = 0, pending = 0;
    for (const r of checked) {
      const draft = input.mode === "draft" || r.draft;
      const status: PostStatus = draft ? "draft" : needsApproval ? "pending" : "scheduled";
      await insertScheduledPost(admin, {
        client_id: input.clientId, text: r.text, platform_texts: {}, platforms, targets, media: [], status, scheduled_at: r.at,
        created_by: v.id, created_by_name: v.name || v.email, requested_mode: status === "pending" ? "schedule" : null, add_utm: addUtmOn,
      });
      if (status === "draft") drafts++; else if (status === "pending") pending++; else scheduled++;
    }
    await audit(admin, v, "post.bulk", input.clientId, `CSV一括：予約${scheduled}件・承認待ち${pending}件・下書き${drafts}件・${targets.map((t) => `${t.platform}:${t.external_id}`).join(",")}`, await clientIp());
    revalidatePath(`/clients/${input.clientId}/publish`);
    return { ok: true, scheduled, drafts, pending };
  } catch (e) {
    return fail(e);
  }
}
