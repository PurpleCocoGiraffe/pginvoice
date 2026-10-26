-- Local check for supabase-migrations/20261026_my_wage_live.sql.
--
-- SCRATCH DATABASE ONLY -- never run this against the live project. Builds the shared stub
-- schema (_permissions_setup.sql), adds the columns/tables the function reads, applies the
-- migration twice (idempotency), then checks pginvoice_my_wage_live() as:
--   - consultant c2 (linked to p3, ClickUp name "c. smith"): an open month returns only p3's
--     own wage person (no xero_name / note), rules (no note), leave (no note) and ClickUp
--     rows -- matched case-insensitively and trimmed, never another user's, never an ignored
--     login; settings without the Xero name map or ignored list; firstMonth; nothing from
--     wage lines;
--   - a closed month returns only { status: 'closed' }; a bad month string is refused;
--   - consultant c1 (no linked person), admin a1 and anon are refused;
--   - k1 (coordinator linked to p99, Wages own) with no wage person row: status 'not_set_up'.
-- Run like scoped_modules_check.sql:
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/my_wage_live_check.sql
\set ON_ERROR_STOP 1
begin;
\ir _permissions_setup.sql

alter table public.pginvoice_clickup_entries add column space_id text, add column billable boolean default true, add column task_id text;
alter table public.pginvoice_wage_people add column start_date date, add column end_date date, add column note text;
create table public.pginvoice_wage_rules (
  id uuid primary key default gen_random_uuid(), person_id text not null, effective_from date not null, basis text not null,
  daily_hours numeric(4,2) not null default 7.6, mon_h numeric default 0, tue_h numeric default 0, wed_h numeric default 0,
  thu_h numeric default 0, fri_h numeric default 0, sat_h numeric default 0, sun_h numeric default 0,
  monthly_target_h numeric, note text, updated_at timestamptz default now(), updated_by uuid);
create table public.pginvoice_wage_settings (
  id smallint primary key default 1, hours_per_day numeric(4,2) not null default 7.6, xero_tolerance_h numeric default 0.25,
  variance_threshold_h numeric default 3.8, pg_folders text[] not null default '{"Purple Giraffe"}',
  ignored_clickup_users text[] not null default '{"Purple Giraffe"}', xero_name_map jsonb not null default '{}');
create table public.pginvoice_leave_entries (
  id uuid primary key default gen_random_uuid(), person_id text not null, month_key text not null, leave_type text not null,
  hours numeric not null, days numeric, note text);
create table public.pginvoice_wage_lines (month_key text, person_id text, xero_hours numeric, kw_comment text);
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
alter table public.pginvoice_wage_rules enable row level security;
alter table public.pginvoice_wage_settings enable row level security;
alter table public.pginvoice_leave_entries enable row level security;
alter table public.pginvoice_wage_lines enable row level security;
create policy admin_tier_all on public.pginvoice_wage_rules for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_settings for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_leave_entries for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());
create policy admin_tier_all on public.pginvoice_wage_lines for all to authenticated using (pg_is_admin_tier()) with check (pg_is_admin_tier());

update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c2';
update public.pginvoice_profiles set person_id = 'p99' where user_id = '00000000-0000-0000-0000-0000000000d1';
update public.pginvoice_wage_people set start_date = '2026-03-10', note = 'HR: probation review due' where person_id = 'p3';
insert into public.pginvoice_wage_settings (id, xero_name_map, ignored_clickup_users) values (1, '{"Chloe S":"p3"}', '{"Purple Giraffe","C. Smith Shared"}');
insert into public.pginvoice_wage_rules (person_id, effective_from, basis, note) values
  ('p3', '2026-04-01', 'ft', 'Rule note: salary band B'),
  ('p30', '2025-01-01', 'casual_xero', 'someone else');
insert into public.pginvoice_leave_entries (person_id, month_key, leave_type, hours, days, note) values
  ('p3', '2026-10', 'annual', 7.6, 1, 'Leave note: medical'),
  ('p3', '2026-09', 'annual', 15.2, 2, null),
  ('p30', '2026-10', 'personal', 7.6, 1, null);
insert into public.pginvoice_wage_lines values ('2026-10', 'p3', 160, 'Reviewer comment');
-- p3's ClickUp name is "c. smith": matches " C. Smith" (trim + case), never "Chloe Smith" (e3).
insert into public.pginvoice_clickup_entries (entry_id, user_name, folder, minutes, month_key, space_id, billable, task_id) values
  ('e10', ' C. Smith', 'Australian Cyber Collaboration Centre', 120, '2026-10', '90167546842', true, 't1'),
  ('e11', 'c. smith', 'Australian Cyber Collaboration Centre', 60, '2026-10', '90167546842', true, 't2'),
  ('e12', 'c. smith', 'Admin', 30, '2026-10', null, false, null),
  ('e13', 'Chloe Smith', 'Australian Cyber Collaboration Centre', 999, '2026-10', '90167546842', true, 't3'),
  ('e14', 'Someone Else', 'AWIWA', 500, '2026-10', '90167546842', true, 't4'),
  ('e15', 'c. smith', 'Old work', 10, '2025-11', '90167546842', true, 't5');

