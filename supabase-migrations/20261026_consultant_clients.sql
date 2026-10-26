-- Consultant client access follows the Clients module's Consultant field, not ClickUp history.
-- NOT YET APPLIED to fzvlnzlecchsubkpsmew. Apply BEFORE deploying the manage-users that stops
-- writing source='clickup' rows (until then the old function re-adds them on a user edit).
--
-- Before: manage-users gave a consultant/coordinator every client whose ClickUp folder they had
-- EVER logged time in (source='clickup'). Holly got 16 clients for 2 of her own: every client
-- she had ever helped on since mid-2025, offboarded ones included.
--
-- Now (source='consultant'): the active and on-hold clients whose pginvoice_clients.consultant
-- names them, plus manual ticks (source='manual'). Time logged THIS month still shows in Client
-- Accruals through the existing card rule (scopedCardLists), so that part is unchanged.
--
-- Matching (pg_consultant_matches): the Consultant field is free text -- "Holly L", "Alice FS",
-- "Chloe", "Chloe James", "Kasey Doren" -- and the account's ClickUp name is the full name
-- ("Holly Latham", "Alice Fulton-Sherriff", "Kasey Doran"). First names must be equal
-- (case-insensitive); if the field has anything after the first name, its first letter must
-- equal the first letter of the ClickUp surname. That separates two people with one first
-- name (Holly L / Holly F) and tolerates a misspelt surname (Doren / Doran). Checked against
-- every Consultant value and ClickUp name on 2026-10-26: each one matches exactly one person.
--
-- Kept in sync by triggers, so nothing has to remember to call it:
--   * pginvoice_clients: insert / delete / change of consultant or status -> everyone resynced;
--   * pginvoice_profiles: insert / change of role or ClickUp name -> that user resynced.

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
  insert into pginvoice_user_clients (user_id, client, source)
  select p.user_id, c.client, 'consultant'
    from pginvoice_profiles p
    join pginvoice_clients c on pg_consultant_matches(c.consultant, p.clickup_user_name)
   where p.role in ('consultant', 'coordinator')
     and c.status in ('active', 'on_hold')
     and (p_user_id is null or p.user_id = p_user_id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function public.pginvoice_sync_consultant_clients(uuid) from public, anon, authenticated;
grant execute on function public.pginvoice_sync_consultant_clients(uuid) to service_role;

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

create or replace function public.pginvoice_profiles_sync_consultants()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  perform pginvoice_sync_consultant_clients(new.user_id);
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
create trigger pginvoice_profiles_sync_consultants after insert or update of role, clickup_user_name on public.pginvoice_profiles
  for each row execute function public.pginvoice_profiles_sync_consultants();

-- 5. Switch over: drop the all-time ClickUp grants and build the new ones.
delete from public.pginvoice_user_clients where source = 'clickup';
select public.pginvoice_sync_consultant_clients(null);
