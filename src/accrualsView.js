// Pure display logic for Client Accruals Management (ClientAccruals.jsx): which ledger rows
// show, what kind of entry each cell is, agreed hours per month, sorting, the balance health
// summary and the watch list. No Supabase, no React -- pinned by accrualsView.test.js.
//
// Ledger sign convention (same as pginvoice_accruals.accrual_value): positive = the client
// used more hours than its package (over-serviced, they owe us); negative = unused package
// hours (we owe them). A month's carry-out is reset_value ?? accrual_value (carryOutOf).
import { carryOutOf, HOURLY_SETTLEMENT_NOTE } from "./format.js";
import { NOT_INVOICED_NOTE, WRAP_UP_NOTE, parseAgreedHours, shiftMonthKey, monthLabelOf } from "./accrualsSync.js";

export const ON_HOLD_NOTE = "On hold — accrual paused";
// The Aug 2026 legacy macro-sheet re-baseline month; a reset in any other month is a write-off.
export const MACRO_RESET_MONTH = "2026-08";
// Longest range the month-range picker builds (a reversed or runaway range used to render
// up to 240 month columns).
export const MAX_RANGE_MONTHS = 36;

const r2 = (x) => Math.round(x * 100) / 100;

// What kind of ledger entry a month's cell is. null = no cell.
//   not_invoiced  human override: the month's package was never billed (Comunet Sep 2026)
//   settlement    package -> hourly settlement row (Treasure Boxes Oct 2026)
//   wrap_up       offboarded client's owed hours drawn down by wrap-up work
//   on_hold       accrual paused, balance held
//   sheet         any other human override (historical figure from the original sheet)
//   ended         offboarded/archived month, no accrual
//   off_package   not on a package that month
//   computed      worked - agreed + prior from ClickUp hours
export function cellKind(cell) {
  if (!cell) return null;
  const note = cell.accrualNote || null;
  if (cell.isOverride) return note === NOT_INVOICED_NOTE ? "not_invoiced" : "sheet";
  if (note === HOURLY_SETTLEMENT_NOTE) return "settlement";
  if (note === WRAP_UP_NOTE) return "wrap_up";
  if (note === ON_HOLD_NOTE) return "on_hold";
  if (note === "Client offboarded" || note === "Client archived") return "ended";
  if (note === "Not on a package this month") return "off_package";
  return "computed";
}

export const CELL_KIND_LABEL = {
  not_invoiced: "Not invoiced",
  settlement: "Hourly settlement",
  wrap_up: "Wrap-up",
  on_hold: "On hold",
  sheet: "Sheet",
  ended: "Ended",
  off_package: "No package",
  computed: "Computed",
};

export const CELL_KIND_HELP = {
  not_invoiced: "This month's package was not invoiced: its closing balance is its worked hours against the balance carried in (no package hours).",
  settlement: "Moved from package to hourly: the package balance is settled on the hourly invoice. The figure is what's still owed after this month (0 once settled).",
  wrap_up: "Offboarded with unused hours owed: wrap-up work is deducted from the owed balance.",
  on_hold: "On hold: the accrual is paused and the balance carries forward unchanged.",
  sheet: "Historical figure entered by hand from the original sheet — never recalculated.",
  ended: "Client offboarded/archived: nothing accrues this month.",
  off_package: "Not on a package this month: nothing accrues.",
  computed: "Computed from ClickUp hours: worked - agreed + prior month's balance.",
};

// "macro" for the Aug 2026 macro-sheet re-baseline, "write_off" for any other reset.
export function resetKind(monthKey, cell) {
  if (!cell || cell.resetValue == null) return null;
  return monthKey === MACRO_RESET_MONTH ? "macro" : "write_off";
}

// A cell counts as a ledger entry for the list when it carries a figure -- 0 included (a
// balance of exactly 0, a settled hourly month or a write-off to 0 is real, and used to hide
// the client entirely).
export function hasLedgerFigure(cell) {
  return !!cell && (cell.accrualValue != null || cell.resetValue != null);
}

