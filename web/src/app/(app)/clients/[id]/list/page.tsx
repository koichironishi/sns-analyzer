import { redirect } from "next/navigation";

/** 投稿一覧はダッシュボードに移したため、以前のURLはダッシュボードの一覧へ移す */
export default async function PostListPage({ params, searchParams }: PageProps<"/clients/[id]/list">) {
  const { id } = await params;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") q.set(k, v);
  const s = q.toString();
  redirect(`/clients/${id}${s ? `?${s}` : ""}#posts`);
}
