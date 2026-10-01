// Bridges the pginvoice_accruals table into the same client/month/comment shape
// the Client Accruals module renders, and provides the manual-upload fallback
// parser + the matching xlsx exporter — mirrors the clickupSync.js pattern.
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";
import { fetchClickupFromSupabase } from "./clickupSync.js";
import { findMatch, multiFolderAccrualMatchesFor, isInternalFolder } from "./nameMatch.js";
import { fetchClients, fetchClientEvents, typeForMonth, statusForMonth, lifecycleTimeline } from "./clientsSync.js";
import { monthLabel } from "./parsers.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PG_ACCRUALS_KEY } from "./storageKeys.js";
import { carryOutOf } from "./format.js";

export { carryOutOf };

const PAGE_SIZE = 1000;

// App.jsx (Client Invoicing) reads the accrual ledger exactly once, on mount, and --
// unlike pgClients/capClients/cost-centres, which all listen for this same event to stay
// live -- had NO way to ever find out this table changed underneath it. That's a real,
// confirmed gap: Client Accruals successfully recomputing and writing corrected numbers
// (e.g. after a ClickUp sync outage got fixed) never reached Client Invoicing for the rest
// of that browser session, no matter how many times the page was revisited -- only a
// genuine fresh page load raced Client Invoicing's own quick read against Client Accruals'
// much slower full-history recompute, and Client Invoicing's read almost always won,
// showing stale pre-recompute numbers indefinitely. Broadcasting this after every write
// (single-cell edit or a full recompute) is what actually closes that gap.
function notifyAccrualsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key: PG_ACCRUALS_KEY } }));
}

// Stamped onto the reconciliation-shaped payload built from Supabase below -- a
// manually uploaded workbook's fileName is always a real filename, which never
// matches this literal, so Client Invoicing can tell the two apart after a value
// has round-tripped through IndexedDB (same pattern as clickupSync's LIVE_SYNC_LABEL).
export const ACCRUALS_LIVE_SYNC_LABEL = "Live sync from stored accruals";

// First number in strings like "24 (Aug)" or "8 (increased to 10 Aug)" — the same
// convention parseAccruedWorkbook in App.jsx already uses for the package figure.
export function parseAgreedHours(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  const m = String(raw).match(/(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

export function monthKeyOf(year, month) { return `${year}-${String(month + 1).padStart(2, "0")}`; }
export function currentMonthKey() {
  const d = new Date();
  return monthKeyOf(d.getFullYear(), d.getMonth());
}
export function monthLabelOf(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "2-digit" });
}
export function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number); // m is 1-12
  const d = new Date(y, m - 1 + delta, 1);
  return monthKeyOf(d.getFullYear(), d.getMonth());
}

