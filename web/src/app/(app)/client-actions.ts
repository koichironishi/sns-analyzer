"use server";
/**
 * クライアント（SNS分析 専用）と閲覧ユーザーの管理。
 * ログイン（Supabase Auth）は MEO と共通のため、既存のアカウント（MEO のスタッフなど）を消さないよう注意する。
 */
import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getViewer, UUID_RE } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  addViewerRow, audit, createSnsClient, deleteSnsClient, deleteViewerRow, getClient, getViewerRow, listViewers,
  updateSnsClient, updateViewerRow, usedByMeo,
} from "@/lib/sns/store";
import type { ActionState } from "./clients/[id]/settings/actions";

async function staff(adminOnly = false) {
  const v = await getViewer();
  if (!v || v.kind !== "staff" || (adminOnly && !v.isAdmin)) throw new Error(adminOnly ? "この操作は管理者だけが行えます" : "権限がありません");
  return { v, admin: createAdminClient() };
}

const fail = (e: unknown): ActionState => ({ error: e instanceof Error ? e.message : "処理に失敗しました" });

function clientFields(form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  if (!name) throw new Error("クライアント名を入力してください");
  if (name.length > 100) throw new Error("クライアント名は100文字以内で入力してください");
  if (note.length > 500) throw new Error("メモは500文字以内で入力してください");
  return { name, note };
}

/** 読み間違えやすい文字（0/O、1/l/I など）を除いた初期パスワード */
function initialPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 16 }, () => chars[randomInt(chars.length)]).join("");
}

// ---- クライアント -------------------------------------------------------------------

export async function createClientAction(_: ActionState, form: FormData): Promise<ActionState> {
  let to: string;
  try {
    const { v, admin } = await staff();
    const { name, note } = clientFields(form);
    const id = await createSnsClient(admin, name, note);
    await audit(admin, v, "client.create", id, name, await clientIp());
    revalidatePath("/");
    to = `/clients/${id}/settings?ok=client_created#connections`;
  } catch (e) {
    return fail(e);
  }
  redirect(to);
}

export async function updateClientAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, admin } = await staff();
    const id = String(form.get("client_id") ?? "");
    if (!UUID_RE.test(id)) return { error: "クライアントの指定が正しくありません" };
    const { name, note } = clientFields(form);
    await updateSnsClient(admin, id, name, note);
    await audit(admin, v, "client.update", id, name, await clientIp());
    revalidatePath("/", "layout");
    return { ok: "クライアント情報を保存しました。" };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteClientAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, admin } = await staff(true);
    const id = String(form.get("client_id") ?? "");
    if (!UUID_RE.test(id)) return { error: "クライアントの指定が正しくありません" };
    const client = await getClient(admin, id);
    if (!client) return { error: "クライアントが見つかりません" };
    if (String(form.get("confirm_name") ?? "").trim() !== client.name) return { error: "確認のため、クライアント名を正確に入力してください" };
    // SNS分析で作った閲覧ユーザーのログインアカウントも消す（MEO でも使われているアカウントは残す）
    const viewers = await listViewers(admin, id);
    for (const u of viewers) {
      if (u.created_by_sns && !(await usedByMeo(admin, u.user_id))) await admin.auth.admin.deleteUser(u.user_id);
    }
    await deleteSnsClient(admin, id);
    await audit(admin, v, "client.delete", null, `${client.name}（閲覧ユーザー ${viewers.length}人を含む）`, await clientIp());
    revalidatePath("/", "layout");
  } catch (e) {
    return fail(e);
  }
  redirect("/?ok=client_deleted");
}

// ---- 閲覧ユーザー --------------------------------------------------------------------

