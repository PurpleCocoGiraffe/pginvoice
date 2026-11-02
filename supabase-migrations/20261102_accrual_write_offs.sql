-- Balance resets beyond the Aug 2026 macro-sheet re-baseline (write-offs).
--
-- pginvoice_accruals.reset_value was limited to month_key = '2026-08' (the one-off legacy
-- macro-sheet re-baseline). A client's balance can also be written off by agreement, so a
-- reset is now allowed in any month AS LONG AS reset_note says why -- the note is shown on
-- hover in Client Accruals Management, Client Accruals and the exports, so nobody has to
-- guess later why a carry changed. The app math is unchanged: a month's carry-out is
-- reset_value ?? accrual_value (carryOutOf in format.js), recomputeAccruals never writes
-- reset_value, and the month's own computed accrual_value still shows as-is.
--
-- First use (applied live 2026-11-02): Coonawarra 2026-09 reset_value = 0 -- the 27.16 h
-- Sep 2026 closing balance was written off at Lynda's request, so October 2026 carries
-- nothing in (Oct closes at 1.15 h, Nov starts from that).

alter table public.pginvoice_accruals drop constraint if exists pginvoice_accruals_reset_scope_chk;
alter table public.pginvoice_accruals add constraint pginvoice_accruals_reset_scope_chk
  check (reset_value is null or month_key = '2026-08' or nullif(btrim(reset_note), '') is not null);

-- The write-off itself (data, idempotent).
update public.pginvoice_accruals
   set reset_value = 0,
       reset_note = 'Write-off: the 27.16 h Sep 2026 closing balance was written off at Lynda''s request (recorded 2 Nov 2026). October 2026 starts with 0 carried in.',
       reset_at = now(),
       comment = coalesce(nullif(comment, '') || E'\n', '') || '27.16 h accrual written off at Lynda''s request (recorded 2 Nov 2026) -- October carry set to 0.'
 where client = 'Coonawarra' and month_key = '2026-09'
   and reset_value is distinct from 0;
