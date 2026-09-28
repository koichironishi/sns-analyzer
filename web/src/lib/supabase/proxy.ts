import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** ログイン不要のパス（審査で公開URLの提出が必要なページ、外部からのコールバック、cron） */
export function isPublicPath(path: string): boolean {
  return path === "/privacy" || path === "/terms" || path === "/data-deletion"
    || path.startsWith("/data-deletion/") || path.startsWith("/api/data-deletion/") || path.startsWith("/api/cron/");
}

/** セッション（Cookie）を更新し、未ログインなら /login へ誘導する */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  if (isPublicPath(path)) return response;
  if (!url || !key) {
    return path === "/setup" ? response : NextResponse.redirect(new URL("/setup", request.url));
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();

  const isLogin = path === "/login";
  if (!user && !isLogin) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.search = path === "/" ? "" : `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(to);
  }
  if (user && isLogin) return NextResponse.redirect(new URL("/", request.url));
  return response;
}
