import { getViewer, UUID_RE } from "@/lib/auth";
import { clientIp } from "@/lib/http";
import { parsePeriod } from "@/lib/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { analyze } from "@/lib/sns/analysis";
import { compare } from "@/lib/sns/compare";
import { DOWNLOAD_FILES, downloads, zip, type DownloadName } from "@/lib/sns/export";
import { audit, getClient, latestAiResult, loadReportData } from "@/lib/sns/store";

export async function GET(req: Request, ctx: RouteContext<"/api/clients/[id]/export/[file]">) {
  const { id, file } = await ctx.params;
  const v = await getViewer();
  if (!v || !UUID_RE.test(id) || (v.kind === "client" && v.clientId !== id)) return new Response("見つかりません", { status: 404 });
  if (file !== "all.zip" && !(file in DOWNLOAD_FILES)) return new Response("見つかりません", { status: 404 });

  const url = new URL(req.url);
  const { days, end } = parsePeriod(Object.fromEntries(url.searchParams));
  const db = await createClient();
  const client = await getClient(db, id);
  if (!client) return new Response("見つかりません", { status: 404 });
  const [data, stored] = await Promise.all([loadReportData(db, id, { days, end }), latestAiResult(db, id)]);
  const analysis = analyze(data.ownPosts, data.ownFollowers, { days, end, accountNames: data.ownNames });
  const cmp = data.competitors.length ? compare(data.ownPosts, data.ownFollowers, data.competitors, { days, end, ownNames: data.ownNames }) : null;
  const files = downloads(analysis, data.ownPosts, data.ownFollowers, cmp, stored?.result ?? null, client.name);

  const slug = `sns_${end}_${days}d`;
  let body: Uint8Array | string;
  let type: string;
  let name: string;
  if (file === "all.zip") {
    const entries: Record<string, string> = {};
    for (const [k, c] of Object.entries(files)) entries[`${slug}_${k}`] = c!;
    entries[`${slug}_data.json`] = JSON.stringify({ client: client.name, period: analysis.period, analysis, competitors: cmp }, null, 1);
    body = zip(entries);
    type = "application/zip";
    name = `${slug}.zip`;
  } else {
    const content = files[file as DownloadName];
    if (!content) return new Response("この期間には該当するデータがありません", { status: 404 });
    body = content;
    type = file.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8";
    name = `${slug}_${file}`;
  }
  await audit(createAdminClient(), v, "download", id, `${name}`, await clientIp());
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
