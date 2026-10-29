-- Client Accruals: let a non-admin see the client hours of chosen teammates (Simone -> Julia,
-- Ariani). Order: this migration, then manage-users (writes the list), then the frontend.
--
-- Before: a consultant's Client Accruals reads only their own ClickUp time plus everyone's
-- time on their own clients (entries RLS: own ClickUp names, or a folder of one of their
-- clients), so a client only a teammate worked on never shows up for them.
--
-- Now an admin can give a user a list of roster people whose client hours they can see
-- (pginvoice_user_viewable_people). While the viewer's Client Accruals (module `invoicing`)
-- isn't `none`, the entries policy also lets them read rows logged under those people's
-- ClickUp names, and the frontend lists the clients those rows belong to -- with the package
-- figures withheld, exactly like a client the viewer logged time on themself. Nothing else
-- widens: no client access (pg_has_client_access), no wages or billability, no roster record.
-- Names come from the same two places as a user's own (pg_my_clickup_name_keys): the ClickUp
-- name on the person's linked account, and their wage person's clickup_user_names.

-- 1. Who can view whom. Written only by manage-users (service role); readable by the viewer
-- themself and by admins.
create table if not exists public.pginvoice_user_viewable_people (
  user_id uuid not null references public.pginvoice_profiles(user_id) on delete cascade,
  person_id text not null check (nullif(trim(person_id), '') is not null),
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (user_id, person_id)
);
alter table public.pginvoice_user_viewable_people enable row level security;
drop policy if exists viewable_people_read on public.pginvoice_user_viewable_people;
create policy viewable_people_read on public.pginvoice_user_viewable_people
  for select to authenticated using (user_id = (select auth.uid()) or (select pg_is_admin_tier()));
revoke all on public.pginvoice_user_viewable_people from anon;
grant select on public.pginvoice_user_viewable_people to authenticated;
grant all on public.pginvoice_user_viewable_people to service_role;

-- 2. The lower(trim()) ClickUp name keys of the caller's viewable people. Empty for admins
-- (they read everything anyway) and while the caller's Client Accruals scope is `none`.
create or replace function public.pg_my_viewable_name_keys()
returns text[]
language sql stable security definer set search_path = public, pg_temp as $fn$
  select case when pg_is_admin_tier() or pg_module_scope('invoicing') = 'none' then '{}'::text[] else
    coalesce((select array_agg(distinct lower(trim(k))) from (
      select pr.clickup_user_name as k
        from pginvoice_user_viewable_people v
        join pginvoice_profiles pr on pr.person_id = v.person_id
       where v.user_id = auth.uid()
      union all
      select unnest(w.clickup_user_names)
        from pginvoice_user_viewable_people v
        join pginvoice_wage_people w on w.person_id = v.person_id
       where v.user_id = auth.uid()
    ) raw where k is not null and trim(k) <> ''), '{}'::text[]) end;
$fn$;
revoke all on function public.pg_my_viewable_name_keys() from public, anon;
grant execute on function public.pg_my_viewable_name_keys() to authenticated, service_role;

-- 3. [{ personId, name, clickupUserNames }] -- roster name (cap_people) and the exact user_name
-- spellings in synced entries, nothing else. Client Accruals lists the clients these names
-- logged time on.
create or replace function public.pg_my_viewable_people()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $fn$
  select case when pg_is_admin_tier() or pg_module_scope('invoicing') = 'none' then '[]'::jsonb else
    coalesce((select jsonb_agg(jsonb_build_object(
        'personId', v.person_id,
        'name', coalesce((select e ->> 'name' from pginvoice_app_state s
                            cross join lateral jsonb_array_elements(case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) e
                           where s.key = 'cap_people' and jsonb_typeof(e) = 'object' and e ->> 'id' = v.person_id limit 1), v.person_id),
        'clickupUserNames', coalesce((
          select jsonb_agg(distinct en.user_name)
            from pginvoice_clickup_entries en
           where lower(trim(en.user_name)) = any (array(
             select lower(trim(k)) from (
               select pr.clickup_user_name as k from pginvoice_profiles pr where pr.person_id = v.person_id
               union all
               select unnest(w.clickup_user_names) from pginvoice_wage_people w where w.person_id = v.person_id
             ) raw where k is not null and trim(k) <> ''))), '[]'::jsonb))
      order by v.person_id)
      from pginvoice_user_viewable_people v where v.user_id = auth.uid()), '[]'::jsonb) end;
$fn$;
revoke all on function public.pg_my_viewable_people() from public, anon, authenticated;

-- 4. The entries policy gains the viewable-people clause; the rest is the live policy unchanged.
drop policy if exists authenticated_read on public.pginvoice_clickup_entries;
create policy authenticated_read on public.pginvoice_clickup_entries
  for select to authenticated using (
    (select pg_is_admin_tier())
    or lower(trim(user_name)) = any ((select pg_my_clickup_name_keys())::text[])
    or lower(trim(folder)) = any ((select pg_my_entry_folder_keys())::text[])
    or lower(trim(user_name)) = any ((select pg_my_viewable_name_keys())::text[])
  );

-- 5. pginvoice_my_access() gains `viewablePeople` (admin tier: []). Everything else is the
-- live definition unchanged (copied from the database on 2026-10-29).
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
    'clickupUserNames', case when pg_is_admin_tier() then '[]'::jsonb else pg_my_clickup_user_names() end,
    'activityClients', case when pg_is_admin_tier() then '[]'::jsonb else pg_my_activity_clients() end,
    'viewablePeople', case when pg_is_admin_tier() then '[]'::jsonb else pg_my_viewable_people() end
  )
  from pginvoice_profiles p
  where p.user_id = auth.uid();
$fn$;
revoke all on function public.pginvoice_my_access() from public, anon;
grant execute on function public.pginvoice_my_access() to authenticated, service_role;
