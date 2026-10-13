import type { Metadata } from "next";
import { SettingsView } from "./settings-view";

export const metadata: Metadata = { title: "クライアント情報" };

export default function ClientInfoPage({ params, searchParams }: PageProps<"/clients/[id]/settings">) {
  return <SettingsView params={params} searchParams={searchParams} part="client" />;
}