async function findUserIdByEmail(admin: ReturnType<typeof createAdminClient>, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`アカウントの検索に失敗しました：${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
  return null;
}

export async function addViewerAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, admin } = await staff();
    const clientId = String(form.get("client_id") ?? "");
    if (!UUID_RE.test(clientId) || !(await getClient(admin, clientId))) return { error: "クライアントの指定が正しくありません" };
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    if (!name || name.length > 100) return { error: "氏名を100文字以内で入力してください" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "メールアドレスの形式が正しくありません" };

    const password = initialPassword();
    let userId: string;
    let created = true;
    const res = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (res.error) {
      // すでにログインアカウントがある（MEO のアカウントなど）場合は、そのアカウントを閲覧ユーザーにする
      const existing = res.error.status === 422 || /already|registered|exists/i.test(res.error.message) ? await findUserIdByEmail(admin, email) : null;
      if (!existing) return { error: `アカウントを作成できませんでした：${res.error.message}` };
      userId = existing;
      created = false;
    } else {
      userId = res.data.user.id;
    }
    const current = await getViewerRow(admin, userId);
    if (current) return { error: current.client_id === clientId ? "このメールアドレスは、すでに閲覧ユーザーです" : "このメールアドレスは、別のクライアントの閲覧ユーザーです" };
    await addViewerRow(admin, { user_id: userId, client_id: clientId, name, email, must_change_password: created, created_by_sns: created });
    await audit(admin, v, "viewer.add", clientId, `${name}（${email}）${created ? "" : "・既存のアカウント"}`, await clientIp());
    revalidatePath(`/clients/${clientId}`, "layout");
    return created
      ? { ok: `閲覧ユーザー「${name}」を作成しました。初期パスワード：${password}（この画面を閉じると再表示できません。ご本人に安全な方法で伝えてください。初回ログイン時にパスワードの変更を求めます）` }
      : { ok: `すでにあるアカウント（${email}）を閲覧ユーザーにしました。今のパスワードでログインできます。` };
  } catch (e) {
    return fail(e);
  }
}

async function viewerOf(admin: ReturnType<typeof createAdminClient>, form: FormData) {
  const clientId = String(form.get("client_id") ?? "");
  const userId = String(form.get("user_id") ?? "");
  if (!UUID_RE.test(clientId) || !UUID_RE.test(userId)) throw new Error("閲覧ユーザーの指定が正しくありません");
  const row = await getViewerRow(admin, userId);
  if (!row || row.client_id !== clientId) throw new Error("閲覧ユーザーが見つかりません");
  return row;
}

export async function resetViewerPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { v, admin } = await staff();
    const row = await viewerOf(admin, form);
    if (!row.created_by_sns || (await usedByMeo(admin, row.user_id))) {
      return { error: "MEO と共通のアカウントのため、ここではパスワードを再発行できません。MEO コンソールで再設定してください" };
    }
    const password = initialPassword();
    const { error } = await admin.auth.admin.updateUserById(row.user_id, { password });
    if (error) return { error: `パスワードを再発行できませんでした：${error.message}` };
    await updateViewerRow(admin, row.user_id, { must_change_password: true });
    await audit(admin, v, "viewer.reset_password", row.client_id, `${row.name}（${row.email}）`, await clientIp());
    return { ok: `「${row.name}」の新しい初期パスワード：${password}（この画面を閉じると再表示できません。次回ログイン時にパスワードの変更を求めます）` };
  } catch (e) {
    return fail(e);
  }
}

export async function removeViewerAction(_: ActionState, form: FormData): Promise<ActionState> {
  let to: string;
  try {
    const { v, admin } = await staff();
    const row = await viewerOf(admin, form);
    if (form.get("confirm") !== "on") return { error: "確認のチェックを入れてください" };
    await deleteViewerRow(admin, row.user_id);
    const deleteLogin = row.created_by_sns && !(await usedByMeo(admin, row.user_id));
    if (deleteLogin) await admin.auth.admin.deleteUser(row.user_id);
    await audit(admin, v, "viewer.remove", row.client_id, `${row.name}（${row.email}）${deleteLogin ? "・ログインアカウントも削除" : ""}`, await clientIp());
    revalidatePath(`/clients/${row.client_id}`, "layout");
    // 削除した行のフォームは画面から消えるので、結果はページ側に表示する
    to = `/clients/${row.client_id}/settings?ok=${deleteLogin ? "viewer_removed" : "viewer_removed_kept"}#viewers`;
  } catch (e) {
    return fail(e);
  }
  redirect(to);
}
