-- Local check for supabase-migrations/20261022_capacity_admin_only.sql.
--
-- SCRATCH DATABASE ONLY -- never run this against the live project. Builds the shared stub
-- schema (_permissions_setup.sql), adds pginvoice_app_state with its live (pre-migration)
-- policies and fixtures, applies the migration twice (idempotency), then checks:
--   - admin: still reads and writes every key; directory capClients carries real agreed hours;
--   - consultant c2 (linked to p3): reads/writes nothing in the table; pginvoice_my_roster()
--     returns only p3, without rate/note, and only p3's leave keys (not p30's);
--     directory capClients carries per-group ranks instead of agreed hours;
--   - consultant c1 (no linked person): empty roster, no error; anon can't call the RPC.
-- Run like scoped_modules_check.sql:
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/capacity_admin_only_check.sql
\set ON_ERROR_STOP 1
begin;
\ir _permissions_setup.sql

create table public.pginvoice_app_state (key text primary key, value jsonb, updated_at timestamptz default now());
grant select, insert, update, delete on public.pginvoice_app_state to anon, authenticated, service_role;
alter table public.pginvoice_app_state enable row level security;
-- Live policies before the migration (00000000_live_rls_record.sql).
create policy authenticated_read on public.pginvoice_app_state for select to authenticated using (true);
create policy authenticated_update on public.pginvoice_app_state for update to authenticated using (true) with check (true);
create policy authenticated_write on public.pginvoice_app_state for insert to authenticated with check (true);

insert into public.pginvoice_app_state (key, value) values
  ('cap_people', '[
     {"id":"p3","name":"Chloe","alias":"Chloe Smith","role":"Consultant","state":"SA","contracted":30,"rate":0.7,"note":"Probation","photo":"data:x","resignationDate":null},
     {"id":"p30","name":"Other","role":"Consultant","state":"WA","contracted":38,"rate":0.2,"note":"Support-heavy"},
     {"id":"p4","name":"Coord","role":"Coordinator","state":"SA","contracted":20,"rate":0.5,"note":"x"}]'),
  ('cap_leaves', '{"p3_2026-09":7.6,"p3_2026-10":15.2,"p30_2026-09":38,"p3x_2026-09":1,"p4_2026-09":3}'),
  ('cap_clients', '[
     {"id":"c1","client":"Majestic Plumbing (WA)","group":"Majestic Plumbing","basis":"Package","agreed":24.5,"status":"active","lead":"Holly","history":[{"from":"2026-01","agreed":12}],"note":"n"},
     {"id":"c2","client":"Majestic Plumbing Quoted Web Project (WA)","group":"Majestic Plumbing","basis":"Quoted Project","agreed":40,"status":"active"},
     {"id":"c3","client":"Australian Cyber Collaboration Centre","group":"Aus3C","basis":"Package","agreed":20,"status":"inactive","offboardedFrom":"2026-09","offboardNote":"done"},
     {"id":"c4","client":"Tiny","group":"Tiny","basis":"Hourly","agreed":null,"status":"active"}]');

\ir ../supabase-migrations/20261022_capacity_admin_only.sql
\ir ../supabase-migrations/20261022_capacity_admin_only.sql

update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c2';

do $$
begin
  if (select count(*) from pg_policies where tablename = 'pginvoice_app_state') <> 1 then
    raise exception 'app_state should have exactly the admin-tier policy, got %', (select string_agg(policyname, ',') from pg_policies where tablename = 'pginvoice_app_state');
  end if;
  if not exists (select 1 from pg_proc where proname = 'pginvoice_my_roster' and prosecdef and 'search_path=public, pg_temp' = any (proconfig)) then
    raise exception 'pginvoice_my_roster must be SECURITY DEFINER with search_path pinned';
  end if;
  if has_function_privilege('anon', 'public.pginvoice_my_roster()', 'execute') then raise exception 'anon can execute pginvoice_my_roster'; end if;
  raise notice 'ok: migration applied twice, one admin-tier policy, roster RPC locked down';
