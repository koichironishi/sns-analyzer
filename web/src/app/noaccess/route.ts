import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * SNS分析の利用権限がないアカウントの出口。
 *
 * ログイン（Supabase Auth）は MEO と共通のため、MEO だけを契約しているクライアントでも
 * ログイン自体は通ってしまう。画面に進ませず、ログアウトさせてから案内を出す
 * （ログインしたままだと、別のアカウントで入り直せない）。
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login?e=noaccess", request.url));
}
