-- Migration 004: pg_cron + pg_net 설정
-- auto-approve Edge Function을 5분마다 호출
--
-- 사전 요구사항:
--   Supabase Dashboard > Database > Extensions 에서
--   pg_cron, pg_net 두 확장을 활성화해야 합니다.
--
-- 아래 두 값을 실제 프로젝트 값으로 교체 후 실행하세요:
--   <YOUR_SUPABASE_URL>         예: https://xxxx.supabase.co
--   <YOUR_SERVICE_ROLE_KEY>     Supabase Dashboard > Settings > API > service_role

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 기존 잡 제거 (재실행 대비)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-approve-tasks') THEN
    PERFORM cron.unschedule('auto-approve-tasks');
  END IF;
END $$;

-- 5분마다 auto-approve Edge Function 호출
SELECT cron.schedule(
  'auto-approve-tasks',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://<YOUR_SUPABASE_URL>/functions/v1/auto-approve',
    headers := '{"Content-Type":"application/json","Authorization":"Bearer <YOUR_SERVICE_ROLE_KEY>"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);
