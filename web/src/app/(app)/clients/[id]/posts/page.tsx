import { redirect } from "next/navigation";

/** 投稿ランキングはダッシュボードに移したため、以前のURLはダッシュボードのランキングへ移す */
export default async function PostsPage({ params, searchParams }: PageProps<"/clients/[id]/posts">) {
  const { id } = await params;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") q.set(k, v);
  const s = q.toString();
  redirect(`/clients/${id}${s ? `?${s}` : ""}#ranking`);
}
