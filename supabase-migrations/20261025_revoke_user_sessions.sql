-- Ends every session of one user, for manage-users (password reset, role change).
-- APPLIED to fzvlnzlecchsubkpsmew on 2026-10-25 (before the manage-users that calls it).
--
-- Why: manage-users called supabase-js admin.auth.admin.signOut(userId, "global"), but that
-- method takes the user's own access token, not a user id -- so it always failed (silently,
-- behind .catch) and nobody was ever signed out. Deleting the user's auth.sessions rows
-- removes their refresh tokens (on delete cascade), so a session can't be renewed; an access
-- token already issued stays valid until it expires (JWT expiry, 1 hour by default).
--
-- Service role only: a browser must never be able to end someone else's sessions.
create or replace function public.pginvoice_revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare n integer;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

revoke all on function public.pginvoice_revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.pginvoice_revoke_user_sessions(uuid) to service_role;
