import type { Metadata } from "next";
import { SettingsView } from "../settings-view";

export const metadata: Metadata = { title: "SNS連携" };

export default function ConnectionsPage({ params, searchParams }: PageProps<"/clients/[id]/settings/connections">) {
  return <SettingsView params={params} searchParams={searchParams} part="connections" />;
}
