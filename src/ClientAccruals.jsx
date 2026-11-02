import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Search, Download, RefreshCw, ChevronLeft, ChevronRight, Pencil, AlertTriangle } from "lucide-react";
import {
  fetchAccrualsFromSupabase, upsertAccrualCell, recomputeAccruals, downloadAccrualsWorkbook,
  currentMonthKey, monthLabelOf, shiftMonthKey, mergeLatestComments,
  acknowledgeHoursFlag, recordWriteOff, removeWriteOff, markNotInvoiced, undoNotInvoiced,
} from "./accrualsSync.js";
import { fetchClients, fetchClientEvents, statusForMonth } from "./clientsSync.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PG_CLIENTS_KEY, ACCRUALS_PREFS_KEY } from "./storageKeys.js";
import {
  cellKind, CELL_KIND_LABEL, CELL_KIND_HELP, resetKind, normalizeRange, agreedLabel, filterClients, sortClients,
  SORTS, ledgerHealth, watchReasons, accrualsWorkbookRows,
} from "./accrualsView.js";
import AccrualClientDrawer, { fmtH, balanceText } from "./AccrualClientDrawer.jsx";
import AccrualActionDialog from "./AccrualActionDialog.jsx";

const STATUS_LABEL = { active: "Active", offboarded: "Offboarded", archived: "Archived (unverified)", on_hold: "On Hold" };
const PREF_FIELDS = ["rangeMode", "signFilter", "statusFilter", "manager", "view", "sort"];
const DEFAULT_PREFS = { rangeMode: "month", signFilter: "all", statusFilter: "in_range", manager: "all", view: "all", sort: "name" };

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCRUALS_PREFS_KEY) || "{}");
    const out = { ...DEFAULT_PREFS };
    for (const k of PREF_FIELDS) if (typeof raw[k] === "string") out[k] = raw[k];
    return out;
  } catch { return { ...DEFAULT_PREFS }; }
}

// Only the fields the accrual replay reads -- a note or website edit in the Clients module
// fires the same change event but needs no recompute.
function lifecycleSignature(profiles, events) {
  return JSON.stringify([
    profiles.map((p) => [p.client, p.type, p.agreedHours, p.baseType, p.baseAgreedHours, p.status, p.clickupFolder, p.startDate, p.endDate]),
    events.map((e) => [e.id, e.client, e.kind, e.applied, e.effective_date, e.new_type, e.new_agreed_hours]),
  ]);
}

const WRITERS = {
  acknowledge: (c, mk, cell, { reason }) => acknowledgeHoursFlag(c.client, mk, cell, reason),
  write_off: (c, mk, cell, { reason, value }) => recordWriteOff(c.client, mk, cell, { value, reason }),
  remove_write_off: (c, mk, cell, { reason }) => removeWriteOff(c.client, mk, cell, reason),
  not_invoiced: (c, mk, cell, { reason, balance }) => markNotInvoiced(c.client, mk, cell, { balance, reason }),
  undo_not_invoiced: (c, mk, cell, { reason }) => undoNotInvoiced(c.client, mk, cell, reason),
};
const DONE_MSG = {
  acknowledge: "Hours change acknowledged.",
  write_off: "Write-off recorded and balances recomputed.",
  remove_write_off: "Write-off removed and balances recomputed.",
  not_invoiced: "Month marked not invoiced and balances recomputed.",
  undo_not_invoiced: "Not-invoiced mark removed and balances recomputed.",
};

