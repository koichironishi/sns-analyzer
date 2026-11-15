import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UUID_RE } from "@/lib/auth";
import { publishContext } from "@/lib/publish-page";
import { getScheduledPost, listConnections } from "@/lib/sns/store";
import { PageHead } from "@/components/report-ui";
import { PostCard } from "@/components/post-card";

export const metadata: Metadata = { title: "投稿の確認" };

/** 投稿1件の確認。画像を投稿する順番どおりに大きく並べ、SNSごとに実際に投稿する本文を全文で出す */
export default async function ViewPostPage({ params }: PageProps<"/clients/[id]/publish/[postId]/view">) {
  const { id, postId } = await params;
  if (!UUID_RE.test(postId)) notFound();
  const { v, admin } = await publishContext(id);
  const [post, conns] = await Promise.all([getScheduledPost(admin, postId), listConnections(admin, id)]);
  if (!post || post.client_id !== id) notFound();
  return (
    <>
      <p className="back-link"><Link href={`/clients/${id}/publish`}><span aria-hidden="true">←&nbsp;</span>投稿の一覧に戻る</Link></p>
      <PageHead lead="画像は投稿する順番に並んでいます。本文は、SNSごとに実際に投稿する文章です。" />
      <PostCard post={post} clientId={id} isStaff={v.kind === "staff"} conns={conns} detail />
    </>
  );
}
