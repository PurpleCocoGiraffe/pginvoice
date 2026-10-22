-- Capacity data (pginvoice_app_state) is admin tier only -- owner decision 2026-10-22.
-- NOT yet applied to fzvlnzlecchsubkpsmew.
--
-- Before: every signed-in user could read AND write every key (cap_people with rates and
-- notes, cap_leaves, cap_clients, cap_overrides, clickup_known_user_ids...).
--
-- DEPLOY ORDER: (1) the frontend (it falls back to the old table reads while this isn't
-- applied), (2) this migration. Applied before the new frontend, a non-admin would get an
-- empty roster from RLS (Overview "My utilization" / Timesheets person / Wages photo blank,
-- scoped Invoicing types guessed without Capacity rows) -- no errors, no writes. Admins are
-- unaffected either way.
--
-- What non-admins still get, through SECURITY DEFINER functions instead of the table:
--   * pginvoice_my_roster(): their OWN cap_people record (no rate, no note) and their own
--     cap_leaves keys -- Overview, Timesheets (own) and Wages (own).
--   * pginvoice_client_directory() gains `capClients` (see below) -- scoped Invoicing.
-- The Edge Functions use the service role and are unaffected (clickup-sync's known user ids,
-- manage-users' roster-person check).

-- 1. Table policies: admin tier only, for every command.
drop policy if exists authenticated_read on public.pginvoice_app_state;
drop policy if exists authenticated_update on public.pginvoice_app_state;
drop policy if exists authenticated_write on public.pginvoice_app_state;
drop policy if exists app_state_admin_all on public.pginvoice_app_state;
create policy app_state_admin_all on public.pginvoice_app_state
  for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());

-- 2. The caller's own roster record and leave totals.
create or replace function public.pginvoice_my_roster()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_person text;
  v_people jsonb;
  v_leaves jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  select p.person_id into v_person from pginvoice_profiles p where p.user_id = auth.uid();
  if v_person is null then
    return jsonb_build_object('personId', null, 'people', '[]'::jsonb, 'leaves', '{}'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e -> 'id', 'name', e -> 'name', 'alias', e -> 'alias', 'role', e -> 'role', 'state', e -> 'state',
      'contracted', e -> 'contracted', 'photo', e -> 'photo', 'resignationDate', e -> 'resignationDate')), '[]'::jsonb)
    into v_people
    from pginvoice_app_state s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) e
   where s.key = 'cap_people' and jsonb_typeof(e) = 'object' and e ->> 'id' = v_person;
  -- cap_leaves keys are `${personId}_${YYYY-MM}`; match the whole id, not a prefix of it.
  select coalesce(jsonb_object_agg(kv.key, kv.value), '{}'::jsonb)
    into v_leaves
    from pginvoice_app_state s
    cross join lateral jsonb_each(case when jsonb_typeof(s.value) = 'object' then s.value else '{}'::jsonb end) kv
   where s.key = 'cap_leaves'
     and kv.key ~ '_[0-9]{4}-[0-9]{2}$'
     and left(kv.key, length(kv.key) - 8) = v_person;
  return jsonb_build_object('personId', v_person, 'people', v_people, 'leaves', v_leaves);
end;
$fn$;
revoke all on function public.pginvoice_my_roster() from public, anon;
grant execute on function public.pginvoice_my_roster() to authenticated;

-- 3. The client directory (20261017_scoped_modules.sql, unchanged apart from `capClients`).
create or replace function public.pginvoice_client_directory()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_admin boolean := pg_is_admin_tier();
  v_mine text[];
begin
  if auth.uid() is null or pg_module_scope('invoicing') = 'none' then
    raise exception 'The client directory needs Client Invoicing access' using errcode = '42501';
  end if;
  -- The caller's clients: their pginvoice_user_clients rows, read once into an array (the
  -- same rows pg_has_client_access checks for a non-admin, without calling it per row; the
  -- admin tier ignores the array and gets everything unredacted). Plus any client whose own
  -- ClickUp folder is a cost-centre / sub-project folder of one of them -- a separately
  -- registered sub-project follows its parent, as its card does.
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
    -- Capacity Planning's client rows, which the pipeline reads for each card's basis, group
    -- and offboarded state (buildCapIndexes). pginvoice_app_state is admin-only, so they come
    -- through here. Only those fields; non-admins get `agreed` as its rank within the group:
    -- dominantClientType only ever compares agreed hours inside one group, so the rank gives
    -- the same answer without exposing any client's capacity hours.
    'capClients', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.e -> 'id', 'client', r.e -> 'client', 'group', r.e -> 'group', 'basis', r.e -> 'basis',
          'agreed', case when v_admin then r.e -> 'agreed' else to_jsonb(r.agreed_rank) end,
          'status', r.e -> 'status', 'offboardedFrom', r.e -> 'offboardedFrom', 'offboardNote', r.e -> 'offboardNote'
        ) order by r.ord)
      from (
        select e, ord, dense_rank() over (partition by e ->> 'group'
            order by coalesce(case when jsonb_typeof(e -> 'agreed') = 'number' then (e ->> 'agreed')::numeric end, 0)) as agreed_rank
        from pginvoice_app_state s
        cross join lateral jsonb_array_elements(case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) with ordinality as x(e, ord)
        where s.key = 'cap_clients' and jsonb_typeof(e) = 'object'
      ) r
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