// `canWrite`: admin tier only. pginvoice_accruals INSERT/UPDATE is admin-only under RLS
// (20261017_scoped_modules.sql); anyone else granted this module gets a read-only ledger --
// no auto-recompute on load, no Recompute button, no comment editing, no ledger actions.
export default function ClientAccruals({ canWrite = false }) {
  const [clients, setClients] = useState(null); // null = not loaded yet
  const [profileByClient, setProfileByClient] = useState(new Map());
  const [events, setEvents] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState(null);
  const [search, setSearch] = useState("");
  const [prefs, setPrefs] = useState(loadPrefs);
  const [month, setMonth] = useState(currentMonthKey());
  const [rangeStart, setRangeStart] = useState(shiftMonthKey(currentMonthKey(), -2));
  const [rangeEnd, setRangeEnd] = useState(currentMonthKey());
  const [editingCell, setEditingCell] = useState(null); // "client|monthKey"
  const [draftComment, setDraftComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(null); // client name with the drawer open
  const [action, setAction] = useState(null); // { kind, client, monthKey }
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const autoRecomputedRef = useRef(false);
  // One recompute at a time, auto (on load / after a lifecycle change) or the button: two
  // overlapping runs each replay from their own snapshot and race their upserts.
  const recomputeInFlightRef = useRef(false);
  const clientsRef = useRef(null);
  const signatureRef = useRef(null);
  const lifecycleTimerRef = useRef(null);
  useEffect(() => { clientsRef.current = clients; }, [clients]);

  const setPref = (k, v) => setPrefs((p) => {
    const next = { ...p, [k]: v };
    try { localStorage.setItem(ACCRUALS_PREFS_KEY, JSON.stringify(next)); } catch { /* private window etc. */ }
    return next;
  });

  // Runs recomputeAccruals under the single in-flight guard. Returns null (without running)
  // when one is already in progress. A recompute replays from a snapshot taken before it
  // started, so any comment saved while it ran is kept from current state on merge.
  async function guardedRecompute(base) {
    if (recomputeInFlightRef.current) return null;
    recomputeInFlightRef.current = true;
    setRecomputing(true);
    try {
      const result = await recomputeAccruals(base);
      setClients((prev) => mergeLatestComments(result.clients, prev));
      return result;
    } finally {
      recomputeInFlightRef.current = false;
      setRecomputing(false);
    }
  }

  async function loadProfiles() {
    const [profiles, evs] = await Promise.all([fetchClients(), fetchClientEvents()]);
    setProfileByClient(new Map(profiles.map((p) => [p.client, p])));
    setEvents(evs);
    const sig = lifecycleSignature(profiles, evs);
    const changed = signatureRef.current !== null && signatureRef.current !== sig;
    signatureRef.current = sig;
    return changed;
  }

  async function loadAndRecompute() {
    try {
      // Client profiles/events only drive the status filter, badges and the drawer -- a failure
      // there shows a warning but never blanks the ledger itself.
      const [data] = await Promise.all([
        fetchAccrualsFromSupabase(),
        loadProfiles().catch((e) => { setLoadError("Couldn't load client details (status filter and lifecycle may be incomplete): " + (e.message || e)); }),
      ]);
      if (!data) { setClients([]); return; }
      setClients(data);
      if (canWrite && !autoRecomputedRef.current && !recomputeInFlightRef.current) {
        autoRecomputedRef.current = true;
        try {
          await guardedRecompute(data);
        } catch (e) {
          // Never a silent no-op: a failure here (a timeout on the full-ClickUp-history fetch,
          // an unexpected RLS case) must show, or a stuck ledger looks merely "not updated"
          // (the Aus3C + 44 clients frozen-since-a-sync-outage incident).
          console.error("Auto-recompute failed:", e);
          setLoadError("Auto-recompute on load failed: " + (e.message || e) + " — showing last-saved figures. Try \"Recompute from ClickUp\".");
        }
      }
    } catch (e) {
      setLoadError(e.message || String(e));
      setClients((c) => c ?? []);
    }
  }

  // A type / hours / status / folder change in the Clients module (or Capacity Planning)
  // changes the accrual replay itself, so an admin's ledger recomputes (debounced) instead of
  // staying stale until someone presses Recompute. Other client edits (notes, website) only
  // refresh the profiles.
  async function onClientsChanged() {
    try {
      const changed = await loadProfiles();
      if (!changed || !canWrite) return;
      clearTimeout(lifecycleTimerRef.current);
      lifecycleTimerRef.current = setTimeout(async () => {
        if (!clientsRef.current) return;
        try {
          const result = await guardedRecompute(clientsRef.current);
          if (result) { setLoadError(null); setRecomputeMsg(`Client details changed — recomputed${result.updatedCount ? `, ${result.updatedCount} month${result.updatedCount === 1 ? "" : "s"} updated` : ", nothing to change"}.`); }
        } catch (e) {
          setLoadError("Couldn't recompute after a client change: " + (e.message || e));
        }
      }, 1500);
    } catch (e) {
      setLoadError("Couldn't refresh client details: " + (e.message || e));
    }
  }

  useEffect(() => {
    loadAndRecompute();
    // This module stays mounted for the whole session (no remount on tab switch).
    const onUpdate = (e) => { if (!e.detail || e.detail.key === PG_CLIENTS_KEY) onClientsChanged(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { window.removeEventListener(PG_DATA_EVENT, onUpdate); clearTimeout(lifecycleTimerRef.current); };
  }, []);

  const months = useMemo(() => (prefs.rangeMode === "month" ? [month] : normalizeRange(rangeStart, rangeEnd)), [prefs.rangeMode, month, rangeStart, rangeEnd]);
  const lastMonth = months[months.length - 1];

  // statusOf(name, null) = current status; (name, monthKey) = status that month from the
  // dated lifecycle events. null = no Clients-module profile.
  const statusOf = useCallback((name, mk) => {
    const p = profileByClient.get(name);
    if (!p) return null;
    return mk ? statusForMonth(p, events, mk) : p.status;
  }, [profileByClient, events]);

  const watchByClient = useMemo(() => {
    const m = new Map();
    for (const c of clients || []) {
      const p = profileByClient.get(c.client);
      m.set(c.client, watchReasons(c, lastMonth, { agreedFallback: p && (p.type === "package" || p.type === "strategy") ? p.agreedHours : null }));
    }
    return m;
  }, [clients, lastMonth, profileByClient]);
  const watchFor = useCallback((c) => watchByClient.get(c.client) || [], [watchByClient]);

  const managers = useMemo(() => [...new Set((clients || []).map((c) => c.manager).filter(Boolean))].sort(), [clients]);

  // Cards summarise everything matching the search / status / manager filters (not the sign
  // or view filters the cards themselves switch, so clicking one doesn't empty the others).
  const baseList = useMemo(() => filterClients(clients, { months, search, statusFilter: prefs.statusFilter, manager: prefs.manager, statusOf }),
    [clients, months, search, prefs.statusFilter, prefs.manager, statusOf]);
  const health = useMemo(() => ledgerHealth(baseList, months, { watchFor }), [baseList, months, watchFor]);
  const filtered = useMemo(() => sortClients(
    filterClients(baseList, { months, signFilter: prefs.signFilter, statusFilter: "all", view: prefs.view, watchFor }),
    prefs.sort, months,
  ), [baseList, months, prefs.signFilter, prefs.view, prefs.sort, watchFor]);

  async function runRecompute() {
    if (!canWrite || !clients || recomputeInFlightRef.current) return;
    setRecomputeMsg(null);
    try {
      const result = await guardedRecompute(clients);
      if (!result) return;
      setLoadError(null);
      const { updatedCount } = result;
      setRecomputeMsg(updatedCount ? `Updated ${updatedCount} month${updatedCount === 1 ? "" : "s"} from ClickUp hours.` : "Everything is already up to date.");
    } catch (e) {
      setLoadError("Couldn't recompute from ClickUp: " + (e.message || e));
    }
  }

  async function saveComment(client, monthKey) {
    if (!canWrite) return;
    setSaving(true);
    try {
      // This month's own agreed hours, never the stale client-level scalar (see CLAUDE.md).
      // No `?? null`: a cell that doesn't carry agreedHpm leaves the stored column alone --
      // sending null wiped live package months (they then read as "No package").
      await upsertAccrualCell(client.client, monthKey, { comment: draftComment || null }, { manager: client.manager, agreedHpm: client.months[monthKey]?.agreedHpm });
      setClients((prev) => prev.map((c) => (c.client !== client.client ? c : { ...c, months: { ...c.months, [monthKey]: { ...(c.months[monthKey] || {}), comment: draftComment || null } } })));
      setEditingCell(null);
    } catch (e) {
      setLoadError("Couldn't save that comment: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  // Escape closes the action dialog first, not the drawer behind it.
  const actionOpenRef = useRef(false);
  useEffect(() => { actionOpenRef.current = !!action; }, [action]);
  const closeDrawer = useCallback(() => { if (!actionOpenRef.current) setSelected(null); }, []);

  function openAction(kind, client, monthKey) {
    if (!canWrite) return;
    setActionError(null);
    setAction({ kind, clientName: client.client, monthKey });
  }

  async function confirmAction(input) {
    const c = (clients || []).find((x) => x.client === action.clientName);
    if (!c) return;
    const cell = c.months[action.monthKey] || {};
    setActionBusy(true);
    setActionError(null);
    try {
      const comment = await WRITERS[action.kind](c, action.monthKey, cell, input);
      if (action.kind === "acknowledge") {
        setClients((prev) => prev.map((x) => (x.client !== c.client ? x : { ...x, months: { ...x.months, [action.monthKey]: { ...cell, comment, hoursFlagged: false, flaggedFromHours: null } } })));
      } else {
        // Balance-changing actions: re-read the ledger (the write is already stored) and replay
        // every later month from it.
        const fresh = await fetchAccrualsFromSupabase();
        if (fresh) setClients(fresh);
        try {
          await guardedRecompute(fresh || clients);
        } catch (e) {
          setLoadError(`Saved, but the recompute failed: ${e.message || e} — press "Recompute from ClickUp".`);
        }
      }
      setRecomputeMsg(`${c.client}, ${monthLabelOf(action.monthKey)}: ${DONE_MSG[action.kind]}`);
      setAction(null);
    } catch (e) {
      setActionError(e.message || String(e));
    } finally {
      setActionBusy(false);
    }
  }

  // Months where any client carries a balance reset (macro sheet / write-off) get an extra "Reset" sub-column.
  const resetMonths = new Set(months.filter((mk) => (clients || []).some((c) => c.months[mk]?.resetValue != null)));

  function exportRange() {
    downloadAccrualsWorkbook(accrualsWorkbookRows(filtered, months), `client-accruals-${months[0]}_to_${months[months.length - 1]}`);
  }

  if (clients === null) return <div className="pg-cap-container"><div className="pg-empty">Loading…</div></div>;

  const selectedClient = selected ? clients.find((c) => c.client === selected) : null;
  const actionClient = action ? clients.find((c) => c.client === action.clientName) : null;
  const rangeReversed = prefs.rangeMode === "range" && rangeStart > rangeEnd;

  const kpi = (label, value, sub, { tone, pressed, onClick, title }) => (
    <button type="button" className="pg-kpi-card pg-acc-kpi-btn" aria-pressed={pressed} onClick={onClick} title={title}>
      <div className="pg-kpi-card__top"><span className="pg-kpi-card__label">{label}</span></div>
      <div className={`pg-kpi-card__value${tone ? ` pg-acc-kpi-value--${tone}` : ""}`}>{value}</div>
      <div className="pg-kpi-card__sub">{sub}</div>
    </button>
  );
  const toggleSign = (v) => setPref("signFilter", prefs.signFilter === v ? "all" : v);
  const toggleView = (v) => setPref("view", prefs.view === v ? "all" : v);

  return (
    <div className="pg-acc-layout">
      <div className="pg-cap-container">
        <div className="pg-app-header">
          <div>
            <span className="pg-eyebrow">Purple Giraffe · Internal</span>
            <h1 className="pg-app-header__title">Client Accruals Management</h1>
            <p className="pg-app-header__sub">The package-hours ledger, recomputed from ClickUp: each month's balance = worked − agreed + the balance carried in. Click a client for its full history{canWrite ? " and to record a write-off, a month that wasn't invoiced, or acknowledge changed hours" : ""}.</p>
          </div>
        </div>

        {loadError && <div className="pg-banner-warn">{loadError}</div>}
        {recomputeMsg && <div className="pg-acc-banner-ok" role="status">{recomputeMsg}</div>}
        {!clients.length && <div className="pg-panel">No accrual data yet.</div>}

        <div className="pg-kpi-row">
          {kpi("Owed to clients", `${fmtH(health.owedToClients)} h`, `${health.owedToClientsCount} client${health.owedToClientsCount === 1 ? "" : "s"} with unused package hours`, {
            tone: health.owedToClients ? "under" : undefined, pressed: prefs.signFilter === "negative", onClick: () => toggleSign("negative"), title: "Show only clients with unused hours (click again for all)",
          })}
          {kpi("Over-serviced", `${fmtH(health.owedByClients)} h`, `${health.owedByClientsCount} client${health.owedByClientsCount === 1 ? "" : "s"} over their package`, {
            tone: health.owedByClients ? "over" : undefined, pressed: prefs.signFilter === "positive", onClick: () => toggleSign("positive"), title: "Show only over-serviced clients (click again for all)",
          })}
          {kpi("Watch list", health.watch, "growing 3 months running, a month+ of package, or hours changed", {
            pressed: prefs.view === "watch", onClick: () => toggleView("watch"), title: "Show only clients worth a look (click again for all)",
          })}
          {kpi("Hours changes", health.flagged, "worked hours edited after a month closed", {
            tone: health.flagged ? "under" : undefined, pressed: prefs.view === "flagged", onClick: () => toggleView("flagged"), title: "Show only months with changed hours to review (click again for all)",
          })}
        </div>
        <p className="pg-footnote" style={{ marginTop: 6 }}>Totals use each client's latest balance in {months.length === 1 ? monthLabelOf(lastMonth) : `${monthLabelOf(months[0])}–${monthLabelOf(lastMonth)}`}; hours owed and hours over are summed separately, never netted.</p>

        <div className="pg-panel" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <label className="pg-field" style={{ width: 220 }}>
            <span className="pg-field__label"><Search size={11} /> Client</span>
            <input className="pg-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients or managers…" />
          </label>

          <label className="pg-field">
            <span className="pg-field__label">Range</span>
            <select className="pg-input" value={prefs.rangeMode} onChange={(e) => setPref("rangeMode", e.target.value)}>
              <option value="month">By Month</option>
              <option value="range">By Month Range</option>
            </select>
          </label>

          {prefs.rangeMode === "month" ? (
            <div className="pg-field">
              <span className="pg-field__label">Month</span>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="pg-btn-ghost" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonthKey(m, -1))}><ChevronLeft size={13} /></button>
                <span className="pg-tag">{monthLabelOf(month)}</span>
                <button className="pg-btn-ghost" aria-label="Next month" onClick={() => setMonth((m) => shiftMonthKey(m, 1))}><ChevronRight size={13} /></button>
              </div>
            </div>
          ) : (
            <>
              {[["Start", rangeStart, setRangeStart], ["End", rangeEnd, setRangeEnd]].map(([label, value, set]) => (
                <div className="pg-field" key={label}>
                  <span className="pg-field__label">{label}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button className="pg-btn-ghost" aria-label={`${label} month earlier`} onClick={() => set((m) => shiftMonthKey(m, -1))}><ChevronLeft size={13} /></button>
                    <span className="pg-tag">{monthLabelOf(value)}</span>
                    <button className="pg-btn-ghost" aria-label={`${label} month later`} onClick={() => set((m) => shiftMonthKey(m, 1))}><ChevronRight size={13} /></button>
                  </div>
                </div>
              ))}
            </>
          )}

          <label className="pg-field">
            <span className="pg-field__label">Status</span>
            <select className="pg-input" value={prefs.statusFilter} onChange={(e) => setPref("statusFilter", e.target.value)}>
              <option value="in_range">Active in range</option>
              <option value="active">Active now</option>
              <option value="on_hold">On Hold now</option>
              <option value="offboarded">Offboarded</option>
              <option value="archived">Archived (unverified)</option>
              <option value="all">All</option>
            </select>
          </label>

          <label className="pg-field">
            <span className="pg-field__label">Manager</span>
            <select className="pg-input" value={prefs.manager} onChange={(e) => setPref("manager", e.target.value)}>
              <option value="all">All</option>
              {managers.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>

          <label className="pg-field">
            <span className="pg-field__label">Balance</span>
            <select className="pg-input" value={prefs.signFilter} onChange={(e) => setPref("signFilter", e.target.value)}>
              <option value="all">All</option>
              <option value="positive">Over-serviced</option>
              <option value="negative">Unused hours</option>
            </select>
          </label>

          <label className="pg-field">
            <span className="pg-field__label">Show</span>
            <select className="pg-input" value={prefs.view} onChange={(e) => setPref("view", e.target.value)}>
              <option value="all">All clients</option>
              <option value="watch">Watch list</option>
              <option value="flagged">Hours changes</option>
            </select>
          </label>

          <label className="pg-field">
            <span className="pg-field__label">Sort</span>
            <select className="pg-input" value={prefs.sort} onChange={(e) => setPref("sort", e.target.value)}>
              {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>

          {canWrite && (
            <div className="pg-field">
              <span className="pg-field__label" style={{ visibility: "hidden" }}>Recompute</span>
              <button className="pg-btn-ghost" disabled={recomputing} onClick={runRecompute}><RefreshCw size={14} /> {recomputing ? "Recomputing…" : "Recompute from ClickUp"}</button>
            </div>
          )}
          <div className="pg-field" style={{ marginLeft: "auto" }}>
            <span className="pg-field__label" style={{ visibility: "hidden" }}>Export</span>
            <button className="pg-btn" onClick={exportRange} disabled={!filtered.length}><Download size={14} /> Export</button>
          </div>
        </div>
        {rangeReversed && <p className="pg-footnote">Start is after End — showing {monthLabelOf(months[0])} to {monthLabelOf(lastMonth)}.</p>}

        <div className="pg-cap-card" style={{ overflowX: "auto" }}>
          <table className="pg-table pg-acc-table">
            <thead>
              <tr>
                <th className="pg-acc-sticky">Client</th>
                <th>Manager</th>
                <th title="Agreed package hours in force in the month(s) shown, from each month's own ledger row">Agreed hrs</th>
                {months.map((mk) => <th key={mk} colSpan={resetMonths.has(mk) ? 5 : 4}>{monthLabelOf(mk)}</th>)}
              </tr>
              <tr>
                <th className="pg-acc-sticky" /><th /><th />
                {months.map((mk) => (
                  <React.Fragment key={mk}>
                    <th style={{ fontWeight: 400 }}>Worked</th>
                    <th style={{ fontWeight: 400 }} title="Closing balance: positive = over-serviced, negative = unused package hours">Balance</th>
                    {resetMonths.has(mk) && <th style={{ fontWeight: 400 }} title="An agreed closing balance (macro-sheet re-baseline or a write-off) — carried into next month in place of the computed balance; hover a cell for its note">Reset</th>}
                    <th style={{ fontWeight: 400 }}>Accrual %</th>
                    <th style={{ fontWeight: 400 }}>Comments</th>
                  </React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const profile = profileByClient.get(c.client);
                const status = profile?.status;
                const reasons = watchFor(c);
                return (
                  <tr key={c.client} className={selected === c.client ? "pg-acc-row--selected" : undefined}>
                    <td className="pg-acc-sticky">
                      <button type="button" className="pg-acc-client-btn" onClick={() => setSelected((s) => (s === c.client ? null : c.client))} title="Open the full ledger for this client">{c.client}</button>
                      {status && status !== "active" && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }}>{STATUS_LABEL[status] || status}</span>}
                      {!status && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }} title="No matching client profile in the Clients module">Unmatched</span>}
                      {reasons.map((r) => <span key={r.kind} className={`pg-acc-watch pg-acc-watch--${r.tone}`} title={r.detail}>{r.label}</span>)}
                    </td>
                    <td>{c.manager || "—"}</td>
                    <td className="pg-acc-num">{agreedLabel(c, months)}</td>
                    {months.map((mk) => {
                      const cell = c.months[mk] || {};
                      const kind = c.months[mk] ? cellKind(cell) : null;
                      const rk = resetKind(mk, cell);
                      const commentKey = `${c.client}|${mk}`;
                      const flagTitle = cell.hoursFlagged ? `Worked hours changed after the month closed${cell.flaggedFromHours != null ? ` (was ${fmtH(cell.flaggedFromHours)} h)` : ""}.${canWrite ? " Click to review and acknowledge." : ""}` : undefined;
                      return (
                        <React.Fragment key={mk}>
                          <td className={`pg-acc-num${cell.hoursFlagged ? " pg-acc-flagged" : ""}`} title={flagTitle}>
                            {cell.hoursFlagged ? (
                              <button type="button" className="pg-acc-flag-btn" disabled={!canWrite} onClick={() => openAction("acknowledge", c, mk)} aria-label={flagTitle}>
                                <AlertTriangle size={11} /> {fmtH(cell.workedHours)}
                              </button>
                            ) : fmtH(cell.workedHours)}
                          </td>
                          <td className="pg-acc-num" title={kind ? CELL_KIND_HELP[kind] : undefined}>
                            <span className={cell.accrualValue > 0 ? "pg-acc-pos" : cell.accrualValue < 0 ? "pg-acc-neg" : undefined}>
                              {cell.accrualValue != null ? fmtH(cell.accrualValue) : (cell.accrualNote || "—")}
                            </span>
                            {kind && kind !== "computed" && cell.accrualValue != null && <span className={`pg-acc-kind pg-acc-kind--${kind}`}>{CELL_KIND_LABEL[kind]}</span>}
                          </td>
                          {resetMonths.has(mk) && (
                            <td className="pg-acc-num" title={cell.resetValue != null ? `${rk === "macro" ? "Macro-sheet reset" : "Write-off"}${cell.resetNote ? `: ${cell.resetNote}` : ""} — next month carries ${balanceText(cell.resetValue)} instead of the computed balance` : undefined}>
                              {cell.resetValue != null ? <>{fmtH(cell.resetValue)}<span className={`pg-acc-kind pg-acc-kind--${rk}`}>{rk === "macro" ? "Macro" : "Write-off"}</span></> : ""}
                            </td>
                          )}
                          <td className="pg-acc-num">{cell.pct != null ? `${(cell.pct * 100).toFixed(1)}%` : "—"}</td>
                          <td style={{ minWidth: 200, whiteSpace: "normal" }}>
                            {!canWrite ? (
                              <span style={{ whiteSpace: "pre-wrap" }}>{cell.comment || ""}</span>
                            ) : editingCell === commentKey ? (
                              <div style={{ display: "flex", gap: 4 }}>
                                <input
                                  className="pg-input" autoFocus value={draftComment} onChange={(e) => setDraftComment(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === "Enter") saveComment(c, mk); if (e.key === "Escape") setEditingCell(null); }}
                                />
                                <button className="pg-btn-ghost" disabled={saving} onClick={() => saveComment(c, mk)}>Save</button>
                              </div>
                            ) : (
                              <button type="button" className="pg-acc-flag-btn" style={{ display: "flex", width: "100%", gap: 6, textAlign: "left" }}
                                onClick={() => { setEditingCell(commentKey); setDraftComment(cell.comment || ""); }}
                              >
                                <span style={{ flex: 1, whiteSpace: "pre-wrap" }}>{cell.comment || <span style={{ opacity: 0.5 }}>Add comment</span>}</span>
                                <Pencil size={12} />
                              </button>
                            )}
                          </td>
                        </React.Fragment>
                      );
                    })}
                  </tr>
                );
              })}
              {!filtered.length && clients.length > 0 && (
                <tr><td colSpan={3 + months.length * 5} className="pg-empty">No clients match these filters for {months.length === 1 ? monthLabelOf(lastMonth) : "this range"}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="pg-footnote">Purple Giraffe · Client Accruals Management · Balance = hours worked − agreed hours + the balance carried in, recomputed from ClickUp. Package and Strategy clients accrue; a client moving to hourly settles its balance on the hourly invoice, and an offboarded client still owed hours has wrap-up work deducted. "Active in range" includes offboarded clients that carried a balance in the months shown.</p>
      </div>

      {selectedClient && (
        <AccrualClientDrawer
          client={selectedClient} profile={profileByClient.get(selectedClient.client)} events={events}
          canWrite={canWrite} uptoMonth={lastMonth} onClose={closeDrawer} onAction={openAction}
        />
      )}
      {action && actionClient && (
        <AccrualActionDialog
          action={action.kind} client={actionClient} monthKey={action.monthKey}
          busy={actionBusy} error={actionError} onConfirm={confirmAction} onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}
