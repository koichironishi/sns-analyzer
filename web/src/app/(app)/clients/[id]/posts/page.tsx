import { redirect } from "next/navigation";

/** 投稿ランキングはダッシュボードの投稿一覧に統合したため、以前のURLは指数の大きい順の一覧へ移す */
export default async function PostsPage({ params, searchParams }: PageProps<"/clients/[id]/posts">) {
  const { id } = await params;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") q.set(k, v);
  if (!q.has("sort")) q.set("sort", "score");
  redirect(`/clients/${id}?${q.toString()}#posts`);
}
