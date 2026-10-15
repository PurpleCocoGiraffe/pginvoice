-- Local check for supabase-migrations/20261016_user_permissions.sql.
--
-- SCRATCH DATABASE ONLY -- never run this against the live project: it creates stub
-- auth.uid(), pginvoice_profiles / pginvoice_clients / pginvoice_user_clients tables and the
-- live pg_* helpers (copied from 00000000_live_rls_record.sql), applies the migration twice
-- (idempotency), then checks pginvoice_my_access() / pg_module_scope() / RLS for an admin,
-- a consultant with no overrides and a consultant with an override. Everything runs in one
-- transaction that is rolled back, so the scratch database is left empty again.
--
-- Run from the repo root against an empty Postgres 15+ database, e.g.
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/user_permissions_check.sql
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
create table public.pginvoice_clients (client text primary key);
create table public.pginvoice_user_clients (
  user_id uuid not null references public.pginvoice_profiles (user_id) on delete cascade,
  client text not null references public.pginvoice_clients (client) on update cascade on delete cascade,
  source text not null default 'manual',
  primary key (user_id, client, source)
);
grant select, insert, update, delete on public.pginvoice_profiles, public.pginvoice_clients, public.pginvoice_user_clients to anon, authenticated, service_role;

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

-- Live policies on the two tables the migration reads.
alter table public.pginvoice_profiles enable row level security;
alter table public.pginvoice_user_clients enable row level security;
create policy profiles_select_own_or_admin on public.pginvoice_profiles for select to authenticated
  using (user_id = auth.uid() or pg_is_admin_tier());
create policy user_clients_select_own_or_admin on public.pginvoice_user_clients for select to authenticated
  using (user_id = auth.uid() or pg_is_admin_tier());

-- ---- fixtures ---------------------------------------------------------------------------
-- a1 admin (Kelly), c1 consultant no overrides, c2 consultant with overrides, k1 coordinator.
insert into public.pginvoice_profiles (user_id, email, role, clickup_user_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'kelly@example.test', 'admin', null),
  ('00000000-0000-0000-0000-0000000000c1', 'holly@example.test', 'consultant', 'Holly Fraser'),
  ('00000000-0000-0000-0000-0000000000c2', 'chloe@example.test', 'consultant', 'Chloe Smith'),
  ('00000000-0000-0000-0000-0000000000d1', 'coord@example.test', 'coordinator', 'Coord One');
insert into public.pginvoice_clients values ('Aus3C'), ('Majestic Plumbing'), ('Warrina Homes');
insert into public.pginvoice_user_clients (user_id, client, source) values
  ('00000000-0000-0000-0000-0000000000c1', 'Majestic Plumbing', 'clickup'),
  ('00000000-0000-0000-0000-0000000000c1', 'Aus3C', 'manual'),
  ('00000000-0000-0000-0000-0000000000c1', 'Aus3C', 'clickup'),
  ('00000000-0000-0000-0000-0000000000c2', 'Warrina Homes', 'capacity_lead');

-- ---- apply the migration twice ----------------------------------------------------------
\ir ../supabase-migrations/20261016_user_permissions.sql
\ir ../supabase-migrations/20261016_user_permissions.sql

do $$
begin
  if (select count(*) from pginvoice_module_scopes) <> 8 then raise exception 'module_scopes: expected 8 rows after two runs'; end if;
  if (select count(*) from pginvoice_role_presets) <> 8 then raise exception 'role_presets: expected 8 rows after two runs'; end if;
  raise notice 'ok: migration applied twice, seeds not duplicated';
end $$;

