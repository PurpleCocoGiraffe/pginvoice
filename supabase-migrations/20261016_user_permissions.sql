-- Per-user module permissions (plan phase 1, task 3). Safe to re-run: every statement is
-- IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR REPLACE / DROP ... IF EXISTS first.
-- NOT yet applied to project fzvlnzlecchsubkpsmew.
--
-- DEPLOY ORDER: (1) this migration, (2) the manage-users Edge Function, (3) the frontend.
-- Each step tolerates the previous one being missing: the frontend falls back to role-
-- derived access while pginvoice_my_access() is absent and hides the access editors while
-- manage-users doesn't return module scopes; manage-users `list` degrades without the new
-- column/tables. But only this order never offers an edit the next layer can't store.
--
-- Validated locally against stub auth/profiles tables by supabase-tests/user_permissions_check.sql.
--
-- Model: a non-admin's scope for a module is their per-user override, else their role's
-- preset, else 'none'. Admin tier (super_admin + admin) is always 'all' and ignores both,
-- so Lynda and Kelly can't be locked out. Scopes: none / own / assigned / all.
--
-- Phase 1 seeds only what today's code already does for consultant/coordinator: Overview,
-- Clients, Client Accruals and Reporting, each 'assigned' (= today's client-scoped view via
-- pginvoice_user_clients + RLS). Invoicing / Timesheets / Wages scopes for non-admins come
-- with their scoped views in a later migration, which also changes these presets.
--
-- Nav built from this is still cosmetic; RLS stays the real gate. Writes to the new tables
-- happen only through the manage-users Edge Function (service role); browsers only read.
--
-- Also closes a pre-existing hole: the live profiles_insert/update/delete_admin policies let
-- an admin JWT write pginvoice_profiles straight through PostgREST (e.g. set role =
-- 'super_admin', or person_id), bypassing manage-users' guards. See the last section.

-- ---------------------------------------------------------------------------
-- Link an account to its roster/wage person (cap_people[].id == pginvoice_wage_people.person_id).
-- One account per person.
-- ---------------------------------------------------------------------------
alter table public.pginvoice_profiles add column if not exists person_id text;
create unique index if not exists pginvoice_profiles_person_id_key
  on public.pginvoice_profiles (person_id) where person_id is not null;

-- ---------------------------------------------------------------------------
-- Modules a non-admin can be granted, and the scopes each supports. The Settings
-- module-access editor lists exactly these, so it grows when a later migration adds rows.
-- Not listed (capacity, team, bdm, settings, help): admin tier only for now.
-- ---------------------------------------------------------------------------
create table if not exists public.pginvoice_module_scopes (
  module_key text not null check (module_key ~ '^[a-z_]+$'),
  scope text not null check (scope in ('none', 'own', 'assigned', 'all')),
  primary key (module_key, scope)
);
insert into public.pginvoice_module_scopes (module_key, scope) values
  ('overview', 'none'), ('overview', 'assigned'),
  ('clients', 'none'), ('clients', 'assigned'),
  ('accruals', 'none'), ('accruals', 'assigned'),
  ('performance', 'none'), ('performance', 'assigned')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Role presets: the single source of defaults for non-admin roles (admin tier never reads
-- them). A module with no preset row is 'none' for that role.
-- ---------------------------------------------------------------------------
create table if not exists public.pginvoice_role_presets (
  role text not null check (role in ('consultant', 'coordinator')),
  module_key text not null,
  scope text not null,
  primary key (role, module_key),
  foreign key (module_key, scope) references public.pginvoice_module_scopes (module_key, scope)
);
-- Reproduces today's client-scoped nav exactly. DO NOTHING so a re-run never reverts a
-- later migration's preset change.
insert into public.pginvoice_role_presets (role, module_key, scope) values
  ('consultant', 'overview', 'assigned'), ('consultant', 'clients', 'assigned'),
  ('consultant', 'accruals', 'assigned'), ('consultant', 'performance', 'assigned'),
  ('coordinator', 'overview', 'assigned'), ('coordinator', 'clients', 'assigned'),
  ('coordinator', 'accruals', 'assigned'), ('coordinator', 'performance', 'assigned')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Per-user overrides. No row = inherit the role preset. Written only by manage-users
-- (set_access / create), which refuses admin-tier targets and self-edits.
-- ---------------------------------------------------------------------------
create table if not exists public.pginvoice_user_module_access (
  user_id uuid not null references public.pginvoice_profiles (user_id) on delete cascade,
  module_key text not null,
  scope text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (user_id, module_key),
  foreign key (module_key, scope) references public.pginvoice_module_scopes (module_key, scope)
);

-- RLS. Config tables: every signed-in user reads (the UI needs presets/scopes), nobody
-- writes from the browser. Overrides: your own rows, or every row for admin tier.
alter table public.pginvoice_module_scopes enable row level security;
alter table public.pginvoice_role_presets enable row level security;
alter table public.pginvoice_user_module_access enable row level security;
revoke all on public.pginvoice_module_scopes, public.pginvoice_role_presets, public.pginvoice_user_module_access from anon, authenticated;
grant select on public.pginvoice_module_scopes, public.pginvoice_role_presets, public.pginvoice_user_module_access to authenticated;
grant all on public.pginvoice_module_scopes, public.pginvoice_role_presets, public.pginvoice_user_module_access to service_role;

