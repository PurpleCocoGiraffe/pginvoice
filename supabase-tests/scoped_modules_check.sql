-- Local check for supabase-migrations/20261017_scoped_modules.sql (on top of 20261016).
--
-- SCRATCH DATABASE ONLY -- never run this against the live project: it creates stub
-- auth.uid(), stub pginvoice_* tables with the live RLS policies that matter here (copied
-- from 00000000_live_rls_record.sql), applies both permission migrations, applies phase 2
-- twice (idempotency), then checks as an admin, consultants and a coordinator:
--   - presets / grantable scopes, admin still 'all' everywhere;
--   - a consultant can no longer write pginvoice_accruals (admin still can);
--   - pginvoice_client_directory(): refuses a caller with Invoicing off (Overview alone isn't
--     enough -- least privilege); for a
--     consultant returns every client / applied event / cost centre / ledger row, with
--     fees, notes, agreed hours and balances withheld for unassigned clients; admin gets
--     exactly the tables;
--   - pginvoice_my_wage_months() / _line(): closed months only, own person only, comments
--     and the Xero name map stripped; refuses no linked person, wages off, and admins;
--   - pginvoice_my_access().clickupUserNames (via pg_my_clickup_user_names + its index).
-- Everything runs in one transaction that is rolled back.
--
-- Run from the repo root against an empty Postgres 15+ database, e.g.
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/scoped_modules_check.sql
-- Any failed check raises an exception (ON_ERROR_STOP), so a clean run ends in ROLLBACK
-- with every "ok" notice printed.
\set ON_ERROR_STOP 1
begin;

-- ---- stubs for what Supabase provides --------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create table public.pginvoice_profiles (
  user_id uuid primary key,
  email text,
  role text not null check (role in ('super_admin', 'admin', 'consultant', 'coordinator')),
  must_change_password boolean not null default false,
  clickup_user_name text,
  updated_at timestamptz default now()
);
create table public.pginvoice_clients (
  client text primary key,
  type text, base_type text, agreed_hours numeric, base_agreed_hours numeric, fixed_fee numeric,
  consultant text, start_date date, end_date date, status text not null default 'active',
  clickup_folder text, website text, logo_url text
);
create table public.pginvoice_user_clients (
  user_id uuid not null references public.pginvoice_profiles (user_id) on delete cascade,
  client text not null references public.pginvoice_clients (client) on update cascade on delete cascade,
  source text not null default 'manual',
  primary key (user_id, client, source)
);
create table public.pginvoice_client_events (
  id bigserial primary key, client text not null, kind text not null, effective_date date not null,
  applied boolean not null default false, new_type text, new_agreed_hours numeric, new_consultant text, note text
);
create table public.pginvoice_cost_centres (
  id bigserial primary key, client text not null, folder text not null, kind text not null,
  source_folder text, task_prefix text
);
create table public.pginvoice_accruals (
  client text not null, month_key text not null, account_manager text, agreed_hpm text,
  accrual_value numeric, accrual_note text, pct_over_under numeric, comment text, worked_hours numeric,
  is_override boolean default false, hours_flagged boolean default false, flagged_from_hours numeric,
  reset_value numeric, reset_note text, reset_at timestamptz,
  primary key (client, month_key)
);
create table public.pginvoice_clickup_entries (entry_id text primary key, user_name text, folder text, minutes numeric, month_key text);
create table public.pginvoice_wage_people (person_id text primary key, include boolean not null default true, clickup_user_names text[] not null default '{}', xero_name text);
create table public.pginvoice_wage_months (
  month_key text primary key, status text not null default 'draft', snapshot jsonb,
  closed_at timestamptz, closed_by uuid, reopened_reason text
);
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
grant usage on all sequences in schema public to anon, authenticated, service_role;

