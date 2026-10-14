"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { LEGAL_FIELDS } from "@/lib/legal-fields";
import { createAdminClient } from "@/lib/supabase/admin";
import { AI_EFFORTS, AI_MODELS } from "@/lib/sns/ai";
import { audit } from "@/lib/sns/store";
import { deliver, recipients } from "@/lib/notify";
import type { ActionState } from "../clients/[id]/settings/actions";

const Settings = z.object({
  retention_days: z.coerce.number().int().min(0, "保存期間は0以上で入力してください").max(3650, "保存期間は3650日以内で入力してください"),
  collect_days: z.coerce.number().int().min(1).max(365, "収集の対象期間は1〜365日で入力してください"),
  max_posts_per_run: z.coerce.number().int().min(1).max(2000, "取得件数の上限は1〜2000件で入力してください"),
  ai_model: z.enum(AI_MODELS),
  ai_effort: z.enum(AI_EFFORTS),
  graph_api_version: z.string().regex(/^v\d{2}\.\d$/, "Graph API のバージョンは v26.0 の形式で入力してください"),
});

export async function saveAppSettings(_: ActionState, form: FormData): Promise<ActionState> {
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !v.isAdmin) return { error: "権限がありません" };
  const parsed = Settings.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "入力内容を確認してください" };
  const legal: Record<string, string> = {};
  for (const k of Object.keys(LEGAL_FIELDS)) {
    const val = String(form.get(`legal_${k}`) ?? "").trim();
    if (val.length > 1000) return { error: `${LEGAL_FIELDS[k as keyof typeof LEGAL_FIELDS]}は1000文字以内で入力してください` };
    if (val) legal[k] = val;
  }
  if (legal.contact && !/^(https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(legal.contact)) {
    return { error: "お問い合わせ窓口はメールアドレスか URL で入力してください" };
  }
  const admin = createAdminClient();
  const { error } = await admin.from("sns_app_settings").update({ ...parsed.data, legal }).eq("id", 1);
  if (error) return { error: `保存に失敗しました：${error.message}` };
  await audit(admin, v, "settings.update", null, JSON.stringify(parsed.data), await clientIp());
  revalidatePath("/", "layout");
  return { ok: "全体設定を保存しました。" };
}

/** 知らせのメールのテスト送信（SMTP の設定と送り先を確かめる） */
export async function sendTestAlert(): Promise<ActionState> {
  const v = await getViewer();
  if (!v || v.kind !== "staff" || !v.isAdmin) return { error: "権限がありません" };
  const admin = createAdminClient();
  try {
    const to = await recipients(admin);
    await deliver(admin, "テスト送信", [
      "これは知らせのメールのテスト送信です。",
      "予約投稿の失敗・データ収集のエラー・連携の期限が近いときに、この宛先へ届きます。",
    ]);
    await audit(admin, v, "alert.test", null, to.join(", "), await clientIp());
    return { ok: `テストメールを送りました（${to.join("、")}）。届いているか確認してください。` };
  } catch (e) {
    return { error: `送れませんでした：${e instanceof Error ? e.message : String(e)}` };
  }
}