drop policy if exists authenticated_read on public.pginvoice_module_scopes;
create policy authenticated_read on public.pginvoice_module_scopes for select to authenticated using (true);
drop policy if exists authenticated_read on public.pginvoice_role_presets;
create policy authenticated_read on public.pginvoice_role_presets for select to authenticated using (true);
drop policy if exists select_own_or_admin on public.pginvoice_user_module_access;
create policy select_own_or_admin on public.pginvoice_user_module_access for select to authenticated
  using (user_id = auth.uid() or pg_is_admin_tier());

-- ---------------------------------------------------------------------------
-- Helpers. SECURITY DEFINER (like the live pg_* helpers) so RLS policies and the RPC can
-- read profiles/overrides/presets regardless of the caller's own row access; each only
-- ever answers about auth.uid().
-- ---------------------------------------------------------------------------

-- The caller's effective scope for one module: admin tier 'all'; else override ?? preset ?? 'none'.
create or replace function public.pg_module_scope(p_module text)
returns text
language sql stable security definer set search_path = public, pg_temp as $fn$
  select case
    when pg_is_admin_tier() then 'all'
    else coalesce(
      (select a.scope from pginvoice_user_module_access a
        where a.user_id = auth.uid() and a.module_key = p_module),
      (select r.scope from pginvoice_role_presets r
        join pginvoice_profiles p on p.role = r.role
        where p.user_id = auth.uid() and r.module_key = p_module),
      'none')
  end;
$fn$;

-- Everything the browser needs to build the nav, in one round trip:
--   { role, isAdminTier, personId, clickupUserName,
--     modules: { <grantable module_key>: scope },  -- admin tier: 'all' for every key
--     clients: [assigned client names] }            -- admin tier: [] (they see every client)
-- Returns null when the caller has no pginvoice_profiles row (no access).
create or replace function public.pginvoice_my_access()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $fn$
  select jsonb_build_object(
    'role', p.role,
    'isAdminTier', pg_is_admin_tier(),
    'personId', p.person_id,
    'clickupUserName', p.clickup_user_name,
    'modules', coalesce(
      (select jsonb_object_agg(m.module_key, pg_module_scope(m.module_key))
         from (select distinct module_key from pginvoice_module_scopes) m),
      '{}'::jsonb),
    'clients', case when pg_is_admin_tier() then '[]'::jsonb else coalesce(
      (select jsonb_agg(c.client order by c.client)
         from (select distinct client from pginvoice_user_clients where user_id = p.user_id) c),
      '[]'::jsonb) end
  )
  from pginvoice_profiles p
  where p.user_id = auth.uid();
$fn$;

revoke all on function public.pg_module_scope(text) from public, anon;
revoke all on function public.pginvoice_my_access() from public, anon;
grant execute on function public.pg_module_scope(text) to authenticated, service_role;
grant execute on function public.pginvoice_my_access() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- pginvoice_profiles writes: service role only, except one self-service column.
-- The only browser write is ForcePasswordChange -> clearMustChangePassword (src/usersSync.js),
-- which sets the caller's OWN must_change_password to false. So instead of the live admin
-- insert/update/delete policies: no browser insert/delete at all, and an update policy for
-- your own row whose trigger allows nothing but must_change_password true -> false.
-- (Under the old update policy only admins matched, so a consultant's clear silently updated
-- 0 rows and they were asked to change their password again on every sign-in.)
-- ---------------------------------------------------------------------------
drop policy if exists profiles_insert_admin on public.pginvoice_profiles;
drop policy if exists profiles_update_admin on public.pginvoice_profiles;
drop policy if exists profiles_delete_admin on public.pginvoice_profiles;
drop policy if exists profiles_update_own_password_flag on public.pginvoice_profiles;
create policy profiles_update_own_password_flag on public.pginvoice_profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- SECURITY INVOKER on purpose: current_user is then the PostgREST request role. Only the
-- browser roles are restricted; service_role (manage-users) and postgres are unaffected.
create or replace function public.pginvoice_profiles_browser_write_guard()
returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  if current_user in ('authenticated', 'anon') then
    if (to_jsonb(new) - 'must_change_password' - 'updated_at') is distinct from (to_jsonb(old) - 'must_change_password' - 'updated_at')
       or (new.must_change_password and not old.must_change_password) then
      raise exception 'pginvoice_profiles can only be changed through manage-users (you may only clear your own must_change_password)'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;
drop trigger if exists pginvoice_profiles_browser_write_guard on public.pginvoice_profiles;
create trigger pginvoice_profiles_browser_write_guard before update on public.pginvoice_profiles
  for each row execute function public.pginvoice_profiles_browser_write_guard();
