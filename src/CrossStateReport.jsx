import React, { useState, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import { Download, ArrowRight, AlertTriangle } from "lucide-react";
import { idbGet, PG_DATA_EVENT } from "./idbStore.js";
import { fetchClients } from "./clientsSync.js";
import { fetchClientStates, saveClientState } from "./clientStatesSync.js";
import { SEED_PEOPLE, loadKey } from "./capacityData.js";
import { buildCrossStateReport, resolveClientState, STATES, EXTERNAL, UNKNOWN } from "./crossState.js";
import { CLICKUP_DB_KEY, CAP_PEOPLE_KEY, PG_CLIENTS_KEY, CLIENT_STATES_KEY } from "./storageKeys.js";

const fmt1 = (n) => (Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "0.0");
function monthLabelOf(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" });
}
const rowLabel = (s) => (STATES.includes(s) ? `${s} team` : s);
const colLabel = (s) => (STATES.includes(s) ? `${s} clients` : `${s} client`);
const isCross = (rowState, colState) => STATES.includes(rowState) && STATES.includes(colState) && rowState !== colState;

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("CrossStateReport error:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, padding: 24, margin: 24, color: "var(--status-over)", background: "var(--status-over-soft)", borderRadius: "var(--app-radius)", whiteSpace: "pre-wrap" }}>
          <b>Something broke while rendering this report:</b>
          {"\n\n"}{String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

function CrossStateInner({ onNavigateClients, onNavigateTeam }) {
  const [loaded, setLoaded] = useState(false);
  const [clickup, setClickup] = useState(null);
  const [people, setPeople] = useState(SEED_PEOPLE);
  const [clients, setClients] = useState([]);
  const [savedStates, setSavedStates] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [billableOnly, setBillableOnly] = useState(true);
  const [selectedCell, setSelectedCell] = useState(null); // { row, col }
  const [stateSearch, setStateSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [savingClient, setSavingClient] = useState(null);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const cu = await idbGet(CLICKUP_DB_KEY);
      if (cancelled) return;
      setClickup(cu || null);
      const errors = [];
      try { const p = await loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE); if (!cancelled) setPeople(p); } catch (e) { errors.push("consultant roster"); }
      try { const c = await fetchClients(); if (!cancelled) setClients(c); } catch (e) { errors.push("client list"); }
      try { const s = await fetchClientStates(); if (!cancelled) setSavedStates(s); } catch (e) { errors.push("saved client states"); }
      if (cancelled) return;
      setLoadError(errors.length ? `Couldn't load the ${errors.join(", ")}. Figures below may be incomplete. Try reloading the page.` : null);
      setLoaded(true);
    };
    load();
    const keys = [CLICKUP_DB_KEY, CAP_PEOPLE_KEY, PG_CLIENTS_KEY, CLIENT_STATES_KEY];
    const onUpdate = (e) => { if (!e.detail || keys.includes(e.detail.key)) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);

  const availableMonths = useMemo(() => {
    if (!clickup?.rows?.length) return [];
    return [...new Set(clickup.rows.map((r) => r.monthKey).filter(Boolean))].sort();
  }, [clickup]);

  // Default to the most recent month with data; keep a still-valid selection on reload.
  useEffect(() => {
    if (!availableMonths.length) { setRangeFrom(""); setRangeTo(""); return; }
    const last = availableMonths[availableMonths.length - 1];
    setRangeFrom((prev) => (prev && availableMonths.includes(prev) ? prev : last));
    setRangeTo((prev) => (prev && availableMonths.includes(prev) ? prev : last));
  }, [availableMonths]);

  const activeMonths = useMemo(() => {
    if (!rangeFrom || !rangeTo) return availableMonths;
    const [lo, hi] = rangeFrom <= rangeTo ? [rangeFrom, rangeTo] : [rangeTo, rangeFrom];
    return availableMonths.filter((m) => m >= lo && m <= hi);
  }, [availableMonths, rangeFrom, rangeTo]);

  const hasBillable = clickup ? clickup.hasBillable !== false : true;
  const report = useMemo(() => buildCrossStateReport(clickup?.rows || [], {
    clients, people, savedStates, billableOnly, hasBillable, months: new Set(activeMonths),
  }), [clickup, clients, people, savedStates, billableOnly, hasBillable, activeMonths]);

  const crossHours = useMemo(() => {
    let s = 0;
    for (const r of STATES) for (const c of STATES) if (r !== c) s += report.cellHours(r, c);
    return s;
  }, [report]);

  const selectedDetail = useMemo(() => {
    if (!selectedCell) return [];
    return report.detail.filter((d) => d.staffState === selectedCell.row && d.clientState === selectedCell.col);
  }, [report, selectedCell]);

  const stateRows = useMemo(() => {
    const q = stateSearch.trim().toLowerCase();
    return clients
      .filter((c) => !activeOnly || c.status === "active")
      .filter((c) => !q || c.client.toLowerCase().includes(q))
      .map((c) => ({ ...c, ...resolveClientState(c.client, savedStates) }));
  }, [clients, savedStates, stateSearch, activeOnly]);
  const stateCounts = useMemo(() => {
    const counts = { SA: 0, WA: 0, QLD: 0, defaulted: 0 };
    for (const c of stateRows) { counts[c.state] += 1; if (c.source === "default") counts.defaulted += 1; }
    return counts;
  }, [stateRows]);

  async function setState(client, state) {
    setSavingClient(client);
    setSaveError(null);
    try {
      await saveClientState(client, state);
      setSavedStates((prev) => ({ ...prev, [client]: state }));
    } catch (e) {
      setSaveError(`Couldn't save ${client}'s state: ${e.message || String(e)}`);
    } finally {
      setSavingClient(null);
    }
  }

  const periodText = activeMonths.length
    ? (activeMonths.length === 1 ? monthLabelOf(activeMonths[0]) : `${monthLabelOf(activeMonths[0])} to ${monthLabelOf(activeMonths[activeMonths.length - 1])}`)
    : "No data";

  function exportXlsx() {
    const wb = XLSX.utils.book_new();
    const hoursKind = billableOnly && hasBillable ? "Billable hours" : "All hours";
    const grid = [
      ["Purple Giraffe | Cross-state hours"],
      [`Period: ${periodText}`],
      [`Hours counted: ${hoursKind} (internal folders excluded)`],
      [`Generated: ${new Date().toLocaleString()}`],
      [],
      ["Team \\ Client", ...report.colStates.map(colLabel), "Total"],
      ...report.rowStates.map((r) => {
        const vals = report.colStates.map((c) => Number(report.cellHours(r, c).toFixed(2)));
        return [rowLabel(r), ...vals, Number(vals.reduce((a, b) => a + b, 0).toFixed(2))];
      }),
    ];
    const wsGrid = XLSX.utils.aoa_to_sheet(grid);
    wsGrid["!cols"] = [{ wch: 22 }, ...report.colStates.map(() => ({ wch: 16 })), { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsGrid, "Summary");

    const detail = [["Team state", "Client state", "Cross-state?", "Staff member", "Client", "Hours"],
      ...report.detail.map((d) => [d.staffState, d.clientState, isCross(d.staffState, d.clientState) ? "Yes" : "No", d.person, d.client, Number(d.hours.toFixed(2))])];
    const wsDetail = XLSX.utils.aoa_to_sheet(detail);
    wsDetail["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 13 }, { wch: 24 }, { wch: 36 }, { wch: 10 }];
    wsDetail["!autofilter"] = { ref: "A1:F1" };
    XLSX.utils.book_append_sheet(wb, wsDetail, "Detail");

    const states = [["Client", "Status", "State", "Source"], ...clients.map((c) => {
      const r = resolveClientState(c.client, savedStates);
      return [c.client, c.status || "", r.state, r.source === "set" ? "Confirmed" : "Default"];
    })];
    const wsStates = XLSX.utils.aoa_to_sheet(states);
    wsStates["!cols"] = [{ wch: 36 }, { wch: 12 }, { wch: 8 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsStates, "Client states");

    const tag = periodText.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    XLSX.writeFile(wb, `PG-cross-state-hours-${tag}.xlsx`);
  }

  if (!loaded) return <div className="pg-cap-container"><div className="pg-empty">Loading…</div></div>;
  const hasData = availableMonths.length > 0;

  return (
    <div className="pg-cap-container">
      <div className="pg-app-header">
        <div>
          <span className="pg-eyebrow">Purple Giraffe · Internal</span>
          <h1 className="pg-app-header__title">Cross-state hours.</h1>
          <p className="pg-app-header__sub">How many hours each office's team spent on clients based in another state. Rows are where the staff member is based, columns are where the client is based.</p>
        </div>
      </div>

      {loadError && <div className="pg-banner-warn" role="alert">{loadError}</div>}
      {!hasData && <div className="pg-banner-warn">No ClickUp data loaded yet. Open Client Invoicing once (it pulls the live ClickUp sync), then come back here.</div>}

      <div className="pg-panel" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="pg-field">
          <span className="pg-field__label">From</span>
          <select className="pg-select" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} disabled={!hasData}>
            {availableMonths.map((m) => <option key={m} value={m}>{monthLabelOf(m)}</option>)}
          </select>
        </label>
        <label className="pg-field">
          <span className="pg-field__label">To</span>
          <select className="pg-select" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} disabled={!hasData}>
            {availableMonths.map((m) => <option key={m} value={m}>{monthLabelOf(m)}</option>)}
          </select>
        </label>
        <label className="pg-field">
          <span className="pg-field__label">Hours counted</span>
          <select className="pg-select" value={billableOnly ? "billable" : "all"} onChange={(e) => setBillableOnly(e.target.value === "billable")} disabled={!hasBillable}>
            <option value="billable">Billable only</option>
            <option value="all">All logged hours</option>
          </select>
        </label>
        <button className="pg-btn" style={{ marginLeft: "auto" }} onClick={exportXlsx} disabled={!hasData}><Download size={14} /> Export Excel</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <div className="pg-cap-card" style={{ margin: 0 }}><div className="pg-stat__value">{fmt1(report.totalHours)}</div><div className="pg-stat__label">Client hours · {periodText}</div></div>
        <div className="pg-cap-card" style={{ margin: 0 }}><div className="pg-stat__value" style={{ color: "var(--accent)" }}>{fmt1(crossHours)}</div><div className="pg-stat__label">Cross-state hours</div></div>
        <div className="pg-cap-card" style={{ margin: 0 }}><div className="pg-stat__value">{report.totalHours ? Math.round((crossHours / report.totalHours) * 100) : 0}%</div><div className="pg-stat__label">Share of client hours</div></div>
      </div>

      <div className="pg-cap-card" style={{ overflowX: "auto" }}>
        <table className="pg-table">
          <thead>
            <tr>
              <th>Team ↓ / Client →</th>
              {report.colStates.map((c) => <th key={c} className="right">{colLabel(c)}</th>)}
              <th className="right">Total</th>
            </tr>
          </thead>
          <tbody>
            {report.rowStates.map((r) => {
              const total = report.colStates.reduce((a, c) => a + report.cellHours(r, c), 0);
              return (
                <tr key={r}>
                  <td style={{ fontWeight: 600, color: "var(--fg-primary)" }}>{rowLabel(r)}</td>
                  {report.colStates.map((c) => {
                    const h = report.cellHours(r, c);
                    const cross = isCross(r, c);
                    const sel = selectedCell && selectedCell.row === r && selectedCell.col === c;
                    return (
                      <td key={c} className="right num"
                        style={{
                          cursor: h > 0 ? "pointer" : "default",
                          background: sel ? "var(--accent-soft)" : cross && h > 0 ? "color-mix(in srgb, var(--accent) 8%, transparent)" : undefined,
                          color: cross && h > 0 ? "var(--accent)" : r === c || h === 0 ? "var(--fg-tertiary)" : undefined,
                          fontWeight: cross && h > 0 ? 600 : undefined,
                        }}
                        title={h > 0 ? "Click to see who and which clients" : undefined}
                        onClick={() => h > 0 && setSelectedCell(sel ? null : { row: r, col: c })}
                      >
                        {fmt1(h)}
                      </td>
                    );
                  })}
                  <td className="right num" style={{ color: "var(--fg-primary)" }}>{fmt1(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="pg-footnote" style={{ marginTop: 8 }}>{report.ownPgHours > 0 && <>Not included: {fmt1(report.ownPgHours)} hrs on Purple Giraffe's own folder (internal work). </>}Purple figures are cross-state work. Grey figures are same-state work, shown for context. Click any figure to see the breakdown.</p>
      </div>

      {selectedCell && (
        <div className="pg-cap-card" style={{ overflowX: "auto" }}>
          <div className="pg-field__label" style={{ marginBottom: 8 }}>{rowLabel(selectedCell.row)} on {colLabel(selectedCell.col)} · {periodText}</div>
          <table className="pg-table">
            <thead><tr><th>Staff member</th><th>Client</th><th className="right">Hours</th></tr></thead>
            <tbody>
              {selectedDetail.map((d) => (
                <tr key={`${d.person}|${d.client}`}><td>{d.person}</td><td>{d.client}</td><td className="right num">{fmt1(d.hours)}</td></tr>
              ))}
              <tr className="total"><td>Total</td><td /><td className="right num">{fmt1(selectedDetail.reduce((a, d) => a + d.hours, 0))}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {(report.unassignedFolders.length > 0 || report.unmatchedUsers.length > 0) && (
        <div className="pg-grid-2">
          {report.unassignedFolders.length > 0 && (
            <div className="pg-cap-card" style={{ margin: 0 }}>
              <div className="pg-field__label" style={{ display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={12} style={{ color: "var(--status-warn)" }} /> ClickUp folders not linked to any client</div>
              <p className="pg-footnote">These hours show in the "Unknown client" column. Add the client (or set its ClickUp folder) in the Clients module to fix it.</p>
              <table className="pg-table"><tbody>
                {report.unassignedFolders.map((f) => <tr key={f.folder}><td>{f.folder}</td><td className="right num">{fmt1(f.hours)}</td></tr>)}
              </tbody></table>
              {onNavigateClients && <button className="pg-btn-ghost" style={{ marginTop: 8 }} onClick={onNavigateClients}>Go to Clients <ArrowRight size={12} /></button>}
            </div>
          )}
          {report.unmatchedUsers.length > 0 && (
            <div className="pg-cap-card" style={{ margin: 0 }}>
              <div className="pg-field__label" style={{ display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={12} style={{ color: "var(--status-warn)" }} /> ClickUp users not on the consultant roster</div>
              <p className="pg-footnote">These hours show in the "Unknown" team row. Add the person (with their state) or an alias in Consultants to fix it.</p>
              <table className="pg-table"><tbody>
                {report.unmatchedUsers.map((u) => <tr key={u.user}><td>{u.user}</td><td className="right num">{fmt1(u.hours)}</td></tr>)}
              </tbody></table>
              {onNavigateTeam && <button className="pg-btn-ghost" style={{ marginTop: 8 }} onClick={onNavigateTeam}>Go to Consultants <ArrowRight size={12} /></button>}
            </div>
          )}
        </div>
      )}

      {report.estimatedFolders.length > 0 && (
        <details className="pg-cap-card">
          <summary className="pg-field__label" style={{ cursor: "pointer" }}>{report.estimatedFolders.length} ClickUp folder{report.estimatedFolders.length === 1 ? "" : "s"} linked to a client by name only (check these)</summary>
          <p className="pg-footnote">No client has these set as its ClickUp folder, so they were matched by similar name. Setting the folder on the client in the Clients module makes the link exact.</p>
          <table className="pg-table">
            <thead><tr><th>ClickUp folder</th><th>Counted under</th><th className="right">Hours</th></tr></thead>
            <tbody>{report.estimatedFolders.map((f) => <tr key={f.folder}><td>{f.folder}</td><td>{f.client}</td><td className="right num">{fmt1(f.hours)}</td></tr>)}</tbody>
          </table>
        </details>
      )}

      <div className="pg-cap-card">
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
          <div>
            <div className="pg-field__label">Client states</div>
            <p className="pg-footnote" style={{ margin: "4px 0 0" }}>
              {stateCounts.SA} SA · {stateCounts.WA} WA · {stateCounts.QLD} QLD
              {stateCounts.defaulted > 0 && <> · <span style={{ color: "var(--status-warn)" }}>{stateCounts.defaulted} still on the default</span></>}
            </p>
          </div>
          <label className="pg-field" style={{ marginLeft: "auto" }}>
            <span className="pg-field__label">Search</span>
            <input className="pg-input" value={stateSearch} onChange={(e) => setStateSearch(e.target.value)} placeholder="Client name…" />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active clients only
          </label>
        </div>
        {saveError && <div className="pg-banner-warn" role="alert">{saveError}</div>}
        <div style={{ maxHeight: 420, overflow: "auto" }}>
          <table className="pg-table">
            <thead><tr><th>Client</th><th>State</th><th>Source</th></tr></thead>
            <tbody>
              {stateRows.length === 0 && <tr><td colSpan={3} className="empty">No clients match.</td></tr>}
              {stateRows.map((c) => (
                <tr key={c.client}>
                  <td>{c.client}{c.status !== "active" && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 6 }}>{c.status}</span>}</td>
                  <td>
                    <select className="pg-select" value={c.state} disabled={savingClient === c.client} onChange={(e) => setState(c.client, e.target.value)} aria-label={`${c.client} state`}>
                      {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td>{c.source === "set" ? <span className="pg-tag">Confirmed</span> : <span className="pg-tag pg-tag--muted" title="From the starting list. Pick a state to confirm it.">Default</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="pg-footnote">
        Purple Giraffe · Cross-state hours · Internal folders (onboarding, WIP, handover) are excluded. {EXTERNAL} is the shared "Purple Giraffe" ClickUp login used by the external contractor, so it isn't counted as any office's team. {UNKNOWN} means the person or client couldn't be matched yet. History goes back as far as the ClickUp data currently loaded.
      </p>
    </div>
  );
}

export default function CrossStateReport(props) {
  return <ErrorBoundary><CrossStateInner {...props} /></ErrorBoundary>;
}