-- What the manage-users set_access action writes (as service role): c2 loses Clients and
-- Reporting, and is linked to roster person p3.
update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c2';
insert into public.pginvoice_user_module_access (user_id, module_key, scope, updated_by) values
  ('00000000-0000-0000-0000-0000000000c2', 'clients', 'none', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c2', 'performance', 'none', '00000000-0000-0000-0000-0000000000a1');
-- An override on an admin is ignored (set_access refuses to write one; prove it wouldn't matter).
insert into public.pginvoice_user_module_access (user_id, module_key, scope) values
  ('00000000-0000-0000-0000-0000000000a1', 'overview', 'none');

do $$
begin
  begin
    insert into public.pginvoice_user_module_access (user_id, module_key, scope)
      values ('00000000-0000-0000-0000-0000000000c1', 'invoicing', 'assigned');
    raise exception 'FK should refuse a module/scope pair not in pginvoice_module_scopes';
  exception when foreign_key_violation then
    raise notice 'ok: unknown module/scope pair refused';
  end;
  begin
    update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c1';
    raise exception 'unique index should refuse linking one person to two accounts';
  exception when unique_violation then
    raise notice 'ok: person linked to two accounts refused';
  end;
end $$;

-- ---- my_access per caller ---------------------------------------------------------------
set local role authenticated;

\echo '--- admin (a1) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select jsonb_pretty(pginvoice_my_access()) as admin_access;
do $$
declare a jsonb := pginvoice_my_access();
begin
  if a->>'role' <> 'admin' or (a->>'isAdminTier')::boolean is not true then raise exception 'admin: role/isAdminTier wrong: %', a; end if;
  if a->'modules' <> '{"overview":"all","clients":"all","accruals":"all","performance":"all"}'::jsonb then raise exception 'admin: modules wrong: %', a->'modules'; end if;
  if pg_module_scope('wages') <> 'all' or pg_module_scope('capacity') <> 'all' then raise exception 'admin: non-grantable modules must be all'; end if;
  if (select count(*) from pginvoice_user_module_access) <> 3 then raise exception 'admin should read every override row'; end if;
  raise notice 'ok: admin is all everywhere, own override ignored, reads all overrides';
end $$;

\echo '--- consultant, no overrides (c1) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select jsonb_pretty(pginvoice_my_access()) as consultant_access;
do $$
declare a jsonb := pginvoice_my_access();
begin
  if (a->>'isAdminTier')::boolean is not false then raise exception 'c1: isAdminTier should be false'; end if;
  if a->'modules' <> '{"overview":"assigned","clients":"assigned","accruals":"assigned","performance":"assigned"}'::jsonb then raise exception 'c1: modules should equal today''s client-scoped nav: %', a->'modules'; end if;
  if a->'clients' <> '["Aus3C","Majestic Plumbing"]'::jsonb then raise exception 'c1: clients wrong (deduped, sorted): %', a->'clients'; end if;
  if a->>'clickupUserName' <> 'Holly Fraser' or a->'personId' <> 'null'::jsonb then raise exception 'c1: identity wrong: %', a; end if;
  if pg_module_scope('invoicing') <> 'none' or pg_module_scope('wages') <> 'none' then raise exception 'c1: ungranted modules must be none'; end if;
  if (select count(*) from pginvoice_user_module_access) <> 0 then raise exception 'c1 must not read other users'' overrides'; end if;
  raise notice 'ok: consultant without overrides gets today''s modules';
end $$;
-- No browser writes, even to your own row.
do $$
begin
  insert into pginvoice_user_module_access (user_id, module_key, scope) values ('00000000-0000-0000-0000-0000000000c1', 'overview', 'none');
  raise exception 'authenticated insert into user_module_access should be refused';
exception when insufficient_privilege then
  raise notice 'ok: authenticated cannot write overrides';
end $$;
do $$
begin
  insert into pginvoice_role_presets (role, module_key, scope) values ('consultant', 'overview', 'none');
  raise exception 'authenticated insert into role_presets should be refused';
exception when insufficient_privilege then
  raise notice 'ok: authenticated cannot write presets';
end $$;

\echo '--- consultant with overrides (c2) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select jsonb_pretty(pginvoice_my_access()) as overridden_access;
do $$
declare a jsonb := pginvoice_my_access();
begin
  if a->'modules' <> '{"overview":"assigned","clients":"none","accruals":"assigned","performance":"none"}'::jsonb then raise exception 'c2: modules wrong: %', a->'modules'; end if;
  if a->>'personId' <> 'p3' or a->'clients' <> '["Warrina Homes"]'::jsonb then raise exception 'c2: person/clients wrong: %', a; end if;
  if (select count(*) from pginvoice_user_module_access) <> 2 then raise exception 'c2 should read exactly its own 2 override rows'; end if;
  raise notice 'ok: per-user override beats the role preset; own rows readable';
end $$;

\echo '--- coordinator (d1) and a signed-in user with no profile ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
do $$
begin
  if pginvoice_my_access()->'modules' <> '{"overview":"assigned","clients":"assigned","accruals":"assigned","performance":"assigned"}'::jsonb then raise exception 'coordinator should equal consultant defaults'; end if;
  raise notice 'ok: coordinator = consultant defaults';
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000ff', true);
do $$
begin
  if pginvoice_my_access() is not null then raise exception 'no profile should return null'; end if;
  if pg_module_scope('overview') <> 'none' then raise exception 'no profile should be none'; end if;
  raise notice 'ok: no profile -> null access';
end $$;

reset role;
set local role anon;
do $$
begin
  perform pginvoice_my_access();
  raise exception 'anon should not execute pginvoice_my_access';
exception when insufficient_privilege then
  raise notice 'ok: anon cannot call pginvoice_my_access';
end $$;
reset role;

rollback;
