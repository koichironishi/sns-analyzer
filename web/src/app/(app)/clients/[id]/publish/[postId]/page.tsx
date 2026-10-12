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
  const { admin, client, connections } = await publishContext(id);
  const post = await getScheduledPost(admin, postId);
  if (!post || post.client_id !== id) notFound();
  if (!["draft", "scheduled", "canceled"].includes(post.status)) notFound();
  return (
    <>
      <PageHead eyebrow={`${client.name} ・ 投稿`} title="投稿の編集" lead="投稿済み・処理中の投稿は編集できません。" />
      <PostComposer clientId={id} connections={connections} initial={{
        id: post.id, text: post.text, platformTexts: post.platform_texts, platforms: post.platforms, media: post.media,
        scheduledLocal: post.status === "scheduled" ? toLocal(post.scheduled_at) : null,
      }} />
    </>
  );
}