export async function fetchAccrualsFromSupabase() {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pginvoice_accruals")
      .select("client, account_manager, agreed_hpm, month_key, accrual_value, accrual_note, pct_over_under, comment, worked_hours, is_override, hours_flagged, flagged_from_hours, reset_value, reset_note")
      // (client, month_key) is the table's unique key -- ordering by client alone lets a
      // client's rows tie across a page boundary and get skipped/duplicated between pages.
      .order("client", { ascending: true })
      .order("month_key", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  if (!all.length) return null;
  return rowsToClients(all);
}

// Reshapes the persistent pginvoice_accruals table into exactly the shape Client
// Invoicing's manual-upload parser (parseAccruedWorkbook in parsers.js) already
// produces -- { clients: [{ name, package, balances }], balanceCols, warnings,
// fileName } -- so the reconciliation engine can treat live Supabase-sourced
// accrual data interchangeably with an uploaded spreadsheet. This is what lets a
// new device pick up the same accrual history automatically instead of needing
// the sheet re-uploaded every time: the numbers are already being kept current
// here by recomputeAccruals() (run from the Client Accruals module), Client
// Invoicing just needs to read them the same way it reads an uploaded file.
export async function fetchAccruedForReconciliation() {
  const rows = await fetchAccrualsFromSupabase();
  if (!rows) return null;
  return { ...buildReconciliationClients(rows), warnings: [], fileName: ACCRUALS_LIVE_SYNC_LABEL };
}

// Pure reshape, split out from fetchAccruedForReconciliation so it's testable without a
// live Supabase call -- takes rowsToClients()'s per-client output, returns exactly the
// { clients, balanceCols } shape Client Invoicing's reconciliation engine reads.
export function buildReconciliationClients(rows) {
  const monthSet = new Set();
  const clients = rows.map((c) => {
    const balances = {};
    // Per-month agreed hours -- `package` below is a client-level fallback only (kept for
    // callers, like the exported-workbook shape, that genuinely want one scalar); a client
    // whose package hours changed mid-year needs the figure for the month actually being
    // viewed, not whichever row happened to be scanned last when the client-level value
    // was set (see the c.agreedHpm comment in rowsToClients -- that was the exact bug that
    // left a client's now-hourly folder still showing its old package figure forever).
    // Set for every month that has a row at all, even when its own value is null (a
    // client genuinely off-package that month) -- the caller (App.jsx) needs to tell
    // "no data for this month, fall back to the client-level scalar" apart from "this
    // month has a row and it says no package," which an `if (agreedHpm !== null)` guard
    // here can't distinguish (a `key in object` check on the sparse result reads the
    // same either way). Omitting the false case was the exact bug that left ARAS -- off
    // package since August, no row written for August's agreed_hpm -- still showing its
    // old 32 hr/month figure, pulled from the stale client-level scalar as a fallback.
    const agreedByMonth = {};
    // `balances` is each month's CARRY-OUT (reset ?? computed balance) -- every reader in
    // Client Invoicing uses it as "the prior month's balance" for the following month, so a
    // macro-sheet reset flows into Carry, the estimate fallback, the mismatch cross-check and
    // the last-month export without each of those needing its own special case.
    // `computedBalances` keeps our own system figure for display alongside a reset, and
    // `resets` flags exactly which months were re-baselined.
    const computedBalances = {};
    const resets = {};
    for (const [mk, cell] of Object.entries(c.months)) {
      monthSet.add(mk);
      const carry = carryOutOf(cell);
      if (carry !== null) balances[mk] = carry;
      if (cell.accrualValue !== null) computedBalances[mk] = cell.accrualValue;
      if (cell.resetValue != null) resets[mk] = cell.resetValue;
      agreedByMonth[mk] = cell.agreedHpm !== null ? parseAgreedHours(cell.agreedHpm) : null;
    }
    return { name: c.client, package: parseAgreedHours(c.agreedHpm), agreedByMonth, balances, computedBalances, resets };
  });
  const balanceCols = [...monthSet].sort().map((mk) => {
    const [y, m] = mk.split("-").map(Number); // m is 1-12
    return { year: y, month: m - 1, label: monthLabel(y, m - 1) }; // month here is 0-11, matching monthLabel's Date(year, month, 1)
  });
  return { clients, balanceCols };
}

export function rowsToClients(rows) {
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client)) {
      byClient.set(r.client, { client: r.client, manager: r.account_manager || null, agreedHpm: r.agreed_hpm || null, months: {} });
    }
    const c = byClient.get(r.client);
    if (r.account_manager) c.manager = r.account_manager;
    if (r.agreed_hpm) c.agreedHpm = r.agreed_hpm;
    c.months[r.month_key] = {
      accrualValue: r.accrual_value === null ? null : Number(r.accrual_value),
      accrualNote: r.accrual_note || null,
      pct: r.pct_over_under === null ? null : Number(r.pct_over_under),
      comment: r.comment || null,
      workedHours: r.worked_hours === null || r.worked_hours === undefined ? null : Number(r.worked_hours),
      isOverride: !!r.is_override,
      hoursFlagged: !!r.hours_flagged,
      // The worked hours this month was flagged against -- the flag stays until the hours
      // return to this figure (or a human clears it); see replayClientAccruals.
      flaggedFromHours: r.flagged_from_hours == null ? null : Number(r.flagged_from_hours),
      // This row's own agreed hours -- a package's hours can change mid-year (a type
      // event, or simply moving off package for a while), so the right figure for any
      // given month is THIS row's, never the client-level agreedHpm below.
      agreedHpm: r.agreed_hpm === null || r.agreed_hpm === undefined ? null : r.agreed_hpm,
      // One-off re-baseline from the legacy macro sheet (currently only ever on 2026-08,
      // enforced by a table check constraint). Same sign as accrualValue; 0 is a real value.
      // Never written by recomputeAccruals -- see carryOutOf in format.js.
      resetValue: r.reset_value == null ? null : Number(r.reset_value),
      resetNote: r.reset_note || null,
    };
  }
  return [...byClient.values()].sort((a, b) => a.client.localeCompare(b.client));
}

