import type { Metadata } from "next";
import { publishContext } from "@/lib/publish-page";
import { PageHead } from "@/components/report-ui";
import { BulkImport } from "@/components/bulk-import";

export const metadata: Metadata = { title: "CSVで一括予約" };

export default async function BulkPage({ params }: PageProps<"/clients/[id]/publish/bulk">) {
  const { id } = await params;
  const { connections, needsApproval } = await publishContext(id);
  return (
    <>
      <PageHead lead="配信日時と本文を書いたCSVを読み込んで、まとめて予約します。取り込む前に、一覧で中身とエラーを確かめられます。" />
      <BulkImport clientId={id} connections={connections} needsApproval={needsApproval} />
    </>
  );
}
