import type { Metadata } from "next";
import { publishContext } from "@/lib/publish-page";
import { PageHead } from "@/components/report-ui";
import { PostComposer } from "@/components/post-composer";

export const metadata: Metadata = { title: "新しい投稿" };

export default async function NewPostPage({ params }: PageProps<"/clients/[id]/publish/new">) {
  const { id } = await params;
  const { client, connections, needsApproval } = await publishContext(id);
  return (
    <>
      <PageHead eyebrow={`${client.name} ・ 投稿`} title="新しい投稿" lead="本文と画像を入れ、投稿先とタイミングを選んでください。" />
      <PostComposer clientId={id} connections={connections} needsApproval={needsApproval} />
    </>
  );
}
