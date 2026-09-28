import type { Metadata } from "next";
import { Terms } from "@/components/legal";
import { publicSettings } from "@/lib/public-settings";

export const metadata: Metadata = { title: "利用規約", robots: { index: true, follow: true } };

export default async function TermsPage() {
  const s = await publicSettings();
  return <Terms legal={s.legal} retentionDays={s.retention_days} />;
}