-- Live helpers (verbatim from 00000000_live_rls_record.sql).
CREATE OR REPLACE FUNCTION public.pg_is_admin_tier()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce((select role from pginvoice_profiles where user_id = auth.uid()) in ('super_admin','admin'), false);
$function$;
CREATE OR REPLACE FUNCTION public.pg_has_client_access(target_client text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select
    coalesce((select role from pginvoice_profiles where user_id = auth.uid()) in ('super_admin','admin'), false)
    or exists (select 1 from pginvoice_user_clients where user_id = auth.uid() and client = target_client);
$function$;

-- Live policies on the tables involved.
alter table public.pginvoice_profiles enable row level security;
alter table public.pginvoice_user_clients enable row level security;
alter table public.pginvoice_clients enable row level security;
alter table public.pginvoice_client_events enable row level security;
alter table public.pginvoice_cost_centres enable row level security;
alter table public.pginvoice_accruals enable row level security;
alter table public.pginvoice_clickup_entries enable row level security;
alter table public.pginvoice_wage_people enable row level security;
alter table public.pginvoice_wage_months enable row level security;
create policy profiles_select_own_or_admin on public.pginvoice_profiles for select to authenticated using (user_id = auth.uid() or pg_is_admin_tier());
create policy user_clients_select_own_or_admin on public.pginvoice_user_clients for select to authenticated using (user_id = auth.uid() or pg_is_admin_tier());
create policy authenticated_read on public.pginvoice_clients for select to authenticated using (pg_has_client_access(client));
create policy authenticated_read on public.pginvoice_client_events for select to authenticated using (pg_has_client_access(client));
create policy authenticated_read on public.pginvoice_cost_centres for select to authenticated using (pg_has_client_access(client));
create policy authenticated_read on public.pginvoice_accruals for select to authenticated using (pg_has_client_access(client));
create policy authenticated_update on public.pginvoice_accruals for update to authenticated using (pg_has_client_access(client)) with check (pg_has_client_access(client));
create policy authenticated_write on public.pginvoice_accruals for insert to authenticated with check (pg_has_client_access(client));
create policy authenticated_read on public.pginvoice_clickup_entries for select to authenticated using (true);
create policy admin_tier_all on public.pginvoice_wage_people for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_months for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());

-- ---- fixtures ---------------------------------------------------------------------------
-- a1 admin (Kelly); c1 consultant, no person; c2 consultant linked to p3; c3 consultant with
-- Invoicing + Wages off (Overview left on its "assigned" preset); k1 coordinator linked to p4.
insert into public.pginvoice_profiles (user_id, email, role, clickup_user_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'kelly@example.test', 'admin', null),
  ('00000000-0000-0000-0000-0000000000c1', 'holly@example.test', 'consultant', 'Holly Fraser'),
  ('00000000-0000-0000-0000-0000000000c2', 'chloe@example.test', 'consultant', 'Chloe Smith'),
  ('00000000-0000-0000-0000-0000000000c3', 'off@example.test', 'consultant', 'Off User'),
  ('00000000-0000-0000-0000-0000000000d1', 'coord@example.test', 'coordinator', 'Coord One');
insert into public.pginvoice_clients (client, type, base_type, agreed_hours, base_agreed_hours, fixed_fee, status, clickup_folder, start_date) values
  ('Aus3C', 'package', 'package', 20, 20, null, 'active', 'Australian Cyber Collaboration Centre', '2025-01-01'),
  ('Majestic Plumbing', 'package', 'package', 24.5, 12, null, 'active', 'Majestic Plumbing (WA)', null),
  ('AWIWA', 'quoted', 'quoted', null, 57, 10000, 'active', 'AWIWA', null),
  ('Warrina Homes', 'package', 'package', 0, 0, null, 'offboarded', 'Warrina Homes', null),
  ('MP Web Project', 'quoted', 'quoted', 40, 40, 5000, 'active', 'Majestic Plumbing Quoted Web Project (WA)', null);
insert into public.pginvoice_user_clients (user_id, client, source) values
  ('00000000-0000-0000-0000-0000000000c1', 'Majestic Plumbing', 'clickup'),
  ('00000000-0000-0000-0000-0000000000c2', 'Aus3C', 'clickup'),
  ('00000000-0000-0000-0000-0000000000c2', 'Aus3C', 'manual'),
  ('00000000-0000-0000-0000-0000000000d1', 'Warrina Homes', 'capacity_lead');
insert into public.pginvoice_client_events (client, kind, effective_date, applied, new_type, new_agreed_hours, new_consultant, note) values
  ('Majestic Plumbing', 'type', '2026-03-01', true, 'package', 24.5, null, 'Hours increased'),
  ('AWIWA', 'type', '2026-08-01', true, 'quoted', null, null, 'Fixed fee project'),
  ('Warrina Homes', 'offboarding', '2026-08-15', true, null, null, null, 'Contract ended'),
  ('Aus3C', 'consultant', '2026-02-01', true, null, null, 'Chloe', null),
  ('Aus3C', 'type', '2027-01-01', false, 'hourly', null, null, 'future, not applied');
