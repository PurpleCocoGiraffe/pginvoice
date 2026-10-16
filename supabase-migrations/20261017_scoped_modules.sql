-- Per-user permissions, phase 2: scoped Client Invoicing / Timesheets / Wages for non-admins.
-- Safe to re-run: IF EXISTS / ON CONFLICT / CREATE OR REPLACE throughout. NOT yet applied
-- to project fzvlnzlecchsubkpsmew.
--
-- DEPLOY ORDER: (1) this migration, (2) the manage-users Edge Function (its "own needs a
-- roster person" check now only applies to explicit overrides -- the new presets make
-- Timesheets/Wages 'own' by default, and the old function would refuse every create/edit of
-- an unlinked consultant), (3) the frontend.
-- The frontend tolerates this migration being missing: scoped modules show "not available
-- yet" when an RPC below is absent, and admins never call them. Requires
-- 20261016_user_permissions.sql (pg_module_scope, pginvoice_role_presets, profiles.person_id).
--
-- Validated locally against stub tables by supabase-tests/scoped_modules_check.sql.
--
-- What changes:
--   1. Grantable scopes: invoicing {none, assigned}, timesheet {none, own}, wages {none, own}.
--   2. Consultant + coordinator presets become Overview / Invoicing (assigned), Timesheets /
--      Wages (own); Clients / Accruals / Reporting off (still grantable). UPSERT -- unlike
--      phase 1's DO NOTHING, re-running this file resets these seven preset rows.
--   3. Write lockdown: pginvoice_accruals INSERT/UPDATE admin tier only. Today any user with
--      access to a client may write its accrual rows, and a consultant's browser auto-ran
--      recomputeAccruals. No comment-only RPC: Client Accruals is read-only for non-admins
--      (no non-admin has ever edited a comment -- there are no consultant accounts yet).
--   4. pginvoice_client_directory(): the matching inputs Client Invoicing needs so a scoped
--      user's reconciliation runs over the same inputs as an admin's (see the function).
--   5. pginvoice_my_wage_months() / pginvoice_my_wage_line(month): the caller's own line of
--      a CLOSED month's snapshot, reviewer comments stripped. Wage tables stay admin-only.
--   6. pginvoice_my_access() gains clickupUserNames (the caller's exact ClickUp spellings).
--
-- Rule this all serves: Client Invoicing computes over the FULL inputs, then filters which
-- cards to show (display-only scoping). Hiding inputs server-side changes fuzzy/prefix
-- folder matching and silently moves totals -- see CLAUDE.md.

-- ---------------------------------------------------------------------------
-- 1. Grantable scopes
-- ---------------------------------------------------------------------------
insert into public.pginvoice_module_scopes (module_key, scope) values
  ('invoicing', 'none'), ('invoicing', 'assigned'),
  ('timesheet', 'none'), ('timesheet', 'own'),
  ('wages', 'none'), ('wages', 'own')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Role presets (consultant and coordinator alike)
-- ---------------------------------------------------------------------------
insert into public.pginvoice_role_presets (role, module_key, scope)
select r.role, p.module_key, p.scope
from (values ('consultant'), ('coordinator')) as r (role)
cross join (values
  ('overview', 'assigned'), ('invoicing', 'assigned'), ('timesheet', 'own'), ('wages', 'own'),
  ('clients', 'none'), ('accruals', 'none'), ('performance', 'none')
) as p (module_key, scope)
on conflict (role, module_key) do update set scope = excluded.scope;

-- ---------------------------------------------------------------------------
-- 3. pginvoice_accruals writes: admin tier only (reads unchanged: pg_has_client_access).
-- Same policy names as the live ones, so 00000000_live_rls_record.sql stays comparable.
-- ---------------------------------------------------------------------------
drop policy if exists authenticated_update on public.pginvoice_accruals;
drop policy if exists authenticated_write on public.pginvoice_accruals;
create policy authenticated_update on public.pginvoice_accruals for update to authenticated
  using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy authenticated_write on public.pginvoice_accruals for insert to authenticated
  with check (pg_is_admin_tier());

-- ---------------------------------------------------------------------------
-- 4. pginvoice_client_directory()
--
-- Client Invoicing builds each card from: every registered client (name, ClickUp folder,
-- status, type history) as folder-matching candidates; every applied type/lifecycle event
-- (typeForMonth / statusForMonth / endPeriodsFor); every cost-centre row (multi-folder and
-- task-prefix roll-ups); and every accrual ledger row (accrued names are matching candidates
-- too, and seeding / type guesses depend on which months have a package). Under the live
-- RLS a scoped user reads only their own clients' rows of all four tables, so their
-- matching would silently differ from an admin's. This returns all of it, in the same order
-- the admin path reads it (clients by name, events by date + id, accruals by client + month).
--
-- For a client the caller can't access (pg_has_client_access, or a sub-project registered as
-- its own client under one they can) it withholds fees, event notes,
-- agreed hours and ledger balances: agreed hours come back as sign(hours) -- 1 / 0 / null --
-- which keeps every structural decision identical (seed a zero-hour package row? is this a
-- package? which group member is primary?) without the figure, and accrual_value /
-- reset_value come back null (with public ClickUp hours they would give the agreed hours
-- away). `assigned` says which rows are real; the UI withholds the package figures on any
-- card built from a non-assigned row (only reachable when fuzzy/prefix matching ties the
-- user's own hours to a client they aren't assigned).
--
-- Admin tier gets every row unredacted. Callers with neither Invoicing nor Overview get an
-- error, not an empty result.
-- ---------------------------------------------------------------------------
create or replace function public.pginvoice_client_directory()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_admin boolean := pg_is_admin_tier();
  v_mine text[];
