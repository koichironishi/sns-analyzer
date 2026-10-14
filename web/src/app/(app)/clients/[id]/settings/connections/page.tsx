import type { Metadata } from "next";
import { SettingsView } from "../settings-view";

export const metadata: Metadata = { title: "SNS連携" };
// X を Bearer Token で連携した直後に、そのまま最初の収集を行うため（collectSoon）
export const maxDuration = 300;

export default function ConnectionsPage({ params, searchParams }: PageProps<"/clients/[id]/settings/connections">) {
  return <SettingsView params={params} searchParams={searchParams} part="connections" />;
}
