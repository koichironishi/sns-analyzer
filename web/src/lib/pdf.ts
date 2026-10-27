import "server-only";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import puppeteer, { type Browser } from "puppeteer-core";

/**
 * 画面をそのままPDFにする（サーバーで Chromium を動かす）。
 * Vercel（Linux）の Chromium には日本語の書体がないため、同梱の Noto Sans JP（fonts/、SIL OFL）を /tmp/fonts に置いてから起動する。
 * 手元（Mac）では、インストール済みの Chrome / Brave を使う（PDF_CHROME_PATH で指定もできる）
 */
const LOCAL_CHROME = [
  process.env.PDF_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter((x): x is string => Boolean(x));

async function exists(p: string) {
  return stat(p).then(() => true, () => false);
}

async function launch(): Promise<Browser> {
  if (process.platform === "linux") {
    const dir = path.join(tmpdir(), "fonts");
    const dest = path.join(dir, "NotoSansJP.ttf");
    if (!(await exists(dest))) {
      await mkdir(dir, { recursive: true });
      await copyFile(path.join(process.cwd(), "fonts", "NotoSansJP.ttf"), dest);
    }
    return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  }
  for (const p of LOCAL_CHROME) if (await exists(p)) return puppeteer.launch({ executablePath: p, headless: true });
  throw new Error("PDFを作るためのブラウザが見つかりません（PDF_CHROME_PATH を設定してください）");
}

export type PdfCookie = { name: string; value: string };

/** origin の path を、渡したクッキー（ログイン中の利用者のもの）で開いてPDFにする */
export async function renderPdf(origin: string, pagePath: string, cookies: PdfCookie[]): Promise<Uint8Array> {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754 });
    const host = new URL(origin).hostname;
    await browser.setCookie(...cookies.map((c) => ({ ...c, domain: host, path: "/", httpOnly: true, secure: origin.startsWith("https"), sameSite: "Lax" as const })));
    const res = await page.goto(`${origin}${pagePath}`, { waitUntil: "networkidle0", timeout: 45_000 });
    if (!res || !res.ok()) throw new Error(`画面を開けませんでした（${res?.status() ?? "応答なし"}）`);
    if (new URL(page.url()).pathname.startsWith("/login")) throw new Error("ログインの情報を引き継げませんでした。画面を再読み込みしてから、もう一度お試しください");
    await page.emulateMediaType("print");
    return await page.pdf({
      format: "A4", printBackground: true, preferCSSPageSize: false,
      margin: { top: "12mm", bottom: "14mm", left: "10mm", right: "10mm" },
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: '<div style="width:100%;font-size:8px;color:#666;text-align:center;font-family:\'Noto Sans JP\',sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    await browser.close();
  }
}