// Start/end in order, at most MAX_RANGE_MONTHS long (the end moves back to fit).
export function normalizeRange(start, end) {
  let s = start, e = end;
  if (s > e) [s, e] = [e, s];
  const out = [];
  for (let k = s; k <= e && out.length < MAX_RANGE_MONTHS; k = shiftMonthKey(k, 1)) out.push(k);
  return out;
}

// The agreed hours that applied in `monthKey` -- that month's own row only (never the stale
// client-level agreedHpm scalar, see CLAUDE.md). null when the month has no package.
export function agreedForMonth(client, monthKey) {
  const cell = client?.months?.[monthKey];
  if (!cell || cell.agreedHpm == null) return null;
  const n = parseAgreedHours(cell.agreedHpm);
  // A not-invoiced month is stored with agreed 0 (no package hours billed) -- not a package.
  return n === null || (n === 0 && cell.isOverride) ? null : n;
}

// Agreed-hours text for the visible months: one figure, or "16 → 13" when it changed within
// the range, or "—". Built from each month's own row only.
export function agreedLabel(client, months) {
  const seq = [];
  for (const mk of months) {
    const n = agreedForMonth(client, mk);
    if (n !== null && seq[seq.length - 1] !== n) seq.push(n);
  }
  return seq.length ? seq.join(" → ") : "—";
}

// Latest carry-out (reset ?? accrual) at or before the last month of `months`, looking only
// inside `months`. { monthKey, value } or null.
export function latestCarry(client, months) {
  for (let i = months.length - 1; i >= 0; i--) {
    const v = carryOutOf(client.months[months[i]]);
    if (v !== null) return { monthKey: months[i], value: v };
  }
  return null;
}

// Every month this client has a flagged (changed-after-close) worked-hours figure.
export function flaggedMonths(client) {
  return Object.keys(client.months).filter((mk) => client.months[mk]?.hoursFlagged).sort();
}

// ----------------------------------------------------------------------------- watch list

// Reasons a client deserves a look, as of `uptoMonth`:
//   trend  - the balance moved further the same way three months running
//   large  - the balance is at least one month of package hours either way
//   flags  - worked hours changed after a month closed and nobody has acknowledged it
export function watchReasons(client, uptoMonth, { agreedFallback = null } = {}) {
  const reasons = [];
  const keys = Object.keys(client.months).filter((k) => k <= uptoMonth).sort();
  // Last three consecutive calendar months with a figure, ending at the latest one.
  const series = [];
  for (let i = keys.length - 1; i >= 0 && series.length < 3; i--) {
    const v = carryOutOf(client.months[keys[i]]);
    if (v === null) break;
    if (series.length && shiftMonthKey(keys[i], 1) !== series[0].mk) break;
    series.unshift({ mk: keys[i], v });
  }
  if (series.length === 3) {
    const [a, b, c] = series.map((s) => s.v);
    if (a > 0 && b > a && c > b) reasons.push({ kind: "trend", tone: "over", label: "Over-servicing growing", detail: `Balance rose 3 months running (${r2(a)} → ${r2(b)} → ${r2(c)} h)` });
    else if (a < 0 && b < a && c < b) reasons.push({ kind: "trend", tone: "under", label: "Unused hours growing", detail: `Unused hours grew 3 months running (${r2(-a)} → ${r2(-b)} → ${r2(-c)} h)` });
  }
  const last = series[series.length - 1];
  if (last) {
    const agreed = agreedForMonth(client, last.mk) ?? agreedFallback;
    if (agreed && Math.abs(last.v) >= agreed) {
      reasons.push(last.v > 0
        ? { kind: "large", tone: "over", label: "Over by a month+", detail: `${r2(last.v)} h over — at least one month of package (${agreed} h)` }
        : { kind: "large", tone: "under", label: "Owed a month+", detail: `${r2(-last.v)} h unused — at least one month of package (${agreed} h)` });
    }
  }
  const flags = flaggedMonths(client).filter((k) => k <= uptoMonth);
  if (flags.length) reasons.push({ kind: "flags", tone: "warn", label: flags.length === 1 ? "Hours changed" : `Hours changed ×${flags.length}`, detail: "Worked hours changed after the month closed — review and acknowledge" });
  return reasons;
}