insert into public.pginvoice_cost_centres (client, folder, kind, source_folder, task_prefix) values
  ('Majestic Plumbing', 'MP - Commercial Leak Tech (WA)', 'cost_centre', null, null),
  ('Majestic Plumbing', 'Majestic Plumbing Quoted Web Project (WA)', 'sub_project', null, null),
  ('Aus3C', 'Aus3C IRAP', 'task_prefix', 'Australian Cyber Collaboration Centre', 'IRAP');
insert into public.pginvoice_accruals (client, month_key, agreed_hpm, accrual_value, reset_value, comment) values
  ('Majestic Plumbing', '2026-07', '24.5', -3.25, null, 'MP note'),
  ('Majestic Plumbing', '2026-08', '24.5 (Aug)', -1.5, -2, null),
  ('Aus3C', '2026-08', '20', 4.75, null, 'Aus3C note'),
  ('Warrina Homes', '2026-08', '0', -13.41, -13.41, null),
  ('Warrina Homes', '2026-09', null, -13.41, null, null);
insert into public.pginvoice_clickup_entries (entry_id, user_name, folder, minutes, month_key) values
  ('e1', 'Holly Fraser', 'Majestic Plumbing (WA)', 60, '2026-09'),
  ('e2', 'holly fraser ', 'Majestic Plumbing (WA)', 30, '2026-09'),
  ('e3', 'Chloe Smith', 'Australian Cyber Collaboration Centre', 90, '2026-09'),
  ('e4', 'C. Smith', 'Aus3C IRAP', 15, '2026-09'),
  ('e5', 'Kelly W', 'AWIWA', 45, '2026-09');
insert into public.pginvoice_wage_people (person_id, clickup_user_names, xero_name) values
  ('p3', '{"c. smith"}', 'Chloe Smith'),
  ('p4', '{}', 'Coord One');
insert into public.pginvoice_wage_months (month_key, status, snapshot, closed_at) values
  ('2026-07', 'closed', jsonb_build_object(
     'version', 1, 'computed_at', '2026-08-03T00:00:00Z',
     'settings', jsonb_build_object('hours_per_day', 7.6, 'xero_tolerance_h', 0.25, 'variance_threshold_h', 3.8,
                                    'pg_folders', jsonb_build_array('Purple Giraffe'), 'ignored_clickup_users', jsonb_build_array('Purple Giraffe'),
                                    'xero_name_map', jsonb_build_object('Chloe S', 'p3')),
     'standardHours', 174.8, 'weekdays', 23, 'holidaysByState', jsonb_build_object('SA', '[]'::jsonb),
     'lines', jsonb_build_array(
       jsonb_build_object('person_id', 'p3', 'name', 'Chloe Smith', 'H', 150.5, 'L', 152, 'S', 152, 'T', 0.5, 'status', 'ok',
                          'kw_comment', 'Looks fine', 'pg_comment', 'PG note', 'ls_comment', null, 'phil_comment', 'ok', 'kw2_comment', null,
                          'phil_leave_applied', true, 'expected_override_reason', 'reviewer reason', 'xero_source', 'paste'),
       jsonb_build_object('person_id', 'p4', 'name', 'Coord One', 'H', 80, 'L', 76, 'kw_comment', 'Check leave'))),
   '2026-08-03'),
  ('2026-08', 'closed', jsonb_build_object('computed_at', '2026-09-02T00:00:00Z', 'settings', '{}'::jsonb,
     'lines', jsonb_build_array(jsonb_build_object('person_id', 'p4', 'name', 'Coord One', 'H', 70))), '2026-09-02'),
  ('2026-09', 'draft', null, null);

-- ---- apply phase 1, then phase 2 twice --------------------------------------------------
\ir ../supabase-migrations/20261016_user_permissions.sql
\ir ../supabase-migrations/20261017_scoped_modules.sql
\ir ../supabase-migrations/20261017_scoped_modules.sql