begin
  if auth.uid() is null or (pg_module_scope('invoicing') = 'none' and pg_module_scope('overview') = 'none') then
    raise exception 'The client directory needs Client Invoicing or Overview access' using errcode = '42501';
  end if;
  -- The caller's clients (pg_has_client_access, evaluated once rather than per row), plus any
  -- client whose own ClickUp folder is a cost-centre / sub-project folder of one of them --
  -- a separately registered sub-project follows its parent, as its card does.
  select coalesce(array_agg(distinct uc.client), '{}') into v_mine
    from pginvoice_user_clients uc where uc.user_id = auth.uid();
  select coalesce(array_agg(distinct x), '{}') into v_mine from (
    select unnest(v_mine) as x
    union
    select c.client from pginvoice_clients c
      join pginvoice_cost_centres cc on lower(trim(cc.folder)) = lower(trim(c.clickup_folder))
     where cc.client = any (v_mine)
  ) t;

  return jsonb_build_object(
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
          'client', c.client,
          'clickup_folder', c.clickup_folder,
          'status', c.status,
          'type', c.type,
          'base_type', c.base_type,
          'start_date', c.start_date,
          'end_date', c.end_date,
          'logo_url', c.logo_url,
          'agreed_hours', case when ok then c.agreed_hours else sign(c.agreed_hours) end,
          'base_agreed_hours', case when ok then c.base_agreed_hours else sign(c.base_agreed_hours) end,
          'fixed_fee', case when ok then c.fixed_fee end,
          'assigned', ok
        ) order by c.client)
      from pginvoice_clients c
      cross join lateral (select v_admin or c.client = any (v_mine) as ok) a
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', e.id,
          'client', e.client,
          'kind', e.kind,
          'effective_date', e.effective_date,
          'applied', e.applied,
          'new_type', e.new_type,
          'new_agreed_hours', case when ok then e.new_agreed_hours else sign(e.new_agreed_hours) end,
          'note', case when ok then e.note end
        ) order by e.effective_date, e.id)
      from pginvoice_client_events e
      cross join lateral (select v_admin or e.client = any (v_mine) as ok) a
      -- Every reader filters to applied events; consultant events aren't needed.
      where e.applied and e.kind in ('type', 'offboarding', 'reactivation', 'hold', 'resume')
    ), '[]'::jsonb),
    'costCentres', coalesce((
      select jsonb_agg(jsonb_build_object(
          'client', cc.client, 'folder', cc.folder, 'kind', cc.kind,
          'source_folder', cc.source_folder, 'task_prefix', cc.task_prefix
        ) order by cc.client, cc.folder)
      from pginvoice_cost_centres cc
    ), '[]'::jsonb),
    'accruals', coalesce((
      select jsonb_agg(jsonb_build_object(
          'client', x.client,
          'month_key', x.month_key,
          'agreed_hpm', case when ok then x.agreed_hpm
                        else sign(substring(x.agreed_hpm::text from '-?\d+(?:\.\d+)?')::numeric)::text end,
          'accrual_value', case when ok then x.accrual_value end,
          'reset_value', case when ok then x.reset_value end
        ) order by x.client, x.month_key)
      from pginvoice_accruals x
      cross join lateral (select v_admin or x.client = any (v_mine) as ok) a
    ), '[]'::jsonb)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Wages: the caller's own line of a closed month.
--
-- Requires wages scope 'own' (admin tier is 'all' and uses the full module instead) and a
-- linked roster person (pginvoice_profiles.person_id). Only CLOSED months: their snapshot is
-- what Kelly signed off; a draft is still moving and returns no numbers at all. The snapshot
-- holds every person's line, so it is only ever sliced here, never exposed by a row policy.
-- ---------------------------------------------------------------------------
create or replace function public.pginvoice_my_wage_person()
returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_person text;
begin
  if auth.uid() is null or pg_module_scope('wages') <> 'own' then
    raise exception 'Wages (own) isn''t turned on for this account' using errcode = '42501';
  end if;
  select p.person_id into v_person from pginvoice_profiles p where p.user_id = auth.uid();
  if v_person is null then
    raise exception 'No roster person is linked to this account' using errcode = '42501';
  end if;
  return v_person;