// ----------------------------------------------------------------------------- filtering

// statusOf(clientName, monthKey|null) -> "active" | "on_hold" | "offboarded" | "archived" | null
// (null monthKey = current status; null result = no Clients-module profile).
export function filterClients(clients, {
  months, search = "", signFilter = "all", statusFilter = "in_range", manager = "all",
  view = "all", statusOf = () => null, watchFor = null,
} = {}) {
  const q = search.trim().toLowerCase();
  return (clients || []).filter((c) => {
    if (q && !c.client.toLowerCase().includes(q) && !(c.manager || "").toLowerCase().includes(q)) return false;
    if (manager !== "all" && (c.manager || "") !== manager) return false;
    // A client with no Clients-module profile (status unknown) is never hidden by the status
    // filter -- better to surface an unmatched record than silently drop it.
    const current = statusOf(c.client, null);
    if (statusFilter === "in_range") {
      // Active / on hold now, or carrying a figure in a month of the range while active or on
      // hold then -- or drawing down owed hours after offboarding (wrap-up), which the plain
      // current-status filter used to hide.
      const live = (st) => st === "active" || st === "on_hold";
      if (current && !live(current) && !months.some((mk) => {
        const cell = c.months[mk];
        return hasLedgerFigure(cell) && (live(statusOf(c.client, mk)) || cellKind(cell) === "wrap_up");
      })) return false;
    } else if (statusFilter !== "all" && current && current !== statusFilter) return false;
    const cells = months.map((mk) => c.months[mk]);
    if (!cells.some(hasLedgerFigure)) return false;
    if (signFilter !== "all") {
      const values = cells.flatMap((cell) => [cell?.accrualValue, cell?.resetValue]).filter((v) => typeof v === "number");
      if (signFilter === "positive" && !values.some((v) => v > 0)) return false;
      if (signFilter === "negative" && !values.some((v) => v < 0)) return false;
    }
    if (view === "flagged" && !months.some((mk) => c.months[mk]?.hoursFlagged)) return false;
    if (view === "watch" && !(watchFor ? watchFor(c) : []).length) return false;
    return true;
  });
}

export const SORTS = {
  name: "Client A–Z",
  largest: "Largest balance",
  over: "Most over-serviced",
  under: "Most unused hours",
};

export function sortClients(list, sortKey, months) {
  const carry = (c) => latestCarry(c, months)?.value ?? 0;
  const by = {
    largest: (a, b) => Math.abs(carry(b)) - Math.abs(carry(a)),
    over: (a, b) => carry(b) - carry(a),
    under: (a, b) => carry(a) - carry(b),
  }[sortKey];
  const out = [...list];
  out.sort((a, b) => (by ? by(a, b) : 0) || a.client.localeCompare(b.client));
  return out;
}

// ----------------------------------------------------------------------------- health summary

// Balance health for the clients in view, at each client's latest carry within `months`.
// Owed-to and owed-by are summed separately -- a net total lets them cancel out (the
// Overview sign-cancellation bug).
export function ledgerHealth(clients, months, { watchFor = null } = {}) {
  let owedToClients = 0, owedToClientsCount = 0, owedByClients = 0, owedByClientsCount = 0, flagged = 0, watch = 0;
  for (const c of clients) {
    const lc = latestCarry(c, months);
    if (lc && lc.value < 0) { owedToClients += -lc.value; owedToClientsCount++; }
    if (lc && lc.value > 0) { owedByClients += lc.value; owedByClientsCount++; }
    flagged += months.filter((mk) => c.months[mk]?.hoursFlagged).length;
    if (watchFor && watchFor(c).length) watch++;
  }
  return { owedToClients: r2(owedToClients), owedToClientsCount, owedByClients: r2(owedByClients), owedByClientsCount, flagged, watch, clientCount: clients.length };
}

