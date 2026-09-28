/**
 * supabase/sns.sql の検証（PGlite = WASM版 PostgreSQL）。
 * MEO 側の前提（auth / staff / clients / client_users と認可関数）は最小限のスタブで再現する。
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const SNS_SQL = readFileSync(new URL("../../supabase/sns.sql", import.meta.url), "utf8");

// Supabase / MEO の前提をまねた最小スタブ
const MEO_STUB = `
create schema if not exists auth;
create table auth.users (id uuid primary key);
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
create table clients (id uuid primary key default gen_random_uuid(), name text not null);
create table client_users (id uuid primary key references auth.users(id), client_id uuid not null references clients(id),
  name text, email text, is_active boolean not null default true, role text not null default 'member');
create or replace function current_client_id() returns uuid language sql stable security definer as
  $$ select client_id from client_users where id = auth.uid() and is_active $$;
create role authenticated;
`;

const IDS = {
  admin: "00000000-0000-0000-0000-00000000000a",
  member: "00000000-0000-0000-0000-00000000000b",
  viewerA: "00000000-0000-0000-0000-00000000000c",
  stranger: "00000000-0000-0000-0000-00000000000d",
  clientA: "10000000-0000-0000-0000-00000000000a",
  clientB: "10000000-0000-0000-0000-00000000000b",
};

let db: PGlite;

before(async () => {
  db = new PGlite();
  await db.exec(MEO_STUB);
  await db.exec(SNS_SQL);
  await db.exec(SNS_SQL); // 2回流しても壊れない（何度実行しても安全）
  await db.exec(`
    insert into auth.users values ('${IDS.admin}'), ('${IDS.member}'), ('${IDS.viewerA}'), ('${IDS.stranger}');
    insert into staff (id, name, email, role) values ('${IDS.admin}', 'A', 'a@x', 'admin'), ('${IDS.member}', 'M', 'm@x', 'member');
    insert into clients (id, name) values ('${IDS.clientA}', 'A社'), ('${IDS.clientB}', 'B社');
    insert into client_users (id, client_id, name, email) values ('${IDS.viewerA}', '${IDS.clientA}', 'V', 'v@x');
    grant usage on schema public to authenticated;
    grant select on all tables in schema public to authenticated;
  `);
  // 各クライアントにアカウント・投稿・指標・接続（トークン）を1件ずつ
  for (const c of [IDS.clientA, IDS.clientB]) {
    const acct = (await db.query<{ id: string }>(
      `insert into sns_accounts (client_id, platform, external_id, username) values ($1, 'x', $2, 'u') returning id`,
      [c, `ext-${c}`])).rows[0].id;
    const post = (await db.query<{ id: string }>(
      `insert into sns_posts (account_id, client_id, platform, external_id, posted_at, text)
       values ($1, $2, 'x', 'p1', now(), 'hello') returning id`, [acct, c])).rows[0].id;
    await db.query(`insert into sns_post_metrics (post_id, client_id, fetched_date, likes) values ($1, $2, current_date - 1, 1),
                    ($1, $2, current_date, 5)`, [post, c]);
    await db.query(`insert into sns_connections (client_id, platform, external_id, access_token) values ($1, 'x', 'u', 'SECRET')`, [c]);
    await db.query(`insert into sns_ai_consents (client_id, status, version) values ($1, 'granted', 'v1')`, [c]);
  }
  await db.exec(`insert into sns_audit (action) values ('test')`);
});

async function as<T>(uid: string, sql: string): Promise<T[]> {
  await db.exec(`reset role; select set_config('app.uid', '${uid}', false); set role authenticated;`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

test("スタッフは全クライアントの分析データを読める", async () => {
  const rows = await as<{ client_id: string }>(IDS.member, "select client_id from sns_posts");
  assert.equal(rows.length, 2);
});

test("クライアント閲覧者は自社分だけ読める", async () => {
  for (const t of ["sns_accounts", "sns_posts", "sns_post_metrics", "sns_ai_consents"]) {
    const rows = await as<{ client_id: string }>(IDS.viewerA, `select client_id from ${t}`);
    assert.ok(rows.length > 0, t);
    assert.ok(rows.every((r) => r.client_id === IDS.clientA), t);
  }
});

test("どこにも属さないユーザーは何も読めない", async () => {
  const rows = await as(IDS.stranger, "select * from sns_posts");
  assert.equal(rows.length, 0);
});

test("トークンを持つ sns_connections は誰のセッションからも読めない", async () => {
  for (const uid of [IDS.admin, IDS.member, IDS.viewerA]) {
    const rows = await as(uid, "select * from sns_connections");
    assert.equal(rows.length, 0, uid);
  }
});

test("操作ログは管理者だけ", async () => {
  assert.equal((await as(IDS.admin, "select * from sns_audit")).length, 1);
  assert.equal((await as(IDS.member, "select * from sns_audit")).length, 0);
  assert.equal((await as(IDS.viewerA, "select * from sns_audit")).length, 0);
});

test("最新指標のビューは呼び出した人の権限で絞られ、最新日の値を返す", async () => {
  const rows = await as<{ client_id: string; likes: number }>(IDS.viewerA, "select client_id, likes from sns_posts_latest");
  assert.deepEqual(rows, [{ client_id: IDS.clientA, likes: 5 }]);
});

test("画面のセッションからは書き込めない（ポリシーなし）", async () => {
  await db.exec(`reset role; select set_config('app.uid', '${IDS.admin}', false); grant insert on sns_competitors to authenticated; set role authenticated;`);
  await assert.rejects(db.query(`insert into sns_competitors (client_id, name) values ('${IDS.clientA}', 'x')`));
  await db.exec("reset role;");
});

test("クライアント削除で SNS のデータも消える（MEO の clients に追従）", async () => {
  await db.exec(`delete from clients where id = '${IDS.clientB}'`);
  const left = await db.query<{ n: number }>(
    `select (select count(*) from sns_posts where client_id = '${IDS.clientB}')::int +
            (select count(*) from sns_connections where client_id = '${IDS.clientB}')::int as n`);
  assert.equal(left.rows[0].n, 0);
});
