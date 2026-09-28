"use server";
/**
 * 設定・連携ページの操作。Server Action は外部から直接呼べるため、
 * すべての関数で「スタッフか」「入力が正しいか」を確認してから service_role で書き込む。
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getViewer, UUID_RE } from "@/lib/auth";
import { clearPages, readPages } from "@/lib/connect-flow";
import { clientIp } from "@/lib/http";
import { saveMetaPage } from "@/lib/meta-pages";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanHandle } from "@/lib/sns/collectors/types";
import { checkConnection, xVerify } from "@/lib/sns/connect";
import { ImportError, readCsv } from "@/lib/sns/importers";
import { PLATFORMS, PLATFORM_LABELS, isPlatform, todayIn, type Platform } from "@/lib/sns/models";
import { CONSENT_VERSION } from "@/lib/sns/privacy";
import {
  audit, deleteCompetitor, deleteConnection, deletePlatformData, findAccount, getAppSettings,
  getConnectionSecrets, grantConsent, listCompetitors, recordFollowers, revokeConsent, saveCollected,
  saveCompetitor, saveConnection, setBrandContext,
} from "@/lib/sns/store";

export type ActionState = { ok?: string; error?: string };

async function staff(form: FormData) {
  const v = await getViewer();
  if (!v || v.kind !== "staff") throw new Error("権限がありません");
  const clientId = String(form.get("client_id") ?? "");
  if (!UUID_RE.test(clientId)) throw new Error("クライアントが正しくありません");
  return { v, clientId, admin: createAdminClient() };
}

const done = (clientId: string, ok: string): ActionState => {
  revalidatePath(`/clients/${clientId}`, "layout");
  return { ok };
};

const fail = (e: unknown): ActionState => ({
  error: e instanceof z.ZodError ? (e.issues[0]?.message ?? "入力内容を確認してください") : e instanceof Error ? e.message : "処理に失敗しました",
});

const handle = z.string().trim().max(100, "100文字以内で入力してください").transform(cleanHandle)
  .refine((s) => s === "" || /^[\p{L}\p{N}._-]{1,100}$/u.test(s), "ユーザー名に使えない文字が含まれています");

// ---- 接続 -----------------------------------------------------------------------

export async function connectX(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, clientId, admin } = await staff(form);
    const token = String(form.get("bearer_token") ?? "").trim();
    const username = String(form.get("username") ?? "");
    if (token.length < 20 || token.length > 500 || /\s/.test(token)) return { error: "Bearer Token の形式が正しくありません" };
    const user = await xVerify(token, username);
    await saveConnection(admin, clientId, "x", { externalId: user.userId, username: user.username, accessToken: token, expiresAt: null, connectedUserId: null });
    await audit(admin, v, "connect.x", clientId, `@${user.username}`, await clientIp());
    return done(clientId, `X（@${user.username}）を連携しました。`);
  } catch (e) {
    return fail(e);
  }
}

export async function testConnection(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { clientId, admin } = await staff(form);
    const platform = String(form.get("platform"));
    if (!isPlatform(platform)) return { error: "SNSの指定が正しくありません" };
    const conn = (await getConnectionSecrets(admin, clientId)).find((c) => c.platform === platform);
    if (!conn) return { error: "未連携です" };
    const { graph_api_version } = await getAppSettings(admin);
    const r = await checkConnection(platform, {
      externalId: conn.external_id, username: conn.username ?? "", accessToken: conn.access_token, expiresAt: conn.token_expires_at,
    }, graph_api_version);
    return r.ok
      ? done(clientId, `${PLATFORM_LABELS[platform]}：${r.message}（${r.account}${r.followers !== null ? `・フォロワー ${r.followers.toLocaleString()}人` : ""}）`)
      : { error: `${PLATFORM_LABELS[platform]}：${r.message}` };
  } catch (e) {
    return fail(e);
  }
}

export async function disconnect(_: ActionState, form: FormData): Promise<ActionState> {
  let to: string;
  try {
    const { v, clientId, admin } = await staff(form);
    const platform = String(form.get("platform"));
    if (!isPlatform(platform)) return { error: "SNSの指定が正しくありません" };
    const withData = form.get("delete_data") === "on";
    if (withData) await deletePlatformData(admin, clientId, platform, "all", true);
    else await deleteConnection(admin, clientId, platform);
    await audit(admin, v, "disconnect", clientId, `${platform}${withData ? "（データも削除）" : ""}`, await clientIp());
    revalidatePath(`/clients/${clientId}`, "layout");
    to = `/clients/${clientId}/settings?ok=${withData ? "disconnected_data" : "disconnected"}&p=${platform}#connections`;
  } catch (e) {
    return fail(e);
  }
  // 解除するとこのフォーム自体が消えるので、結果はページ側に表示する
  redirect(to);
}

export async function selectMetaPage(form: FormData): Promise<void> {
  const { v, clientId, admin } = await staff(form);
  const pending = await readPages();
  const page = pending?.pages.find((p) => p.pageId === String(form.get("page_id")));
  if (!pending || pending.clientId !== clientId || pending.userId !== v.id || !page) {
    redirect(`/clients/${clientId}/settings?e=expired#connections`);
  }
  await saveMetaPage(admin, v, clientId, page, pending.metaUserId);
  await clearPages();
  revalidatePath(`/clients/${clientId}`, "layout");
  redirect(`/clients/${clientId}/settings?ok=meta#connections`);
}

// ---- 競合 -----------------------------------------------------------------------

const CompetitorSchema = z.object({
  id: z.string().regex(UUID_RE).or(z.literal("")),
  name: z.string().trim().min(1, "競合名を入力してください").max(80, "競合名は80文字以内で入力してください"),
  instagram: handle, facebook: handle, threads: handle, x: handle,
});

export async function upsertCompetitor(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, clientId, admin } = await staff(form);
    const c = CompetitorSchema.parse(Object.fromEntries(["id", "name", ...PLATFORMS].map((k) => [k, String(form.get(k) ?? "")])));
    const handles = Object.fromEntries(PLATFORMS.filter((p) => c[p]).map((p) => [p, c[p]])) as Partial<Record<Platform, string>>;
    if (!Object.keys(handles).length) return { error: "いずれかのSNSのアカウントを入力してください（フォロワー数の手動記録だけの場合も、ユーザー名を入力します）" };
    const existing = await listCompetitors(admin, clientId);
    if (!c.id && existing.length >= 20) return { error: "競合は1クライアントにつき20件まで登録できます" };
    if (existing.some((x) => x.name === c.name && x.id !== c.id)) return { error: "同じ名前の競合がすでに登録されています" };
    await saveCompetitor(admin, clientId, c.name, handles, c.id || undefined);
    await audit(admin, v, c.id ? "competitor.update" : "competitor.add", clientId, `${c.name}：${JSON.stringify(handles)}`, await clientIp());
    return done(clientId, `競合「${c.name}」を${c.id ? "更新" : "登録"}しました。次回のデータ収集から取得します。`);
  } catch (e) {
    return fail(e);
  }
}

export async function removeCompetitor(_: ActionState, form: FormData): Promise<ActionState> {
  let to: string;
  try {
    const { v, clientId, admin } = await staff(form);
    const id = String(form.get("competitor_id") ?? "");
    if (!UUID_RE.test(id)) return { error: "競合が正しくありません" };
    if (form.get("confirm") !== "on") return { error: "確認のチェックを入れてください" };
    const msg = await deleteCompetitor(admin, clientId, id);
    await audit(admin, v, "competitor.delete", clientId, msg, await clientIp());
    revalidatePath(`/clients/${clientId}`, "layout");
    to = `/clients/${clientId}/settings?ok=competitor_deleted#competitors`;
  } catch (e) {
    return fail(e);
  }
  redirect(to);
}

// ---- AI分析の同意・事業内容 ---------------------------------------------------------

export async function grantAiConsent(_: ActionState, form: FormData): Promise<ActionState> {
  let to: string;
  try {
    const { v, clientId, admin } = await staff(form);
    const by = String(form.get("granted_by") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    if (!by) return { error: "同意した方の氏名・所属を入力してください" };
    if (by.length > 100 || note.length > 500) return { error: "氏名は100文字、メモは500文字以内で入力してください" };
    if (form.get("confirm") !== "on") return { error: "説明内容をクライアントに伝え、同意を得たことを確認してチェックを入れてください" };
    const includePostText = form.get("include_post_text") === "on";
    await grantConsent(admin, clientId, { version: CONSENT_VERSION, grantedBy: by, includePostText, note, recordedBy: v.id });
    await audit(admin, v, "consent.grant", clientId, `${by}・版${CONSENT_VERSION}・本文${includePostText ? "含む" : "含まない"}`, await clientIp());
    revalidatePath(`/clients/${clientId}`, "layout");
    to = `/clients/${clientId}/settings?ok=consent_granted#consent`;
  } catch (e) {
    return fail(e);
  }
  redirect(to);
}

export async function revokeAiConsent(_: ActionState, form: FormData): Promise<ActionState> {
  let to: string;
  try {
    const { v, clientId, admin } = await staff(form);
    if (form.get("confirm") !== "on") return { error: "確認のチェックを入れてください" };
    const n = await revokeConsent(admin, clientId, CONSENT_VERSION, v.id);
    await audit(admin, v, "consent.revoke", clientId, `AI分析結果 ${n}件を削除`, await clientIp());
    revalidatePath(`/clients/${clientId}`, "layout");
    to = `/clients/${clientId}/settings?ok=consent_revoked#consent`;
  } catch (e) {
    return fail(e);
  }
  redirect(to);
}

export async function saveBrand(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, clientId, admin } = await staff(form);
    const text = String(form.get("brand_context") ?? "").trim();
    if (text.length > 2000) return { error: "2000文字以内で入力してください" };
    await setBrandContext(admin, clientId, text);
    await audit(admin, v, "brand.update", clientId, `${text.length}文字`, await clientIp());
    return done(clientId, "事業内容・SNSの目的を保存しました。");
  } catch (e) {
    return fail(e);
  }
}

// ---- 取り込み・手動記録 ----------------------------------------------------------------

async function owner(admin: ReturnType<typeof createAdminClient>, clientId: string, value: string): Promise<string | null> {
  if (value === "own") return null;
  if (!UUID_RE.test(value) || !(await listCompetitors(admin, clientId)).some((c) => c.id === value)) throw new Error("記録先が正しくありません");
  return value;
}

const MAX_CSV_BYTES = 4 * 1024 * 1024;

export async function importCsv(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, clientId, admin } = await staff(form);
    const platform = String(form.get("platform"));
    if (!isPlatform(platform)) return { error: "SNSを選んでください" };
    const username = handle.parse(String(form.get("username") ?? ""));
    if (!username) return { error: "アカウント名（ユーザー名）を入力してください" };
    const competitorId = await owner(admin, clientId, String(form.get("owner") ?? "own"));
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "CSVファイルを選んでください" };
    if (file.size > MAX_CSV_BYTES) return { error: "ファイルが大きすぎます（4MBまで）" };
    const posts = readCsv(new Uint8Array(await file.arrayBuffer()));
    if (!posts.length) return { error: "取り込める行がありませんでした" };
    const existing = await findAccount(admin, clientId, platform, username, competitorId);
    const r = await saveCollected(admin, clientId, {
      account: { platform, externalId: existing?.external_id ?? `csv:${username.toLowerCase()}`, username, followers: null, following: null, postsCount: null },
      posts, warnings: [],
    }, { competitorId, source: existing ? undefined : "csv" });
    await audit(admin, v, "import.csv", clientId, `${platform}・${username}・${r.posts}件・${file.name.slice(0, 80)}`, await clientIp());
    return done(clientId, `${PLATFORM_LABELS[platform]}（${username}）に ${r.posts.toLocaleString()}件の投稿を取り込みました。`);
  } catch (e) {
    if (e instanceof ImportError) return { error: e.message };
    return fail(e);
  }
}

export async function recordFollowerCount(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, clientId, admin } = await staff(form);
    const platform = String(form.get("platform"));
    if (!isPlatform(platform)) return { error: "SNSを選んでください" };
    const username = handle.parse(String(form.get("username") ?? ""));
    if (!username) return { error: "アカウント名（ユーザー名）を入力してください" };
    const followers = Number(String(form.get("followers") ?? "").replace(/[,\s]/g, ""));
    if (!Number.isInteger(followers) || followers < 0 || followers > 2_000_000_000) return { error: "フォロワー数は0以上の整数で入力してください" };
    const date = String(form.get("date") || todayIn());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayIn()) return { error: "日付が正しくありません（未来の日付は指定できません）" };
    const competitorId = await owner(admin, clientId, String(form.get("owner") ?? "own"));
    await recordFollowers(admin, clientId, platform, username, followers, date, competitorId);
    await audit(admin, v, "followers.manual", clientId, `${platform}・${username}・${followers}・${date}`, await clientIp());
    return done(clientId, `${PLATFORM_LABELS[platform]}（${username}）の ${date.replaceAll("-", "/")} のフォロワー数を記録しました。`);
  } catch (e) {
    return fail(e);
  }
}

// ---- データ削除 -------------------------------------------------------------------

export async function deleteData(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, clientId, admin } = await staff(form);
    const platform = String(form.get("platform"));
    const scope = String(form.get("scope"));
    if (!isPlatform(platform) || !["own", "competitor", "all"].includes(scope)) return { error: "削除する対象を選んでください" };
    if (form.get("confirm") !== "on") return { error: "確認のチェックを入れてください" };
    const msg = await deletePlatformData(admin, clientId, platform, scope as "own" | "competitor" | "all", form.get("disconnect") === "on");
    await audit(admin, v, "data.delete", clientId, msg, await clientIp());
    return done(clientId, msg);
  } catch (e) {
    return fail(e);
  }
}
