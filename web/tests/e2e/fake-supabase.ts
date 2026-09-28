/**
 * 画面の動作確認用の「偽 Supabase」（テスト専用。本番では使わない）。
 *
 * PGlite（WASM版 PostgreSQL）に MEO のスタブと supabase/sns.sql を流し、
 * supabase-js が使う範囲の PostgREST / GoTrue の API だけを実装する。
 * 利用者のトークンで来た読み取りは authenticated ロール＋RLS で実行するので、本番と同じ権限で画面を確認できる。
 *
 *   node --experimental-strip-types tests/e2e/fake-supabase.ts   （ポート 54321）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PGlite, types } from "@electric-sql/pglite";

const PORT = Number(process.env.FAKE_SUPABASE_PORT ?? 54321);
export const SERVICE_KEY = "fake-service-role-key";
export const ANON_KEY = "fake-anon-key";

const tsText = (v: string) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
const db = new PGlite({
  parsers: {
    [types.TIMESTAMPTZ]: tsText, [types.TIMESTAMP]: tsText, [types.DATE]: (v: string) => v,
    [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v),
  },
});

const MEO_STUB = `
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
create or replace function set_updated_at() returns trigger language plpgsql as
  $$ begin new.updated_at = now(); return new; end $$;
create type staff_role as enum ('admin', 'member');
create table staff (id uuid primary key references auth.users(id), name text, email text,
  role staff_role not null default 'member', is_active boolean not null default true);
create or replace function is_staff() returns boolean language sql stable security definer as
  $$ select exists (select 1 from staff where id = auth.uid() and is_active) $$;
create or replace function is_admin() returns boolean language sql stable security definer as
  $$ select exists (select 1 from staff where id = auth.uid() and is_active and role = 'admin') $$;
create table clients (id uuid primary key default gen_random_uuid(), name text not null, status text default 'active');
alter table clients enable row level security;
create table client_users (id uuid primary key references auth.users(id), client_id uuid not null references clients(id) on delete cascade,
  name text, email text, is_active boolean not null default true, role text not null default 'member');
alter table staff enable row level security;
alter table client_users enable row level security;
create or replace function current_client_id() returns uuid language sql stable security definer as
  $$ select client_id from client_users where id = auth.uid() and is_active $$;
create policy clients_read on clients for select using (is_staff() or id = current_client_id());
create policy staff_self on staff for select using (id = auth.uid() or is_staff());
create policy cu_self on client_users for select using (id = auth.uid() or is_staff());
create role authenticated;
`;

export const USERS = [
  { id: "00000000-0000-0000-0000-00000000000a", email: "admin@example.test", password: "test-admin-pass", name: "管理 太郎", kind: "admin" },
  { id: "00000000-0000-0000-0000-00000000000b", email: "staff@example.test", password: "test-staff-pass", name: "運用 花子", kind: "member" },
  { id: "00000000-0000-0000-0000-00000000000c", email: "viewer@example.test", password: "test-viewer-pass", name: "閲覧 次郎", kind: "viewer" },
];
export const CLIENT_A = "10000000-0000-0000-0000-00000000000a";
export const CLIENT_B = "10000000-0000-0000-0000-00000000000b";

async function seed() {
  await db.exec(MEO_STUB);
  await db.exec(readFileSync(new URL("../../../supabase/sns.sql", import.meta.url), "utf8"));
  await db.exec(`grant usage on schema public to authenticated; grant select on all tables in schema public to authenticated;`);
  for (const u of USERS) await db.query("insert into auth.users (id, email) values ($1, $2)", [u.id, u.email]);
  await db.query("insert into clients (id, name) values ($1, 'デモ株式会社'), ($2, 'サンプル商店')", [CLIENT_A, CLIENT_B]);
  await db.query("insert into staff (id, name, email, role) values ($1, $2, $3, 'admin'), ($4, $5, $6, 'member')",
    [USERS[0].id, USERS[0].name, USERS[0].email, USERS[1].id, USERS[1].name, USERS[1].email]);
  await db.query("insert into client_users (id, client_id, name, email) values ($1, $2, $3, $4)", [USERS[2].id, CLIENT_A, USERS[2].name, USERS[2].email]);

  // デモデータ（Python 版の sample_data と同じもの）をクライアントAに入れる
  type P = { externalId: string; platform: string; postedAt: string; text: string; mediaType: string; permalink: string | null; metrics: Record<string, number | null> };
  const fx = JSON.parse(readFileSync(new URL("../fixtures/python-parity.json", import.meta.url), "utf8")) as {
    end: string; posts: P[]; followers: Record<string, [string, number][]>;
    competitors: { platform: string; competitorName: string; username: string; series: [string, number][]; posts: P[] }[];
  };
  // 日付を今日に合わせてずらす
  const shiftDays = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(fx.end)) / 86_400_000);
  const shiftIso = (iso: string) => new Date(Date.parse(iso) + shiftDays * 86_400_000).toISOString();
  const shiftDate = (d: string) => shiftIso(`${d}T00:00:00Z`).slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  async function account(platform: string, externalId: string, username: string, competitorId: string | null) {
    return (await db.query<{ id: string }>(
      "insert into sns_accounts (client_id, platform, external_id, username, competitor_id) values ($1,$2,$3,$4,$5) returning id",
      [CLIENT_A, platform, externalId, username, competitorId])).rows[0].id;
  }
  async function posts(accountId: string, list: P[]) {
    for (const p of list) {
      const id = (await db.query<{ id: string }>(
        "insert into sns_posts (account_id, client_id, platform, external_id, posted_at, text, media_type, permalink) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
        [accountId, CLIENT_A, p.platform, p.externalId, shiftIso(p.postedAt), p.text, p.mediaType, p.permalink])).rows[0].id;
      const m = p.metrics;
      await db.query("insert into sns_post_metrics (post_id, client_id, fetched_date, views, reach, likes, comments, shares, saves, quotes, clicks) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [id, CLIENT_A, today, m.views, m.reach, m.likes, m.comments, m.shares, m.saves, m.quotes, m.clicks]);
    }
  }
  async function series(accountId: string, s: [string, number][]) {
    for (const [d, f] of s) await db.query("insert into sns_snapshots (account_id, client_id, date, followers) values ($1,$2,$3,$4)", [accountId, CLIENT_A, shiftDate(d), f]);
  }
  const names: Record<string, string> = { instagram: "demo_shop", facebook: "デモ株式会社", threads: "demo_shop", x: "demo_shop" };
  for (const platform of ["instagram", "facebook", "threads", "x"]) {
    const acc = await account(platform, `demo_${platform}`, names[platform], null);
    await posts(acc, fx.posts.filter((p) => p.platform === platform));
    await series(acc, fx.followers[platform] ?? []);
  }
  const compIds = new Map<string, string>();
  for (const c of fx.competitors) {
    let cid = compIds.get(c.competitorName);
    if (!cid) {
      cid = (await db.query<{ id: string }>("insert into sns_competitors (client_id, name, handles) values ($1,$2,'{}') returning id", [CLIENT_A, c.competitorName])).rows[0].id;
      compIds.set(c.competitorName, cid);
    }
    await db.query("update sns_competitors set handles = handles || jsonb_build_object($2::text, $3::text) where id = $1", [cid, c.platform, c.username]);
    const acc = await account(c.platform, `comp_${c.competitorName}_${c.platform}`, c.username, cid);
    await posts(acc, c.posts);
    await series(acc, c.series);
  }
  await db.query("insert into sns_connections (client_id, platform, external_id, username, access_token, token_expires_at) values ($1,'threads','th1','demo_shop','FAKE-TOKEN', now() + interval '50 days')", [CLIENT_A]);
  await db.query("insert into sns_collect_state (client_id, platform, last_run_at, last_success_at, posts_saved) values ($1,'threads', now(), now(), 42)", [CLIENT_A]);
}

// ---- 認証（GoTrue の最小限） ---------------------------------------------------------

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwt(u: (typeof USERS)[number]) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", exp, session_id: u.id })}.sig`;
}
function userFromToken(token: string | undefined) {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    if (payload.exp * 1000 < Date.now()) return null;
    return USERS.find((u) => u.id === payload.sub) ?? null;
  } catch {
    return null;
  }
}
const userJson = (u: (typeof USERS)[number]) => ({
  id: u.id, aud: "authenticated", role: "authenticated", email: u.email, app_metadata: { provider: "email" }, user_metadata: {},
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
});
const session = (u: (typeof USERS)[number]) => ({
  access_token: jwt(u), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: `refresh-${u.id}`, user: userJson(u),
});

// ---- PostgREST の最小限 -------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => {
  const t = s.replace(/"/g, "").trim();
  if (!IDENT.test(t)) throw new Error(`bad identifier ${s}`);
  return `"${t}"`;
};

function parseList(v: string): string[] {
  const inner = v.replace(/^\(/, "").replace(/\)$/, "");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of inner) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "" || inner.endsWith(",")) out.push(cur);
  return out;
}

function where(params: URLSearchParams, args: unknown[]): string {
  const conds: string[] = [];
  const reserved = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  for (const [key, raw] of params) {
    if (reserved.has(key)) continue;
    const col = ident(key);
    let v = raw;
    let neg = false;
    if (v.startsWith("not.")) { neg = true; v = v.slice(4); }
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    let c: string;
    const p = () => { args.push(val); return `$${args.length}`; };
    switch (op) {
      case "eq": c = `${col}::text = ${p()}`; break;
      case "neq": c = `${col}::text <> ${p()}`; break;
      case "gt": c = `${col} > ${p()}`; break;
      case "gte": c = `${col} >= ${p()}`; break;
      case "lt": c = `${col} < ${p()}`; break;
      case "lte": c = `${col} <= ${p()}`; break;
      case "ilike": c = `${col}::text ilike ${p()}`; break;
      case "like": c = `${col}::text like ${p()}`; break;
      case "is": c = `${col} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`; break;
      case "in": { const list = parseList(val); args.push(list); c = `${col}::text = any($${args.length}::text[])`; break; }
      default: throw new Error(`unsupported op ${op}`);
    }
    conds.push(neg ? `not (${c})` : c);
  }
  return conds.length ? ` where ${conds.join(" and ")}` : "";
}

function selectCols(s: string | null): string {
  if (!s || s === "*") return "*";
  return s.split(",").map((c) => ident(c)).join(", ");
}

function orderBy(s: string | null): string {
  if (!s) return "";
  return " order by " + s.split(",").map((part) => {
    const [c, dir, nulls] = part.split(".");
    return `${ident(c)} ${dir === "desc" ? "desc" : "asc"}${nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : ""}`;
  }).join(", ");
}

const toParam = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const r = queue.then(fn, fn);
  queue = r.catch(() => undefined);
  return r;
};

async function run(role: { service: boolean; uid: string }, sql: string, args: unknown[]) {
  return serial(() => db.transaction(async (tx) => {
    if (!role.service) {
      await tx.query("select set_config('app.uid', $1, true)", [role.uid]);
      await tx.exec("set local role authenticated");
    }
    return tx.query<Record<string, unknown>>(sql, args);
  }));
}

async function rest(req: IncomingMessage, res: ServerResponse, table: string, url: URL, body: unknown) {
  const apikey = req.headers["apikey"];
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const service = apikey === SERVICE_KEY && (bearer === SERVICE_KEY || bearer === "");
  const user = service ? null : userFromToken(bearer);
  const role = { service, uid: user?.id ?? "" };
  const prefer = String(req.headers.prefer ?? "");
  const accept = String(req.headers.accept ?? "");
  const t = ident(table);
  const args: unknown[] = [];
  const p = url.searchParams;
  let sql: string;
  const method = req.method ?? "GET";

  if (method === "GET" || method === "HEAD") {
    const w = where(p, args);
    sql = `select ${selectCols(p.get("select"))} from ${t}${w}${orderBy(p.get("order"))}`;
    if (p.get("limit")) sql += ` limit ${Number(p.get("limit"))}`;
    if (p.get("offset")) sql += ` offset ${Number(p.get("offset"))}`;
    const r = await run(role, sql, args);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (/count=exact/.test(prefer)) {
      const cargs: unknown[] = [];
      const cw = where(p, cargs);
      const total = (await run(role, `select count(*)::int as n from ${t}${cw}`, cargs)).rows[0].n as number;
      headers["Content-Range"] = `0-${Math.max(0, r.rows.length - 1)}/${total}`;
    }
    return send(res, r.rows, accept, headers, method === "HEAD");
  }
  if (method === "POST") {
    const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
    const cols = p.get("columns") ? p.get("columns")!.split(",").map((c) => c.replace(/"/g, "")) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const values = rows.map((r) => `(${cols.map((c) => (c in r ? (args.push(toParam(r[c])), `$${args.length}`) : "default")).join(", ")})`);
    sql = `insert into ${t} (${cols.map(ident).join(", ")}) values ${values.join(", ")}`;
    if (/resolution=merge-duplicates/.test(prefer) || /resolution=ignore-duplicates/.test(prefer)) {
      const conflict = (p.get("on_conflict") ?? "id").split(",").map(ident).join(", ");
      const upd = cols.filter((c) => !(p.get("on_conflict") ?? "id").split(",").includes(c));
      sql += /ignore/.test(prefer) || !upd.length ? ` on conflict (${conflict}) do nothing` : ` on conflict (${conflict}) do update set ${upd.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
    }
    if (/return=representation/.test(prefer)) sql += ` returning ${selectCols(p.get("select"))}`;
    const r = await run(role, sql, args);
    return send(res, r.rows, accept, { "Content-Type": "application/json" }, !/return=representation/.test(prefer), 201);
  }
  if (method === "PATCH") {
    const obj = body as Record<string, unknown>;
    const sets = Object.keys(obj).map((c) => { args.push(toParam(obj[c])); return `${ident(c)} = $${args.length}`; });
    sql = `update ${t} set ${sets.join(", ")}${where(p, args)} returning ${selectCols(p.get("select"))}`;
    const r = await run(role, sql, args);
    return send(res, /return=representation/.test(prefer) ? r.rows : [], accept, { "Content-Type": "application/json" }, !/return=representation/.test(prefer));
  }
  if (method === "DELETE") {
    sql = `delete from ${t}${where(p, args)} returning ${selectCols(p.get("select"))}`;
    const r = await run(role, sql, args);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (/count=exact/.test(prefer)) headers["Content-Range"] = `*/${r.rows.length}`;
    return send(res, /return=representation/.test(prefer) ? r.rows : [], accept, headers, !/return=representation/.test(prefer));
  }
  res.writeHead(405).end();
}

function send(res: ServerResponse, rows: unknown[], accept: string, headers: Record<string, string>, empty: boolean, status = 200) {
  if (accept.includes("vnd.pgrst.object+json")) {
    if (rows.length !== 1) {
      res.writeHead(406, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `${rows.length} rows`, hint: null }));
    }
    res.writeHead(status, headers);
    return res.end(JSON.stringify(rows[0]));
  }
  res.writeHead(empty ? (status === 201 ? 201 : 204) : status, headers);
  res.end(empty ? "" : JSON.stringify(rows));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return Object.fromEntries(new URLSearchParams(s)); }
}

export async function start(port = PORT) {
  await seed();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    try {
      const body = await readBody(req);
      if (url.pathname === "/auth/v1/token") {
        const grant = url.searchParams.get("grant_type");
        const b = body as Record<string, string>;
        const u = grant === "password"
          ? USERS.find((x) => x.email === b?.email && x.password === b?.password)
          : USERS.find((x) => `refresh-${x.id}` === b?.refresh_token);
        if (!u) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials" })); }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(session(u)));
      }
      if (url.pathname === "/auth/v1/user") {
        const u = userFromToken((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!u) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ code: 401, msg: "invalid JWT" })); }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(userJson(u)));
      }
      if (url.pathname === "/auth/v1/logout") { res.writeHead(204).end(); return; }
      const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
      if (m) return await rest(req, res, m[1], url, body);
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "FAKE", message: e instanceof Error ? e.message : String(e), details: null, hint: null }));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { server, db };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
  console.log(`fake supabase listening on http://127.0.0.1:${PORT}`);
}
