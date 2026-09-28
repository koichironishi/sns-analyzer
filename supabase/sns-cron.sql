-- =============================================================
--  SNS Analyzer — 自動収集を Supabase から呼び出す（任意）
--
--  Vercel の Hobby プランは cron が1日1回・1回の実行時間にも上限があるため、
--  クライアントや連携が多い場合は、Supabase の pg_cron + pg_net で
--  /api/cron/collect を1日に数回呼び、前回の続きを処理させる。
--  （収集はクライアント×SNS 単位で「今日まだ処理していないもの」だけを進めるので、何度呼んでも重複しない）
--
--  使い方:
--   1. Supabase の Database → Extensions で pg_cron と pg_net を有効にする
--   2. 下の 2 か所（URL と CRON_SECRET）を書き換えて SQL Editor で実行する
--      ※ CRON_SECRET はこのファイルに保存せず、実行時にだけ貼り付けること
-- =============================================================

select cron.unschedule('sns-collect') where exists (select 1 from cron.job where jobname = 'sns-collect');

select cron.schedule(
  'sns-collect',
  '10 19,20,21,22 * * *',   -- 日本時間 4:10〜7:10 に1時間おき（UTC 表記）
  $$
  select net.http_post(
    url     := 'https://YOUR-SNS-APP.vercel.app/api/cron/collect',
    headers := jsonb_build_object('Authorization', 'Bearer ' || 'REPLACE_WITH_CRON_SECRET', 'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);
