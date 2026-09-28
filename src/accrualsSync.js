// Bridges the pginvoice_accruals table into the same client/month/comment shape
// the Client Accruals module renders, and provides the manual-upload fallback
// parser + the matching xlsx exporter — mirrors the clickupSync.js pattern.
import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";
import { fetchClickupFromSupabase } from "./clickupSync.js";
import { findMatch, multiFolderAccrualMatchesFor, isInternalFolder } from "./nameMatch.js";
import { fetchClients, fetchClientEvents, typeForMonth, statusForMonth } from "./clientsSync.js";
import { monthLabel } from "./parsers.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PG_ACCRUALS_KEY } from "./storageKeys.js";

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
      .select("client, account_manager, agreed_hpm, month_key, accrual_value, accrual_note, pct_over_under, comment, worked_hours, is_override, hours_flagged")
      .order("client", { ascending: true })
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
    for (const [mk, cell] of Object.entries(c.months)) {
      monthSet.add(mk);
      if (cell.accrualValue !== null) balances[mk] = cell.accrualValue;
      agreedByMonth[mk] = cell.agreedHpm !== null ? parseAgreedHours(cell.agreedHpm) : null;
    }
    return { name: c.client, package: parseAgreedHours(c.agreedHpm), agreedByMonth, balances };
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
      // This row's own agreed hours -- a package's hours can change mid-year (a type
      // event, or simply moving off package for a while), so the right figure for any
      // given month is THIS row's, never the client-level agreedHpm below.
      agreedHpm: r.agreed_hpm === null || r.agreed_hpm === undefined ? null : r.agreed_hpm,
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
    // Some clients (Aus3C, Clarke Energy, Magain, etc.) log real work across several
    // sibling ClickUp folders instead of one umbrella folder -- sum minutes across all of
    // them per month rather than picking a single best-match folder, which was silently
    // undercounting these clients' accruals.
    const multi = multiFolderAccrualMatchesFor(c.client, folderNames);
    let folderMinutes = null;
    if (multi && multi.length) {
      folderMinutes = new Map();
      for (const f of multi) {
        const fm = workedByFolderMonth.get(f);
        if (!fm) continue;
        for (const [mk, min] of fm) folderMinutes.set(mk, (folderMinutes.get(mk) || 0) + min);
      }
    } else if (profile.clickupFolder && workedByFolderMonth.has(profile.clickupFolder)) {
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
      folderMinutes = workedByFolderMonth.get(profile.clickupFolder);
    } else {
      const match = findMatch(c.client, folderNames);
      folderMinutes = match ? workedByFolderMonth.get(match.name) : null;
    }

    const existingMonths = Object.keys(c.months).sort();
    const startMonth = existingMonths.length ? existingMonths[0] : (profile.startDate ? profile.startDate.slice(0, 7) : cur);

    let prior = 0;
    let mk = startMonth;
    let guard = 0;
    while (mk <= cur && guard++ < 240) {
      const seg = typeForMonth(profile, events, mk);
      const existing = c.months[mk];
      const monthStatus = statusForMonth(profile, events, mk);
      // On hold pauses the accrual clock without erasing the balance -- unlike a genuine
      // off-package gap (below), the running balance carries forward unchanged so it picks
      // back up exactly where it left off once the client resumes. A human override is still
      // left alone regardless of status.
      if (monthStatus === "on_hold" && !existing?.isOverride) {
        const cell = { accrualValue: prior, accrualNote: "On hold — accrual paused", pct: null, comment: existing?.comment ?? null, workedHours: existing?.workedHours ?? null, isOverride: false, hoursFlagged: false };
        const changed = !existing || existing.accrualValue !== cell.accrualValue || existing.accrualNote !== cell.accrualNote;
        c.months[mk] = cell;
        if (changed) {
          updatedRows.push({
            client: c.client, account_manager: c.manager || null, agreed_hpm: seg.agreedHours != null ? String(seg.agreedHours) : null,
            month_key: mk, accrual_value: cell.accrualValue, accrual_note: cell.accrualNote, pct_over_under: null,
            comment: cell.comment, worked_hours: cell.workedHours, is_override: false, hours_flagged: false,
          });
        }
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
          const cell = { accrualValue: null, accrualNote: "Not on a package this month", pct: null, comment: existing.comment ?? null, workedHours: null, isOverride: false, hoursFlagged: false };
          c.months[mk] = cell;
          updatedRows.push({
            // Not the client-level c.agreedHpm here -- that's a stale snapshot from whenever a
            // package month last wrote it and doesn't apply during a non-package period (see
            // the isPackageNow check in ClientAccruals.jsx, which now prefers the live profile
            // over this column anyway, but keep the raw data honest too).
            client: c.client, account_manager: c.manager || null, agreed_hpm: null,
            month_key: mk, accrual_value: null, accrual_note: "Not on a package this month", pct_over_under: null,
            comment: cell.comment, worked_hours: null, is_override: false, hours_flagged: false,
          });
        }
        prior = 0; // a package pause doesn't carry an accrual balance across the gap
        mk = shiftMonthKey(mk, 1);
        continue;
      }
      const agreedNum = Number(seg.agreedHours);

      if (existing?.isOverride) {
        prior = existing.accrualValue ?? prior;
      } else {
        const worked = (folderMinutes?.get(mk) || 0) / 60;
        const workedHours = Math.round(worked * 100) / 100;
        const accrualValue = Math.round((worked - agreedNum + prior) * 100) / 100;
        const pct = agreedNum ? Math.round((accrualValue / agreedNum) * 10000) / 10000 : null;
        const isClosedMonth = mk < cur;
        const hoursFlagged = isClosedMonth && existing?.workedHours != null && Math.abs(existing.workedHours - workedHours) > 0.01;
        const cell = { accrualValue, accrualNote: null, pct, comment: existing?.comment ?? null, workedHours, isOverride: false, hoursFlagged };
        const changed = !existing || existing.accrualValue !== accrualValue || existing.workedHours !== workedHours;
        c.months[mk] = cell;
        if (changed) {
          updatedRows.push({
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
            comment: cell.comment, worked_hours: workedHours, is_override: false, hours_flagged: hoursFlagged,
          });
        }
        prior = accrualValue;
      }
      mk = shiftMonthKey(mk, 1);
    }
  }

  if (updatedRows.length) {
    await upsertAccrualRows(updatedRows);
    notifyAccrualsChanged();
  }
  return { clients: nextClients, updatedCount: updatedRows.length };
}

// -------------------------- export, same layout as the source sheet --------------------------
export function exportAccrualsWorkbook(clients, monthKeys, fileLabel) {
  const header = ["Client", "Agreed h.p.m"];
  for (const mk of monthKeys) header.push(`Worked hrs (${monthLabelOf(mk)})`, monthLabelOf(mk) + " Accrued", "% over/under hours", `Comments (${monthLabelOf(mk)})`);
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
      row.push(cell.workedHours ?? "", cell.accrualValue ?? cell.accrualNote ?? "", cell.pct ?? "", cell.comment ?? "");
    }
    aoa.push(row);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 28 }, { wch: 12 }, ...monthKeys.flatMap(() => [{ wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 40 }])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Accrued Hours");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${fileLabel || "client-accruals"}.xlsx`; a.click();
  URL.revokeObjectURL(url);
}
