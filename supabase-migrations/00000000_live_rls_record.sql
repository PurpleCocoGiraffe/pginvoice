-- RECORD ONLY -- do not run. Live row-level security for every pginvoice_* table and the
-- pg_* / pginvoice_* helper functions, exported read-only from project fzvlnzlecchsubkpsmew
-- on 2026-10-15. The original RBAC migration was applied straight to the database and never
-- checked in; this file is the reference new policies are reviewed against. Re-export with
-- supabase-tests/export_live_rls.sql before relying on it later.
--
-- Table grants: anon and authenticated hold full table privileges on every table (Supabase
-- default), so RLS below is the only gate. No policy targets anon, so anon reads nothing.
-- RLS is enabled with no policies (service role only) on: pginvoice_secrets,
-- pginvoice_clickup_entries_backup_20261001, pginvoice_clickup_entries_backup_20261012.

-- ===== Row level security on =====

alter table public.pginvoice_accruals enable row level security;
alter table public.pginvoice_app_state enable row level security;
alter table public.pginvoice_audit_log enable row level security;
alter table public.pginvoice_clickup_entries enable row level security;
alter table public.pginvoice_clickup_entries_backup_20261001 enable row level security;
alter table public.pginvoice_clickup_entries_backup_20261012 enable row level security;
alter table public.pginvoice_client_events enable row level security;
alter table public.pginvoice_client_history enable row level security;
alter table public.pginvoice_client_notes enable row level security;
alter table public.pginvoice_clients enable row level security;
alter table public.pginvoice_cost_centres enable row level security;
alter table public.pginvoice_leave_entries enable row level security;
alter table public.pginvoice_profiles enable row level security;
alter table public.pginvoice_secrets enable row level security;
alter table public.pginvoice_sync_meta enable row level security;
alter table public.pginvoice_user_clients enable row level security;
alter table public.pginvoice_wage_lines enable row level security;
alter table public.pginvoice_wage_months enable row level security;
alter table public.pginvoice_wage_people enable row level security;
alter table public.pginvoice_wage_rules enable row level security;
alter table public.pginvoice_wage_settings enable row level security;

-- ===== Policies =====

-- Any user with access to the client can also INSERT/UPDATE its accrual rows.
create policy authenticated_read on public.pginvoice_accruals as PERMISSIVE for SELECT to authenticated
  using (pg_has_client_access(client));
create policy authenticated_update on public.pginvoice_accruals as PERMISSIVE for UPDATE to authenticated
  using (pg_has_client_access(client))
  with check (pg_has_client_access(client));
create policy authenticated_write on public.pginvoice_accruals as PERMISSIVE for INSERT to authenticated
  with check (pg_has_client_access(client));

-- Roster/capacity state (cap_people incl. rates, cap_leaves, ...): every signed-in user reads and writes.
create policy authenticated_read on public.pginvoice_app_state as PERMISSIVE for SELECT to authenticated
  using (true);
create policy authenticated_update on public.pginvoice_app_state as PERMISSIVE for UPDATE to authenticated
  using (true)
  with check (true);
create policy authenticated_write on public.pginvoice_app_state as PERMISSIVE for INSERT to authenticated
  with check (true);

create policy audit_log_select_admin on public.pginvoice_audit_log as PERMISSIVE for SELECT to authenticated
  using (pg_is_admin_tier());

-- Every ClickUp time entry, for every signed-in user.
create policy authenticated_read on public.pginvoice_clickup_entries as PERMISSIVE for SELECT to authenticated
  using (true);

create policy authenticated_read on public.pginvoice_client_events as PERMISSIVE for SELECT to authenticated
  using (pg_has_client_access(client));
create policy authenticated_update on public.pginvoice_client_events as PERMISSIVE for UPDATE to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy authenticated_write on public.pginvoice_client_events as PERMISSIVE for INSERT to authenticated
  with check (pg_is_admin_tier());

