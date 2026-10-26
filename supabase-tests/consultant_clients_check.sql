-- Local check for supabase-migrations/20261026_consultant_clients.sql.
--
-- SCRATCH DATABASE ONLY -- never run this against the live project. Builds the shared stub
-- schema (_permissions_setup.sql), adds the Consultant column and a few clients, applies the
-- migration twice (idempotency), then checks:
--   - pg_consultant_matches on the real shapes of the Consultant field ("Holly L", "Alice FS",
--     "Chloe", "Kasey Doren" vs ClickUp "Kasey Doran"), and that "Holly F" != "Holly Latham";
--   - the switch-over: source='clickup' rows gone, manual / capacity_lead rows untouched, each
--     consultant gets only ACTIVE / ON-HOLD clients naming them;
--   - the triggers: reassigning a client, offboarding one, adding one, renaming a profile's
--     ClickUp name and promoting someone to admin all resync access;
--   - signed-in users can't call the sync function.
-- Run like scoped_modules_check.sql:
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/consultant_clients_check.sql
\set ON_ERROR_STOP 1
begin;
\ir _permissions_setup.sql

alter table public.pginvoice_clients add column consultant text;
alter table public.pginvoice_user_clients add constraint pginvoice_user_clients_source_check
  check (source = any (array['manual', 'clickup', 'capacity_lead']));
-- c1 = "Holly Fraser", c2 = "Chloe Smith", d1 (coordinator) = "Coord One".
update public.pginvoice_clients set consultant = 'Holly F' where client in ('Majestic Plumbing', 'Warrina Homes');
update public.pginvoice_clients set consultant = 'Chloe' where client = 'Aus3C';
insert into public.pginvoice_clients (client, type, status, consultant) values
  ('Holly L Client', 'package', 'active', 'Holly L'),
  ('Paused Co', 'package', 'on_hold', 'Holly Fraser'),
  ('Archived Co', 'package', 'archived', 'Holly F');
insert into public.pginvoice_user_clients (user_id, client, source) values
  ('00000000-0000-0000-0000-0000000000c1', 'AWIWA', 'clickup'),
  ('00000000-0000-0000-0000-0000000000c1', 'MP Web Project', 'manual');

\ir ../supabase-migrations/20261026_consultant_clients.sql
\ir ../supabase-migrations/20261026_consultant_clients.sql

do $$
declare got text;
begin
  if not pg_consultant_matches('Holly L', 'Holly Latham') then raise exception 'Holly L / Holly Latham'; end if;
  if pg_consultant_matches('Holly F', 'Holly Latham') then raise exception 'Holly F must not match Holly Latham'; end if;
  if not pg_consultant_matches('Alice FS', 'Alice Fulton-Sherriff') then raise exception 'Alice FS'; end if;
  if not pg_consultant_matches('Chloe', 'Chloe James') then raise exception 'Chloe'; end if;
  if not pg_consultant_matches(' chloe  james ', 'Chloe James') then raise exception 'spacing / case'; end if;
  if not pg_consultant_matches('Kasey Doren', 'Kasey Doran') then raise exception 'misspelt surname'; end if;
  if pg_consultant_matches('Holly', 'Hollie Smith') then raise exception 'different first name matched'; end if;
  if pg_consultant_matches(null, 'Holly Latham') or pg_consultant_matches('Holly L', null) or pg_consultant_matches('', 'Holly') then
    raise exception 'empty matched'; end if;
  raise notice 'ok: matching rule';

  if exists (select 1 from pginvoice_user_clients where source = 'clickup') then raise exception 'clickup rows left'; end if;
  select string_agg(client, ',' order by client) into got from pginvoice_user_clients
   where user_id = '00000000-0000-0000-0000-0000000000c1' and source = 'consultant';
  if got is distinct from 'Majestic Plumbing,Paused Co' then raise exception 'c1 consultant clients: %', got; end if;
  if not exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000c1' and client = 'MP Web Project' and source = 'manual') then
    raise exception 'manual row lost'; end if;
  if not exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000d1' and source = 'capacity_lead') then
    raise exception 'capacity_lead row lost'; end if;
  select string_agg(client, ',') into got from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000c2' and source = 'consultant';
  if got is distinct from 'Aus3C' then raise exception 'c2 consultant clients: %', got; end if;
  if exists (select 1 from pginvoice_user_clients uc join pginvoice_profiles p using (user_id) where p.role in ('admin', 'super_admin') and uc.source = 'consultant') then
    raise exception 'admin got consultant rows'; end if;
  raise notice 'ok: switch-over (active + on hold only, manual / capacity lead kept, clickup rows gone)';

  update pginvoice_clients set consultant = 'Chloe Smith' where client = 'Majestic Plumbing';
  if exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000c1' and client = 'Majestic Plumbing') then
    raise exception 'reassign: Holly kept Majestic'; end if;
  if not exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000c2' and client = 'Majestic Plumbing') then
    raise exception 'reassign: Chloe did not get Majestic'; end if;
  update pginvoice_clients set status = 'offboarded' where client = 'Paused Co';
  if exists (select 1 from pginvoice_user_clients where client = 'Paused Co') then raise exception 'offboarded client kept'; end if;
  insert into pginvoice_clients (client, type, status, consultant) values ('New Co', 'package', 'active', 'Holly F');
  if not exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000c1' and client = 'New Co') then
    raise exception 'new client not granted'; end if;
  raise notice 'ok: client triggers (reassign, offboard, insert)';

  update pginvoice_profiles set clickup_user_name = 'Holly Latham' where user_id = '00000000-0000-0000-0000-0000000000c1';
  select string_agg(client, ',' order by client) into got from pginvoice_user_clients
   where user_id = '00000000-0000-0000-0000-0000000000c1' and source = 'consultant';
  if got is distinct from 'Holly L Client' then raise exception 'rename: got %', got; end if;
  update pginvoice_profiles set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000c2';
  if exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000c2' and source = 'consultant') then
    raise exception 'promoted admin kept consultant rows'; end if;
  insert into pginvoice_profiles (user_id, email, role, clickup_user_name) values ('00000000-0000-0000-0000-0000000000e1', 'new@example.test', 'consultant', 'Chloe Smith');
  if not exists (select 1 from pginvoice_user_clients where user_id = '00000000-0000-0000-0000-0000000000e1' and client = 'Majestic Plumbing') then
    raise exception 'new account not granted'; end if;
  raise notice 'ok: profile triggers (rename, promote, create)';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
begin
  perform pginvoice_sync_consultant_clients(null); raise exception 'authenticated could call the sync';
exception when insufficient_privilege then raise notice 'ok: signed-in users cannot call the sync';
end $$;
reset role;

rollback;
