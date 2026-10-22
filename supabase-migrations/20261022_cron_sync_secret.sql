-- clickup-sync caller check: the pg_cron jobs authenticate with a secret that exists only
-- in Vault. Safe to re-run (the secret is created once; the function is CREATE OR REPLACE;
-- cron.alter_job just rewrites each command).
--
-- Before this, clickup-sync accepted any valid JWT -- including the public anon key the
-- cron jobs (and every browser) carry -- so anyone could trigger syncs and read a raw
-- ClickUp entry back. It now requires either a signed-in admin-tier user or an
-- x-cron-secret header that pginvoice_cron_secret_ok() confirms against Vault
-- (supabase-functions/_shared/authz.ts + caller.ts).
--
-- The secret is generated here, inside the database, and is never in a file, an env var
-- or a function secret. To rotate it: update the Vault secret's value; nothing else changes.
--
-- DEPLOY ORDER (each step is safe on its own; the sync never stops):
--   1. Apply THIS migration. The jobs start sending the header; the currently deployed
--      function ignores it, so nothing changes yet.
--   2. Deploy clickup-sync (with supabase-functions/_shared/), then confirm the next cron
--      run in cron.job_run_details / net._http_response and
--      pginvoice_sync_meta.last_sync_status = 'ok'.
--
-- The Authorization header keeps the anon key: the function still has verify_jwt on, and
-- that key is already public (src/supabaseClient.js). It no longer grants anything here.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'pginvoice_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'pginvoice_cron_secret',
      'Shared secret the pg_cron jobs send to the clickup-sync Edge Function (x-cron-secret).');
  end if;
end $$;

-- Service role only: lets the Edge Function check a presented secret without ever reading it.
create or replace function public.pginvoice_cron_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(length(p_secret), 0) > 0 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'pginvoice_cron_secret' and decrypted_secret = p_secret
  );
$$;
revoke all on function public.pginvoice_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.pginvoice_cron_secret_ok(text) to service_role;

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
