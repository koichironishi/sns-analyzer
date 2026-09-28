import type { Metadata } from "next";
import { PrivacyPolicy } from "@/components/legal";
import { siteUrl } from "@/lib/http";
import { publicSettings } from "@/lib/public-settings";

export const metadata: Metadata = { title: "プライバシーポリシー", robots: { index: true, follow: true } };

export default async function PrivacyPage() {
  const s = await publicSettings();
  return <PrivacyPolicy legal={s.legal} retentionDays={s.retention_days} collectDays={s.collect_days} siteUrl={siteUrl()} />;
}