\ir ../supabase-migrations/20261026_my_wage_live.sql
\ir ../supabase-migrations/20261026_my_wage_live.sql

set local role authenticated;

\echo '--- consultant c2 (p3) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$
declare r jsonb := pginvoice_my_wage_live('2026-10'); t text;
begin
  if r ->> 'status' <> 'open' then raise exception 'c2: expected open, got %', r; end if;
  if r -> 'wagePerson' ->> 'person_id' <> 'p3' or r -> 'wagePerson' ? 'xero_name' or r -> 'wagePerson' ? 'note' then
    raise exception 'c2: wagePerson wrong or leaks xero_name/note: %', r -> 'wagePerson'; end if;
  if jsonb_array_length(r -> 'rules') <> 1 or r -> 'rules' -> 0 ->> 'person_id' <> 'p3' or r -> 'rules' -> 0 ? 'note' then
    raise exception 'c2: rules wrong or leak notes: %', r -> 'rules'; end if;
  if jsonb_array_length(r -> 'leaveEntries') <> 1 or (r -> 'leaveEntries' -> 0 ->> 'hours')::numeric <> 7.6 or r -> 'leaveEntries' -> 0 ? 'note' then
    raise exception 'c2: leave wrong: %', r -> 'leaveEntries'; end if;
  if (select sum((x ->> 'minutes')::numeric) from jsonb_array_elements(r -> 'clickupSummary') x) <> 210 then
    raise exception 'c2: expected 210 own minutes (120+60+30), got %', r -> 'clickupSummary'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'clickupSummary') x where lower(trim(x ->> 'user_name')) <> 'c. smith') then
    raise exception 'c2: another user''s rows leaked'; end if;
  if (select (x ->> 'taskless')::boolean from jsonb_array_elements(r -> 'clickupSummary') x where x ->> 'folder' = 'Admin') is not true then
    raise exception 'c2: taskless flag wrong'; end if;
  if r -> 'settings' ? 'xero_name_map' or r -> 'settings' ? 'ignored_clickup_users' or (r -> 'settings' -> 'pg_folders') is null then
    raise exception 'c2: settings wrong: %', r -> 'settings'; end if;
  -- All 5 fixture clients (the caller's own RLS view of pginvoice_clients shows only their 1).
  if jsonb_array_length(r -> 'clients') <> 5 then raise exception 'c2: client list incomplete: %', r -> 'clients'; end if;
  if r ->> 'firstMonth' <> '2025-11' then raise exception 'c2: firstMonth should be 2025-11 (first own ClickUp month), got %', r ->> 'firstMonth'; end if;
  t := r::text;
  if t like '%Reviewer comment%' or t like '%160%' or t like '%HR: probation%' or t like '%salary band%' or t like '%medical%' or t like '%Chloe S%' then
    raise exception 'c2: something private leaked: %', t; end if;
  raise notice 'ok: c2 open month is own-only and private fields are withheld';

  r := pginvoice_my_wage_live('2026-07');
  if r <> jsonb_build_object('monthKey', '2026-07', 'status', 'closed') then raise exception 'c2: closed month should return status only: %', r; end if;
  -- 2026-09 is a draft month row: still open.
  if pginvoice_my_wage_live('2026-09') ->> 'status' <> 'open' then raise exception 'c2: draft month should be open'; end if;
  raise notice 'ok: closed month returns status only, draft month is live';

  begin perform pginvoice_my_wage_live('2026-13'); raise exception 'c2: bad month accepted';
  exception when sqlstate '22023' then raise notice 'ok: bad month refused'; end;
end $$;

\echo '--- ignored login ---'
reset role;
update pginvoice_wage_people set clickup_user_names = '{"c. smith","C. Smith Shared"}' where person_id = 'p3';
insert into pginvoice_clickup_entries (entry_id, user_name, folder, minutes, month_key, space_id, billable, task_id)
  values ('e16', 'C. Smith Shared', 'AWIWA', 400, '2026-10', '90167546842', true, 't6');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$
declare r jsonb := pginvoice_my_wage_live('2026-10');
begin
  if (select sum((x ->> 'minutes')::numeric) from jsonb_array_elements(r -> 'clickupSummary') x) <> 210 then
    raise exception 'ignored shared login was counted: %', r -> 'clickupSummary'; end if;
  raise notice 'ok: ignored login never counted';
end $$;

\echo '--- refusals ---'
do $$
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  begin perform pginvoice_my_wage_live('2026-10'); raise exception 'c1 (no person) was allowed';
  exception when insufficient_privilege then raise notice 'ok: c1 without a linked person refused'; end;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  begin perform pginvoice_my_wage_live('2026-10'); raise exception 'admin was allowed';
  exception when insufficient_privilege then raise notice 'ok: admin refused (uses the full module)'; end;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
  if pginvoice_my_wage_live('2026-10') ->> 'status' <> 'not_set_up' then raise exception 'k1: expected not_set_up'; end if;
  raise notice 'ok: linked person with no wage setup gets not_set_up';
end $$;
reset role;
set local role anon;
do $$
begin
  perform pginvoice_my_wage_live('2026-10'); raise exception 'anon was allowed';
exception when insufficient_privilege then raise notice 'ok: anon refused';
end $$;
reset role;

rollback;
