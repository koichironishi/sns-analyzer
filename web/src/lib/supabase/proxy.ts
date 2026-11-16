import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { mfaState } from "../mfa";

/** ログイン不要のパス（審査で公開URLの提出が必要なページ、外部からのコールバック、cron、外部ツール用の受け口） */
export function isPublicPath(path: string): boolean {
  return path === "/privacy" || path === "/terms" || path === "/data-deletion"
    || path.startsWith("/data-deletion/") || path.startsWith("/api/data-deletion/") || path.startsWith("/api/cron/")
    // 外部ツールからの投稿の登録（ログインの代わりに、ルート側でクライアントごとの合言葉を確かめる）
    || path.startsWith("/api/import/");
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
  const isMfa = path === "/mfa";
  /*
    多要素認証を登録した人は、2段階目（確認コード）を通るまで中に入れない（lib/mfa.ts）。
    Supabase はパスワードが合えば1段階目のセッションを出すので、ここで止めないと登録しても守りが増えない。
  */
  const enrolled = Boolean(user?.factors?.some((f) => f.status === "verified"));
  const mfaPending = enrolled && !mfaState(user, (await supabase.auth.getSession()).data.session?.access_token).satisfied;
  if (user && mfaPending && !isMfa) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "確認コードの入力が必要です" }, { status: 401 });
    const to = request.nextUrl.clone();
    to.pathname = "/mfa";
    to.search = isLogin || path === "/" ? "" : `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(to);
  }
  if (user && !mfaPending && isMfa) return NextResponse.redirect(new URL("/", request.url));
  if (!user && isMfa) return NextResponse.redirect(new URL("/login", request.url));
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
