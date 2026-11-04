-- Carry hold: a package -> hourly move that settles the package balance in a LATER month
-- instead of on the first hourly invoice (settleHourly / carryHoldFor in src/format.js).
-- First use: gpex, Oct 2026 closed 54.79 h over its 70 h package; Hourly from 2026-11-01
-- with carry_settle_month '2026-12' (Nov bills its own hours and holds the 54.79 h, Dec
-- invoices 54.79 h + every Dec hour), back on the 70 h package from 2027-01-01 at 0.
--
-- Additive: a nullable column on the type event, and pginvoice_client_directory() passes it
-- through (withheld for an unassigned client, like the note) so a scoped Client Invoicing
-- view shows the same held card an admin sees. Applied 2026-11-04.

alter table public.pginvoice_client_events
  add column if not exists carry_settle_month text;

alter table public.pginvoice_client_events
  drop constraint if exists pginvoice_client_events_carry_settle_chk;
alter table public.pginvoice_client_events
  add constraint pginvoice_client_events_carry_settle_chk check (
    carry_settle_month is null
    or (kind = 'type'
        and new_type = 'hourly'
        and carry_settle_month ~ '^\d{4}-(0[1-9]|1[0-2])$'
        and carry_settle_month >= to_char(effective_date, 'YYYY-MM'))
  );

CREATE OR REPLACE FUNCTION public.pginvoice_client_directory()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
          'note', case when ok then e.note end,
          'carry_settle_month', case when ok then e.carry_settle_month end
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
$function$;
