-- Time entries: a non-admin reads only their own entries and their clients' folders --
-- owner decision 2026-10-22 (option A: link folders first, then lock down).
-- NOT yet applied to fzvlnzlecchsubkpsmew. Requires 20261017_scoped_modules.sql.
--
-- Before: every signed-in user could read every row of pginvoice_clickup_entries (every
-- client's and every colleague's tasks, hours and free-text descriptions).
--
-- DEPLOY ORDER: (1) the frontend (it fills pginvoice_folder_clients from an admin's Client
-- Invoicing load and reads pginvoice_clickup_months() when present), (2) an admin opens
-- Client Invoicing once (fills the folder map), (3) this migration. Applying it before the
-- map is filled leaves a consultant's Client Invoicing showing only their own time.
--
-- Parity: a consultant's assigned-client cards must equal the admin's. Checked on the live
-- data (2026-10-22, 55,855 entries, 58 clients, 404 client-months since Dec 2025): with
-- rows limited to each client's mapped folders, every card was identical once the pipeline
-- is told which months the sync covers (pginvoice_clickup_months(), below) -- without that, a
-- month where the user's rows were empty dropped the prior-month estimate.
--
-- 1. pginvoice_folder_clients: real ClickUp folder -> Clients-module client, written by an
--    admin browser from Client Invoicing's own attribution (src/folderAccess.js) -- the same
--    multi-folder prefix rules, cost centres and name matches, so a new "Magain <agent>"
--    folder maps itself the next time an admin opens Client Invoicing.
create table if not exists public.pginvoice_folder_clients (
  folder_key text not null,                     -- lower(trim(folder))
  folder text not null,
  client text not null references public.pginvoice_clients (client) on update cascade on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (folder_key, client)
);
alter table public.pginvoice_folder_clients enable row level security;
grant select, insert, update, delete on public.pginvoice_folder_clients to authenticated;
drop policy if exists folder_clients_read on public.pginvoice_folder_clients;
drop policy if exists folder_clients_admin_write on public.pginvoice_folder_clients;
create policy folder_clients_read on public.pginvoice_folder_clients
  for select to authenticated using (pg_is_admin_tier() or pg_has_client_access(client));
create policy folder_clients_admin_write on public.pginvoice_folder_clients
  for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());

-- 2. The caller's readable folder keys and own-name keys, each computed once per statement
--    (the policy wraps them in a sub-select). "My clients" is the same set the client
--    directory uses: pginvoice_user_clients, plus any client whose own folder is a
--    cost-centre / sub-project folder of one of them.
create or replace function public.pg_my_entry_folder_keys()
returns text[]
language sql stable security definer set search_path = public, pg_temp as $fn$
  with mine as (
    select uc.client from pginvoice_user_clients uc where uc.user_id = auth.uid()
  ), withsub as (
    select client from mine
    union
    select c.client from pginvoice_clients c
      join pginvoice_cost_centres cc on lower(trim(cc.folder)) = lower(trim(c.clickup_folder))
     where cc.client in (select client from mine)
  )
  select coalesce(array_agg(distinct fc.folder_key), '{}')
    from pginvoice_folder_clients fc where fc.client in (select client from withsub);
$fn$;

create or replace function public.pg_my_clickup_name_keys()
returns text[]
language sql stable security definer set search_path = public, pg_temp as $fn$
  select coalesce(array_agg(distinct lower(trim(k))), '{}') from (
    select p.clickup_user_name as k from pginvoice_profiles p where p.user_id = auth.uid()
    union all
    select unnest(w.clickup_user_names)
      from pginvoice_profiles p join pginvoice_wage_people w on w.person_id = p.person_id
     where p.user_id = auth.uid()
  ) raw where k is not null and trim(k) <> '';
$fn$;
revoke all on function public.pg_my_entry_folder_keys() from public, anon;
revoke all on function public.pg_my_clickup_name_keys() from public, anon;
grant execute on function public.pg_my_entry_folder_keys() to authenticated, service_role;
grant execute on function public.pg_my_clickup_name_keys() to authenticated, service_role;

create index if not exists pginvoice_clickup_entries_folder_norm_idx
  on public.pginvoice_clickup_entries (lower(trim(folder)));

-- 3. The entries policy.
drop policy if exists authenticated_read on public.pginvoice_clickup_entries;
drop policy if exists entries_read_own_or_clients on public.pginvoice_clickup_entries;
create policy entries_read_own_or_clients on public.pginvoice_clickup_entries
  for select to authenticated using (
    (select pg_is_admin_tier())
    or lower(trim(user_name)) = any ((select pg_my_clickup_name_keys())::text[])
    or lower(trim(folder)) = any ((select pg_my_entry_folder_keys())::text[])
  );

-- 4. Which months the sync holds data for -- month keys only, nothing else. Client
--    Invoicing needs it to treat a month as covered even when none of the caller's rows
--    fall in it (see the parity note above; reconcile.js billableMinutesByFolder).
create or replace function public.pginvoice_clickup_months()
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $fn$
  select case when auth.uid() is null then '[]'::jsonb else coalesce((
    select jsonb_agg(m order by m) from (select distinct month_key as m from pginvoice_clickup_entries where month_key is not null) x
  ), '[]'::jsonb) end;
$fn$;
revoke all on function public.pginvoice_clickup_months() from public, anon;
grant execute on function public.pginvoice_clickup_months() to authenticated, service_role;
