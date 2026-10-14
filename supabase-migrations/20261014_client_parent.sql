-- A cost centre / sub-project can carry its own client profile (type, hours, dated
-- transitions) while still belonging to its parent client: parent_client marks it, and
-- the Clients module / Overview never list or count such a row as a client of its own.
alter table public.pginvoice_clients
  add column if not exists parent_client text
  references public.pginvoice_clients(client) on update cascade on delete set null;

update public.pginvoice_clients
  set parent_client = 'ARAS'
  where client = 'ARAS Website Optimisation Project';
