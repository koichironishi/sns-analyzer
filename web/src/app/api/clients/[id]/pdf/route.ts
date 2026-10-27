import { cookies } from "next/headers";
import { getViewer, UUID_RE } from "@/lib/auth";
import { json } from "@/lib/http";
import { renderPdf } from "@/lib/pdf";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, getClient } from "@/lib/sns/store";
import { todayIn } from "@/lib/sns/models";

// Chromium の起動とページの描画に時間がかかるため
export const maxDuration = 60;

/** PDFにできる画面（レポートの画面）。設定や投稿の画面は対象にしない */
const PAGES: Record<string, string> = {
  "": "ダッシュボード", insights: "インサイト", "insights/content": "インサイト_コンテンツ", "insights/audience": "インサイト_オーディエンス",
  sns: "比較・分析", timing: "時間帯", competitors: "競合比較", content: "形式・タグ", ai: "AI分析", monthly: "月次レポート",
};

/**
 * レポートの画面をPDFにしてダウンロードさせる。?path= に、PDFにしたい画面のパス（クエリを含む）を渡す。
 * 画面はログイン中の利用者の権限で開く（その人が見られるものだけがPDFになる）
 */
export async function GET(req: Request, ctx: RouteContext<"/api/clients/[id]/pdf">) {
  const { id } = await ctx.params;
  const v = await getViewer();
  if (!v || !UUID_RE.test(id) || (v.kind === "client" && v.clientId !== id)) return json({ error: "権限がありません" }, 403);
  const url = new URL(req.url);
  const target = new URL(url.searchParams.get("path") ?? "", url.origin);
  // 同じクライアントのレポートの画面だけ（ほかのサイトや、ほかのクライアントの画面は開かない）
  const base = `/clients/${id}`;
  const rest = target.pathname === base ? "" : target.pathname.startsWith(`${base}/`) ? target.pathname.slice(base.length + 1) : null;
  if (target.origin !== url.origin || rest === null || !(rest in PAGES)) return json({ error: "PDFにできない画面です" }, 400);
  const admin = createAdminClient();
  const client = await getClient(admin, id);
  if (!client) return json({ error: "クライアントが見つかりません" }, 404);
  // ログインのクッキー（Supabase の sb-…）だけを、PDFを作るブラウザに渡す
  const jar = (await cookies()).getAll().filter((c) => c.name.startsWith("sb-"));
  try {
    const pdf = await renderPdf(url.origin, `${target.pathname}${target.search}`, jar);
    const month = target.searchParams.get("month");
    const name = `${client.name}_${PAGES[rest]}_${month ?? todayIn().replaceAll("-", "")}.pdf`.replace(/[\\/:*?"<>|]/g, "_");
    await audit(admin, v.kind === "staff" ? v : { id: v.id, email: v.email }, "download.pdf", id, `${PAGES[rest]}${month ? `（${month}）` : ""}`);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("PDFの作成に失敗しました", e instanceof Error ? e.message : e);
    return json({ error: `PDFを作れませんでした：${e instanceof Error ? e.message : "不明なエラー"}` }, 500);
  }
}