// Upserts a single client/month cell (used when the user edits a comment or accrual
// value in the Client Accruals module). Pass is_override: true whenever a human is
// setting the accrual value directly — recomputeAccruals then treats that month as a
// fixed baseline instead of something to keep recalculating from ClickUp hours.
export async function upsertAccrualCell(client, monthKey, patch, extra = {}) {
  const row = {
    client,
    month_key: monthKey,
    account_manager: extra.manager ?? null,
    agreed_hpm: extra.agreedHpm ?? null,
    ...patch,
  };
  const { error } = await supabase.from("pginvoice_accruals").upsert(row, { onConflict: "client,month_key" });
  if (error) throw error;
  notifyAccrualsChanged();
}

export async function upsertAccrualRows(rows) {
  if (!rows.length) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from("pginvoice_accruals").upsert(chunk, { onConflict: "client,month_key" });
    if (error) throw error;
  }
}

// -------------------------- auto-compute from live ClickUp hours --------------------------

// Which folders' minutes count toward one client's package accrual, summed per month.
// Returns Map(monthKey -> minutes), or null when nothing matched at all.
export function accrualFolderMinutesFor(clientName, clickupFolder, workedByFolderMonth, folderNames = [...workedByFolderMonth.keys()]) {
  // Some clients (Aus3C, Clarke Energy, Magain, etc.) log real work across several
  // sibling ClickUp folders instead of one umbrella folder -- sum minutes across all of
  // them per month rather than picking a single best-match folder, which was silently
  // undercounting these clients' accruals. The client's own registered folder is passed
  // through so a dynamic cost-centre client's own hours are never dropped in favour of
  // only its siblings' (see multiFolderAccrualMatchesFor).
  const multi = multiFolderAccrualMatchesFor(clientName, folderNames, clickupFolder);
  if (multi && multi.length) {
    const folderMinutes = new Map();
    for (const f of multi) {
      const fm = workedByFolderMonth.get(f);
      if (!fm) continue;
      for (const [mk, min] of fm) folderMinutes.set(mk, (folderMinutes.get(mk) || 0) + min);
    }
    return folderMinutes;
  }
  // Registered folder matched case- and whitespace-insensitively, summing every variant:
  // ClickUp folder names drift (GPEx's folder was renamed "GPEX" -> "gpex", so all of
  // September 2026's 103.57 billable hours sat under a name the exact lookup never saw and
  // the ledger recorded 0 worked; "Utter Gutters " carries a trailing space). Client
  // Invoicing already matches loosely, so the two modules disagreed.
  const ownKey = clickupFolder ? clickupFolder.trim().toLowerCase() : "";
  const ownVariants = ownKey ? folderNames.filter((f) => f.trim().toLowerCase() === ownKey) : [];
  if (ownVariants.length) {
    // The Clients module already has an authoritative, human-set folder mapping for
    // this exact client (pginvoice_clients.clickup_folder) -- prefer it over re-deriving
    // a match from the accrual sheet's own client name string. Found via a real
    // discrepancy: "Coonwarra" (the accrual sheet's name for this client) doesn't
    // fuzzy-match its real ClickUp folder "Coonawarra Grape and Wine Inc" at all (one
    // letter off, zero shared tokens after the "Grape and Wine Inc" suffix), so the old
    // name-only lookup below silently recorded 0 worked hours against a client with
    // 21.23h of real billable July work (29.02h total logged, 7.78h of it non-billable
    // and correctly excluded) -- and "PRG Strategic Advisors" vs "PRG Financial Services
    // Outsourced Marketing" hit the exact same failure mode (0 of 8.37 real billable
    // hours counted). Client Invoicing already prefers this same registered mapping for
    // exactly this reason (see pgProfileByFolder in App.jsx); accruals were the one
    // place still re-deriving the folder from the name instead of trusting it.
    if (ownVariants.length === 1) return workedByFolderMonth.get(ownVariants[0]);
    const merged = new Map();
    for (const f of ownVariants) for (const [mk, min] of workedByFolderMonth.get(f)) merged.set(mk, (merged.get(mk) || 0) + min);
    return merged;
  }
  const match = findMatch(clientName, folderNames);
  return match ? workedByFolderMonth.get(match.name) : null;
}

