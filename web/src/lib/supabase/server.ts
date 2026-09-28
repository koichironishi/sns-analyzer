import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** ログイン中の利用者の権限で読む Supabase クライアント（RLS が効く） */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Component から呼ばれた場合は set できない（proxy 側で更新する）
        }
      },
    },
  });
}
