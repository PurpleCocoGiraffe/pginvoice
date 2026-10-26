-- Billability Overview (Wages `own`) for months that aren't closed yet.
-- APPLIED to fzvlnzlecchsubkpsmew on 2026-10-26 (before the frontend). Requires 20261017_scoped_modules.sql.
--
-- Before: a consultant's own page (WagesSelf.jsx) only showed CLOSED months, via the
-- snapshot in pginvoice_my_wage_line(). Until Kelly closed a month they saw nothing at all.
--
-- pginvoice_my_wage_live(p_month) returns the inputs to compute the caller's OWN line for an
-- open month in the browser, with the same pure code the admin page uses
-- (wagesView.js computeLiveView), so their numbers match the admin's for the same person:
--   wagePerson   their pginvoice_wage_people row (no xero_name, no note)
--   rules        their hours rules (no note)
--   settings     hours per day, the two tolerances and the PG folder list (no Xero name map,
--                no ignored-user list: ignored logins are dropped here instead)
--   leaveEntries their typed leave for the month (no note)
--   clickupSummary  the same grouping as pginvoice_clickup_month_summary, own ClickUp names
--                only (exact, case-insensitive -- attributeToPeople's rule)
--   clients      every registered client name + folder: classifyClickup needs them to tell a
--                client's onboarding folder from staff onboarding. Consultants with Client
--                Accruals already get these names from pginvoice_client_directory().
--   firstMonth   earliest of start date, first rule and first own ClickUp month
-- Nothing from pginvoice_wage_lines is returned: no Xero hours, no overrides, no comments.
-- A closed month returns { status: 'closed' } only; its numbers come from the snapshot RPC.
-- The roster record and cap_leaves come from pginvoice_my_roster().
create or replace function public.pginvoice_my_wage_live(p_month text)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  v_person text := pginvoice_my_wage_person();
  v_wp pginvoice_wage_people%rowtype;
  v_names text[];
  v_settings pginvoice_wage_settings%rowtype;
  v_status text;
begin
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Invalid month' using errcode = '22023';
  end if;

  select m.status into v_status from pginvoice_wage_months m
   where m.month_key = p_month and m.status = 'closed' and jsonb_typeof(m.snapshot -> 'lines') = 'array';
  if v_status = 'closed' then
    return jsonb_build_object('monthKey', p_month, 'status', 'closed');
  end if;

  select * into v_wp from pginvoice_wage_people w where w.person_id = v_person;
  if not found then
    return jsonb_build_object('monthKey', p_month, 'status', 'not_set_up');
  end if;
  select coalesce(array_agg(lower(trim(n))), '{}') into v_names from unnest(v_wp.clickup_user_names) n;
  select * into v_settings from pginvoice_wage_settings s where s.id = 1;
  -- An ignored (shared) login is never anyone's time.
  v_names := array(select n from unnest(v_names) n
                   where n <> all (select lower(trim(i)) from unnest(coalesce(v_settings.ignored_clickup_users, '{}')) i));

  return jsonb_build_object(
    'monthKey', p_month,
    'status', 'open',
    'wagePerson', jsonb_build_object(
      'person_id', v_wp.person_id, 'include', v_wp.include, 'clickup_user_names', to_jsonb(v_wp.clickup_user_names),
      'start_date', v_wp.start_date, 'end_date', v_wp.end_date),
    'rules', coalesce((
      select jsonb_agg(to_jsonb(r) - array['note', 'updated_by', 'updated_at', 'id'] order by r.effective_from)
        from pginvoice_wage_rules r where r.person_id = v_person), '[]'::jsonb),
    'settings', jsonb_build_object(
      'hours_per_day', v_settings.hours_per_day,
      'xero_tolerance_h', v_settings.xero_tolerance_h,
      'variance_threshold_h', v_settings.variance_threshold_h,
      'pg_folders', to_jsonb(coalesce(v_settings.pg_folders, '{}'))),
    'leaveEntries', coalesce((
      select jsonb_agg(jsonb_build_object('person_id', l.person_id, 'month_key', l.month_key,
                                          'leave_type', l.leave_type, 'hours', l.hours, 'days', l.days))
        from pginvoice_leave_entries l where l.person_id = v_person and l.month_key = p_month), '[]'::jsonb),
    'clickupSummary', coalesce((
      select jsonb_agg(jsonb_build_object('user_name', s.user_name, 'folder', s.folder, 'space_id', s.space_id,
                                          'billable', s.billable, 'taskless', s.taskless, 'minutes', s.minutes, 'entries', s.entries))
        from (select e.user_name, e.folder, e.space_id, e.billable, (e.task_id is null) as taskless,
                     sum(e.minutes)::numeric as minutes, count(*) as entries
                from pginvoice_clickup_entries e
               where e.month_key = p_month and lower(trim(e.user_name)) = any (v_names)
               group by 1, 2, 3, 4, 5) s), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object('client', c.client, 'clickup_folder', c.clickup_folder))
        from pginvoice_clients c), '[]'::jsonb),
    'firstMonth', (
      select to_char(min(d), 'YYYY-MM') from (
        select v_wp.start_date::date as d
        union all select min(r.effective_from) from pginvoice_wage_rules r where r.person_id = v_person
        union all select to_date(min(e.month_key), 'YYYY-MM') from pginvoice_clickup_entries e
                   where lower(trim(e.user_name)) = any (v_names)) x)
  );
end;
$fn$;

revoke all on function public.pginvoice_my_wage_live(text) from public, anon;
grant execute on function public.pginvoice_my_wage_live(text) to authenticated, service_role;
