-- Shared scratch-database setup for the permission checks (scoped_modules_check.sql,
-- capacity_admin_only_check.sql): Supabase stubs, stub pginvoice_* tables with their live
-- policies, fixtures, and the 20261016 + 20261017 migrations (phase 2 applied twice).
-- Include it with \ir right after `begin;` -- it never commits. SCRATCH DATABASE ONLY.

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
