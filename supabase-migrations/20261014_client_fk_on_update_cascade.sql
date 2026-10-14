-- Let a client be renamed in place: every table keyed on pginvoice_clients.client follows
-- the new name instead of blocking the update (pginvoice_cost_centres already did).
-- Delete behaviour is unchanged. pginvoice_accruals and the cap_clients pgLink have no
-- foreign key and are updated alongside a rename. Applied 2026-10-14, first used to rename
-- "Mary Di Marco - Ray White (Qld)" -> "Mary Di Marco (Qld)".
alter table public.pginvoice_client_events
  drop constraint pginvoice_client_events_client_fkey,
  add constraint pginvoice_client_events_client_fkey foreign key (client)
    references public.pginvoice_clients(client) on update cascade on delete cascade;
alter table public.pginvoice_user_clients
  drop constraint pginvoice_user_clients_client_fkey,
  add constraint pginvoice_user_clients_client_fkey foreign key (client)
    references public.pginvoice_clients(client) on update cascade on delete cascade;
alter table public.pginvoice_client_notes
  drop constraint pginvoice_client_notes_client_fkey,
  add constraint pginvoice_client_notes_client_fkey foreign key (client)
    references public.pginvoice_clients(client) on update cascade;
alter table public.pginvoice_client_history
  drop constraint pginvoice_client_history_client_fkey,
  add constraint pginvoice_client_history_client_fkey foreign key (client)
    references public.pginvoice_clients(client) on update cascade;