// ----------------------------------------------------------------------------- actions

// The carry into `monthKey`: the previous month's carry-out, 0 when there is none.
export function carryInto(client, monthKey) {
  return carryOutOf(client.months[shiftMonthKey(monthKey, -1)]) ?? 0;
}

// A not-invoiced month's closing balance: its worked hours against the balance carried in
// (no package hours) -- Comunet Sep 2026: 6.38 h worked, -1.80 h carried in -> 4.58 h.
export function notInvoicedBalance(client, monthKey) {
  const worked = client.months[monthKey]?.workedHours ?? 0;
  return r2(carryInto(client, monthKey) + worked);
}

// Which actions a month offers an admin. Overrides other than not-invoiced are historical
// sheet figures and left alone; the macro-sheet reset month's reset is never removed here.
export function monthActions(client, monthKey) {
  const cell = client.months[monthKey];
  const kind = cellKind(cell);
  const out = [];
  if (cell?.hoursFlagged) out.push("acknowledge");
  if (kind === "computed" && cell.agreedHpm != null) out.push("not_invoiced");
  if (kind === "not_invoiced") out.push("undo_not_invoiced");
  if (hasLedgerFigure(cell) && cell.resetValue == null) out.push("write_off");
  if (resetKind(monthKey, cell) === "write_off") out.push("remove_write_off");
  return out;
}

// ----------------------------------------------------------------------------- export

// Rows for the Excel export: the source sheet's layout (Worked / Accrued / % / Comments per
// month), plus -- only for months where an exported client has one -- a "Balance reset" and
// "Reset reason" pair and an "Entry" column naming any non-computed entry (Not invoiced,
// Hourly settlement, ...). Agreed hours come from the latest in-range month's own row, never
// the stale client-level scalar.
export function accrualsWorkbookRows(clients, monthKeys) {
  const resetMonths = new Set(monthKeys.filter((mk) => clients.some((c) => c.months[mk]?.resetValue != null)));
  const entryMonths = new Set(monthKeys.filter((mk) => clients.some((c) => { const k = cellKind(c.months[mk]); return k && k !== "computed"; })));
  const header = ["Client", "Agreed h.p.m"];
  const cols = [{ wch: 28 }, { wch: 12 }];
  for (const mk of monthKeys) {
    const label = monthLabelOf(mk);
    header.push(`Worked hrs (${label})`, `${label} Accrued`); cols.push({ wch: 12 }, { wch: 14 });
    if (entryMonths.has(mk)) { header.push(`${label} Entry`); cols.push({ wch: 18 }); }
    if (resetMonths.has(mk)) { header.push(`${label} Balance reset`, `${label} Reset reason`); cols.push({ wch: 14 }, { wch: 40 }); }
    header.push("% over/under hours", `Comments (${label})`); cols.push({ wch: 12 }, { wch: 40 });
  }
  const aoa = [["PG Weekly Hours Summary (Accumulative Total)"], [], header];
  for (const c of clients) {
    let agreed = "";
    for (let i = monthKeys.length - 1; i >= 0; i--) {
      const n = agreedForMonth(c, monthKeys[i]);
      if (n !== null) { agreed = n; break; }
    }
    const row = [c.client, agreed];
    for (const mk of monthKeys) {
      const cell = c.months[mk] || {};
      row.push(cell.workedHours ?? "", cell.accrualValue ?? cell.accrualNote ?? "");
      if (entryMonths.has(mk)) { const k = cellKind(c.months[mk]); row.push(k && k !== "computed" ? CELL_KIND_LABEL[k] : ""); }
      if (resetMonths.has(mk)) row.push(cell.resetValue ?? "", cell.resetNote ?? "");
      row.push(cell.pct ?? "", cell.comment ?? "");
    }
    aoa.push(row);
  }
  return { aoa, cols };
}