end $$;

set local role authenticated;

\echo '--- admin (a1) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
declare d jsonb := pginvoice_client_directory(); n int;
begin
  if (select count(*) from pginvoice_app_state) <> 3 then raise exception 'admin: should read every key'; end if;
  update pginvoice_app_state set value = value where key = 'cap_people';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'admin: update refused'; end if;
  insert into pginvoice_app_state (key, value) values ('cap_notes', '[]');
  if jsonb_array_length(d->'capClients') <> 4 then raise exception 'admin: directory capClients incomplete: %', d->'capClients'; end if;
  if (select (c->>'agreed')::numeric from jsonb_array_elements(d->'capClients') c where c->>'id' = 'c2') <> 40 then raise exception 'admin: agreed should be real hours'; end if;
  if exists (select 1 from jsonb_array_elements(d->'capClients') c where c ? 'lead' or c ? 'history' or c ? 'note') then
    raise exception 'directory capClients should carry only the pipeline fields';
  end if;
  raise notice 'ok: admin reads/writes app_state; directory capClients has real agreed hours and only pipeline fields';
end $$;

\echo '--- consultant c2 (linked to p3) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$
declare r jsonb := pginvoice_my_roster(); d jsonb := pginvoice_client_directory(); n int; p jsonb;
begin
  if (select count(*) from pginvoice_app_state) <> 0 then raise exception 'consultant: can still read app_state'; end if;
  update pginvoice_app_state set value = '[]' where key = 'cap_people';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'consultant: update went through'; end if;
  begin
    insert into pginvoice_app_state (key, value) values ('evil', '1');
    raise exception 'consultant: insert went through';
  exception when insufficient_privilege then null;
  end;
  if r->>'personId' <> 'p3' or jsonb_array_length(r->'people') <> 1 then raise exception 'consultant: roster should be just p3: %', r; end if;
  p := r->'people'->0;
  if p->>'name' <> 'Chloe' or (p->>'contracted')::numeric <> 30 or p->>'photo' <> 'data:x' then raise exception 'consultant: own record incomplete: %', p; end if;
  if p ? 'rate' or p ? 'note' then raise exception 'consultant: rate/note leaked: %', p; end if;
  if r->'leaves' <> '{"p3_2026-09":7.6,"p3_2026-10":15.2}'::jsonb then raise exception 'consultant: leaves should be only p3''s: %', r->'leaves'; end if;
  -- Ranks within each group, never the hours: Majestic 24.5 -> 1, 40 -> 2; Aus3C 20 -> 1; null -> 1.
  if (select jsonb_object_agg(c->>'id', c->'agreed') from jsonb_array_elements(d->'capClients') c) <> '{"c1":1,"c2":2,"c3":1,"c4":1}'::jsonb then
    raise exception 'consultant: capClients agreed should be per-group ranks: %', d->'capClients';
  end if;
  if (select c->>'offboardedFrom' from jsonb_array_elements(d->'capClients') c where c->>'id' = 'c3') <> '2026-09' then raise exception 'consultant: offboardedFrom missing'; end if;
  raise notice 'ok: consultant reads/writes nothing in app_state; roster = own record (no rate/note) + own leave; capClients ranked';
end $$;

\echo '--- consultant c1 (no linked person) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$
declare r jsonb := pginvoice_my_roster();
begin
  if r <> '{"personId":null,"people":[],"leaves":{}}'::jsonb then raise exception 'unlinked: expected an empty roster, got %', r; end if;
  raise notice 'ok: unlinked consultant gets an empty roster';
end $$;

\echo '--- anon ---'
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform pginvoice_my_roster();
    raise exception 'anon: roster RPC ran';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from pginvoice_app_state) <> 0 then raise exception 'anon: reads app_state'; end if;
  raise notice 'ok: anon gets nothing';
end $$;

reset role;
rollback;
