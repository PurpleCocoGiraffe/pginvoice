-- Consultant client access follows the Clients module's Consultant field, not ClickUp history.
-- NOT YET APPLIED to fzvlnzlecchsubkpsmew. Apply BEFORE deploying the manage-users that stops
-- writing source='clickup' rows (until then the old function re-adds them on a user edit).
--
-- Before: manage-users gave a consultant/coordinator every client whose ClickUp folder they had
-- EVER logged time in (source='clickup'). Holly got 16 clients for 2 of her own: every client
-- she had ever helped on since mid-2025, offboarded ones included.
--
-- Now (source='consultant'): the active and on-hold clients whose pginvoice_clients.consultant
-- names them, plus manual ticks (source='manual'). Owner decisions (2026-10-26):
--   * Client Accruals is unchanged: a card for a client they logged time on in the VIEWED month
--     still shows with its package figures withheld (scopedCardLists / withholdRedactedFigures).
--     Those clients get no RLS access, so such a card counts only their own hours.
--   * Overview `assigned` also counts clients they logged time on in the CURRENT Adelaide month
--     in "My active clients" / type mix: pginvoice_my_access() now returns `activityClients`
--     ({client, status, type}, names-only facts the directory already shares). Accrual health,
--     over-serviced and the trend stay on their own clients.
--   * A Consultant value matching two or more accounts goes to no one; admins see it via
--     pginvoice_consultant_match_issues() (manage-users `list`).
--
-- Matching (pg_consultant_matches): the Consultant field is free text -- "Holly L", "Alice FS",
-- "Chloe", "Chloe James", "Kasey Doren" -- and the account's ClickUp name is the full name
-- ("Holly Latham", "Alice Fulton-Sherriff", "Kasey Doran"). First names must be equal
-- (case-insensitive); if the field has anything after the first name, its first letter must
-- equal the first letter of the ClickUp surname. That separates two people with one first
-- name (Holly L / Holly F) and tolerates a misspelt surname (Doren / Doran). Checked against
-- every Consultant value and ClickUp name on 2026-10-26: each one matches exactly one person.
-- A value that still matches 2+ eligible accounts grants to nobody (never guess).
--
-- Kept in sync by triggers, so nothing has to remember to call it:
--   * pginvoice_clients: insert / delete / change of consultant or status -> everyone resynced;
--   * pginvoice_profiles: insert / delete / change of role or ClickUp name -> everyone resynced
--     (one account can make another's match ambiguous).

-- 1. Allow the new source.
alter table public.pginvoice_user_clients drop constraint if exists pginvoice_user_clients_source_check;
alter table public.pginvoice_user_clients add constraint pginvoice_user_clients_source_check
  check (source = any (array['manual', 'clickup', 'capacity_lead', 'consultant']));

-- 2. The match rule (pure).
create or replace function public.pg_consultant_matches(p_consultant text, p_clickup_name text)
returns boolean
language sql immutable set search_path = public, pg_temp as $fn$
  select case
    when nullif(trim(coalesce(p_consultant, '')), '') is null or nullif(trim(coalesce(p_clickup_name, '')), '') is null then false
    else
      lower(split_part(regexp_replace(trim(p_consultant), '\s+', ' ', 'g'), ' ', 1))
        = lower(split_part(regexp_replace(trim(p_clickup_name), '\s+', ' ', 'g'), ' ', 1))
      and (
        split_part(regexp_replace(trim(p_consultant), '\s+', ' ', 'g'), ' ', 2) = ''
        or lower(left(split_part(regexp_replace(trim(p_consultant), '\s+', ' ', 'g'), ' ', 2), 1))
           = lower(left(split_part(regexp_replace(trim(p_clickup_name), '\s+', ' ', 'g'), ' ', 2), 1))
      )
  end;
$fn$;

-- 3. Rebuild source='consultant' rows for one user (or everyone when p_user_id is null).
create or replace function public.pginvoice_sync_consultant_clients(p_user_id uuid default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare n integer;
begin
  delete from pginvoice_user_clients uc
   where uc.source = 'consultant' and (p_user_id is null or uc.user_id = p_user_id);
  -- Pairs are formed over EVERY eligible account, so a value matching two of them is seen as
  -- ambiguous even when only one user is being resynced.
  insert into pginvoice_user_clients (user_id, client, source)
  select m.user_id, m.client, 'consultant'
    from (
      select p.user_id, c.client, count(*) over (partition by c.client) as n
        from pginvoice_profiles p
        join pginvoice_clients c on pg_consultant_matches(c.consultant, p.clickup_user_name)
       where p.role in ('consultant', 'coordinator')
         and c.status in ('active', 'on_hold')
    ) m
   where m.n = 1 and (p_user_id is null or m.user_id = p_user_id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function public.pginvoice_sync_consultant_clients(uuid) from public, anon, authenticated;
grant execute on function public.pginvoice_sync_consultant_clients(uuid) to service_role;

-- 3b. For admins (manage-users `list`): Consultant values on active / on-hold clients that
-- match no account or more than one, so nobody gets those clients automatically.
-- [{ consultant, matches: [ClickUp names], clients: [client names] }]
create or replace function public.pginvoice_consultant_match_issues()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('consultant', v.consultant, 'matches', v.matches, 'clients', v.clients)
                            order by v.consultant), '[]'::jsonb)
    from (
      select trim(c.consultant) as consultant,
             coalesce((select jsonb_agg(distinct p.clickup_user_name)
                         from pginvoice_profiles p
                        where p.role in ('consultant', 'coordinator')
                          and pg_consultant_matches(c.consultant, p.clickup_user_name)), '[]'::jsonb) as matches,
             jsonb_agg(c.client order by c.client) as clients
        from pginvoice_clients c
       where c.status in ('active', 'on_hold')
         and nullif(trim(coalesce(c.consultant, '')), '') is not null
         and lower(trim(c.consultant)) <> 'purple giraffe'
       group by trim(c.consultant), c.consultant
    ) v
   where jsonb_array_length(v.matches) <> 1;
$fn$;
revoke all on function public.pginvoice_consultant_match_issues() from public, anon, authenticated;
grant execute on function public.pginvoice_consultant_match_issues() to service_role;

-- 3c. Clients the caller logged ClickUp time on in the current Adelaide month that aren't
-- already theirs: [{ client, status, type }] -- facts pginvoice_client_directory() already
-- shares with every Invoicing user; no figures. Folder -> client the same ways entry access
-- does: the admin-built folder map, a client's own folder, a cost-centre folder.
-- Only pginvoice_my_access() calls it (no grant to authenticated).
create or replace function public.pg_my_activity_clients()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $fn$
  with mine as (
    select distinct lower(trim(e.folder)) as folder_key
      from pginvoice_clickup_entries e
     where e.month_key = to_char(now() at time zone 'Australia/Adelaide', 'YYYY-MM')
       and lower(trim(e.user_name)) = any (pg_my_clickup_name_keys())
       and e.folder is not null
  ), hit as (
    select fc.client from pginvoice_folder_clients fc join mine m on m.folder_key = fc.folder_key
    union
    select c.client from pginvoice_clients c join mine m on m.folder_key = lower(trim(c.clickup_folder))
    union
    select cc.client from pginvoice_cost_centres cc join mine m on m.folder_key = lower(trim(cc.folder))
  )
  select coalesce(jsonb_agg(jsonb_build_object('client', c.client, 'status', c.status, 'type', c.type) order by c.client), '[]'::jsonb)
    from pginvoice_clients c
   where c.client in (select client from hit)
     and c.client not in (select uc.client from pginvoice_user_clients uc where uc.user_id = auth.uid());
$fn$;
revoke all on function public.pg_my_activity_clients() from public, anon, authenticated;

-- 3d. pginvoice_my_access() gains `activityClients` (admin tier: []). Everything else is the
-- live definition unchanged (copied from the database on 2026-10-26).
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
    'activityClients', case when pg_is_admin_tier() then '[]'::jsonb else pg_my_activity_clients() end
  )
  from pginvoice_profiles p
  where p.user_id = auth.uid();
