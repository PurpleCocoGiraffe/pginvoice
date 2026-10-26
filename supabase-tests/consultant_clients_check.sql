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
--   - a Consultant value matching two accounts goes to no one and is listed for admins;
--   - pginvoice_my_access().activityClients: current-month clients only, own clients left out,
--     [] for admins, old keys unchanged;
--   - signed-in users can't call the sync, the issues list or pg_my_activity_clients().
-- Run like scoped_modules_check.sql:
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/consultant_clients_check.sql
\set ON_ERROR_STOP 1
begin;
\ir _permissions_setup.sql

-- Folder map + pg_my_clickup_name_keys(), which activityClients builds on.
\ir ../supabase-migrations/20261022_entries_own_clients.sql
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

  -- c1 is now "Holly Latham" and owns 'Holly L Client'. A second "Holly L..." makes it ambiguous.
  insert into pginvoice_profiles (user_id, email, role, clickup_user_name) values ('00000000-0000-0000-0000-0000000000e2', 'lee@example.test', 'consultant', 'Holly Lee');
  if exists (select 1 from pginvoice_user_clients where client = 'Holly L Client') then
    raise exception 'ambiguous Consultant value was granted: %', (select string_agg(user_id::text, ',') from pginvoice_user_clients where client = 'Holly L Client'); end if;
  -- "Holly F" (New Co) matches nobody since c1 became Holly Latham: listed too, with no matches.
  got := (select string_agg(x ->> 'consultant', ',' order by x ->> 'consultant') from jsonb_array_elements(pginvoice_consultant_match_issues()) x);
  if got is distinct from 'Holly F,Holly L' then raise exception 'match issues: %', pginvoice_consultant_match_issues(); end if;
  if (select jsonb_array_length(x -> 'matches') from jsonb_array_elements(pginvoice_consultant_match_issues()) x where x ->> 'consultant' = 'Holly L') <> 2 then
    raise exception 'clash should list both accounts'; end if;
  if (select jsonb_array_length(x -> 'matches') from jsonb_array_elements(pginvoice_consultant_match_issues()) x where x ->> 'consultant' = 'Holly F') <> 0 then
    raise exception 'unmatched value should list no accounts'; end if;
  delete from pginvoice_profiles where user_id = '00000000-0000-0000-0000-0000000000e2';
  if not exists (select 1 from pginvoice_user_clients where client = 'Holly L Client' and user_id = '00000000-0000-0000-0000-0000000000c1') then
    raise exception 'removing the clash did not restore Holly L Client'; end if;
  if (select string_agg(x ->> 'consultant', ',') from jsonb_array_elements(pginvoice_consultant_match_issues()) x) is distinct from 'Holly F' then
    raise exception 'issues after resolving: %', pginvoice_consultant_match_issues(); end if;
  raise notice 'ok: name clash grants nobody, clash and no-match values are listed for admins, and it clears when resolved';
end $$;

-- activityClients: e1 ("Chloe Smith") owns Majestic Plumbing and Aus3C (Consultant "Chloe").
-- This month: Majestic and Aus3C IRAP (own, left out), AWIWA (someone else's), and a cost-centre
-- folder of the offboarded Warrina Homes (wrap-up work still counts); last month: MP Web Project.
insert into public.pginvoice_cost_centres (client, folder, kind) values ('Warrina Homes', 'Warrina Extras', 'cost_centre');
insert into public.pginvoice_clickup_entries (entry_id, user_name, folder, minutes, month_key) values
  ('a1', 'Chloe Smith', 'Majestic Plumbing (WA)', 60, to_char(now() at time zone 'Australia/Adelaide', 'YYYY-MM')),
  ('a2', ' chloe smith', 'AWIWA', 30, to_char(now() at time zone 'Australia/Adelaide', 'YYYY-MM')),
  ('a3', 'Chloe Smith', 'Aus3C IRAP', 15, to_char(now() at time zone 'Australia/Adelaide', 'YYYY-MM')),
  ('a4', 'Chloe Smith', 'Warrina Extras', 45, to_char(now() at time zone 'Australia/Adelaide', 'YYYY-MM')),
  ('a6', 'Chloe Smith', 'Majestic Plumbing Quoted Web Project (WA)', 45, to_char((now() at time zone 'Australia/Adelaide') - interval '1 month', 'YYYY-MM')),
  ('a5', 'Someone Else', 'AWIWA', 99, to_char(now() at time zone 'Australia/Adelaide', 'YYYY-MM'));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', true);
do $$
declare a jsonb := pginvoice_my_access(); got text;
begin
  got := (select string_agg(x ->> 'client', ',' order by x ->> 'client') from jsonb_array_elements(a -> 'activityClients') x);
  if got is distinct from 'AWIWA,Warrina Homes' then raise exception 'activityClients: %', a -> 'activityClients'; end if;
  if (select x ->> 'type' from jsonb_array_elements(a -> 'activityClients') x where x ->> 'client' = 'AWIWA') <> 'quoted' then
    raise exception 'activityClients should carry type'; end if;
  if exists (select 1 from jsonb_array_elements(a -> 'activityClients') x where x ? 'agreed_hours' or x ? 'fixed_fee') then
    raise exception 'activityClients leaks figures'; end if;
  if not (a ? 'role' and a ? 'isAdminTier' and a ? 'personId' and a ? 'clickupUserName' and a ? 'modules' and a ? 'clients' and a ? 'clickupUserNames') then
    raise exception 'my_access lost a key: %', a; end if;
  if a -> 'clients' <> '["Aus3C", "Majestic Plumbing"]'::jsonb then raise exception 'clients: %', a -> 'clients'; end if;
  raise notice 'ok: activityClients = this month only, own clients left out, no figures, old keys kept';

  begin perform pginvoice_sync_consultant_clients(null); raise exception 'authenticated could call the sync';
  exception when insufficient_privilege then null; end;
  begin perform pginvoice_consultant_match_issues(); raise exception 'authenticated could read match issues';
  exception when insufficient_privilege then null; end;
  begin perform pg_my_activity_clients(); raise exception 'authenticated could call pg_my_activity_clients';
  exception when insufficient_privilege then null; end;
  raise notice 'ok: signed-in users cannot call the sync, the issues list or the activity helper';
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
begin
  if pginvoice_my_access() -> 'activityClients' <> '[]'::jsonb then raise exception 'admin activityClients should be []'; end if;
  raise notice 'ok: admin activityClients is []';
end $$;
reset role;


rollback;