// Replays one client's ledger month by month from `startMonth` through `cur`, mutating
// `c.months` in place with every rebuilt cell and returning the upsert payload rows for
// whatever changed. Pure (no I/O) so the chaining rules are testable: `segFor(mk)` ->
// typeForMonth's { type, agreedHours }, `statusFor(mk)` -> statusForMonth's status string,
// `workedMinutesFor(mk)` -> this client's accrual-eligible minutes for that month.
//
// Resets: a month carrying a macro-sheet `resetValue` hands THAT figure forward as the next
// month's prior, in every branch (package, override, on hold, off package), while its own
// computed accrual_value is still recalculated and stored as normal. The reset itself is
// never part of an upsert payload (PostgREST upsert only touches listed columns, so the
// stored reset survives every recompute) -- but every rebuilt in-memory cell must carry it
// over, or a second recompute in the same session would lose it and chain from our own
// figure instead. The same goes for `comment`: only a human edits it (upsertAccrualCell), so
// it's never in a recompute payload either -- a recompute running from a snapshot taken
// before a comment was saved would otherwise write the old comment back over the new one.
//
// Offboarded/archived: a month inside one of the client's end periods (see endPeriodsFor)
// accrues nothing. Each period is `{ from, until, after, note }`: ended from month `from`
// (inclusive) up to `until` (exclusive; null = still ended). `from: null` means undated --
// the end is derived here as the month after the last "evidence" month (worked hours > 0,
// an override, or a reset) within [after, until); with no evidence in that window the whole
// window is ended. Ended months clear any existing computed row (override rows untouched)
// and only create a row when ClickUp still shows worked hours for a package-like month
// (wrap-up work) -- a cleared row, so Client Invoicing sees "no package" for that month
// instead of estimating from the stale client-level scalar. Prior restarts at 0 after an
// end (or carries a reset/override figure from the last ended month), so any on-hold
// balance in place when a client is offboarded is dropped -- intended.
export function replayClientAccruals(c, { startMonth, cur, segFor, statusFor, workedMinutesFor, endPeriods = [] }) {
  const rows = [];
  let prior = 0;
  let mk = startMonth;
  let guard = 0;
  const evidenceMonths = new Set(Object.keys(c.months).filter((k) => c.months[k]?.isOverride || c.months[k]?.resetValue != null));
  for (let k = startMonth, g = 0; k <= cur && g++ < 240; k = shiftMonthKey(k, 1)) {
    if (workedMinutesFor(k) > 0) evidenceMonths.add(k);
  }
  const periods = endPeriods.map((p) => {
    if (p.from) return p;
    let last = null;
    for (const k of evidenceMonths) {
      if ((p.after == null || k >= p.after) && (p.until == null || k < p.until) && (last === null || k > last)) last = k;
    }
    return { ...p, from: last ? shiftMonthKey(last, 1) : (p.after ?? "0000-01") };
  });
  while (mk <= cur && guard++ < 240) {
    const seg = segFor(mk);
    const existing = c.months[mk];
    const monthStatus = statusFor(mk);
    const resetValue = existing?.resetValue ?? null;
    const resetNote = existing?.resetNote ?? null;
    const endedNote = periods.find((p) => mk >= p.from && (p.until == null || mk < p.until))?.note ?? null;
    if (endedNote) {
      if (existing?.isOverride) {
        prior = resetValue ?? existing.accrualValue ?? 0;
      } else {
        const hasValues = existing && (existing.accrualValue !== null || existing.workedHours !== null);
        const wrapUpWork = !existing && (seg.type === "package" || seg.type === "strategy") && workedMinutesFor(mk) > 0;
        if (hasValues || wrapUpWork) {
          const cell = { accrualValue: null, accrualNote: endedNote, pct: null, comment: existing?.comment ?? null, workedHours: null, isOverride: false, hoursFlagged: false, flaggedFromHours: null, resetValue, resetNote };
          c.months[mk] = cell;
          rows.push({
            client: c.client, account_manager: c.manager || null, agreed_hpm: null,
            month_key: mk, accrual_value: null, accrual_note: endedNote, pct_over_under: null,
            worked_hours: null, is_override: false, hours_flagged: false, flagged_from_hours: null,
          });
        }
        prior = resetValue ?? 0;
      }
      mk = shiftMonthKey(mk, 1);
      continue;
    }
    // On hold pauses the accrual clock without erasing the balance -- unlike a genuine
    // off-package gap (below), the running balance carries forward unchanged so it picks
    // back up exactly where it left off once the client resumes. A human override is still
    // left alone regardless of status. Gated on package/strategy the same way the
    // not-on-package branch below is -- "Put On Hold" has no type restriction in the
    // Clients module UI, so an Hourly/Quoted/Project/MAP/Ad-hoc client can be put on hold
    // too; without this check, every one of that client's on-hold months got a bogus
    // "On hold — accrual paused" row written here (accrual_value 0, since it never had a
    // package to carry a real prior balance from) that made a client with no package look
    // like a package client in Client Accruals until the following recompute cycle.
    if (monthStatus === "on_hold" && (seg.type === "package" || seg.type === "strategy") && !existing?.isOverride) {
      const cell = { accrualValue: prior, accrualNote: "On hold — accrual paused", pct: null, comment: existing?.comment ?? null, workedHours: existing?.workedHours ?? null, isOverride: false,
        // Worked hours aren't recomputed while on hold, so a flag is neither raised nor
        // cleared here -- carried over as-is.
        hoursFlagged: !!existing?.hoursFlagged, flaggedFromHours: existing?.flaggedFromHours ?? null, resetValue, resetNote };
      const changed = !existing || existing.accrualValue !== cell.accrualValue || existing.accrualNote !== cell.accrualNote;
      c.months[mk] = cell;
      if (changed) {
        rows.push({
          client: c.client, account_manager: c.manager || null, agreed_hpm: seg.agreedHours != null ? String(seg.agreedHours) : null,
          month_key: mk, accrual_value: cell.accrualValue, accrual_note: cell.accrualNote, pct_over_under: null,
          worked_hours: cell.workedHours, is_override: false, hours_flagged: cell.hoursFlagged, flagged_from_hours: cell.flaggedFromHours,
        });
      }
      if (resetValue !== null) prior = resetValue;
      mk = shiftMonthKey(mk, 1);
      continue;
    }
    // Strategy is an ongoing engagement with agreed recurring hours -- the same fixed-
    // hours accrual shape as a Package -- so it accrues the same way; every other type
    // (Quoted, Project, MAP, Hourly, Ad hoc, Queensland) has no monthly accrual.
    if ((seg.type !== "package" && seg.type !== "strategy") || seg.agreedHours === null) {
      // Not on a package this month -- no accrual applies. A month that WAS package before
      // (e.g. Baintech before June, GPEx before it briefly switched to hourly) can still have
      // a stale computed row sitting in the table from back when it did apply; clear it so it
      // doesn't keep showing an accrual for a period the client wasn't actually on a package.
      // A human-entered override is presumed intentional regardless of type and is left alone.
      if (existing && !existing.isOverride && (existing.accrualValue !== null || existing.workedHours !== null)) {
        const cell = { accrualValue: null, accrualNote: "Not on a package this month", pct: null, comment: existing.comment ?? null, workedHours: null, isOverride: false, hoursFlagged: false, flaggedFromHours: null, resetValue, resetNote };
        c.months[mk] = cell;
        rows.push({
          // Not the client-level c.agreedHpm here -- that's a stale snapshot from whenever a
          // package month last wrote it and doesn't apply during a non-package period (see
          // the isPackageNow check in ClientAccruals.jsx, which now prefers the live profile
          // over this column anyway, but keep the raw data honest too).
          client: c.client, account_manager: c.manager || null, agreed_hpm: null,
          month_key: mk, accrual_value: null, accrual_note: "Not on a package this month", pct_over_under: null,
          worked_hours: null, is_override: false, hours_flagged: false, flagged_from_hours: null,
        });
      }
      // A package pause doesn't carry an accrual balance across the gap -- unless the macro
      // sheet gave this month an explicit figure, which is carried forward as-is.
      prior = resetValue ?? 0;
      mk = shiftMonthKey(mk, 1);
      continue;
    }
    const agreedNum = Number(seg.agreedHours);

    if (existing?.isOverride) {
      prior = resetValue ?? existing.accrualValue ?? prior;
    } else {
      const worked = workedMinutesFor(mk) / 60;
      const workedHours = Math.round(worked * 100) / 100;
      const accrualValue = Math.round((worked - agreedNum + prior) * 100) / 100;
      const pct = agreedNum ? Math.round((accrualValue / agreedNum) * 10000) / 10000 : null;
      const isClosedMonth = mk < cur;
      // A closed month's worked hours changing after the fact raises hours_flagged and records
      // the figure it was flagged against (flagged_from_hours). The flag is sticky: the run
      // that raises it also stores the new hours, so "stored != fresh" is false on every
      // later run -- deriving the flag from that comparison alone cleared it on the very next
      // recompute (i.e. next page load). It clears only when the hours come back to the
      // flagged-against figure, or when a human clears hours_flagged directly. A legacy flag
      // with no recorded figure (set before flagged_from_hours existed) just stays.
      let hoursFlagged = false;
      let flaggedFromHours = null;
      if (existing?.hoursFlagged) {
        const from = existing.flaggedFromHours ?? null;
        if (!(from !== null && Math.abs(workedHours - from) <= 0.01)) {
          hoursFlagged = true;
          flaggedFromHours = from;
        }
      } else if (isClosedMonth && existing?.workedHours != null && Math.abs(existing.workedHours - workedHours) > 0.01) {
        hoursFlagged = true;
        flaggedFromHours = existing.workedHours;
      }
      const cell = { accrualValue, accrualNote: null, pct, comment: existing?.comment ?? null, workedHours, isOverride: false, hoursFlagged, flaggedFromHours, resetValue, resetNote };
      const changed = !existing || existing.accrualValue !== accrualValue || existing.workedHours !== workedHours
        || !!existing.hoursFlagged !== hoursFlagged || (existing.flaggedFromHours ?? null) !== flaggedFromHours;
      c.months[mk] = cell;
      if (changed) {
        rows.push({
          // The client's *current-month* agreed hours (from typeForMonth, same value
          // agreedNum above was computed from) -- not c.agreedHpm, a stale snapshot set
          // once from whichever row happened to be scanned first in rowsToClients() and
          // never updated after. Writing that instead of agreedNum meant a package's
          // displayed hours figure could get stuck at an old value forever after a type
          // event changed it (Amorim Cork stuck at 0 after a Jul 2025 event raised it to
          // 16; Warrina Homes stuck at 24 after an Aug 2026 event dropped it to 13) even
          // though the accrual math itself (which does use agreedNum) was already correct.
          client: c.client, account_manager: c.manager || null, agreed_hpm: String(agreedNum),
          month_key: mk, accrual_value: accrualValue, accrual_note: null, pct_over_under: pct,
          worked_hours: workedHours, is_override: false, hours_flagged: hoursFlagged, flagged_from_hours: flaggedFromHours,
        });
      }
      prior = resetValue ?? accrualValue;
    }
    mk = shiftMonthKey(mk, 1);
  }
  return rows;
}

