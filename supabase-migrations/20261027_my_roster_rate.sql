-- My billability: colour a consultant's own billable % against their roster Billable % target.
-- pginvoice_my_roster() returned their own roster record without `rate` (and without `note`);
-- the card needs their own target, so it now includes `rate` -- their own record only, still
-- no note. Everything else is the live definition unchanged (copied 2026-10-27).
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
      'contracted', e -> 'contracted', 'rate', e -> 'rate', 'photo', e -> 'photo', 'resignationDate', e -> 'resignationDate')), '[]'::jsonb)
    into v_people
    from pginvoice_app_state s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) e
   where s.key = 'cap_people' and jsonb_typeof(e) = 'object' and e ->> 'id' = v_person;
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
