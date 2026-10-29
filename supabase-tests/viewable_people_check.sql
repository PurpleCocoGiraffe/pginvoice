-- Local check for supabase-migrations/20261029_viewable_people.sql.
--
-- SCRATCH DATABASE ONLY -- never run this against the live project. Builds the shared stub
-- schema (_permissions_setup.sql), the entries policy chain (20261022 + 20261023) and
-- 20261026_consultant_clients (pginvoice_my_access as it is live), applies the migration twice
-- (idempotency), then checks, signed in as consultant c1 ("Holly Fraser"):
--   - before any grant she reads only her own entries -- not Chloe's (e3 "Chloe Smith", e4
--     "C. Smith", Chloe's wage-person spelling);
--   - viewing roster person p3 (Chloe, linked to c2) lets her read exactly e3 + e4, never e5
--     (Kelly), and pginvoice_my_access().viewablePeople lists p3 with its roster name and both
--     spellings;
--   - she sees her own viewable rows only and can't write them;
--   - Client Accruals switched off (override `none`) takes the extra rows and the list away;
--   - admins get viewablePeople [] (they read everything anyway); old keys unchanged.
-- Run like scoped_modules_check.sql:
--   psql -h <socket dir> -p <port> -d scratch -f supabase-tests/viewable_people_check.sql
\set ON_ERROR_STOP 1
begin;
\ir _permissions_setup.sql

\ir ../supabase-migrations/20261022_entries_own_clients.sql
\ir ../supabase-migrations/20261023_entries_policy.sql
alter table public.pginvoice_user_clients add constraint pginvoice_user_clients_source_check
  check (source = any (array['manual', 'clickup', 'capacity_lead']));
\ir ../supabase-migrations/20261026_consultant_clients.sql

create table public.pginvoice_app_state (key text primary key, value jsonb, updated_at timestamptz default now());
insert into public.pginvoice_app_state (key, value) values
  ('cap_people', '[{"id": "p3", "name": "Chloe"}, {"id": "p4", "name": "Coord"}]');
update public.pginvoice_profiles set person_id = 'p3' where user_id = '00000000-0000-0000-0000-0000000000c2';

\ir ../supabase-migrations/20261029_viewable_people.sql
\ir ../supabase-migrations/20261029_viewable_people.sql

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$
declare got text; a jsonb;
begin
  select string_agg(entry_id, ',' order by entry_id) into got from pginvoice_clickup_entries where entry_id in ('e3', 'e4', 'e5');
  if got is not null then raise exception 'before any grant c1 read others'' entries: %', got; end if;
  a := pginvoice_my_access();
  if a -> 'viewablePeople' <> '[]'::jsonb then raise exception 'viewablePeople before grant: %', a -> 'viewablePeople'; end if;
  if not (a ? 'clients' and a ? 'activityClients' and a ? 'clickupUserNames' and a ? 'modules') then raise exception 'my_access lost keys: %', a; end if;
  begin
    insert into pginvoice_user_viewable_people (user_id, person_id) values ('00000000-0000-0000-0000-0000000000c1', 'p3');
    raise exception 'c1 could insert a viewable row';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok: before a grant (own entries only, nothing writable)';
end $$;
reset role;

insert into public.pginvoice_user_viewable_people (user_id, person_id) values
  ('00000000-0000-0000-0000-0000000000c1', 'p3'),
  ('00000000-0000-0000-0000-0000000000c2', 'p4');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$
declare got text; a jsonb;
begin
  select string_agg(entry_id, ',' order by entry_id) into got from pginvoice_clickup_entries where entry_id in ('e3', 'e4', 'e5');
  if got is distinct from 'e3,e4' then raise exception 'viewer entries: %', got; end if;
  a := pginvoice_my_access() -> 'viewablePeople';
  if jsonb_array_length(a) <> 1 or a -> 0 ->> 'personId' <> 'p3' or a -> 0 ->> 'name' <> 'Chloe' then raise exception 'viewablePeople: %', a; end if;
  select string_agg(x #>> '{}', ',' order by x #>> '{}') into got from jsonb_array_elements(a -> 0 -> 'clickupUserNames') x;
  if got is distinct from 'C. Smith,Chloe Smith' then raise exception 'viewable spellings: %', got; end if;
  select string_agg(person_id, ',') into got from pginvoice_user_viewable_people;
  if got is distinct from 'p3' then raise exception 'c1 sees viewable rows: %', got; end if;
  raise notice 'ok: viewing p3 reads Chloe''s entries (both spellings), nobody else''s';
end $$;
reset role;

insert into public.pginvoice_user_module_access (user_id, module_key, scope)
  values ('00000000-0000-0000-0000-0000000000c1', 'invoicing', 'none');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$
declare got text;
begin
  select string_agg(entry_id, ',' order by entry_id) into got from pginvoice_clickup_entries where entry_id in ('e3', 'e4');
  if got is not null then raise exception 'Client Accruals off still reads viewable entries: %', got; end if;
  if pginvoice_my_access() -> 'viewablePeople' <> '[]'::jsonb then raise exception 'Client Accruals off still lists people'; end if;
  raise notice 'ok: Client Accruals switched off takes the access away';
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
do $$
begin
  if pginvoice_my_access() -> 'viewablePeople' <> '[]'::jsonb then raise exception 'admin viewablePeople not []'; end if;
  if (select count(*) from pginvoice_user_viewable_people) <> 2 then raise exception 'admin should read every viewable row'; end if;
  raise notice 'ok: admin';
end $$;
reset role;

rollback;