// First month a dated end takes effect: the month after the date's month, unless the date
// is the 1st (then that month itself) -- the same boundary statusForMonth applies, so a
// 2026-07-31 or 2026-08-15 offboarding still accrues its whole effective month.
function firstMonthOnOrAfter(date) {
  return date.slice(8, 10) === "01" ? date.slice(0, 7) : shiftMonthKey(date.slice(0, 7), 1);
}

// Builds the end periods replayClientAccruals skips, from applied offboarding/reactivation
// events plus the client's current status:
//   - an offboarding opens a dated period from firstMonthOnOrAfter(effective_date);
//   - a reactivation closes the open period at its own month (the reactivation month
//     accrues in full, even mid-month). A reactivation with no open period (the client was
//     archived/offboarded by a direct status edit, then reactivated) implies an undated end
//     between the previous reactivation (if any) and this one;
//   - a later type or resume event re-engages an offboarded client the same way a
//     reactivation does (closes the open period at its own month); with no open period
//     it's ordinary and implies nothing. A hold never re-engages;
//   - still offboarded/archived with no open period at the end (status set directly): an
//     open-ended period from profile.endDate when set, else undated -- unless that status
//     is just the stale leftover of an offboarding event that's already been closed.
// Hold/resume otherwise don't affect ends (statusForMonth still drives on-hold).
export function endPeriodsFor(profile, events) {
  // Same ordering rule as the client's current status (lifecycleTimeline in clientsSync.js):
  // on the same date an offboarding beats a type event.
  const statusEvents = lifecycleTimeline(events.filter((e) => e.applied), profile.client);
  const periods = [];
  let open = null;
  let holdWhileOpen = false; // a hold placed after the open offboarding -- explains an on_hold profile
  let after = null; // month of the latest reactivation -- lower bound for an undated end's evidence window
  const closedOffboardingDates = new Set();
  let openOffboardingDate = null;
  const close = (until) => {
    periods.push({ ...open, until });
    closedOffboardingDates.add(openOffboardingDate);
    open = null;
    openOffboardingDate = null;
    holdWhileOpen = false;
    after = until;
  };
  for (const e of statusEvents) {
    if (e.kind === "hold") {
      if (open) holdWhileOpen = true;
      continue;
    }
    if (e.kind === "type" || e.kind === "resume") {
      // A later type/package event re-engages an offboarded client just like a
      // reactivation does: Equippers was offboarded 2026-06-01 then re-signed as a 24h
      // package from 2026-08-01 via a type event (no "reactivation"), and the open-ended
      // offboarding period wrongly cleared its live Aug/Sep package rows. A type event
      // with no open period is ordinary and never implies an end on its own.
      if (open) close(e.effective_date.slice(0, 7));
      continue;
    }
    if (e.kind === "offboarding") {
      if (!open) {
        open = { from: firstMonthOnOrAfter(e.effective_date), until: null, after: null, note: "Client offboarded" };
        openOffboardingDate = e.effective_date;
      }
    } else if (open) {
      close(e.effective_date.slice(0, 7));
    } else {
      const until = e.effective_date.slice(0, 7);
      periods.push({ from: null, until, after, note: "Client offboarded" });
      after = until;
    }
  }
  // A client whose current status is active/on hold is demonstrably not ended, whatever
  // a stale offboarding event with nothing after it says -- never clear its current rows.
  // Except an on_hold status explained by a hold placed AFTER the offboarding: a hold
  // doesn't re-engage, so the client is still ended (offboarded 2026-10-15, hold 2026-11-01).
  const notEnded = profile.status === "active" || (profile.status === "on_hold" && !holdWhileOpen);
  if (open && notEnded) periods.push({ ...open, until: open.from });
  else if (open) periods.push(open);
  else if (profile.status === "offboarded" || profile.status === "archived") {
    // An "offboarded" profile whose end_date is exactly an offboarding event that a later
    // type/reactivation/resume already closed is stale stored state (written before the
    // client row's status was recomputed to follow re-engagement) -- not a fresh, direct
    // offboarding. Adding a trailing period for it cleared every new month without hours.
    const staleFromClosedEvent = profile.status === "offboarded" && profile.endDate && closedOffboardingDates.has(profile.endDate);
    if (!staleFromClosedEvent) {
      const note = profile.status === "archived" ? "Client archived" : "Client offboarded";
      // An end_date earlier than a later reactivation is stale (the app clears it on
      // reactivation; only a direct edit leaves it) -- treat the end as undated so the
      // evidence rule decides, rather than ending the client from the reactivation month.
      const endFrom = profile.endDate ? firstMonthOnOrAfter(profile.endDate) : null;
      const from = endFrom && after && endFrom < after ? null : endFrom;
      periods.push({ from, until: null, after, note });
    }
  }
  return periods;
}