$fn$;
revoke all on function public.pginvoice_my_access() from public, anon;
grant execute on function public.pginvoice_my_access() to authenticated, service_role;

-- 4. Triggers.
create or replace function public.pginvoice_clients_sync_consultants()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  perform pginvoice_sync_consultant_clients(null);
  return null;
end;
$fn$;
revoke all on function public.pginvoice_clients_sync_consultants() from public, anon, authenticated;

-- Everyone, not just the changed account: a new or renamed account can make another
-- account's Consultant match ambiguous (a second "Holly L"), which must take it from both.
create or replace function public.pginvoice_profiles_sync_consultants()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  perform pginvoice_sync_consultant_clients(null);
  return null;
end;
$fn$;
revoke all on function public.pginvoice_profiles_sync_consultants() from public, anon, authenticated;

drop trigger if exists pginvoice_clients_sync_consultants_ins_del on public.pginvoice_clients;
create trigger pginvoice_clients_sync_consultants_ins_del after insert or delete on public.pginvoice_clients
  for each statement execute function public.pginvoice_clients_sync_consultants();
drop trigger if exists pginvoice_clients_sync_consultants_upd on public.pginvoice_clients;
create trigger pginvoice_clients_sync_consultants_upd after update of consultant, status on public.pginvoice_clients
  for each statement execute function public.pginvoice_clients_sync_consultants();

drop trigger if exists pginvoice_profiles_sync_consultants on public.pginvoice_profiles;
create trigger pginvoice_profiles_sync_consultants after insert or delete or update of role, clickup_user_name on public.pginvoice_profiles
  for each statement execute function public.pginvoice_profiles_sync_consultants();

-- 5. Switch over: drop the all-time ClickUp grants and build the new ones.
delete from public.pginvoice_user_clients where source = 'clickup';
select public.pginvoice_sync_consultant_clients(null);