end;
$fn$;

-- [{ monthKey, closedAt }], newest first: closed months whose snapshot has the caller's line.
create or replace function public.pginvoice_my_wage_months()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_person text := pginvoice_my_wage_person();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('monthKey', m.month_key, 'closedAt', m.closed_at) order by m.month_key desc)
    from pginvoice_wage_months m
    where m.status = 'closed'
      and jsonb_typeof(m.snapshot -> 'lines') = 'array'
      and exists (select 1 from jsonb_array_elements(m.snapshot -> 'lines') l where l ->> 'person_id' = v_person)
  ), '[]'::jsonb);
end;
$fn$;

-- { monthKey, status: 'closed' | 'draft' | 'none', ... }. Only a closed month carries numbers:
--   closedAt, computedAt, line (own line minus reviewer comments / sign-off flag / override
--   reason; null when the caller wasn't in that month), settings (hours per day + the two
--   tolerances -- never the Xero name map, PG folder or ignored-user lists), standardHours,
--   weekdays, holidaysByState.
create or replace function public.pginvoice_my_wage_line(p_month text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_person text := pginvoice_my_wage_person();
  v_month pginvoice_wage_months%rowtype;
  v_line jsonb;
begin
  select * into v_month from pginvoice_wage_months m where m.month_key = p_month;
  if not found then
    return jsonb_build_object('monthKey', p_month, 'status', 'none');
  end if;
  if v_month.status <> 'closed' or jsonb_typeof(v_month.snapshot -> 'lines') is distinct from 'array' then
    return jsonb_build_object('monthKey', p_month, 'status', 'draft');
  end if;
  select l into v_line from jsonb_array_elements(v_month.snapshot -> 'lines') l
    where l ->> 'person_id' = v_person limit 1;
  return jsonb_build_object(
    'monthKey', p_month,
    'status', 'closed',
    'closedAt', v_month.closed_at,
    'computedAt', v_month.snapshot -> 'computed_at',
    'line', v_line - array['pg_comment', 'kw_comment', 'ls_comment', 'phil_comment', 'kw2_comment',
                           'phil_leave_applied', 'expected_override_reason'],
    'settings', jsonb_build_object(
      'hours_per_day', v_month.snapshot -> 'settings' -> 'hours_per_day',
      'xero_tolerance_h', v_month.snapshot -> 'settings' -> 'xero_tolerance_h',
      'variance_threshold_h', v_month.snapshot -> 'settings' -> 'variance_threshold_h'),
    'standardHours', v_month.snapshot -> 'standardHours',
    'weekdays', v_month.snapshot -> 'weekdays',
    'holidaysByState', v_month.snapshot -> 'holidaysByState'
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. pginvoice_my_access(): + clickupUserNames -- every exact spelling in
-- pginvoice_clickup_entries.user_name matching (case-insensitively, trimmed) the profile's
-- clickup_user_name or one of the linked person's pginvoice_wage_people.clickup_user_names.
-- Timesheets (own) and Overview fetch with these. Admin tier: [] (they see everyone, and
-- this runs on every window focus).
-- ---------------------------------------------------------------------------
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
      '[]'::jsonb) end,
    'clickupUserNames', case when pg_is_admin_tier() then '[]'::jsonb else coalesce(
      (select jsonb_agg(n.user_name order by n.user_name)
         from (select distinct e.user_name from pginvoice_clickup_entries e
                where lower(trim(e.user_name)) in (
                  select lower(trim(k)) from (
                    select p.clickup_user_name as k
                    union all
                    select unnest(w.clickup_user_names) from pginvoice_wage_people w
                     where p.person_id is not null and w.person_id = p.person_id
                  ) keys where k is not null and trim(k) <> '')) n),
      '[]'::jsonb) end
  )
  from pginvoice_profiles p
  where p.user_id = auth.uid();
$fn$;

-- ---------------------------------------------------------------------------
-- Grants: signed-in users only.
-- ---------------------------------------------------------------------------
revoke all on function public.pginvoice_client_directory() from public, anon;
revoke all on function public.pginvoice_my_wage_person() from public, anon;
revoke all on function public.pginvoice_my_wage_months() from public, anon;
revoke all on function public.pginvoice_my_wage_line(text) from public, anon;
revoke all on function public.pginvoice_my_access() from public, anon;
grant execute on function public.pginvoice_client_directory() to authenticated, service_role;
grant execute on function public.pginvoice_my_wage_person() to authenticated, service_role;
grant execute on function public.pginvoice_my_wage_months() to authenticated, service_role;
grant execute on function public.pginvoice_my_wage_line(text) to authenticated, service_role;
grant execute on function public.pginvoice_my_access() to authenticated, service_role;
