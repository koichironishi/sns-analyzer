import type { Metadata } from "next";
import { SettingsView } from "../settings-view";

export const metadata: Metadata = { title: "利用者管理" };

export default function UsersPage({ params, searchParams }: PageProps<"/clients/[id]/settings/users">) {
  return <SettingsView params={params} searchParams={searchParams} part="users" />;
}
