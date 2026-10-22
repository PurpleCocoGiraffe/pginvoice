-- clickup-sync caller check: the pg_cron jobs authenticate with a shared secret.
-- Safe to re-run (cron.alter_job just rewrites each command).
--
-- Before this, clickup-sync accepted any valid JWT -- including the public anon key the
-- cron jobs (and every browser) carry -- so anyone could trigger syncs and read a raw
-- ClickUp entry back. It now requires either a signed-in admin-tier user or an
-- x-cron-secret header matching its CRON_SECRET function secret
-- (supabase-functions/_shared/authz.ts).
--
-- DEPLOY ORDER (each step is safe on its own; the sync never stops):
--   1. Generate a random secret. Store it twice, with the same value:
--        a. Edge Function secret CRON_SECRET (dashboard -> Edge Functions -> Secrets).
--        b. Vault:  select vault.create_secret('<value>', 'pginvoice_cron_secret');
--      The value is never committed.
--   2. Apply THIS migration. The jobs start sending the header; the currently deployed
--      function ignores it, so nothing changes yet.
--   3. Deploy clickup-sync, then confirm the next cron run in cron.job_run_details and
--      pginvoice_sync_meta.last_sync_status = 'ok'.
--
-- The Authorization header keeps the anon key: the function still has verify_jwt on, and
-- that key is already public (src/supabaseClient.js). It no longer grants anything here.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'pginvoice_cron_secret') then
    raise exception 'Create the pginvoice_cron_secret Vault secret first (see DEPLOY ORDER above).';
  end if;
end $$;

-- Every 20 minutes: the current month.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'pginvoice-clickup-sync'),
  command := $cmd$
    select net.http_post(
      url := 'https://fzvlnzlecchsubkpsmew.supabase.co/functions/v1/clickup-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6dmxuemxlY2Noc3Via3BzbWV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2ODIyODMsImV4cCI6MjA5NzI1ODI4M30.UDQFf4X43i7nriZntWoIIwV1KbgCR1wHdPF5MghWMAQ',
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pginvoice_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $cmd$
);

-- Every 4 hours: last month.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'pginvoice-clickup-sync-lastmonth'),
  command := $cmd$
    select net.http_post(
      url := 'https://fzvlnzlecchsubkpsmew.supabase.co/functions/v1/clickup-sync',
      headers := jsonb_build_object(
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6dmxuemxlY2Noc3Via3BzbWV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2ODIyODMsImV4cCI6MjA5NzI1ODI4M30.UDQFf4X43i7nriZntWoIIwV1KbgCR1wHdPF5MghWMAQ',
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pginvoice_cron_secret')
      ),
      body := '{"monthOffset": 1}'::jsonb
    );
  $cmd$
);
