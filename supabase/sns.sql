-- =============================================================
--  SNS Analyzer — MEO と同じ Supabase に追加するテーブル
--
--  方針:
--   - MEO の表（clients / staff / client_users など）は変更しない。追加は sns_ で始まる表だけ
--   - ログイン（Supabase Auth）とスタッフは MEO と共通
--       スタッフ（MEO の staff） : 全クライアントを運用・閲覧（admin は操作ログも閲覧）
--   - クライアントは SNS分析 専用（sns_clients）。MEO のクライアントとは別に管理する
--       閲覧ユーザー（sns_client_users） : 自社の分析結果だけ閲覧
--   - 書き込みはすべてサーバー側（service_role）で行う。画面のセッションからは読むだけ
--   - アクセストークンを持つ表（sns_connections）はポリシーを作らない＝service_role 専用
--
--  前提: MEO の schema.sql が適用済み（staff / is_staff() / is_admin() / set_updated_at() を使う）
--  何度実行しても安全。
-- =============================================================

-- ---------- クライアント（SNS分析 専用） ----------
create table if not exists sns_clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 100),
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_sns_clients_updated on sns_clients;
create trigger trg_sns_clients_updated before update on sns_clients
  for each row execute function set_updated_at();

-- ---------- クライアントの閲覧ユーザー ----------
create table if not exists sns_client_users (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  client_id            uuid not null references sns_clients(id) on delete cascade,
  name                 text not null,
  email                text not null,
  is_active            boolean not null default true,
  -- 初回ログイン時にパスワードの変更を求める
  must_change_password boolean not null default true,
  -- SNS分析 で作成したアカウントか（true なら、閲覧ユーザーの削除時にログインアカウントも削除する）
  created_by_sns       boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_sns_client_users_client on sns_client_users(client_id);

drop trigger if exists trg_sns_client_users_updated on sns_client_users;
create trigger trg_sns_client_users_updated before update on sns_client_users
  for each row execute function set_updated_at();

-- ログイン中の閲覧ユーザーのクライアント
create or replace function sns_current_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from sns_client_users where user_id = auth.uid() and is_active;
$$;

-- ---------- アプリ全体の設定（1行だけ） ----------
create table if not exists sns_app_settings (
  id                smallint primary key default 1 check (id = 1),
  -- この日数を過ぎたデータはデータ収集のたびに削除する（0 で無効）
  retention_days    integer not null default 400 check (retention_days >= 0),
  -- 収集の対象期間（日）。この期間の投稿を取り直し、SNS上で消えた投稿を削除する
  collect_days      integer not null default 60 check (collect_days between 1 and 365),
  max_posts_per_run integer not null default 300 check (max_posts_per_run between 1 and 2000),
  ai_model          text    not null default 'claude-opus-5-5',
  ai_effort         text    not null default 'high' check (ai_effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  graph_api_version text    not null default 'v26.0',
  -- プライバシーポリシー・利用規約に表示する事業者情報（未入力は【要記入】と表示）
  legal             jsonb   not null default '{}',
  updated_at        timestamptz not null default now()
);
insert into sns_app_settings (id) values (1) on conflict (id) do nothing;

drop trigger if exists trg_sns_app_settings_updated on sns_app_settings;
create trigger trg_sns_app_settings_updated before update on sns_app_settings
  for each row execute function set_updated_at();

-- ---------- クライアントごとの設定 ----------
create table if not exists sns_client_settings (
  client_id     uuid primary key references sns_clients(id) on delete cascade,
  -- AI分析の前提として渡す事業内容・SNSの目的
  brand_context text not null default '',
  updated_at    timestamptz not null default now()
);

-- クライアントの閲覧ユーザーが作った投稿に、スタッフの承認を必須にするか
alter table sns_client_settings add column if not exists require_approval boolean not null default false;
-- クライアントの利用者が作る投稿はクライアントの責任のため、承認は既定でなし（必要なクライアントだけ「利用者管理」で有効にする）
alter table sns_client_settings alter column require_approval set default false;

drop trigger if exists trg_sns_client_settings_updated on sns_client_settings;
create trigger trg_sns_client_settings_updated before update on sns_client_settings
  for each row execute function set_updated_at();

-- ---------- SNSとの接続（トークンを持つので service_role 専用） ----------
create table if not exists sns_connections (
  client_id         uuid not null references sns_clients(id) on delete cascade,
  platform          text not null check (platform in ('instagram', 'facebook', 'threads', 'x')),
  external_id       text not null,          -- ページID / IGビジネスアカウントID / ThreadsユーザーID / XユーザーID
  username          text,
  access_token      text not null,          -- ページトークン / Threads長期トークン / X Bearer Token
  token_expires_at  timestamptz,            -- 期限なしは null
  connected_user_id text,                   -- 連携を許可した人のアプリ用ID（データ削除リクエストの照合に使う）
  status            text not null default 'connected' check (status in ('connected', 'error')),
  last_error        text,
  connected_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (client_id, platform)
);

-- 投稿用：X のリフレッシュトークン、投稿の権限があるか、連携の方式
alter table sns_connections add column if not exists refresh_token text;
alter table sns_connections add column if not exists can_publish boolean not null default false;

-- 同じSNSで複数のアカウントを連携できるよう、主キーにアカウント（external_id）を含める（2026-10-14）
do $$
begin
  if exists (
    select 1 from pg_constraint c
    where c.conrelid = 'sns_connections'::regclass and c.contype = 'p' and array_length(c.conkey, 1) = 2
  ) then
    alter table sns_connections drop constraint sns_connections_pkey;
    alter table sns_connections add primary key (client_id, platform, external_id);
  end if;
end $$;
alter table sns_connections add column if not exists auth_kind text not null default 'token';

drop trigger if exists trg_sns_connections_updated on sns_connections;
create trigger trg_sns_connections_updated before update on sns_connections
  for each row execute function set_updated_at();

-- ---------- 競合 ----------
create table if not exists sns_competitors (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references sns_clients(id) on delete cascade,
  name       text not null check (length(name) between 1 and 80),
  -- {"instagram": "user", "facebook": "page", "threads": "user", "x": "user"}
  handles    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (client_id, name)
);
create index if not exists idx_sns_competitors_client on sns_competitors(client_id);

-- ---------- 収集したアカウント（自社・競合） ----------
create table if not exists sns_accounts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references sns_clients(id) on delete cascade,
  platform      text not null check (platform in ('instagram', 'facebook', 'threads', 'x')),
  external_id   text not null,
  username      text,
  -- null = 自社アカウント。値あり = その競合のアカウント
  competitor_id uuid references sns_competitors(id) on delete cascade,
  source        text not null default 'api' check (source in ('api', 'csv', 'manual')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id, platform, external_id)
);
create index if not exists idx_sns_accounts_client on sns_accounts(client_id);
-- MEO のクライアント（clients.id）との結び付け。月次レポートに Googleマップ（口コミ・投稿・検索キーワード）の結果も載せるため。
-- MEO の表は変えない（外部キーも張らない。MEO 側でクライアントを消しても、こちらは結果が出なくなるだけ）
alter table sns_clients add column if not exists meo_client_id uuid;

-- 呼び名（「本店」「店舗A」など）。同じSNSに複数のアカウントがあるとき、切り替えや投稿先で見分けやすくする
alter table sns_accounts add column if not exists nickname text;

drop trigger if exists trg_sns_accounts_updated on sns_accounts;
create trigger trg_sns_accounts_updated before update on sns_accounts
  for each row execute function set_updated_at();

-- ---------- フォロワー数などの日次記録 ----------
create table if not exists sns_snapshots (
  account_id  uuid not null references sns_accounts(id) on delete cascade,
  client_id   uuid not null references sns_clients(id) on delete cascade,
  date        date not null,
  followers   integer,
  following   integer,
  posts_count integer,
  primary key (account_id, date)
);
create index if not exists idx_sns_snapshots_client_date on sns_snapshots(client_id, date);

-- ---------- 投稿 ----------
create table if not exists sns_posts (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references sns_accounts(id) on delete cascade,
  client_id   uuid not null references sns_clients(id) on delete cascade,
  platform    text not null check (platform in ('instagram', 'facebook', 'threads', 'x')),
  external_id text not null,
  posted_at   timestamptz not null,
  text        text not null default '',
  media_type  text not null default 'other'
              check (media_type in ('image', 'video', 'reel', 'carousel', 'text', 'link', 'other')),
  permalink   text,
  unique (account_id, external_id)
);
create index if not exists idx_sns_posts_client_posted on sns_posts(client_id, posted_at);
-- コンテンツの種類（通常の投稿／ストーリーズ）。ストーリーズは24時間で消えるため、削除の同期の対象外
alter table sns_posts add column if not exists content_type text not null default 'post' check (content_type in ('post', 'story'));

-- ---------- 投稿ごとの指標（取得日ごとの履歴） ----------
create table if not exists sns_post_metrics (
  post_id      uuid not null references sns_posts(id) on delete cascade,
  client_id    uuid not null references sns_clients(id) on delete cascade,
  fetched_date date not null,
  views        integer,
  reach        integer,
  likes        integer not null default 0,
  comments     integer not null default 0,
  shares       integer not null default 0,
  saves        integer not null default 0,
  quotes       integer not null default 0,
  clicks       integer,
  primary key (post_id, fetched_date)
);
create index if not exists idx_sns_post_metrics_client on sns_post_metrics(client_id);
-- フォロワーによる閲覧数（取得できるSNSのみ。Facebook）
alter table sns_post_metrics add column if not exists follower_views integer;

-- 各投稿の最新の指標（呼び出した人の権限で読む）
create or replace view sns_posts_latest with (security_invoker = true) as
  select p.id, p.account_id, p.client_id, p.platform, p.external_id, p.posted_at, p.text,
         p.media_type, p.permalink,
         m.fetched_date, m.views, m.reach, m.likes, m.comments, m.shares, m.saves, m.quotes, m.clicks,
         p.content_type, m.follower_views
  from sns_posts p
  join lateral (
    select * from sns_post_metrics pm
    where pm.post_id = p.id
    order by pm.fetched_date desc
    limit 1
  ) m on true;

-- ---------- アカウント全体の日別の指標（インサイト。Facebook ページ・Instagram） ----------
-- metric：views（閲覧数）/ viewers（閲覧者・リーチ）/ interactions / visits（ページへのアクセス）/
--         link_clicks / follows / unfollows / video_views / engaged（反応したアカウント）
create table if not exists sns_daily_insights (
  account_id uuid not null references sns_accounts(id) on delete cascade,
  client_id  uuid not null references sns_clients(id) on delete cascade,
  platform   text not null check (platform in ('instagram', 'facebook', 'threads', 'x')),
  date       date not null,
  metric     text not null check (metric ~ '^[a-z_]{1,40}$'),
  value      bigint not null,
  primary key (account_id, date, metric)
);
create index if not exists idx_sns_daily_insights_client_date on sns_daily_insights(client_id, date);

-- ---------- フォロワーの属性（性別・年齢・市区町村・国）。取得日ごとに1件 ----------
-- data：{"gender_age": {"F": {"25-34": 12}}, "city": {"大津市": 40}, "country": {"JP": 120}}
create table if not exists sns_audience (
  account_id   uuid not null references sns_accounts(id) on delete cascade,
  client_id    uuid not null references sns_clients(id) on delete cascade,
  platform     text not null check (platform in ('instagram', 'facebook', 'threads', 'x')),
  fetched_date date not null,
  data         jsonb not null default '{}',
  primary key (account_id, fetched_date)
);
create index if not exists idx_sns_audience_client on sns_audience(client_id, fetched_date);

-- ---------- AI分析の同意（クライアント単位） ----------
create table if not exists sns_ai_consents (
  client_id         uuid primary key references sns_clients(id) on delete cascade,
  status            text not null check (status in ('granted', 'revoked')),
  version           text not null,           -- 同意した説明文の版。版が変わると再同意が必要
  granted_by        text,                    -- 同意した方の氏名・所属
  granted_at        timestamptz,
  include_post_text boolean not null default false,
  note              text,
  recorded_by       uuid references auth.users(id) on delete set null,
  revoked_at        timestamptz,
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_sns_ai_consents_updated on sns_ai_consents;
create trigger trg_sns_ai_consents_updated before update on sns_ai_consents
  for each row execute function set_updated_at();

-- ---------- AI分析の結果 ----------
create table if not exists sns_ai_results (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references sns_clients(id) on delete cascade,
  period_end date not null,
  days       integer not null,
  result     jsonb not null,
  model      text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (client_id, period_end, days)
);

-- ---------- 収集の実行状況（1回の cron で処理しきれない分を次回へ回すために使う） ----------
create table if not exists sns_collect_state (
  client_id       uuid not null references sns_clients(id) on delete cascade,
  platform        text not null check (platform in ('instagram', 'facebook', 'threads', 'x')),
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  posts_saved     integer,
  primary key (client_id, platform)
);
-- 収集の状況もアカウントごとに持つ（同じSNSの複数アカウント。2026-10-14）
alter table sns_collect_state add column if not exists external_id text not null default '';
update sns_collect_state s set external_id = c.external_id
  from sns_connections c
  where s.external_id = '' and c.client_id = s.client_id and c.platform = s.platform;
do $$
begin
  if exists (
    select 1 from pg_constraint c
    where c.conrelid = 'sns_collect_state'::regclass and c.contype = 'p' and array_length(c.conkey, 1) = 2
  ) then
    alter table sns_collect_state drop constraint sns_collect_state_pkey;
    alter table sns_collect_state add primary key (client_id, platform, external_id);
  end if;
end $$;

-- ---------- SNSへの投稿（予約・即時） ----------
create table if not exists sns_scheduled_posts (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references sns_clients(id) on delete cascade,
  text            text not null default '' check (length(text) <= 63206),
  -- SNSごとに本文を変える場合 {"x": "短い文", ...}
  platform_texts  jsonb not null default '{}',
  platforms       text[] not null check (cardinality(platforms) between 1 and 4
                    and platforms <@ array['instagram', 'facebook', 'threads', 'x']),
  -- 画像 [{"path": "<client_id>/<file>.jpg", "url": "https://..."}]（最大10枚）
  media           jsonb not null default '[]',
  status          text not null default 'draft',
  scheduled_at    timestamptz,
  -- SNSごとの結果 {"instagram": {"state": "published", "id": "...", "permalink": "...", "error": null, "at": "..."}}
  results         jsonb not null default '{}',
  locked_at       timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_by_name text,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- 承認（クライアントの閲覧ユーザーが作った投稿は、スタッフの承認を経て公開する）
--   pending  : 承認待ち（requested_mode = 'now' なら承認と同時に投稿、'schedule' なら scheduled_at に投稿）
--   rejected : 差し戻し（review_note に理由）
alter table sns_scheduled_posts add column if not exists requested_mode   text check (requested_mode in ('now', 'schedule'));
alter table sns_scheduled_posts add column if not exists review_note      text;
alter table sns_scheduled_posts add column if not exists reviewed_by      uuid references auth.users(id) on delete set null;
alter table sns_scheduled_posts add column if not exists reviewed_by_name text;
alter table sns_scheduled_posts add column if not exists reviewed_at      timestamptz;
alter table sns_scheduled_posts drop constraint if exists sns_scheduled_posts_status_check;
alter table sns_scheduled_posts add constraint sns_scheduled_posts_status_check
  check (status in ('draft', 'pending', 'rejected', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'canceled'));

create index if not exists idx_sns_scheduled_posts_due on sns_scheduled_posts(status, scheduled_at);
create index if not exists idx_sns_scheduled_posts_client on sns_scheduled_posts(client_id, created_at desc);

drop trigger if exists trg_sns_scheduled_posts_updated on sns_scheduled_posts;
create trigger trg_sns_scheduled_posts_updated before update on sns_scheduled_posts
  for each row execute function set_updated_at();

-- 投稿先のアカウント [{"platform": "instagram", "external_id": "..."}]。同じSNSの複数アカウントに出すため（2026-10-14）。
-- 空のとき（以前の投稿）は、platforms の各SNSの連携アカウントに出す。結果（results）は "instagram:<external_id>" のキーで持つ
alter table sns_scheduled_posts add column if not exists targets jsonb not null default '[]';

-- 外部ツール（Rhythmos AI など）から登録した投稿の識別子。同じ投稿を登録し直したときに重複させない
alter table sns_scheduled_posts add column if not exists import_ref text check (import_ref is null or length(import_ref) between 1 and 200);
create unique index if not exists idx_sns_scheduled_posts_import_ref on sns_scheduled_posts(client_id, import_ref) where import_ref is not null;

-- 投稿のリンクに計測用の印（UTM）を付けるか。投稿するときに、SNSごとの utm_source を付けて出す（2026-10-15）
alter table sns_scheduled_posts add column if not exists add_utm boolean not null default false;

-- 投稿の種類。post＝通常の投稿、story＝ストーリーズ（Instagram・Facebook ページのみ。画像1枚ごとに1つのストーリーズ）（2026-10-27）
alter table sns_scheduled_posts add column if not exists kind text not null default 'post';
alter table sns_scheduled_posts drop constraint if exists sns_scheduled_posts_kind_check;
alter table sns_scheduled_posts add constraint sns_scheduled_posts_kind_check check (kind in ('post', 'story'));

-- ---------- 外部ツールから投稿を登録するための合言葉（クライアントごとに1つ） ----------
-- 合言葉そのものは保存せず、SHA-256 の値だけを持つ。service_role 専用（ポリシーを作らない）
create table if not exists sns_import_keys (
  client_id       uuid primary key references sns_clients(id) on delete cascade,
  key_hash        text not null,
  key_hint        text not null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz
);

-- 投稿画像の置き場所（Instagram・Threads は公開URLから画像を取りに来るため公開バケット。ファイル名は推測できない値）
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('sns-media', 'sns-media', true, 8388608, array['image/jpeg'])
    on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

-- ---------- 操作ログ ----------
create table if not exists sns_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  ip          text,
  action      text not null,
  client_id   uuid,
  detail      text
);
create index if not exists idx_sns_audit_at on sns_audit(at desc);

-- ---------- Meta / Threads からのデータ削除リクエスト ----------
create table if not exists sns_deletion_requests (
  code       text primary key,
  service    text not null check (service in ('meta', 'threads')),
  user_id    text not null,
  status     text not null,
  detail     text,
  created_at timestamptz not null default now()
);

-- =============================================================
--  RLS
--   読み取り: スタッフは全件、クライアント閲覧者は自社分のみ
--   書き込み: ポリシーを作らない（サーバー側の service_role だけが書ける）
-- =============================================================
alter table sns_clients           enable row level security;
alter table sns_client_users      enable row level security;
alter table sns_app_settings      enable row level security;
alter table sns_client_settings   enable row level security;
alter table sns_connections       enable row level security;
alter table sns_competitors       enable row level security;
alter table sns_accounts          enable row level security;
alter table sns_snapshots         enable row level security;
alter table sns_posts             enable row level security;
alter table sns_post_metrics      enable row level security;
alter table sns_ai_consents       enable row level security;
alter table sns_ai_results        enable row level security;
alter table sns_collect_state     enable row level security;
alter table sns_audit             enable row level security;
alter table sns_deletion_requests enable row level security;
alter table sns_scheduled_posts   enable row level security;
alter table sns_daily_insights    enable row level security;
alter table sns_audience          enable row level security;
alter table sns_import_keys       enable row level security;

-- スタッフ専用の表
drop policy if exists sns_app_settings_staff    on sns_app_settings;
drop policy if exists sns_client_settings_staff on sns_client_settings;
drop policy if exists sns_collect_state_staff   on sns_collect_state;
drop policy if exists sns_audit_admin           on sns_audit;
create policy sns_app_settings_staff    on sns_app_settings    for select using (is_staff());
create policy sns_client_settings_staff on sns_client_settings for select using (is_staff());
create policy sns_collect_state_staff   on sns_collect_state   for select using (is_staff());
create policy sns_audit_admin           on sns_audit           for select using (is_admin());

-- クライアントと閲覧ユーザー：スタッフは全件、閲覧ユーザーは自社・自分の行だけ
drop policy if exists sns_clients_staff       on sns_clients;
drop policy if exists sns_clients_own         on sns_clients;
drop policy if exists sns_client_users_staff  on sns_client_users;
drop policy if exists sns_client_users_self   on sns_client_users;
create policy sns_clients_staff      on sns_clients      for select using (is_staff());
create policy sns_clients_own        on sns_clients      for select using (id = sns_current_client_id());
create policy sns_client_users_staff on sns_client_users for select using (is_staff());
create policy sns_client_users_self  on sns_client_users for select using (user_id = auth.uid());

-- 分析データ：スタッフは全件、クライアント閲覧者は自社分
do $$
declare t text;
begin
  foreach t in array array[
    'sns_competitors', 'sns_accounts', 'sns_snapshots', 'sns_posts',
    'sns_post_metrics', 'sns_ai_consents', 'sns_ai_results', 'sns_scheduled_posts',
    'sns_daily_insights', 'sns_audience'
  ] loop
    execute format('drop policy if exists %I_staff_select on %I;', t, t);
    execute format('drop policy if exists %I_client_select on %I;', t, t);
    execute format('create policy %I_staff_select on %I for select using (is_staff());', t, t);
    execute format(
      'create policy %I_client_select on %I for select using (client_id = sns_current_client_id());', t, t);
  end loop;
end $$;

-- sns_connections / sns_deletion_requests / sns_import_keys はポリシーを作らない（service_role 専用）。
-- 接続状態を画面に出すときは、サーバー側で service_role 経由で取得し、トークンは返さない。