create policy authenticated_read on public.pginvoice_client_history as PERMISSIVE for SELECT to authenticated
  using (pg_has_client_access(client));
create policy authenticated_write on public.pginvoice_client_history as PERMISSIVE for INSERT to authenticated
  with check (pg_is_admin_tier());

create policy authenticated_delete on public.pginvoice_client_notes as PERMISSIVE for DELETE to authenticated
  using (pg_is_admin_tier());
create policy authenticated_read on public.pginvoice_client_notes as PERMISSIVE for SELECT to authenticated
  using (pg_has_client_access(client));
create policy authenticated_update on public.pginvoice_client_notes as PERMISSIVE for UPDATE to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy authenticated_write on public.pginvoice_client_notes as PERMISSIVE for INSERT to authenticated
  with check (pg_is_admin_tier());

create policy authenticated_read on public.pginvoice_clients as PERMISSIVE for SELECT to authenticated
  using (pg_has_client_access(client));
create policy authenticated_update on public.pginvoice_clients as PERMISSIVE for UPDATE to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy authenticated_write on public.pginvoice_clients as PERMISSIVE for INSERT to authenticated
  with check (pg_is_admin_tier());

-- No UPDATE policy: cost-centre rows can only be inserted/deleted from the browser.
create policy authenticated_delete on public.pginvoice_cost_centres as PERMISSIVE for DELETE to authenticated
  using (pg_is_admin_tier());
create policy authenticated_read on public.pginvoice_cost_centres as PERMISSIVE for SELECT to authenticated
  using (pg_has_client_access(client));
create policy authenticated_write on public.pginvoice_cost_centres as PERMISSIVE for INSERT to authenticated
  with check (pg_is_admin_tier());

create policy admin_tier_all on public.pginvoice_leave_entries as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());

create policy profiles_delete_admin on public.pginvoice_profiles as PERMISSIVE for DELETE to authenticated
  using (pg_is_admin_tier());
create policy profiles_insert_admin on public.pginvoice_profiles as PERMISSIVE for INSERT to authenticated
  with check (pg_is_admin_tier());
create policy profiles_select_own_or_admin on public.pginvoice_profiles as PERMISSIVE for SELECT to authenticated
  using (((user_id = auth.uid()) OR pg_is_admin_tier()));
create policy profiles_update_admin on public.pginvoice_profiles as PERMISSIVE for UPDATE to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());

create policy authenticated_read on public.pginvoice_sync_meta as PERMISSIVE for SELECT to authenticated
  using (true);

create policy user_clients_select_own_or_admin on public.pginvoice_user_clients as PERMISSIVE for SELECT to authenticated
  using (((user_id = auth.uid()) OR pg_is_admin_tier()));
create policy user_clients_write_admin on public.pginvoice_user_clients as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());

create policy admin_tier_all on public.pginvoice_wage_lines as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_months as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_people as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_rules as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_settings as PERMISSIVE for ALL to authenticated
  using (pg_is_admin_tier())
  with check (pg_is_admin_tier());

-- ===== Functions =====

CREATE OR REPLACE FUNCTION public.pg_current_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from pginvoice_profiles where user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.pg_has_client_access(target_client text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    coalesce((select role from pginvoice_profiles where user_id = auth.uid()) in ('super_admin','admin'), false)
    or exists (
      select 1 from pginvoice_user_clients
      where user_id = auth.uid() and client = target_client
    );
$function$;

CREATE OR REPLACE FUNCTION public.pg_is_admin_tier()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select role from pginvoice_profiles where user_id = auth.uid()) in ('super_admin','admin'), false);
$function$;

CREATE OR REPLACE FUNCTION public.pg_is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select role from pginvoice_profiles where user_id = auth.uid()) = 'super_admin', false);
$function$;

-- pginvoice_clickup_month_summary, pginvoice_touch_updated and pginvoice_wage_lines_lock_guard
-- are defined in 20261012_wages_review.sql and match the live definitions.
