import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { UUID_RE } from "@/lib/auth";
import { publishContext } from "@/lib/publish-page";
import { getScheduledPost } from "@/lib/sns/store";
import { PageHead } from "@/components/report-ui";
import { PostComposer } from "@/components/post-composer";

export const metadata: Metadata = { title: "投稿の編集" };

function toLocal(iso: string | null): string | null {
  if (!iso) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export default async function EditPostPage({ params }: PageProps<"/clients/[id]/publish/[postId]">) {
  const { id, postId } = await params;
  if (!UUID_RE.test(postId)) notFound();
  const { admin, connections, needsApproval } = await publishContext(id);
  const post = await getScheduledPost(admin, postId);
  if (!post || post.client_id !== id) notFound();
  if (!["draft", "pending", "rejected", "scheduled", "canceled"].includes(post.status)) notFound();
  return (
    <>
      <PageHead lead="投稿済み・処理中の投稿は編集できません。" />
      {post.status === "rejected" && post.review_note && (
        <div className="msg error" role="alert">差し戻されました（{post.reviewed_by_name ?? "担当者"}）：{post.review_note}</div>
      )}
      <PostComposer clientId={id} connections={connections} needsApproval={needsApproval} initial={{
        id: post.id, text: post.text, platformTexts: post.platform_texts, platforms: post.platforms, media: post.media,
        scheduledLocal: ["scheduled", "pending", "rejected"].includes(post.status) && post.scheduled_at ? toLocal(post.scheduled_at) : null,
      }} />
    </>
  );
}
