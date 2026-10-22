-- Local check for supabase-migrations/20261022_entries_own_clients.sql + 20261023_entries_policy.sql.
--
-- SCRATCH DATABASE ONLY -- never run this against the live project. On the shared stub schema
-- (_permissions_setup.sql) it applies the migration twice, fills pginvoice_folder_clients as
-- an admin would, then checks which pginvoice_clickup_entries rows each user can read:
--   - admin: every row;
--   - c1 Holly (Majestic Plumbing): her own rows, colleagues' rows in Majestic's folder, and
--     the MP Web Project sub-project's folder (a cost-centre folder of Majestic) -- nothing else;
--   - c2 Chloe (Aus3C, linked to p3 whose wage names include "c. smith"): her rows under both
--     spellings, Aus3C's folder, and her own row in a client she isn't assigned -- nothing else;
--   - c3 (no clients): nothing; anon: nothing;
--   - only admins write the folder map; pginvoice_clickup_months() lists months only.
-- Run like scoped_modules_check.sql.
\set ON_ERROR_STOP 1
begin;
\ir _permissions_setup.sql

\ir ../supabase-migrations/20261022_entries_own_clients.sql
\ir ../supabase-migrations/20261022_entries_own_clients.sql
\ir ../supabase-migrations/20261023_entries_policy.sql
\ir ../supabase-migrations/20261023_entries_policy.sql

update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c2';
insert into public.pginvoice_clickup_entries (entry_id, user_name, folder, minutes, month_key) values
  ('e6', 'Kelly W', 'Majestic Plumbing (WA)', 20, '2026-09'),
  ('e7', 'Kelly W', 'Majestic Plumbing Quoted Web Project (WA)', 25, '2026-08'),
  ('e8', 'Chloe Smith', 'AWIWA', 10, '2026-09');

do $$
begin
  if exists (select 1 from pg_policies where tablename = 'pginvoice_clickup_entries' and qual = 'true') then
    raise exception 'an open (true) entries policy is still there';
  end if;
  if (select count(*) from pg_proc where proname in ('pg_my_entry_folder_keys', 'pg_my_clickup_name_keys', 'pginvoice_clickup_months')
        and prosecdef and 'search_path=public, pg_temp' = any (proconfig)) <> 3 then
    raise exception 'new functions must be SECURITY DEFINER with search_path pinned';
  end if;
  raise notice 'ok: migration applied twice, open policy gone, helpers locked down';
end $$;

set local role authenticated;

\echo '--- admin fills the folder map and reads everything ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
insert into pginvoice_folder_clients (folder_key, folder, client) values
  ('majestic plumbing (wa)', 'Majestic Plumbing (WA)', 'Majestic Plumbing'),
  ('majestic plumbing quoted web project (wa)', 'Majestic Plumbing Quoted Web Project (WA)', 'MP Web Project'),
  ('australian cyber collaboration centre', 'Australian Cyber Collaboration Centre', 'Aus3C'),
  ('awiwa', 'AWIWA', 'AWIWA');
do $$
begin
  if (select count(*) from pginvoice_clickup_entries) <> 8 then raise exception 'admin: should read all 8 rows, got %', (select count(*) from pginvoice_clickup_entries); end if;
  raise notice 'ok: admin reads every entry and writes the folder map';
end $$;

\echo '--- c1 Holly ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$
declare ids text;
begin
  select string_agg(entry_id, ',' order by entry_id) into ids from pginvoice_clickup_entries;
  if ids <> 'e1,e2,e6,e7' then raise exception 'Holly: expected e1,e2,e6,e7, got %', ids; end if;
  begin
    insert into pginvoice_folder_clients (folder_key, folder, client) values ('toto', 'Toto', 'Majestic Plumbing');
    raise exception 'Holly: wrote the folder map';
  exception when insufficient_privilege then null;
  end;
  if jsonb_array_length(pginvoice_clickup_months()) <> 2 then raise exception 'Holly: months should be [2026-08, 2026-09]: %', pginvoice_clickup_months(); end if;
  raise notice 'ok: Holly reads own rows + Majestic folders (incl. its sub-project), not others; can''t write the map';
end $$;

\echo '--- c2 Chloe (linked to p3) ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$
declare ids text;
begin
  select string_agg(entry_id, ',' order by entry_id) into ids from pginvoice_clickup_entries;
  if ids <> 'e3,e4,e8' then raise exception 'Chloe: expected e3,e4,e8, got %', ids; end if;
  raise notice 'ok: Chloe reads her rows under both spellings + Aus3C, her own row elsewhere, nothing else';
end $$;

\echo '--- c3 (no clients) and anon ---'
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  if (select count(*) from pginvoice_clickup_entries) <> 0 then raise exception 'c3: should read nothing'; end if;
  raise notice 'ok: a user with no clients and no time reads nothing';
end $$;
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if (select count(*) from pginvoice_clickup_entries) <> 0 then raise exception 'anon: reads entries'; end if;
  begin
    perform pginvoice_clickup_months();
    raise exception 'anon: months RPC ran';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: anon reads nothing';
end $$;

reset role;
rollback;