do $$
begin
  if (select count(*) from pginvoice_module_scopes) <> 14 then raise exception 'module_scopes: expected 14 rows, got %', (select count(*) from pginvoice_module_scopes); end if;
  if (select count(*) from pginvoice_role_presets) <> 14 then raise exception 'role_presets: expected 14 rows, got %', (select count(*) from pginvoice_role_presets); end if;
  if (select count(*) from pg_proc where proname in ('pginvoice_client_directory', 'pginvoice_my_wage_person', 'pginvoice_my_wage_months', 'pginvoice_my_wage_line', 'pginvoice_my_access', 'pg_my_clickup_user_names')
             and 'search_path=public, pg_temp' = any (proconfig)) <> 6 then
    raise exception 'new functions must set search_path = public, pg_temp';
  end if;
  if exists (select 1 from pg_proc where proname in ('pginvoice_client_directory', 'pginvoice_my_wage_months', 'pginvoice_my_wage_line', 'pg_my_clickup_user_names') and not prosecdef) then
    raise exception 'new RPCs must be SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'pginvoice_clickup_entries_user_name_norm_idx') then
    raise exception 'missing the normalised user_name index on pginvoice_clickup_entries';
  end if;
  raise notice 'ok: migrations applied (phase 2 twice), 14 scopes, 14 presets, search_path pinned, security definer, user_name index';
end $$;

-- Overrides as manage-users set_access would write them (service role).
update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c2';
update public.pginvoice_profiles set person_id = 'p4' where user_id = '00000000-0000-0000-0000-0000000000d1';
insert into public.pginvoice_user_module_access (user_id, module_key, scope) values
  ('00000000-0000-0000-0000-0000000000c3', 'invoicing', 'none'),
  ('00000000-0000-0000-0000-0000000000c3', 'wages', 'none');

set local role authenticated;

-- ---- admin: unchanged ---------------------------------------------------------------------
\echo '--- admin (a1) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
declare a jsonb := pginvoice_my_access(); d jsonb := pginvoice_client_directory(); n int;
begin
  if a->'modules' <> '{"overview":"all","invoicing":"all","clients":"all","accruals":"all","performance":"all","timesheet":"all","wages":"all"}'::jsonb then
    raise exception 'admin: modules should be all everywhere: %', a->'modules';
  end if;
  if a->'clickupUserNames' <> '[]'::jsonb or a->'clients' <> '[]'::jsonb then raise exception 'admin: clients/clickupUserNames should be []'; end if;
  -- The directory is exactly the tables for an admin.
  if jsonb_array_length(d->'clients') <> (select count(*) from pginvoice_clients) then raise exception 'admin: directory clients incomplete'; end if;
  if exists (select 1 from jsonb_array_elements(d->'clients') c where (c->>'assigned')::boolean is not true) then raise exception 'admin: every client should be assigned'; end if;
  if (select (c->>'fixed_fee')::numeric from jsonb_array_elements(d->'clients') c where c->>'client' = 'AWIWA') <> 10000 then raise exception 'admin: fee missing'; end if;
  if (select (c->>'agreed_hours')::numeric from jsonb_array_elements(d->'clients') c where c->>'client' = 'Majestic Plumbing') <> 24.5 then raise exception 'admin: agreed hours redacted'; end if;
  if jsonb_array_length(d->'events') <> 3 then raise exception 'admin: expected the 3 applied type/lifecycle events, got %', jsonb_array_length(d->'events'); end if;
  if jsonb_array_length(d->'costCentres') <> 3 or jsonb_array_length(d->'accruals') <> 5 then raise exception 'admin: cost centres / accruals incomplete'; end if;
  if (select (x->>'accrual_value')::numeric from jsonb_array_elements(d->'accruals') x where x->>'client' = 'Aus3C') <> 4.75 then raise exception 'admin: accrual value redacted'; end if;
  -- Admin still writes accruals (the Client Accruals recompute).
  insert into pginvoice_accruals (client, month_key, agreed_hpm, accrual_value) values ('Aus3C', '2026-09', '20', 1);
  update pginvoice_accruals set accrual_value = 2 where client = 'Aus3C' and month_key = '2026-09';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'admin: accrual update refused'; end if;
  select count(*) into n from pginvoice_accruals;
  if n <> 6 then raise exception 'admin: should read every accrual row'; end if;
  raise notice 'ok: admin is all everywhere, directory = the full tables unredacted, admin still writes accruals';
end $$;
do $$
begin
  perform pginvoice_my_wage_months();
  raise exception 'admin should not use the own-wages RPC';
