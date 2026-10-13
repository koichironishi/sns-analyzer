import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth";
import { AppChrome } from "@/components/app-chrome";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const v = await requireViewer();
  // 初期パスワードのままの利用者には、先にパスワードを変更してもらう
  if (v.kind === "client" && v.mustChangePassword) redirect("/account");
  return <AppChrome v={v}>{children}</AppChrome>;
}
