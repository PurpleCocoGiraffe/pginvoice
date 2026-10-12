-- RECORD OF WHAT WAS APPLIED -- NOT IDEMPOTENT. Do not re-run this file: the tables,
-- policies and triggers below already exist on the project and several statements
-- (CREATE TABLE / CREATE POLICY / CREATE TRIGGER) fail or duplicate on a second run.
-- Make further schema changes as a new migration.
--
-- Wages review module + typed leave entries.
-- Applied to project fzvlnzlecchsubkpsmew via the Supabase MCP as migrations
-- wages_review_tables / _policies / _summary_rpc / _touch_trigger / _lock_guard;
-- kept here so the schema is reviewable alongside the code.
--
-- Access: admin tier only (super_admin + admin) via pg_is_admin_tier(). Nav hiding in
-- Shell.jsx is cosmetic -- these policies are the real gate. Payroll-adjacent data must
-- never go into pginvoice_app_state (readable/writable by every authenticated user).

-- ---------------------------------------------------------------------------
-- Typed leave, entered in the Consultants module and read by Wages review.
-- The Consultants module also rolls each person/month's total back into the
-- cap_leaves app_state key so Capacity Planning keeps working unchanged.
-- ---------------------------------------------------------------------------
create table if not exists public.pginvoice_leave_entries (
  id uuid primary key default gen_random_uuid(),
  person_id text not null,                       -- cap_people[].id
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  leave_type text not null check (leave_type in ('annual', 'personal', 'lwop', 'unspecified')),
  hours numeric(6,2) not null check (hours >= 0),
  days numeric(6,2),                             -- as entered, display only; hours is authoritative
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists pginvoice_leave_entries_month_idx on public.pginvoice_leave_entries (month_key, person_id);

-- ---------------------------------------------------------------------------
-- Per-person wage settings, linked to the Consultants roster (cap_people id),
-- which stays the home of name / photo / state.
-- ---------------------------------------------------------------------------
create table if not exists public.pginvoice_wage_people (
  person_id text primary key,                    -- cap_people[].id
  include boolean not null default true,         -- false = not on payroll (e.g. the shared "Purple Giraffe" login)
  clickup_user_names text[] not null default '{}', -- exact (case-insensitive) ClickUp display names
  xero_name text,                                -- name exactly as it appears in the Xero paste
  start_date date,
  end_date date,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

-- Effective-dated hours rule. The rule applies from effective_from until the next
-- row's effective_from, so a mid-month change splits the month automatically.
create table if not exists public.pginvoice_wage_rules (
  id uuid primary key default gen_random_uuid(),
  person_id text not null references public.pginvoice_wage_people(person_id) on delete cascade,
  effective_from date not null,
  basis text not null check (basis in ('ft', 'pt_pattern', 'casual_xero', 'casual_pattern', 'casual_target')),
  daily_hours numeric(4,2) not null default 7.6,  -- ft only
  mon_h numeric(4,2) not null default 0,
  tue_h numeric(4,2) not null default 0,
  wed_h numeric(4,2) not null default 0,
  thu_h numeric(4,2) not null default 0,
  fri_h numeric(4,2) not null default 0,
  sat_h numeric(4,2) not null default 0,
  sun_h numeric(4,2) not null default 0,
  monthly_target_h numeric(6,2),                 -- casual_target only
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (person_id, effective_from),
  check (basis <> 'casual_target' or monthly_target_h is not null)
);

create table if not exists public.pginvoice_wage_months (
  month_key text primary key check (month_key ~ '^\d{4}-\d{2}$'),
  status text not null default 'draft' check (status in ('draft', 'closed')),
  snapshot jsonb,                                -- every computed line + config, frozen at close
  closed_at timestamptz,
  closed_by uuid,
  reopened_reason text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- One row per person per month: the workbook row's manual inputs and comments.
create table if not exists public.pginvoice_wage_lines (
  month_key text not null check (month_key ~ '^\d{4}-\d{2}$'),
  person_id text not null,
  xero_hours numeric(6,2),                       -- column L; null = not entered yet (never 0)
  xero_source text check (xero_source in ('paste', 'manual')),
  ph_override_h numeric(6,2),                    -- column Q override (Q is computed otherwise)
  expected_override_h numeric(6,2),              -- column S override
  expected_override_reason text,
  pg_comment text,
  kw_comment text,
  ls_comment text,
  phil_comment text,
  phil_leave_applied boolean not null default false,
  kw2_comment text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (month_key, person_id),
  check (expected_override_h is null or length(trim(coalesce(expected_override_reason, ''))) > 0)
);

create table if not exists public.pginvoice_wage_settings (
  id smallint primary key default 1 check (id = 1),
  hours_per_day numeric(4,2) not null default 7.6,
  xero_tolerance_h numeric(5,2) not null default 0.25,   -- column M "close to zero"
  variance_threshold_h numeric(5,2) not null default 3.8, -- column T significance
  pg_folders text[] not null default '{"Purple Giraffe"}', -- folders inside a client space that are PG's own work
  ignored_clickup_users text[] not null default '{"Purple Giraffe"}', -- shared logins, never a payroll person
  xero_name_map jsonb not null default '{}'::jsonb,       -- remembered "pasted name" -> person_id
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.pginvoice_wage_settings (id) values (1) on conflict (id) do nothing;

-- RLS: admin tier only (super_admin + admin), everything.
alter table public.pginvoice_leave_entries enable row level security;
alter table public.pginvoice_wage_people enable row level security;
alter table public.pginvoice_wage_rules enable row level security;
alter table public.pginvoice_wage_months enable row level security;
alter table public.pginvoice_wage_lines enable row level security;
alter table public.pginvoice_wage_settings enable row level security;
revoke all on public.pginvoice_leave_entries, public.pginvoice_wage_people, public.pginvoice_wage_rules, public.pginvoice_wage_months, public.pginvoice_wage_lines, public.pginvoice_wage_settings from anon;
grant select, insert, update, delete on public.pginvoice_leave_entries, public.pginvoice_wage_people, public.pginvoice_wage_rules, public.pginvoice_wage_months, public.pginvoice_wage_lines, public.pginvoice_wage_settings to authenticated;
create policy admin_tier_all on public.pginvoice_leave_entries for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_people for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_rules for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_months for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_lines for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_settings for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());

-- ---------------------------------------------------------------------------
-- ClickUp monthly summary: one row per user x folder x space x billable x taskless
-- for a month, computed live from pginvoice_clickup_entries (so it can never drift
-- out of sync with the entries). PG/client classification happens in
-- src/wagesCalc.js; closing a month freezes the result in wage_months.snapshot.
-- Non-admins get zero rows.
-- ---------------------------------------------------------------------------
create or replace function public.pginvoice_clickup_month_summary(p_month text)
returns table (user_name text, folder text, space_id text, billable boolean, taskless boolean, minutes numeric, entries bigint)
language sql stable security invoker set search_path = public as $fn$
  select e.user_name, e.folder, e.space_id, e.billable, (e.task_id is null) as taskless,
         sum(e.minutes)::numeric as minutes, count(*) as entries
  from pginvoice_clickup_entries e
  where e.month_key = p_month and pg_is_admin_tier()
  group by 1, 2, 3, 4, 5;
$fn$;
revoke all on function public.pginvoice_clickup_month_summary(text) from anon, public;
grant execute on function public.pginvoice_clickup_month_summary(text) to authenticated;

-- updated_at / updated_by maintenance
create or replace function public.pginvoice_touch_updated() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end
$fn$;
create trigger pginvoice_leave_entries_touch before update on public.pginvoice_leave_entries for each row execute function public.pginvoice_touch_updated();
create trigger pginvoice_wage_people_touch before update on public.pginvoice_wage_people for each row execute function public.pginvoice_touch_updated();
create trigger pginvoice_wage_rules_touch before update on public.pginvoice_wage_rules for each row execute function public.pginvoice_touch_updated();
create trigger pginvoice_wage_months_touch before update on public.pginvoice_wage_months for each row execute function public.pginvoice_touch_updated();
create trigger pginvoice_wage_lines_touch before update on public.pginvoice_wage_lines for each row execute function public.pginvoice_touch_updated();
create trigger pginvoice_wage_settings_touch before update on public.pginvoice_wage_settings for each row execute function public.pginvoice_touch_updated();

-- Numbers on a closed month are frozen; comments stay editable (Lynda/Phil/KW round 2
-- happen after Kelly closes the numbers).
create or replace function public.pginvoice_wage_lines_lock_guard() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  st text;
begin
  select status into st from pginvoice_wage_months where month_key = coalesce(new.month_key, old.month_key);
  if st = 'closed' then
    if tg_op = 'DELETE' then
      raise exception 'Month % is closed', old.month_key;
    end if;
    if tg_op = 'INSERT'
       or new.xero_hours is distinct from old.xero_hours
       or new.ph_override_h is distinct from old.ph_override_h
       or new.expected_override_h is distinct from old.expected_override_h then
      raise exception 'Month % is closed: reopen it before changing hours', new.month_key;
    end if;
  end if;
  return coalesce(new, old);
end
$fn$;
create trigger pginvoice_wage_lines_lock before insert or update or delete on public.pginvoice_wage_lines
  for each row execute function public.pginvoice_wage_lines_lock_guard();

-- ---------------------------------------------------------------------------
-- Separately applied the same day (migration "add_space_id_to_clickup_entries"),
-- recorded here for completeness:
--   alter table public.pginvoice_clickup_entries add column if not exists space_id text;
-- ---------------------------------------------------------------------------
