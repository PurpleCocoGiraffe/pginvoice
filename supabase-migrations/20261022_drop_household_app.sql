-- STATUS: NOT yet applied to fzvlnzlecchsubkpsmew (two attempts timed out waiting on the
-- destructive-statement confirmation; nothing was dropped). Apply once the owner confirms.
-- Remove an unrelated household-expenses app that shared this project's public schema and
-- auth.users. Approved by the owner on 2026-10-22. Checked first, live:
--   * all 7 tables had 0 rows and had never had a row inserted;
--   * nothing in pginvoice depends on them (no views, FKs, triggers or policies);
--   * its 20 test logins (*@users.hearth.app) were last used 2026-06-18 and have no
--     pginvoice_profiles row; there are no storage buckets.
-- Not reversible (nothing to restore -- the tables were empty).

drop table if exists public.ledger_entries, public.expenses, public.weeks_home, public.away_periods,
  public.billing_periods, public.members, public.households cascade;

drop function if exists public.claim_or_create_member(text, text);
drop function if exists public.compute_member_weeks(uuid, uuid);
drop function if exists public.ensure_rent_ledger(uuid);
drop function if exists public.fn_expense_ledger();
drop function if exists public.fn_recompute_on_away();
drop function if exists public.fn_recompute_on_move_in();
drop function if exists public.fn_recompute_on_new_period();
drop function if exists public.is_household_member(uuid);
drop function if exists public.recompute_weeks_home(uuid);

-- Its test logins (never pginvoice users -- guarded so a profiled account is never touched).
delete from auth.users
where email like '%@users.hearth.app'
  and id not in (select user_id from public.pginvoice_profiles);
