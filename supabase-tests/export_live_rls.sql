-- Read-only export of the live pginvoice RLS policies + helper functions (changes nothing).
-- Run in the Supabase SQL editor (or the Supabase MCP execute_sql) for project fzvlnzlecchsubkpsmew
-- and compare the output with supabase-migrations/00000000_live_rls_record.sql.

with
tbls as (
  select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pginvoice\_%'
),
rls as (
  select string_agg(
    format('alter table public.%I %s row level security;%s', relname,
           case when relrowsecurity then 'enable' else 'disable' end,
           case when relforcerowsecurity then format(E'\nalter table public.%I force row level security;', relname) else '' end),
    E'\n' order by relname) as body
  from tbls
),
pols as (
  select string_agg(
    format(E'create policy %I on public.%I as %s for %s to %s%s%s;',
           policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
           coalesce(E'\n  using (' || qual || ')', ''),
           coalesce(E'\n  with check (' || with_check || ')', '')),
    E'\n\n' order by tablename, policyname) as body
  from pg_policies
  where schemaname = 'public' and tablename like 'pginvoice\_%'
),
fns as (
  select string_agg(pg_get_functiondef(p.oid) || ';', E'\n\n' order by p.proname) as body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'pg\_%' or p.proname like 'pginvoice\_%')
),
grants as (
  select string_agg(format('-- %s: %s on %s', grantee, privilege_type, table_name), E'\n'
                    order by table_name, grantee, privilege_type) as body
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name like 'pginvoice\_%'
    and grantee in ('anon', 'authenticated')
)
select concat_ws(E'\n\n',
  '-- Live RLS record, exported ' || now()::date,
  '-- ===== Row level security on/off =====', (select body from rls),
  '-- ===== Policies =====', (select body from pols),
  '-- ===== Functions (pg_* / pginvoice_*) =====', (select body from fns),
  '-- ===== Table grants to anon/authenticated (comments only) =====', (select body from grants)
) as live_rls_record;