// Chains newBalance = worked - agreedHours + prior forward, replaying every non-override
// month from each client's earliest month on file through the current one (not just gap-
// filling forward) — because a retroactive ClickUp edit to an earlier closed month changes
// that month's "prior" for everything after it. Only clients on a package that month (per
// the Clients module's type history) accrue at all; a human-entered month (is_override) is
// a frozen baseline the chain treats as fact and never recalculates. If a past, already-
// closed month's freshly-computed worked hours differ from what's stored, the row is
// updated but flagged (hours_flagged) so a retroactive timesheet edit is visible rather than
// silently changing the numbers underneath everyone.
export async function recomputeAccruals(clients) {
  const [live, profiles, events] = await Promise.all([fetchClickupFromSupabase(), fetchClients(), fetchClientEvents()]);
  if (!live) return { clients, updatedCount: 0 };

  const workedByFolderMonth = new Map(); // folder -> Map(monthKey -> minutes)
  for (const r of live.rows) {
    if (isInternalFolder(r.folder)) continue;
    if (live.hasBillable && !r.billable) continue;
    if (!r.monthKey) continue;
    if (!workedByFolderMonth.has(r.folder)) workedByFolderMonth.set(r.folder, new Map());
    const m = workedByFolderMonth.get(r.folder);
    m.set(r.monthKey, (m.get(r.monthKey) || 0) + r.minutes);
  }
  const folderNames = [...workedByFolderMonth.keys()];
  const profileByClient = new Map(profiles.map((p) => [p.client, p]));
  const cur = currentMonthKey();
  const updatedRows = [];
  const nextClients = clients.map((c) => ({ ...c, months: { ...c.months } }));

  // This only ever updated clients that already had at least one row in
  // pginvoice_accruals -- a package/strategy client added straight through the Clients
  // module (never uploaded via the accrued workbook) had no starting row to update, so it
  // silently never got one at all: correctly typed "Package" everywhere else, but
  // permanently "No package on file" in Client Invoicing. Seed an empty entry for every
  // active-or-on-hold package/strategy profile missing from the table so the loop below
  // computes its first row same as any other.
  const existingClientNames = new Set(nextClients.map((c) => c.client));
  for (const p of profiles) {
    if (existingClientNames.has(p.client)) continue;
    if (p.status !== "active" && p.status !== "on_hold") continue;
    if (p.type !== "package" && p.type !== "strategy") continue;
    nextClients.push({ client: p.client, manager: null, agreedHpm: p.agreedHours ?? null, months: {} });
  }

  for (const c of nextClients) {
    const profile = profileByClient.get(c.client);
    if (!profile) continue; // no client profile on file — nothing to compute against
    const folderMinutes = accrualFolderMinutesFor(c.client, profile.clickupFolder, workedByFolderMonth, folderNames);
    const existingMonths = Object.keys(c.months).sort();
    const startMonth = existingMonths.length ? existingMonths[0] : (profile.startDate ? profile.startDate.slice(0, 7) : cur);
    const rows = replayClientAccruals(c, {
      startMonth, cur,
      segFor: (mk) => typeForMonth(profile, events, mk),
      statusFor: (mk) => statusForMonth(profile, events, mk),
      workedMinutesFor: (mk) => folderMinutes?.get(mk) || 0,
      endPeriods: endPeriodsFor(profile, events),
    });
    for (const r of rows) updatedRows.push(r);
  }

  if (updatedRows.length) {
    await upsertAccrualRows(updatedRows);
    notifyAccrualsChanged();
  }
  return { clients: nextClients, updatedCount: updatedRows.length };
}

