-- Time entries, part 2 of 2: a non-admin reads only their own entries and the folders mapped
-- to their clients. APPLIED to fzvlnzlecchsubkpsmew on 2026-10-22 (after the folder map was filled: 113 pairs).
--
-- Apply only after 20261022_entries_own_clients.sql AND an admin's Client Invoicing load has
-- filled pginvoice_folder_clients (select count(*) from pginvoice_folder_clients > 0). Undo:
--   alter policy authenticated_read on public.pginvoice_clickup_entries using (true);
-- Edited in place (ALTER, no drop) -- the live policy keeps its name.
alter policy authenticated_read on public.pginvoice_clickup_entries using (
  (select pg_is_admin_tier())
  or lower(trim(user_name)) = any ((select pg_my_clickup_name_keys())::text[])
  or lower(trim(folder)) = any ((select pg_my_entry_folder_keys())::text[])
);
