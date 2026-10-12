"use server";
/**
 * SNSへの投稿（作成・予約・取り消し・削除・再投稿の準備）。
 * スタッフと、そのクライアントの閲覧ユーザーが使える。Server Action は外部から直接呼べるため、毎回権限を確認する。
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
  audit, deleteScheduledPost, getClient, getScheduledPost, insertScheduledPost, listConnections, MEDIA_BUCKET, removeMedia,
  updateScheduledPost, type MediaItem, type PostStatus,
} from "@/lib/sns/store";

type Result<T = object> = ({ ok: true } & T) | { ok: false; errors: string[] };

/** そのクライアントの投稿を扱えるか（スタッフ、または自社の閲覧ユーザー） */
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

/** 下書き保存・予約・今すぐ投稿（今すぐの場合は、保存後に画面から公開の処理を呼ぶ） */
export async function savePost(input: SavePostInput): Promise<Result<{ id: string; publishNow: boolean }>> {
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

    const status: PostStatus = input.mode === "draft" ? "draft" : "scheduled";
    let id = input.id;
    if (id) {
      if (!UUID_RE.test(id)) return { ok: false, errors: ["投稿の指定が正しくありません"] };
      const cur = await getScheduledPost(admin, id);
      if (!cur || cur.client_id !== input.clientId) return { ok: false, errors: ["投稿が見つかりません"] };
      if (!["draft", "scheduled", "canceled"].includes(cur.status)) return { ok: false, errors: ["投稿済み・処理中の投稿は編集できません"] };
      // 外した画像は削除する
      await removeMedia(admin, cur.media.map((m) => m.path).filter((p) => !mediaPaths.includes(p)));
      await updateScheduledPost(admin, id, { text, platform_texts: platformTexts, platforms, media, status, scheduled_at: scheduledAt, results: {} });
    } else {
      id = await insertScheduledPost(admin, {
        client_id: input.clientId, text, platform_texts: platformTexts, platforms, media, status, scheduled_at: scheduledAt,
        created_by: v.id, created_by_name: v.name || v.email,
      });
    }
    const what = { draft: "下書き保存", schedule: `予約（${scheduledAt}）`, now: "今すぐ投稿" }[input.mode];
    await audit(admin, v, "post.save", input.clientId, `${what}・${platforms.join(",")}・画像${media.length}枚`, await clientIp());
    revalidatePath(`/clients/${input.clientId}/publish`);
    return { ok: true, id: id!, publishNow: input.mode === "now" };
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
    if (post.status !== "scheduled") return { ok: false, errors: ["予約中の投稿だけ取り消せます"] };
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
