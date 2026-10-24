/**
 * 主な画面を開いて、エラーにならないことを確かめる（画面の煙テスト）。
 *
 *   npm run e2e:smoke
 *
 * 偽の Supabase（tests/e2e/fake-supabase.ts）と開発サーバーで動かす。
 * すでに .claude/launch.json の sns-web-e2e（http://localhost:3100、偽の Supabase は 54321）が動いていればそれを使い、
 * なければ両方をこのスクリプトが起動して、終わったら止める。
 *
 * 確かめること：
 *   - 管理者で、全体の画面とクライアントの各画面が 200 で開き、エラー画面になっていない
 *   - クライアントの利用者で、見てよい画面は開き、スタッフ専用の画面は 404 になる
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { CLIENT_A, USERS } from "./fake-supabase.ts";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3100";
const SUPA = process.env.SMOKE_SUPABASE ?? "http://127.0.0.1:54321";
const ANON = "fake-anon-key";

async function up(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

const procs: ChildProcess[] = [];
async function ensureServers() {
  if (!(await up(`${SUPA}/rest/v1/`))) {
    procs.push(spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "tests/e2e/fake-supabase.ts"], { stdio: "ignore" }));
  }
  if (!(await up(`${BASE}/login`))) {
    const port = new URL(BASE).port || "3100";
    procs.push(spawn("npx", ["next", "dev", "-p", port], {
      stdio: "ignore",
      env: {
        ...process.env, NEXT_PUBLIC_SUPABASE_URL: SUPA, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
        NEXT_PUBLIC_SITE_URL: BASE, META_APP_SECRET: "test-meta-secret", THREADS_APP_SECRET: "test-threads-secret", CRON_SECRET: "test-cron-secret",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    }));
  }
  for (let i = 0; i < 90; i++) {
    if ((await up(`${SUPA}/rest/v1/`)) && (await up(`${BASE}/login`))) return;
    await sleep(1000);
  }
  throw new Error("サーバーが起動しませんでした");
}

/** 偽の Supabase でログインし、@supabase/ssr と同じ形のクッキーを作る */
async function cookieFor(email: string): Promise<string> {
  const u = USERS.find((x) => x.email === email)!;
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.password }),
  });
  if (!r.ok) throw new Error(`ログインできません：${email}`);
  const value = `base64-${Buffer.from(await r.text()).toString("base64url")}`;
  const name = `sb-${new URL(SUPA).hostname.split(".")[0]}-auth-token`;
  // 長いときは @supabase/ssr と同じく .0 .1 … に分ける
  const size = 3180;
  if (value.length <= size) return `${name}=${value}`;
  const parts: string[] = [];
  for (let i = 0; i * size < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * size, (i + 1) * size)}`);
  return parts.join("; ");
}

type Check = { path: string; status: number };
const failures: string[] = [];

async function visit(cookie: string, who: string, c: Check) {
  const r = await fetch(`${BASE}${c.path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  const html = await r.text();
  const broken = r.status === 200 && html.includes("エラーが発生しました");
  const ok = r.status === c.status && !broken;
  console.log(`${ok ? "ok  " : "NG  "} ${who} ${c.path} → ${r.status}${broken ? "（エラー画面）" : ""}`);
  if (!ok) failures.push(`${who} ${c.path}：${r.status}${broken ? "（エラー画面）" : ""}（期待 ${c.status}）`);
}

const client = (p: string) => `/clients/${CLIENT_A}${p}`;
const ADMIN_PAGES = [
  "/", "/admin", "/admin/audit", "/admin/audit?all=1", "/help", "/account",
  client(""), client("?days=90"), client("/insights"), client("/insights/content"), client("/insights/audience"),
  client("/sns"), client("/competitors"), client("/content"), client("/downloads"), client("/ai"),
  client("/publish"), client("/publish/calendar"), client("/publish/calendar?month=2026-09"), client("/publish/new"), client("/publish/new?at=2026-12-01T12:00"), client("/publish/bulk"), client("/publish?tab=done"),
  client("/monthly"), client("/monthly?month=2026-09"),
  client("/settings"), client("/settings/connections"), client("/settings/users"),
];
const VIEWER_OK = [client(""), client("/insights"), client("/publish"), client("/publish/calendar"), client("/monthly")];
const VIEWER_404 = ["/admin", "/admin/audit", client("/settings"), client("/settings/connections"), client("/settings/users")];

try {
  await ensureServers();
  const admin = await cookieFor("admin@example.test");
  for (const p of ADMIN_PAGES) await visit(admin, "管理者", { path: p, status: 200 });
  const viewer = await cookieFor("viewer@example.test");
  for (const p of VIEWER_OK) await visit(viewer, "利用者", { path: p, status: 200 });
  for (const p of VIEWER_404) await visit(viewer, "利用者", { path: p, status: 404 });
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  for (const p of procs) p.kill();
}
if (failures.length) {
  console.error(`\n失敗 ${failures.length}件：\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nすべての画面が開けました");
