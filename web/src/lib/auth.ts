import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * ログイン中の利用者。アカウントは MEO と共通。
 * - staff  : 自社スタッフ（admin は操作ログの閲覧も可）。全クライアントを運用する
 * - client : クライアント側の閲覧ユーザー。自社のレポートを見るだけ
 */
export type Viewer =
  | { kind: "staff"; id: string; email: string; name: string; isAdmin: boolean }
  | { kind: "client"; id: string; email: string; name: string; clientId: string };

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;
  const [{ data: staff }, { data: cu }] = await Promise.all([
    supabase.from("staff").select("name,role,is_active").eq("id", user.id).maybeSingle(),
    supabase.from("client_users").select("client_id,name,is_active").eq("id", user.id).maybeSingle(),
  ]);
  if (staff?.is_active) {
    return { kind: "staff", id: user.id, email: user.email ?? "", name: staff.name ?? "", isAdmin: staff.role === "admin" };
  }
  if (cu?.is_active) return { kind: "client", id: user.id, email: user.email ?? "", name: cu.name ?? "", clientId: cu.client_id };
  return null;
});

export async function requireViewer(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) redirect("/login?e=noaccess");
  return v;
}

export async function requireStaff() {
  const v = await requireViewer();
  if (v.kind !== "staff") notFound();
  return v;
}

export async function requireAdmin() {
  const v = await requireStaff();
  if (!v.isAdmin) notFound();
  return v;
}

/** そのクライアントのレポートを見られるか。見られなければ 404 */
export async function requireClientAccess(clientId: string): Promise<Viewer> {
  const v = await requireViewer();
  if (v.kind === "client" && v.clientId !== clientId) notFound();
  return v;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