exception when insufficient_privilege then
  raise notice 'ok: admin is refused by the own-wages RPCs (uses the full module)';
end $$;

-- ---- consultant c1: Majestic Plumbing only, no roster person ------------------------------
\echo '--- consultant c1 ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select jsonb_pretty(pginvoice_my_access()) as consultant_access;
do $$
declare a jsonb := pginvoice_my_access();
begin
  if a->'modules' <> '{"overview":"assigned","invoicing":"assigned","clients":"none","accruals":"none","performance":"none","timesheet":"own","wages":"own"}'::jsonb then
    raise exception 'c1: modules should be the new preset: %', a->'modules';
  end if;
  if a->'clickupUserNames' <> '["Holly Fraser", "holly fraser "]'::jsonb then raise exception 'c1: clickupUserNames wrong: %', a->'clickupUserNames'; end if;
  raise notice 'ok: consultant preset = Overview/Invoicing assigned, Timesheets/Wages own, rest off; exact ClickUp spellings';
end $$;
do $$
declare n int;
begin
  -- Today's live policy allowed this (assigned client); now refused.
  begin
    insert into pginvoice_accruals (client, month_key, accrual_value) values ('Majestic Plumbing', '2026-09', 99);
    raise exception 'c1 inserted an accrual row';
  exception when insufficient_privilege then null;
  end;
  update pginvoice_accruals set comment = 'edited by consultant', accrual_value = 99 where client = 'Majestic Plumbing';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'c1 updated % accrual rows', n; end if;
  -- Still reads its own client's rows.
  select count(*) into n from pginvoice_accruals;
  if n <> 2 then raise exception 'c1 should read Majestic Plumbing''s 2 accrual rows, got %', n; end if;
  raise notice 'ok: consultant cannot insert or update accruals (reads unchanged)';
