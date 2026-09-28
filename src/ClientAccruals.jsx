import React, { useState, useEffect, useMemo, useRef } from "react";
import { Search, Download, RefreshCw, ChevronLeft, ChevronRight, Pencil, AlertTriangle } from "lucide-react";
import {
  fetchAccrualsFromSupabase, upsertAccrualCell, recomputeAccruals, exportAccrualsWorkbook,
  currentMonthKey, monthLabelOf, shiftMonthKey, parseAgreedHours,
} from "./accrualsSync.js";
import { fetchClients } from "./clientsSync.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PG_CLIENTS_KEY } from "./storageKeys.js";

const STATUS_LABEL = { active: "Active", offboarded: "Offboarded", archived: "Archived (unverified)", on_hold: "On Hold" };

function monthRange(start, end) {
  const out = [];
  let k = start;
  let guard = 0;
  while (guard++ < 240) {
    out.push(k);
    if (k === end) break;
    k = shiftMonthKey(k, 1);
  }
  return out;
}

const fmt = (n) => (typeof n === "number" ? (Math.round(n * 100) / 100).toLocaleString() : "—");

export default function ClientAccruals() {
  const [clients, setClients] = useState(null); // null = not loaded yet
  const [statusByClient, setStatusByClient] = useState(new Map());
  const [profileByClient, setProfileByClient] = useState(new Map());
  const [loadError, setLoadError] = useState(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState(null);
  const [search, setSearch] = useState("");
  const [rangeMode, setRangeMode] = useState("month"); // "month" | "range"
  const [month, setMonth] = useState(currentMonthKey());
  const [rangeStart, setRangeStart] = useState(shiftMonthKey(currentMonthKey(), -2));
  const [rangeEnd, setRangeEnd] = useState(currentMonthKey());
  const [signFilter, setSignFilter] = useState("all"); // "all" | "positive" | "negative"
  const [statusFilter, setStatusFilter] = useState("active"); // "active" | "offboarded" | "archived" | "all"
  const [editingCell, setEditingCell] = useState(null); // "client|monthKey"
  const [draftComment, setDraftComment] = useState("");
  const [saving, setSaving] = useState(false);
  const autoRecomputedRef = useRef(false);

  async function loadAndRecompute() {
    try {
      const [data, profiles] = await Promise.all([fetchAccrualsFromSupabase(), fetchClients()]);
      setStatusByClient(new Map(profiles.map((p) => [p.client, p.status])));
      setProfileByClient(new Map(profiles.map((p) => [p.client, p])));
      if (!data) { setClients([]); return; }
      setClients(data);
      if (!autoRecomputedRef.current) {
        autoRecomputedRef.current = true;
        try {
          const { clients: next } = await recomputeAccruals(data);
          setClients(next);
        } catch (e) {
          // Previously a silent no-op -- a real failure here (a timeout on the
          // full-ClickUp-history fetch this depends on, an unexpected RLS case, anything)
          // vanished with zero trace, leaving the page looking merely "not yet updated"
          // instead of visibly broken. Surfacing it is what made a real, multi-week-old
          // stuck-accrual incident (Aus3C and 44 other clients, frozen since a ClickUp
          // sync outage) impossible to diagnose from the UI at all.
          console.error("Auto-recompute failed:", e);
          setLoadError("Auto-recompute on load failed: " + (e.message || e) + " -- showing last-saved figures. Try \"Recompute\" below.");
        }
      }
    } catch (e) {
      setLoadError(e.message || String(e));
      setClients((c) => c ?? []);
    }
  }

  useEffect(() => {
    loadAndRecompute();
    // A consultant/status change made from Capacity Planning or the Clients module writes to
    // the same pginvoice_clients table this reads for the status filter -- refresh on that
    // signal since this module stays mounted for the whole session (no remount on tab switch).
    const onUpdate = (e) => { if (!e.detail || e.detail.key === PG_CLIENTS_KEY) loadAndRecompute(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => window.removeEventListener(PG_DATA_EVENT, onUpdate);
  }, []);

  const months = rangeMode === "month" ? [month] : monthRange(rangeStart, rangeEnd);

  const filtered = useMemo(() => {
    if (!clients) return [];
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (q && !c.client.toLowerCase().includes(q) && !(c.manager || "").toLowerCase().includes(q)) return false;
      // A client with no matching Clients-module profile (status unknown) is never hidden by
      // the status filter — better to surface an orphaned/unmatched record than silently drop it.
      const status = statusByClient.get(c.client);
      if (statusFilter !== "all" && status && status !== statusFilter) return false;
      const values = months.map((mk) => c.months[mk]?.accrualValue).filter((v) => typeof v === "number" && v !== 0);
      if (values.length === 0) return false; // months with no accrual for this client are never shown
      if (signFilter === "positive" && !values.some((v) => v > 0)) return false;
      if (signFilter === "negative" && !values.some((v) => v < 0)) return false;
      return true;
    });
  }, [clients, search, month, rangeStart, rangeEnd, rangeMode, signFilter, statusFilter, statusByClient]);

  async function runRecompute() {
    if (!clients) return;
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      const { clients: next, updatedCount } = await recomputeAccruals(clients);
      setClients(next);
      setRecomputeMsg(updatedCount ? `Updated ${updatedCount} month${updatedCount === 1 ? "" : "s"} from ClickUp hours.` : "Everything is already up to date.");
    } catch (e) {
      setLoadError("Couldn't recompute from ClickUp: " + (e.message || e));
    } finally {
      setRecomputing(false);
    }
  }

  async function saveComment(client, monthKey) {
    setSaving(true);
    try {
      await upsertAccrualCell(client.client, monthKey, { comment: draftComment || null }, { manager: client.manager, agreedHpm: client.agreedHpm });
      setClients((prev) => prev.map((c) => (c.client !== client.client ? c : { ...c, months: { ...c.months, [monthKey]: { ...(c.months[monthKey] || {}), comment: draftComment || null } } })));
      setEditingCell(null);
    } catch (e) {
      setLoadError("Couldn't save that comment: " + (e.message || e));
    } finally {
      setSaving(false);
    }
  }

  function exportRange() {
    exportAccrualsWorkbook(filtered, months, `client-accruals-${months[0]}_to_${months[months.length - 1]}`);
  }

  if (clients === null) return <div className="pg-cap-container"><div className="pg-empty">Loading…</div></div>;

  return (
    <div className="pg-cap-container">
      <div className="pg-app-header">
        <div>
          <span className="pg-eyebrow">Purple Giraffe · Internal</span>
          <h1 className="pg-app-header__title">Client Accruals</h1>
          <p className="pg-app-header__sub">Package clients only. Accrual is auto-computed from ClickUp hours each month — worked − agreed + prior — and isn't directly editable; only comments are.</p>
        </div>
      </div>

      {loadError && <div className="pg-banner-warn">{loadError}</div>}
      {recomputeMsg && <div className="pg-banner-warn" style={{ borderColor: "var(--status-ok)" }}>{recomputeMsg}</div>}
      {!clients.length && <div className="pg-panel">No package clients with accrual data yet.</div>}

      <div className="pg-panel" style={{ alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <label className="pg-field" style={{ width: 240 }}>
          <span className="pg-field__label"><Search size={11} /> Client</span>
          <input className="pg-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search clients…" />
        </label>

        <label className="pg-field">
          <span className="pg-field__label">Range</span>
          <select className="pg-input" value={rangeMode} onChange={(e) => setRangeMode(e.target.value)}>
            <option value="month">By Month</option>
            <option value="range">By Month Range</option>
          </select>
        </label>

        {rangeMode === "month" ? (
          <div className="pg-field">
            <span className="pg-field__label" style={{ visibility: "hidden" }}>Month</span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button className="pg-btn-ghost" onClick={() => setMonth((m) => shiftMonthKey(m, -1))}><ChevronLeft size={13} /></button>
              <span className="pg-tag">{monthLabelOf(month)}</span>
              <button className="pg-btn-ghost" onClick={() => setMonth((m) => shiftMonthKey(m, 1))}><ChevronRight size={13} /></button>
            </div>
          </div>
        ) : (
          <>
            <div className="pg-field">
              <span className="pg-field__label">Start</span>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="pg-btn-ghost" onClick={() => setRangeStart((m) => shiftMonthKey(m, -1))}><ChevronLeft size={13} /></button>
                <span className="pg-tag">{monthLabelOf(rangeStart)}</span>
                <button className="pg-btn-ghost" onClick={() => setRangeStart((m) => shiftMonthKey(m, 1))}><ChevronRight size={13} /></button>
              </div>
            </div>
            <div className="pg-field">
              <span className="pg-field__label">End</span>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button className="pg-btn-ghost" onClick={() => setRangeEnd((m) => shiftMonthKey(m, -1))}><ChevronLeft size={13} /></button>
                <span className="pg-tag">{monthLabelOf(rangeEnd)}</span>
                <button className="pg-btn-ghost" onClick={() => setRangeEnd((m) => shiftMonthKey(m, 1))}><ChevronRight size={13} /></button>
              </div>
            </div>
          </>
        )}

        <label className="pg-field">
          <span className="pg-field__label">Accrual sign</span>
          <select className="pg-input" value={signFilter} onChange={(e) => setSignFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="positive">Positive only</option>
            <option value="negative">Negative only</option>
          </select>
        </label>

        <label className="pg-field">
          <span className="pg-field__label">Status</span>
          <select className="pg-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="active">Active</option>
            <option value="on_hold">On Hold</option>
            <option value="offboarded">Offboarded</option>
            <option value="archived">Archived (unverified)</option>
            <option value="all">All</option>
          </select>
        </label>

        <div className="pg-field">
          <span className="pg-field__label" style={{ visibility: "hidden" }}>Recompute</span>
          <button className="pg-btn-ghost" disabled={recomputing} onClick={runRecompute}><RefreshCw size={14} /> {recomputing ? "Recomputing…" : "Recompute from ClickUp"}</button>
        </div>
        <div className="pg-field" style={{ marginLeft: "auto" }}>
          <span className="pg-field__label" style={{ visibility: "hidden" }}>Export</span>
          <button className="pg-btn" onClick={exportRange}><Download size={14} /> Export</button>
        </div>
      </div>

      <div className="pg-cap-card" style={{ overflowX: "auto" }}>
        <table className="pg-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Manager</th>
              <th>Agreed hrs</th>
              {months.map((mk) => <th key={mk} colSpan={4}>{monthLabelOf(mk)}</th>)}
            </tr>
            <tr>
              <th /><th /><th />
              {months.map((mk) => (
                <React.Fragment key={mk}>
                  <th style={{ fontWeight: 400 }}>Worked</th>
                  <th style={{ fontWeight: 400 }}>Accrual</th>
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
              // Prefer the live Clients-module profile over the historical agreed_hpm text
              // cached on old accrual rows -- that text is a snapshot from whenever it was
              // last written and doesn't update when a client's type/hours change later (e.g.
              // GPEx's rows still said "70" long after it moved off its package to hourly).
              // Strategy is the same fixed-hours accrual shape as Package (see accrualsSync.js),
              // so it's treated identically here for "does an agreed-hours accrual apply".
              const isPackageNow = profile ? (profile.type === "package" || profile.type === "strategy") : true;
              const agreedNum = profile && (profile.type === "package" || profile.type === "strategy") ? profile.agreedHours : (profile ? null : parseAgreedHours(c.agreedHpm));
              return (
                <tr key={c.client}>
                  <td>
                    {c.client}
                    {status && status !== "active" && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }}>{STATUS_LABEL[status] || status}</span>}
                    {!status && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }} title="No matching client profile in the Clients module">Unmatched</span>}
                  </td>
                  <td>{c.manager || "—"}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }} title={profile && !isPackageNow ? `Currently ${profile.type} -- not on a package, so no agreed hours apply` : undefined}>
                    {isPackageNow ? (agreedNum ?? c.agreedHpm ?? "—") : "—"}
                  </td>
                  {months.map((mk) => {
                    const cell = c.months[mk] || {};
                    const commentKey = `${c.client}|${mk}`;
                    return (
                      <React.Fragment key={mk}>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", background: cell.hoursFlagged ? "var(--status-warn-soft, rgba(230,160,40,0.15))" : undefined }}
                          title={cell.hoursFlagged ? "This month's worked hours changed since it was last computed — a timesheet entry may have been edited after the fact." : undefined}
                        >
                          {cell.hoursFlagged && <AlertTriangle size={11} style={{ marginRight: 4, verticalAlign: "-1px" }} />}
                          {fmt(cell.workedHours)}
                        </td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }} title={cell.isOverride ? "Historical figure from the original sheet" : "Computed from ClickUp hours"}>
                          {cell.accrualValue ?? cell.accrualNote ?? "—"}{cell.isOverride && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 4 }}>sheet</span>}
                        </td>
                        <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{cell.pct != null ? `${(cell.pct * 100).toFixed(1)}%` : "—"}</td>
                        <td style={{ minWidth: 200 }}>
                          {editingCell === commentKey ? (
                            <div style={{ display: "flex", gap: 4 }}>
                              <input
                                className="pg-input" autoFocus value={draftComment} onChange={(e) => setDraftComment(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") saveComment(c, mk); if (e.key === "Escape") setEditingCell(null); }}
                              />
                              <button className="pg-btn-ghost" disabled={saving} onClick={() => saveComment(c, mk)}>Save</button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                              onClick={() => { setEditingCell(commentKey); setDraftComment(cell.comment || ""); }}
                            >
                              <span style={{ flex: 1 }}>{cell.comment || <span style={{ opacity: 0.5 }}>Add comment</span>}</span>
                              <Pencil size={12} />
                            </div>
                          )}
                        </td>
                      </React.Fragment>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="pg-footnote">Purple Giraffe · Client Accruals · Accrual = hours worked − agreed hours + prior month's accrual, computed automatically each time from ClickUp. Only package clients (see the Clients module) accrue. Shows Active clients by default — use the Status filter to include offboarded or archived (unverified) ones.</p>
    </div>
  );
}
