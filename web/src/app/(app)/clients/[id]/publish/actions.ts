"use server";
/**
 * SNSへの投稿（作成・予約・取り消し・削除・再投稿の準備）。
 * スタッフと、そのクライアントの利用者が使える。Server Action は外部から直接呼べるため、毎回権限を確認する。
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getViewer, UUID_RE, type Viewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { zonedToUtc } from "@/lib/sns/importers";
import { DEFAULT_TZ, isPlatform, PLATFORM_LABELS, type Platform } from "@/lib/sns/models";
import { validatePost } from "@/lib/sns/publish/rules";
import {
  audit, deleteScheduledPost, getClient, getRequireApproval, getScheduledPost, insertScheduledPost, listConnections, MEDIA_BUCKET,
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
  platforms: string[];
  mediaPaths: string[];
  mode: "draft" | "schedule" | "now";
  scheduledLocal?: string; // "YYYY-MM-DDTHH:mm"（日本時間）
};

/** 下書き保存・予約・今すぐ投稿（今すぐの場合は、保存後に画面から公開の処理を呼ぶ）。
 *  承認が必要なクライアントの利用者の場合は、予約・今すぐ投稿の代わりに「承認待ち」にする */
export async function savePost(input: SavePostInput): Promise<Result<{ id: string; publishNow: boolean; pending: boolean }>> {
  try {
    const { v, admin } = await poster(input.clientId);
    const platforms = [...new Set(input.platforms)].filter(isPlatform);
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
    const media: MediaItem[] = mediaPaths.map((path) => ({ path, url: admin.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl }));

    const errors: string[] = [];
    if (input.mode !== "draft") {
      errors.push(...validatePost(platforms, (p) => platformTexts[p] ?? text, media.length));
      const conns = await listConnections(admin, input.clientId);
      for (const p of platforms) {
        const c = conns.find((x) => x.platform === p);
        if (!c) errors.push(`${PLATFORM_LABELS[p]}：連携されていません`);
        else if (!c.can_publish) errors.push(`${PLATFORM_LABELS[p]}：投稿の許可がありません（スタッフが「設定・連携」で連携し直す必要があります）`);
      }
    } else if (!platforms.length) {
      errors.push("投稿先のSNSを1つ以上選んでください");
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
        text, platform_texts: platformTexts, platforms, media, status, scheduled_at: scheduledAt, results: {}, requested_mode: requestedMode,
        // 依頼し直したら、前回の差し戻しの記録は消す（下書き保存のときは、理由を見ながら直せるよう残す）
        ...(status !== "draft" ? { review_note: null, reviewed_by: null, reviewed_by_name: null, reviewed_at: null } : {}),
      });
    } else {
      id = await insertScheduledPost(admin, {
        client_id: input.clientId, text, platform_texts: platformTexts, platforms, media, status, scheduled_at: scheduledAt,
        created_by: v.id, created_by_name: v.name || v.email, requested_mode: requestedMode,
      });
    }
    const what = needsApproval ? `承認を依頼（${input.mode === "now" ? "今すぐ" : `予約 ${scheduledAt}`}）` : { draft: "下書き保存", schedule: `予約（${scheduledAt}）`, now: "今すぐ投稿" }[input.mode];
    await audit(admin, v, "post.save", input.clientId, `${what}・${platforms.join(",")}・画像${media.length}枚`, await clientIp());
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
    const missing = post.platforms.filter((p) => !conns.find((c) => c.platform === p)?.can_publish);
    if (missing.length) return { ok: false, errors: [`${missing.map((p) => PLATFORM_LABELS[p]).join("・")}：連携されていないか、投稿の許可がありません`] };
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