end $$;
do $$
declare d jsonb := pginvoice_client_directory(); c jsonb; n int;
begin
  -- Direct reads are RLS-scoped; the directory is complete.
  select count(*) into n from pginvoice_cost_centres;
  if n <> 2 then raise exception 'c1: direct cost-centre read should be scoped to 2 rows, got %', n; end if;
  if jsonb_array_length(d->'costCentres') <> 3 then raise exception 'c1: directory must return every cost centre'; end if;
  if jsonb_array_length(d->'clients') <> 5 or jsonb_array_length(d->'accruals') <> 6 or jsonb_array_length(d->'events') <> 3 then
    raise exception 'c1: directory incomplete: %', d;
  end if;
  if (select string_agg(x->>'client', ',' order by ord) from jsonb_array_elements(d->'clients') with ordinality t(x, ord)) <> (select string_agg(v, ',' order by v) from unnest(array['AWIWA', 'Aus3C', 'Majestic Plumbing', 'MP Web Project', 'Warrina Homes']) v) then
    raise exception 'c1: clients must come back ordered by name (database collation, as the admin path''s .order("client"))';
  end if;
  -- Assigned: real figures.
  select x into c from jsonb_array_elements(d->'clients') x where x->>'client' = 'Majestic Plumbing';
  if (c->>'assigned')::boolean is not true or (c->>'agreed_hours')::numeric <> 24.5 or (c->>'base_agreed_hours')::numeric <> 12 then raise exception 'c1: assigned client redacted: %', c; end if;
  if (select x->>'note' from jsonb_array_elements(d->'events') x where x->>'client' = 'Majestic Plumbing') <> 'Hours increased' then raise exception 'c1: own event note missing'; end if;
  if (select (x->>'reset_value')::numeric from jsonb_array_elements(d->'accruals') x where x->>'client' = 'Majestic Plumbing' and x->>'month_key' = '2026-08') <> -2 then raise exception 'c1: own reset missing'; end if;
  -- A sub-project registered as its own client follows its assigned parent (cost-centre row).
  select x into c from jsonb_array_elements(d->'clients') x where x->>'client' = 'MP Web Project';
  if (c->>'assigned')::boolean is not true or (c->>'fixed_fee')::numeric <> 5000 or (c->>'agreed_hours')::numeric <> 40 then raise exception 'c1: sub-project of an assigned client should be unredacted: %', c; end if;
  -- Unassigned: names/folders/status/type kept; fee, note, agreed hours, balances withheld.
  select x into c from jsonb_array_elements(d->'clients') x where x->>'client' = 'AWIWA';
  if (c->>'assigned')::boolean or c->>'fixed_fee' is not null or c->>'clickup_folder' <> 'AWIWA' or c->>'type' <> 'quoted' then raise exception 'c1: AWIWA wrong: %', c; end if;
  if (c->'agreed_hours') <> 'null'::jsonb or (c->>'base_agreed_hours')::numeric <> 1 then raise exception 'c1: AWIWA agreed hours should be sign-only: %', c; end if;
  select x into c from jsonb_array_elements(d->'clients') x where x->>'client' = 'Warrina Homes';
  if (c->>'agreed_hours')::numeric <> 0 or c->>'status' <> 'offboarded' then raise exception 'c1: Warrina: 0 stays 0, status kept: %', c; end if;
  select x into c from jsonb_array_elements(d->'clients') x where x->>'client' = 'Aus3C';
  if (c->>'agreed_hours')::numeric <> 1 then raise exception 'c1: Aus3C agreed hours should be sign-only'; end if;
  if exists (select 1 from jsonb_array_elements(d->'events') x where x->>'client' <> 'Majestic Plumbing' and x->>'note' is not null) then raise exception 'c1: unassigned event notes leaked'; end if;
  if exists (select 1 from jsonb_array_elements(d->'events') x where (x->>'applied')::boolean is not true or x->>'kind' = 'consultant') then raise exception 'c1: only applied type/lifecycle events'; end if;
  -- (6 = the 5 fixtures + the row the admin block inserted.)
  select x into c from jsonb_array_elements(d->'accruals') x where x->>'client' = 'Aus3C' and x->>'month_key' = '2026-08';
  if c->>'agreed_hpm' <> '1' or c->>'accrual_value' is not null or c->>'reset_value' is not null then raise exception 'c1: Aus3C ledger row should be redacted: %', c; end if;
  select x into c from jsonb_array_elements(d->'accruals') x where x->>'client' = 'Warrina Homes' and x->>'month_key' = '2026-08';
  if c->>'agreed_hpm' <> '0' or c->>'accrual_value' is not null then raise exception 'c1: Warrina Aug ledger row wrong: %', c; end if;
  select x into c from jsonb_array_elements(d->'accruals') x where x->>'client' = 'Warrina Homes' and x->>'month_key' = '2026-09';
  if c->'agreed_hpm' <> 'null'::jsonb then raise exception 'c1: a null agreed_hpm must stay null (no package that month): %', c; end if;
  if d::text ~ 'note"?: ?"(MP note|Aus3C note)' or d::text like '%comment%' then raise exception 'c1: ledger comments must not be in the directory'; end if;
  raise notice 'ok: directory complete for a consultant; unassigned fees/notes/agreed hours/balances withheld, sign kept';
end $$;
do $$
begin
  perform pginvoice_my_wage_months();
  raise exception 'c1 (no linked person) got wage months';
exception when insufficient_privilege then
  raise notice 'ok: own-wages RPC refuses a user with no linked person';
end $$;