// Recompute results carry each cell's comment from the snapshot the run started from; a
// comment saved while it was running lives only in current state, so prefer that.
export function mergeLatestComments(next, prev) {
  if (!prev) return next;
  const prevByClient = new Map(prev.map((c) => [c.client, c]));
  return next.map((c) => {
    const p = prevByClient.get(c.client);
    if (!p) return c;
    let months = null;
    for (const [mk, cell] of Object.entries(c.months)) {
      const latest = p.months[mk]?.comment ?? null;
      if (cell && (cell.comment ?? null) !== latest) {
        months = months || { ...c.months };
        months[mk] = { ...cell, comment: latest };
      }
    }
    return months ? { ...c, months } : c;
  });
}

// -------------------------- export, same layout as the source sheet --------------------------
export function exportAccrualsWorkbook(clients, monthKeys, fileLabel) {
  // A "Reset" sub-column only for months where at least one exported client carries a
  // macro-sheet reset -- every other month keeps the source sheet's exact layout.
  const resetMonths = new Set(monthKeys.filter((mk) => clients.some((c) => c.months[mk]?.resetValue != null)));
  const header = ["Client", "Agreed h.p.m"];
  for (const mk of monthKeys) {
    header.push(`Worked hrs (${monthLabelOf(mk)})`, monthLabelOf(mk) + " Accrued");
    if (resetMonths.has(mk)) header.push(monthLabelOf(mk) + " Reset (macro sheet)");
    header.push("% over/under hours", `Comments (${monthLabelOf(mk)})`);
  }
  const aoa = [["PG Weekly Hours Summary (Accumulative Total)"], [], header];
  for (const c of clients) {
    // Prefer the most recent in-range month's own agreed_hpm over the client-level
    // scalar, which is a stale snapshot from whenever it was first written and can be
    // wrong for a client whose package hours changed mid-range (same class of bug as
    // the ARAS/Amorim Cork/Warrina Homes stale-scalar issues fixed elsewhere).
    let agreedForRange = c.agreedHpm ?? "";
    for (let i = monthKeys.length - 1; i >= 0; i--) {
      const cell = c.months[monthKeys[i]];
      if (cell && cell.agreedHpm !== null && cell.agreedHpm !== undefined) { agreedForRange = cell.agreedHpm; break; }
    }
    const row = [c.client, agreedForRange];
    for (const mk of monthKeys) {
      const cell = c.months[mk] || {};
      row.push(cell.workedHours ?? "", cell.accrualValue ?? cell.accrualNote ?? "");
      if (resetMonths.has(mk)) row.push(cell.resetValue ?? "");
      row.push(cell.pct ?? "", cell.comment ?? "");
    }
    aoa.push(row);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 28 }, { wch: 12 }, ...monthKeys.flatMap((mk) => (resetMonths.has(mk) ? [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 40 }] : [{ wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 40 }]))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Accrued Hours");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${fileLabel || "client-accruals"}.xlsx`; a.click();
  URL.revokeObjectURL(url);
}
