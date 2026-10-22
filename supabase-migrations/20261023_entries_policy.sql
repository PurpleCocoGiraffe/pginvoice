-- Time entries, part 2 of 2: a non-admin reads only their own entries and the folders mapped
-- to their clients. NOT yet applied to fzvlnzlecchsubkpsmew.
--
-- Apply only after 20261022_entries_own_clients.sql AND an admin's Client Invoicing load has
-- filled pginvoice_folder_clients (select count(*) from pginvoice_folder_clients > 0). Undo:
--   drop policy entries_read_own_or_clients on public.pginvoice_clickup_entries;
--   create policy authenticated_read on public.pginvoice_clickup_entries for select to authenticated using (true);
drop policy if exists authenticated_read on public.pginvoice_clickup_entries;
drop policy if exists entries_read_own_or_clients on public.pginvoice_clickup_entries;
create policy entries_read_own_or_clients on public.pginvoice_clickup_entries
  for select to authenticated using (
    (select pg_is_admin_tier())
    or lower(trim(user_name)) = any ((select pg_my_clickup_name_keys())::text[])
    or lower(trim(folder)) = any ((select pg_my_entry_folder_keys())::text[])
  );