-- ---- consultant c2: linked to p3 ----------------------------------------------------------
\echo '--- consultant c2 (person p3) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select jsonb_pretty(pginvoice_my_wage_line('2026-07')) as own_wage_line;
do $$
declare m jsonb := pginvoice_my_wage_months(); l jsonb; n int;
begin
  -- 2026-07 has p3's line; 2026-08 is closed without p3; 2026-09 is a draft.
  if jsonb_array_length(m) <> 1 or m->0->>'monthKey' <> '2026-07' or m->0->>'closedAt' is null then
    raise exception 'c2: only closed months with an own line: %', m;
  end if;
  l := pginvoice_my_wage_line('2026-07');
  if l->>'status' <> 'closed' or l->'line'->>'person_id' <> 'p3' or (l->'line'->>'H')::numeric <> 150.5 then raise exception 'c2: own line wrong: %', l; end if;
  if l->'line' ?| array['pg_comment', 'kw_comment', 'ls_comment', 'phil_comment', 'kw2_comment', 'phil_leave_applied', 'expected_override_reason'] then
    raise exception 'c2: reviewer comments not stripped: %', l->'line';
  end if;
  if l::text like '%p4%' or l::text like '%Coord One%' or l::text like '%Check leave%' then raise exception 'c2: another person''s line leaked'; end if;
  if l::text like '%xero_name_map%' or l::text like '%"Chloe S"%' or l->'settings' ? 'pg_folders' then raise exception 'c2: unsafe settings leaked: %', l->'settings'; end if;
  if (l->'settings'->>'hours_per_day')::numeric <> 7.6 or (l->>'standardHours')::numeric <> 174.8 then raise exception 'c2: safe settings / standard hours missing'; end if;
  l := pginvoice_my_wage_line('2026-09');
  if l <> '{"monthKey": "2026-09", "status": "draft"}'::jsonb then raise exception 'c2: a draft month must carry no numbers: %', l; end if;
  l := pginvoice_my_wage_line('2026-08');
  if l->>'status' <> 'closed' or l->'line' <> 'null'::jsonb then raise exception 'c2: closed month without own line should have line null: %', l; end if;
  l := pginvoice_my_wage_line('2025-01');
  if l <> '{"monthKey": "2025-01", "status": "none"}'::jsonb then raise exception 'c2: unknown month: %', l; end if;
  -- The wage tables themselves stay admin-only.
  select count(*) into n from pginvoice_wage_months;
  if n <> 0 then raise exception 'c2 reads wage_months directly'; end if;
  raise notice 'ok: own wage line only, closed months only, comments and Xero map stripped, draft = no numbers';
end $$;
do $$
declare a jsonb := pginvoice_my_access();
begin
  -- Profile name plus the wage person's names, exact stored spellings.
  if a->'clickupUserNames' <> '["C. Smith", "Chloe Smith"]'::jsonb then raise exception 'c2: clickupUserNames wrong: %', a->'clickupUserNames'; end if;
  if (select count(*) from jsonb_array_elements(pginvoice_client_directory()->'clients') x where (x->>'assigned')::boolean) <> 1 then raise exception 'c2: only Aus3C assigned'; end if;
  raise notice 'ok: clickupUserNames includes the wage person''s ClickUp names';
end $$;

-- ---- coordinator: same defaults; sees own line in a month c2 isn't in ----------------------
\echo '--- coordinator (d1, person p4) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
do $$
declare m jsonb := pginvoice_my_wage_months();
begin
  if pginvoice_my_access()->'modules' <> '{"overview":"assigned","invoicing":"assigned","clients":"none","accruals":"none","performance":"none","timesheet":"own","wages":"own"}'::jsonb then
    raise exception 'coordinator should equal consultant defaults';
  end if;
  if jsonb_array_length(m) <> 2 or m->0->>'monthKey' <> '2026-08' then raise exception 'd1: months wrong (newest first): %', m; end if;
  if pginvoice_my_wage_line('2026-07')->'line'->>'person_id' <> 'p4' then raise exception 'd1: wrong line'; end if;
  raise notice 'ok: coordinator = consultant defaults, gets its own line';
end $$;

-- ---- c3: Invoicing and Wages turned off, Overview still on -------------------------------
\echo '--- consultant with modules off (c3) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  begin
    perform pginvoice_client_directory();
    raise exception 'c3 (invoicing none, overview assigned) got the directory';
  exception when insufficient_privilege then null;
  end;
  begin
    perform pginvoice_my_wage_line('2026-07');
    raise exception 'c3 (wages none) got a wage line';
  exception when insufficient_privilege then null;
  end;
  if pginvoice_my_access()->'modules'->>'overview' <> 'assigned' then raise exception 'c3: overview should still be on'; end if;
  raise notice 'ok: directory refuses a caller with Invoicing off even with Overview on; wages refuses wages off';
end $$;

reset role;
set local role anon;
do $$
begin
  begin perform pginvoice_client_directory(); raise exception 'anon ran the directory'; exception when insufficient_privilege then null; end;
  begin perform pginvoice_my_wage_months(); raise exception 'anon ran my_wage_months'; exception when insufficient_privilege then null; end;
  begin perform pginvoice_my_wage_line('2026-07'); raise exception 'anon ran my_wage_line'; exception when insufficient_privilege then null; end;
  begin perform pg_my_clickup_user_names(); raise exception 'anon ran pg_my_clickup_user_names'; exception when insufficient_privilege then null; end;
  raise notice 'ok: anon cannot execute the new RPCs';
end $$;
reset role;

rollback;
