import type { Metadata } from "next";
import { UUID_RE } from "@/lib/auth";
import { publishContext, publishHints } from "@/lib/publish-page";
import { getScheduledPost, listConnections } from "@/lib/sns/store";
import { resolveTargets, targetKey } from "@/lib/sns/publish/targets";
import { PageHead } from "@/components/report-ui";
import { Flash } from "@/components/flash";
import { PostComposer } from "@/components/post-composer";

export const metadata: Metadata = { title: "新しい投稿" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * 新しい投稿。次の指定で中身を入れた状態から始められる
 *   ?from=<予約投稿のID>  … その投稿（本文・SNSごとの本文・画像・投稿先）をもとに作る（画像は保存時に複製）
 *   ?post=<収集した投稿のID> … SNS 上の投稿の本文をもとに作る（画像は SNS から取り込めないため入れ直す）
 *   ?at=YYYY-MM-DDTHH:mm  … その日時で予約する状態で始める（投稿カレンダーから）
 */
export default async function NewPostPage({ params, searchParams }: PageProps<"/clients/[id]/publish/new">) {
  const { id } = await params;
  const sp = await searchParams;
  const { admin, connections, needsApproval } = await publishContext(id);
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(one(sp.at)) ? one(sp.at) : null;
  let initial: Parameters<typeof PostComposer>[0]["initial"] = at ? { text: "", platformTexts: {}, media: [], scheduledLocal: at } : undefined;
  let note: string | null = null;
  const from = one(sp.from);
  const post = one(sp.post);
  if (UUID_RE.test(from)) {
    const src = await getScheduledPost(admin, from);
    if (src && src.client_id === id) {
      const conns = await listConnections(admin, id);
      initial = {
        text: src.text, platformTexts: src.platform_texts, media: src.media, scheduledLocal: at, copy: true, addUtm: Boolean(src.add_utm),
        targets: resolveTargets(src, conns).filter((t) => t.externalId).map((t) => targetKey(t.platform, t.externalId!)),
      };
      note = "もとの投稿の本文・画像・投稿先を入れました。内容と日時を確かめてから保存してください。";
    }
  } else if (UUID_RE.test(post)) {
    const { data } = await admin.from("sns_posts").select("text,client_id").eq("id", post).maybeSingle();
    const row = data as { text: string | null; client_id: string } | null;
    if (row && row.client_id === id) {
      initial = { text: row.text ?? "", platformTexts: {}, media: [], scheduledLocal: at };
      note = "もとの投稿の本文を入れました。画像は SNS から取り込めないため、入れ直してください。";
    }
  }
  return (
    <>
      <PageHead lead="本文と画像を入れ、投稿先とタイミングを選んでください。" />
      {note && <Flash kind="ok">{note}</Flash>}
      <PostComposer clientId={id} connections={connections} needsApproval={needsApproval} {...await publishHints(id)} initial={initial} />
    </>
  );
}
