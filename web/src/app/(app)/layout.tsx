import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { AppChrome } from "@/components/app-chrome";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const v = await requireViewer();
  // 初期パスワードのままの閲覧ユーザーには、先にパスワードを変更してもらう
  if (v.kind === "client" && v.mustChangePassword) redirect("/account");
  return <AppChrome v={v}>{children}</AppChrome>;
}
