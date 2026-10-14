import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  Search, ChevronLeft, ChevronRight, ChevronDown, Calendar, LayoutGrid, Table2, ClipboardPaste, Download,
  FileSpreadsheet, FileText, Lock, Unlock, RefreshCw, AlertTriangle, X, Settings2, ListChecks,
} from "lucide-react";
import { OverviewKpiCard } from "./OverviewKpiCard.jsx";
import { ExportItem } from "./ExportItem.jsx";
import { PersonAvatar } from "./avatar.jsx";
import { useDismissable, useEscape, useFocusTrap } from "./useDismissable.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { CAP_PEOPLE_KEY, CAP_LEAVES_KEY, LEAVE_ENTRIES_KEY, WAGES_PREFS_KEY } from "./storageKeys.js";
import { timeAgo } from "./format.js";
import { adelaideMonthKey, adelaideDayOfMonth, monthOffsetFor } from "./dateMath.js";
import {
  buildMonthView, buildSnapshot, groupLines, filterLines, computeTotals, hasExpected,
  toWorkbookRows, WORKBOOK_HEADINGS, WAGE_STATES,
} from "./wagesView.js";
import {
  loadWagesMonth, WAGE_SOURCES, ESSENTIAL_LIVE_SOURCES, upsertLine, upsertPerson, saveXeroNameMap,
  closeMonth, reopenMonth, resyncClickupMonth,
} from "./wagesSync.js";
import { fmtH, fmtSigned, fmtPct, fmtDay, monthLabel } from "./wagesFormat.js";
import { WageCard, StatusPill, ReviewDots, overUnderText, expectedText, TabBar, tabPanelProps } from "./WageCard.jsx";
import { WageDrawer, HoursInput } from "./WageDrawer.jsx";
import { XeroPasteDialog } from "./XeroPasteDialog.jsx";
import { WageSettings } from "./WageSettings.jsx";

const FIRST_MONTH = "2025-06";
const shiftMonth = (mk, d) => {
  const [y, m] = mk.split("-").map(Number);
  const t = y * 12 + (m - 1) + d;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
// Kelly reconciles last month in the first half of the month; after the 15th the
// current month is the more likely one being looked at.
function defaultMonth() {
  const cur = adelaideMonthKey();
  return adelaideDayOfMonth() <= 15 ? shiftMonth(cur, -1) : cur;
}

const DEFAULT_PREFS = { q: "", state: "all", type: "all", status: "all", view: "cards" };
function loadPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(window.localStorage.getItem(WAGES_PREFS_KEY) || "{}") }; } catch (e) { return DEFAULT_PREFS; }
}

const STATUS_FILTERS = [
  ["all", "All statuses"], ["attention", "Needs attention"], ["awaiting_xero", "Awaiting Xero"], ["check_sync", "Check sync"],
  ["over", "Over"], ["under", "Under"], ["ok", "OK"], ["not_assessed", "Not assessed"],
];
const sourceLabel = (k) => WAGE_SOURCES.find((s) => s.key === k)?.label || k;
const PAGE_TABS = [
  { key: "review", label: "Review", icon: ListChecks },
  { key: "settings", label: "Settings", icon: Settings2 },
];
// The plain-data sources object buildMonthView takes, from loadWagesMonth's
// { key: {data, error} } result. A failed source is passed as undefined, never as empty.
const sourceData = (loaded) => {
  const pick = (k) => (loaded[k] && !loaded[k].error ? loaded[k].data : undefined);
  return {
    roster: pick("roster"), capLeaves: pick("capLeaves"), wagePeople: pick("wagePeople"), rules: pick("rules"),
    settings: pick("settings"), monthRow: pick("monthRow"), lines: pick("lines"), leaveEntries: pick("leaveEntries"), clickupSummary: pick("clickupSummary"),
    clients: pick("clients"),
  };
};

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("WagesReview error:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, padding: 24, margin: 24, color: "var(--status-over)", background: "var(--status-over-soft)", borderRadius: "var(--app-radius)", whiteSpace: "pre-wrap" }}>
          <b>Something broke while rendering Wages review:</b>
          {"\n\n"}{String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}
          {"\n\n"}{this.state.error && this.state.error.stack}
        </div>
      );
    }
    return this.props.children;
  }
}

/* ---------------------------------------------------------------- small pieces --------- */
function Banner({ tone = "warn", icon: Icon = AlertTriangle, children, action }) {
  return (
    <div className={`wr-banner wr-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={14} aria-hidden="true" />
      <div className="wr-banner__body">{children}</div>
      {action}
    </div>
  );
}

function ExportMenu({ disabled, onWorkbook, onCsv }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable(close);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className="pg-pill" disabled={disabled} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Download size={13} className="pg-pill__icon" /> Export <ChevronDown size={13} className="pg-pill__chevron" />
      </button>
      {open && (
        <div className="pg-menu" role="menu">
          <ExportItem icon={<FileSpreadsheet size={14} />} label="Workbook layout (.xlsx, columns A–Y)" onClick={() => { setOpen(false); onWorkbook(); }} />
          <ExportItem icon={<FileText size={14} />} label="CSV" onClick={() => { setOpen(false); onCsv(); }} />
        </div>
      )}
    </div>
  );
}

function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose, disabled, busy, error }) {
  useEscape(onClose);
  const dialogRef = useFocusTrap();
  return (
    <>
      <div className="wr-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={dialogRef} tabIndex={-1} className="wr-modal wr-modal--small" role="dialog" aria-modal="true" aria-labelledby="wr-confirm-title">
        <div className="wr-modal__head">
          <h2 id="wr-confirm-title" className="wr-modal__title">{title}</h2>
          <button type="button" className="wr-iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="wr-modal__foot">
          <button type="button" className="pg-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="pg-btn" disabled={disabled || busy} onClick={onConfirm}>{busy ? "Working…" : confirmLabel}</button>
        </div>
      </div>
    </>
  );
}

function MapToPicker({ userName, people, onMap }) {
  const [state, setState] = useState({ saving: false, error: null });
  return (
    <span className="wr-inline">
      <select className="pg-select wr-select" aria-label={`Map ClickUp user ${userName} to a person`} value="" disabled={state.saving}
        onChange={async (e) => {
          const pid = e.target.value; if (!pid) return;
          setState({ saving: true, error: null });
          try { await onMap(userName, pid); setState({ saving: false, error: null }); }
          catch (err) { setState({ saving: false, error: err?.message || String(err) }); }
        }}>
        <option value="">Map to…</option>
        {people.map((p) => <option key={p.person_id} value={p.person_id}>{p.name}</option>)}
      </select>
      {state.error && <span className="wr-field-state wr-field-state--error" role="alert">{state.error}</span>}
    </span>
  );
}

/* ---------------------------------------------------------------- table view ------------ */
const COLS = [
  { key: "person", label: "Person", tip: "Column A · Employee" },
  { key: "type", label: "Type · State", tip: "Columns C and B" },
  { key: "S", label: "Expected", tip: "Column S · Should be", num: true },
  { key: "L", label: "Xero", tip: "Column L · Xero hours (editable)", num: true },
  { key: "leave", label: "Leave", tip: "Columns N + O + P (+ untyped)", num: true },
  { key: "Q", label: "PH", tip: "Column Q · Public holiday", num: true },
  { key: "R", label: "Accounted", tip: "Column R · Total = L + N + O + P + Q", num: true },
  { key: "T", label: "Over / under", tip: "Column T · Variance = R − S", num: true },
  { key: "H", label: "ClickUp", tip: "Column H · ClickUp total", num: true },
  { key: "M", label: "Gap", tip: "Column M · Xero − ClickUp", num: true },
  { key: "J", label: "Client %", tip: "Column J · Client billed ÷ ClickUp total", num: true },
  { key: "K", label: "Billable %", tip: "Column K · All billable ÷ ClickUp total", num: true },
  { key: "review", label: "Review", tip: "Columns V–Y · KW, LS, Phil, KW round 2" },
  { key: "status", label: "Status" },
];
const leaveTotal = (l) => (Number(l.N) || 0) + (Number(l.O) || 0) + (Number(l.P) || 0) + (Number(l.unspecified) || 0);
const sumKnown = (ls, f) => { const v = ls.map(f).filter((x) => x != null); return v.length ? v.reduce((s, x) => s + Number(x), 0) : null; };

function WagesTable({ lines, closed, onSaveLine, onOpen }) {
  const t = computeTotals(lines);
  return (
    <div className="wr-table-scroll">
      <table className="pg-table wr-table">
        <thead>
          <tr>{COLS.map((c) => <th key={c.key} className={c.num ? "right num" : undefined} title={c.tip} scope="col">{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {lines.length === 0 && <tr><td colSpan={COLS.length} className="empty">No one matches these filters.</td></tr>}
          {lines.map((l) => {
            const ou = overUnderText(l);
            return (
              <tr key={l.person_id}>
                <th scope="row" className="wr-table__person">
                  <button type="button" className="wr-table__name" onClick={() => onOpen(l.person_id)}>
                    <PersonAvatar name={l.name} photo={l.photo} size={24} /> {l.name}
                  </button>
                </th>
                <td>{l.typeShort || "No rule"} · {l.state || "?"}</td>
                <td className="right num">{expectedText(l)}</td>
                <td className="right num">
                  <HoursInput compact label={`Xero hours for ${l.name}`} value={l.L} disabled={closed}
                    onSave={(v) => onSaveLine(l.person_id, { xero_hours: v, xero_source: v == null ? null : "manual" })} />
                </td>
                <td className="right num">{fmtH(leaveTotal(l))}{l.unspecified > 0 && <AlertTriangle size={11} className="wr-warn-icon" aria-label="includes untyped leave" />}</td>
                <td className="right num">{fmtH(l.Q)}</td>
                <td className="right num">{fmtH(l.R)}</td>
                <td className="right num" title={ou.sub}>{ou.value}</td>
                <td className="right num">{fmtH(l.H)}</td>
                <td className="right num">{fmtSigned(l.M, 2)}</td>
                <td className="right num">{fmtPct(l.J)}</td>
                <td className="right num">{fmtPct(l.K)}</td>
                <td><ReviewDots line={l} /></td>
                <td><StatusPill status={l.status} compact /></td>
              </tr>
            );
          })}
        </tbody>
        {lines.length > 0 && (
          <tfoot>
            <tr className="total">
              <th scope="row" className="wr-table__person">Team ({t.people})</th>
              <td />
              <td className="right num">{fmtH(sumKnown(lines, (l) => (hasExpected(l) ? l.S : null)))}</td>
              <td className="right num">{fmtH(t.L)}</td>
              <td className="right num">{fmtH(lines.reduce((s, l) => s + leaveTotal(l), 0))}</td>
              <td className="right num">{fmtH(sumKnown(lines, (l) => l.Q))}</td>
              <td className="right num">{fmtH(sumKnown(lines, (l) => l.R))}</td>
              <td className="right num" title="Net over/under of assessed people">{fmtSigned(t.netT)}</td>
              <td className="right num">{fmtH(t.H)}</td>
              <td className="right num">{fmtSigned(sumKnown(lines, (l) => l.M), 2)}</td>
              <td className="right num">{fmtPct(t.J)}</td>
              <td className="right num">{fmtPct(t.K)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------- export ---------------- */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
// Percentage columns J and K (fractions in the data). Column I ("% billed total") stays
// blank: it's in the workbook's layout but not used in the workbook.
const PCT_COLUMNS = ["% billed client", "% billed (with PG)"].map((h) => WORKBOOK_HEADINGS.indexOf(h));
const COMMENT_COL_START = WORKBOOK_HEADINGS.indexOf("PG");
function workbookSheet(view) {
  const people = view.lines.map((l) => ({ person_id: l.person_id, display_name: l.name, state: l.state, type: l.typeLabel }));
  // S and T blanks (no rule, not assessable) are decided from the data in toWorkbookRows.
  const rows = toWorkbookRows(view.lines, people);
  const aoa = [WORKBOOK_HEADINGS, ...rows.map((r) => WORKBOOK_HEADINGS.map((h) => r[h]))];
  aoa.push([]);
  aoa.push([`Standard hours: ${view.weekdays} weekdays × ${view.perDay} = ${view.standardHours} h`]);
  aoa.push([`${monthLabel(view.monthKey, true)} · ${view.closed ? "Closed" : "Draft"} · exported ${new Date().toLocaleString("en-AU")}`]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // J and K are fractions; show them as percentages like the workbook does.
  for (let r = 1; r <= rows.length; r++) {
    for (const c of PCT_COLUMNS) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = "0.0%";
    }
  }
  ws["!cols"] = WORKBOOK_HEADINGS.map((h, i) => ({ wch: i === 0 ? 22 : i >= COMMENT_COL_START ? 30 : Math.max(9, Math.min(18, h.length + 2)) }));
  return ws;
}

/* ---------------------------------------------------------------- module ---------------- */
function WagesReviewInner() {
  const currentMonth = adelaideMonthKey();
  const [monthKey, setMonthKey] = useState(defaultMonth);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [tab, setTab] = useState("review");
  const [sources, setSources] = useState({ month: null, data: {} });
  const [loading, setLoading] = useState(true);
  const [drawerId, setDrawerId] = useState(null);
  const [drawerTab, setDrawerTab] = useState("recon");
  const [dialog, setDialog] = useState(null); // "paste" | "close" | "reopen"
  const [action, setAction] = useState({ busy: false, error: null });
  const [reopenReason, setReopenReason] = useState("");
  const [resync, setResync] = useState({ busy: false, error: null, done: false });
  const [saveError, setSaveError] = useState(null);
  // Line saves still in flight (an HoursInput commits on blur, e.g. when the Close month
  // button is clicked). Close waits for them so the snapshot can't miss a just-typed value.
  const pendingSaves = useRef(new Set());
  const [pendingCount, setPendingCount] = useState(0);
  const drawerTrigger = useRef(null); // focus goes back here when the drawer closes
  const seq = useRef(0);
  const monthRef = useRef(monthKey);
  monthRef.current = monthKey;

  useEffect(() => {
    try { window.localStorage.setItem(WAGES_PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* storage full / disabled: prefs just won't persist */ }
  }, [prefs]);
  const setPref = (k, v) => setPrefs((p) => ({ ...p, [k]: v }));

  const loadAll = useCallback((mk) => {
    const s = ++seq.current;
    setLoading(true);
    loadWagesMonth(mk).then((data) => {
      if (s !== seq.current) return;
      setSources({ month: mk, data });
      setLoading(false);
    });
  }, []);
  // Reloads a subset; results are dropped if the month changed meanwhile.
  const reload = useCallback(async (keys) => {
    const mk = monthRef.current;
    const data = await loadWagesMonth(mk, keys);
    if (mk !== monthRef.current) return;
    setSources((prev) => (prev.month === mk ? { month: mk, data: { ...prev.data, ...data } } : prev));
  }, []);

  useEffect(() => { loadAll(monthKey); setDrawerId(null); setResync({ busy: false, error: null, done: false }); }, [monthKey, loadAll]);

  // Live refresh when another module changes the roster or leave.
  useEffect(() => {
    const onUpdate = (e) => {
      const key = e.detail?.key;
      if (key === LEAVE_ENTRIES_KEY) reload(["leaveEntries", "capLeaves"]);
      else if (key === CAP_LEAVES_KEY) reload(["capLeaves"]);
      else if (key === CAP_PEOPLE_KEY) reload(["roster"]);
    };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => window.removeEventListener(PG_DATA_EVENT, onUpdate);
  }, [reload]);

  const src = sources.month === monthKey ? sources.data : {};
  const errors = WAGE_SOURCES.filter((s) => src[s.key]?.error).map((s) => ({ key: s.key, label: s.label, error: src[s.key].error }));
  const ok = (k) => src[k] && !src[k].error;
  const monthRow = ok("monthRow") ? src.monthRow.data : undefined;
  const closedWithSnapshot = monthRow?.status === "closed" && monthRow.snapshot && Array.isArray(monthRow.snapshot.lines);
  const missingEssential = ESSENTIAL_LIVE_SOURCES.filter((k) => !ok(k));
  const canBuild = !loading && ok("monthRow") && (closedWithSnapshot || missingEssential.length === 0);

  const view = useMemo(() => {
    if (!canBuild) return null;
    return buildMonthView(sourceData(src), monthKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canBuild, sources, monthKey]);

  const closed = !!view?.closed;
  const filtered = useMemo(() => (view ? filterLines(view.lines, prefs) : []), [view, prefs]);
  const groups = useMemo(() => groupLines(filtered), [filtered]);
  const ordered = prefs.view === "cards" ? groups.flatMap((g) => g.lines) : filtered;
  const drawerIdx = ordered.findIndex((l) => l.person_id === drawerId);
  const drawerLine = drawerIdx >= 0 ? ordered[drawerIdx] : (view?.lines.find((l) => l.person_id === drawerId) || null);
  const monthText = monthLabel(monthKey);
  const offset = monthOffsetFor(monthKey);
  const wagePeople = ok("wagePeople") ? src.wagePeople.data : [];
  const seenUsers = useMemo(() => (ok("clickupSummary") ? [...new Set(src.clickupSummary.data.map((r) => r.user_name).filter(Boolean))].sort() : []), [sources]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- writes ---- */
  const saveLine = useCallback(async (personId, patch) => {
    const mk = monthRef.current;
    const p = upsertLine(mk, personId, patch);
    pendingSaves.current.add(p);
    setPendingCount(pendingSaves.current.size);
    try {
      const row = await p;
      setSources((prev) => {
        if (prev.month !== mk || !prev.data.lines || prev.data.lines.error) return prev;
        const others = prev.data.lines.data.filter((l) => l.person_id !== personId);
        return { ...prev, data: { ...prev.data, lines: { data: [...others, row], error: null } } };
      });
      return row;
    } finally {
      pendingSaves.current.delete(p);
      setPendingCount(pendingSaves.current.size);
    }
  }, []);
  const saveLineReported = useCallback(async (personId, patch) => {
    try { setSaveError(null); return await saveLine(personId, patch); }
    catch (e) { setSaveError(`Couldn't save: ${e?.message || e}`); throw e; }
  }, [saveLine]);

  const mapClickupUser = async (userName, personId) => {
    const w = wagePeople.find((x) => x.person_id === personId);
    const names = [...(w?.clickup_user_names || [])];
    if (!names.some((n) => n.toLowerCase() === userName.toLowerCase())) names.push(userName);
    await upsertPerson({ person_id: personId, clickup_user_names: names });
    await reload(["wagePeople"]);
  };

  const applyPaste = async (rows, remember) => {
    const settled = await Promise.allSettled(rows.map((r) => saveLine(r.person_id, { xero_hours: r.hours, xero_source: "paste" })));
    const failed = settled.map((s, i) => (s.status === "rejected" ? { name: rows[i].name, error: s.reason?.message || String(s.reason) } : null)).filter(Boolean);
    let mapError = null;
    if (Object.keys(remember).length) {
      try { await saveXeroNameMap(remember); } catch (e) { mapError = e?.message || String(e); }
    }
    await reload(["lines", "settings"]);
    return { saved: rows.length - failed.length, failed, mapError };
  };

  // The snapshot is built from a fresh load, not the on-screen view: the page's copy can be
  // stale (another admin's Xero paste, a ClickUp sync, leave edited in Consultants).
  const doClose = async () => {
    const mk = monthKey;
    setAction({ busy: true, error: null });
    try {
      await Promise.allSettled([...pendingSaves.current]);
      const fresh = await loadWagesMonth(mk);
      const failed = ESSENTIAL_LIVE_SOURCES.filter((k) => !fresh[k] || fresh[k].error);
      if (failed.length) throw new Error(`Couldn't reload ${failed.map((k) => sourceLabel(k).toLowerCase()).join(", ")}, so nothing was closed. Try again.`);
      if (fresh.monthRow.data?.status === "closed") throw new Error("This month has already been closed (by someone else?). Nothing was changed.");
      const freshView = buildMonthView(sourceData(fresh), mk);
      await closeMonth(mk, buildSnapshot(freshView));
      if (mk === monthRef.current) setSources({ month: mk, data: fresh });
      await reload(["monthRow", "lines"]);
      setDialog(null);
      setAction({ busy: false, error: null });
    } catch (e) { setAction({ busy: false, error: e?.message || String(e) }); }
  };
  const doReopen = async () => {
    setAction({ busy: true, error: null });
    try {
      await reopenMonth(monthKey, reopenReason.trim());
      await reload(["monthRow"]);
      setDialog(null); setReopenReason("");
      setAction({ busy: false, error: null });
    } catch (e) { setAction({ busy: false, error: e?.message || String(e) }); }
  };
  const doResync = async () => {
    setResync({ busy: true, error: null, done: false });
    try {
      await resyncClickupMonth(monthKey);
      await reload(["clickupSummary", "syncMeta"]);
      setResync({ busy: false, error: null, done: true });
    } catch (e) { setResync({ busy: false, error: e?.message || String(e), done: false }); }
  };

  const exportWorkbook = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, workbookSheet(view), monthLabel(monthKey, true).slice(0, 31));
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `wages-review-${monthKey}.xlsx`);
  };
  const exportCsv = () => {
    const csv = XLSX.utils.sheet_to_csv(workbookSheet(view));
    download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `wages-review-${monthKey}.csv`);
  };

  /* ---- render ---- */
  const syncMeta = ok("syncMeta") ? src.syncMeta.data : null;
  const t = view?.totals;
  const w = view?.warnings;
  const pickable = (view?.lines || []).map((l) => ({ person_id: l.person_id, name: l.name }));
  const pastePeople = (view?.lines || []).map((l) => {
    const wp = wagePeople.find((x) => x.person_id === l.person_id);
    return { person_id: l.person_id, full_name: l.name, display_name: l.name, xero_name: wp?.xero_name || null, clickup_user_names: wp?.clickup_user_names || [] };
  });
  const openDrawer = (personId, tab = "recon") => {
    if (!drawerId) drawerTrigger.current = document.activeElement;
    setDrawerTab(tab);
    setDrawerId(personId);
  };
  const closeDrawer = () => {
    setDrawerId(null);
    const t = drawerTrigger.current;
    drawerTrigger.current = null;
    // After the drawer unmounts; the trigger (card button / table name) is still mounted.
    if (t && typeof t.focus === "function") setTimeout(() => { if (document.contains(t)) t.focus(); }, 0);
  };

  const blockers = view ? [
    t.awaiting && `${t.awaiting} ${t.awaiting === 1 ? "person is" : "people are"} still awaiting Xero hours`,
    t.outOfTolerance && `${t.outOfTolerance} Xero ⇄ ClickUp gap${t.outOfTolerance === 1 ? "" : "s"} out of tolerance`,
    w.untypedLeave.length && `Untyped leave for ${w.untypedLeave.map((u) => u.name).join(", ")}`,
    w.unmapped.length && `${w.unmapped.length} unmapped ClickUp user${w.unmapped.length === 1 ? "" : "s"}`,
    w.noRule.length && `No hours rule for ${w.noRule.map((u) => u.name).join(", ")}`,
    w.needsSetup.length && `${w.needsSetup.length} roster ${w.needsSetup.length === 1 ? "person has" : "people have"} no wage setup`,
    w.conflicts.length && `${w.conflicts.length} ClickUp name${w.conflicts.length === 1 ? "" : "s"} claimed by more than one person`,
    w.unknownSpaceHours > 0 && `${fmtH(w.unknownSpaceHours)} of ClickUp time has no space recorded (classified by folder name)${offset >= 2 ? ": re-sync this month first" : ""}`,
    w.holidaysNotLoaded && "Public holidays aren't loaded for this month",
  ].filter(Boolean) : [];

  return (
    <div className="pg-cap-container wr">
      <div className="pg-app-header">
        <div>
          <span className="pg-eyebrow">Purple Giraffe · Admin</span>
          <h1 className="pg-app-header__title">Wages review.</h1>
          <p className="pg-app-header__sub">Monthly reconciliation of tracked time against Xero and expected hours.</p>
        </div>
      </div>

      <TabBar tabs={PAGE_TABS} active={tab} onChange={setTab} idBase="wr-page" label="Wages review sections" />

      <div className="pg-pillbar wr-filters">
        <label className="pg-pill pg-pill--search">
          <Search size={13} className="pg-pill__icon" aria-hidden="true" />
          <input value={prefs.q} onChange={(e) => setPref("q", e.target.value)} placeholder="Team members…" aria-label="Search team members" />
        </label>
        <div className="pg-pill pg-pill--stepper" role="group" aria-label="Month">
          <button type="button" className="pg-pill__step" aria-label="Previous month" disabled={monthKey <= FIRST_MONTH} onClick={() => setMonthKey(shiftMonth(monthKey, -1))}><ChevronLeft size={14} /></button>
          <span className="pg-pill__step-label" aria-live="polite"><Calendar size={13} className="pg-pill__icon" aria-hidden="true" /> {monthText}</span>
          <button type="button" className="pg-pill__step" aria-label="Next month" disabled={monthKey >= currentMonth} onClick={() => setMonthKey(shiftMonth(monthKey, 1))}><ChevronRight size={14} /></button>
        </div>
        {tab === "review" && <>
          <label className="pg-pill pg-pill--select">
            <span className="wr-sr">State</span>
            <select value={prefs.state} onChange={(e) => setPref("state", e.target.value)}>
              <option value="all">All states</option>{WAGE_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
            <ChevronDown size={13} className="pg-pill__chevron" aria-hidden="true" />
          </label>
          <label className="pg-pill pg-pill--select">
            <span className="wr-sr">Type</span>
            <select value={prefs.type} onChange={(e) => setPref("type", e.target.value)}>
              <option value="all">All types</option><option value="FT">FT</option><option value="PT">PT</option><option value="Casual">Casual</option>
            </select>
            <ChevronDown size={13} className="pg-pill__chevron" aria-hidden="true" />
          </label>
          <label className="pg-pill pg-pill--select">
            <span className="wr-sr">Status</span>
            <select value={prefs.status} onChange={(e) => setPref("status", e.target.value)}>
              {STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <ChevronDown size={13} className="pg-pill__chevron" aria-hidden="true" />
          </label>
          <div className="wr-viewtoggle" role="group" aria-label="View">
            <button type="button" className={"pg-pill pg-pill--iconbtn" + (prefs.view === "cards" ? " is-active" : "")} aria-pressed={prefs.view === "cards"} title="Cards" aria-label="Cards view" onClick={() => setPref("view", "cards")}><LayoutGrid size={15} /></button>
            <button type="button" className={"pg-pill pg-pill--iconbtn" + (prefs.view === "table" ? " is-active" : "")} aria-pressed={prefs.view === "table"} title="Table" aria-label="Table view" onClick={() => setPref("view", "table")}><Table2 size={15} /></button>
          </div>
          <button type="button" className="pg-pill" disabled={!view || closed} title={closed ? "Month is closed" : undefined} onClick={() => setDialog("paste")}>
            <ClipboardPaste size={13} className="pg-pill__icon" aria-hidden="true" /> Paste from Xero
          </button>
          <ExportMenu disabled={!view} onWorkbook={exportWorkbook} onCsv={exportCsv} />
          {view && (closed
            ? <button type="button" className="pg-pill" onClick={() => { setAction({ busy: false, error: null }); setDialog("reopen"); }}><Unlock size={13} className="pg-pill__icon" aria-hidden="true" /> Reopen month</button>
            : <button type="button" className="pg-pill" onClick={() => { setAction({ busy: false, error: null }); setDialog("close"); }}><Lock size={13} className="pg-pill__icon" aria-hidden="true" /> Close month</button>)}
        </>}
      </div>

      {/* Month bar */}
      <div className="wr-monthbar">
        <span className={"wr-chip" + (closed ? " wr-chip--strong" : "")}>{closed ? <><Lock size={11} aria-hidden="true" /> Closed</> : "Draft"}</span>
        <span>ClickUp {syncMeta?.last_synced_at ? `last synced ${timeAgo(syncMeta.last_synced_at)}` : ok("syncMeta") ? "not synced yet" : "sync status unavailable"}{syncMeta?.last_sync_status === "error" ? " (last run failed)" : ""}</span>
        {view && <span>Xero entered {t.xeroEntered}/{t.people}</span>}
        {view && <span>Standard hours: {view.weekdays} weekdays × {view.perDay} = {view.standardHours} h</span>}
        {view && (
          <span>Holidays: {WAGE_STATES.map((s) => `${s} ${(view.holidaysByState[s] || []).map((h) => `${h.name} (${fmtDay(h.date)})`).join(", ") || "none"}`).join(" · ")}</span>
        )}
        {offset >= 2 && !closed && (
          <button type="button" className="pg-btn-ghost" disabled={resync.busy} onClick={doResync}>
            <RefreshCw size={11} aria-hidden="true" className={resync.busy ? "wr-spin" : undefined} /> {resync.busy ? "Re-syncing…" : "Re-sync ClickUp for this month"}
          </button>
        )}
        {resync.done && <span className="wr-field-state">Re-synced.</span>}
      </div>
      {offset >= 2 && !closed && <p className="wr-note">ClickUp's scheduled sync only refreshes the current and previous month; re-sync this month to pick up later edits.</p>}
      {resync.error && <Banner tone="error">Couldn't re-sync ClickUp: {resync.error}</Banner>}

      {/* Source errors */}
      {errors.map((e) => (
        <Banner key={e.key} tone="error" action={<button type="button" className="pg-btn-ghost" onClick={() => reload([e.key])}>Retry</button>}>
          Couldn't load {e.label.toLowerCase()}: {e.error}
        </Banner>
      ))}
      {!loading && !canBuild && (
        <Banner tone="error" action={<button type="button" className="pg-btn-ghost" onClick={() => loadAll(monthKey)}>Retry all</button>}>
          This month can't be calculated until {(!ok("monthRow") ? ["monthRow"] : missingEssential).map((k) => sourceLabel(k).toLowerCase()).join(", ")} load{missingEssential.length === 1 ? "s" : ""}. Nothing is shown rather than partial numbers.
        </Banner>
      )}
      {saveError && <Banner tone="error" action={<button type="button" className="pg-btn-ghost" onClick={() => setSaveError(null)}>Dismiss</button>}>{saveError}</Banner>}

      {tab === "settings" && (
        <div {...tabPanelProps("wr-page", "settings")}>
          {ok("roster") && ok("wagePeople") && ok("rules") && ok("settings")
            ? <WageSettings roster={src.roster.data} wagePeople={src.wagePeople.data} rules={src.rules.data} settingsRow={src.settings.data}
                seenUsers={seenUsers} monthKey={monthKey} onChanged={(keys) => reload(keys)} />
            : loading ? <div className="ov-card ov-skeleton" style={{ marginTop: 18, minHeight: 240 }} /> : null}
        </div>
      )}

      {tab === "review" && <div {...tabPanelProps("wr-page", "review")}>
        {loading && (
          <>
            <div className="wr-kpis">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="ov-card ov-skeleton" aria-hidden="true" />)}</div>
            <div className="wr-grid">{[0, 1, 2].map((i) => <div key={i} className="ov-card ov-skeleton" style={{ minHeight: 420 }} aria-hidden="true" />)}</div>
            <p className="wr-sr" role="status">Loading wages review…</p>
          </>
        )}

        {view && <>
          {closed && (
            <Banner tone="info" icon={Lock}>
              <b>{monthText} is closed</b>{monthRow?.closed_at ? ` (${new Date(monthRow.closed_at).toLocaleDateString("en-AU")})` : ""}.
              {view.fromSnapshot ? " Figures are the snapshot taken at close; hours are locked, comments stay editable." : " No snapshot was stored, so figures below are live. Reopen and close again to freeze them."}
              {view.liveDiffers.length > 0 && <>
                {" "}Live data now differs from the snapshot:
                <ul className="wr-banner__list">
                  {view.liveDiffers.map((d) => (
                    <li key={d.person_id}>
                      {d.name}: {d.missing ? "no longer in the live month (excluded, left, or wage setup changed)" : d.fields.map((f) => `${f.label} ${fmtH(f.snapshot)} → ${fmtH(f.live)}`).join(", ")}
                    </li>
                  ))}
                </ul>
              </>}
            </Banner>
          )}
          {!closed && monthRow?.reopened_reason && <p className="wr-note">Reopened: {monthRow.reopened_reason}</p>}

          <div className="wr-kpis">
            <OverviewKpiCard index={0} primaryLabel="Reconciled" primary={`${t.reconciled}/${t.people}`} secondary={`±${view.settings.xero_tolerance_h} h`} secondaryLabel="Xero matches ClickUp" />
            <OverviewKpiCard index={1} primaryLabel="Team over / under" primary={fmtSigned(t.netT)} secondary={`${t.over} over · ${t.under} under`} secondaryLabel={`of ${t.assessed} assessed`} />
            <OverviewKpiCard index={2} primaryLabel="Xero ⇄ ClickUp out of tolerance" primary={String(t.outOfTolerance)} secondary={`±${view.settings.xero_tolerance_h} h`} secondaryLabel="tolerance" />
            <OverviewKpiCard index={3} primaryLabel="Client billed" primary={fmtPct(t.J)} secondary={fmtPct(t.K)} secondaryLabel="all billable" />
            <OverviewKpiCard index={4} primaryLabel="Awaiting Xero" primary={String(t.awaiting)} secondary={`of ${t.people}`} secondaryLabel="people" />
          </div>

          {!view.fromSnapshot && <>
            {w.unmapped.length > 0 && (
              <Banner>
                <b>ClickUp users not linked to anyone</b> (their time isn't counted):
                <ul className="wr-banner__list">
                  {w.unmapped.map((u) => (
                    // A blank ClickUp name can't be mapped (people map by exact name), so no picker for it.
                    <li key={u.user_name || "(no name)"} className="wr-inline">
                      {u.user_name || "(no name)"} · {fmtH(u.hours)}
                      {u.user_name ? <MapToPicker userName={u.user_name} people={pickable} onMap={mapClickupUser} /> : <span className="wr-note">time logged with no ClickUp user name</span>}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
            {w.conflicts.length > 0 && (
              <Banner tone="error">
                <b>ClickUp names claimed by more than one person</b> (counted for nobody until fixed in Settings):
                <ul className="wr-banner__list">{w.conflicts.map((c) => <li key={c.user_name}>{c.user_name} · {fmtH(c.hours)} · {c.people.map((p) => p.name).join(", ")}</li>)}</ul>
              </Banner>
            )}
            {w.needsSetup.length > 0 && (
              <Banner action={<button type="button" className="pg-btn-ghost" onClick={() => setTab("settings")}>Set up</button>}>
                <b>Needs setup:</b> {w.needsSetup.map((p) => p.name).join(", ")} {w.needsSetup.length === 1 ? "is" : "are"} on the Consultants roster with no wage setup.
              </Banner>
            )}
            {w.noRule.length > 0 && (
              <Banner action={<button type="button" className="pg-btn-ghost" onClick={() => setTab("settings")}>Add rule</button>}>
                <b>No hours rule:</b> {w.noRule.map((p) => p.name).join(", ")}. Expected hours and over/under can't be assessed.
              </Banner>
            )}
            {w.outsideWindow.length > 0 && (
              <Banner><b>Time tracked outside employment dates:</b> {w.outsideWindow.map((p) => `${p.name} (${fmtH(p.hours)})`).join(", ")}. Check their start/end dates.</Banner>
            )}
            {w.orphanWagePeople.length > 0 && (
              <Banner>Wage setup exists for {w.orphanWagePeople.length} person id{w.orphanWagePeople.length === 1 ? "" : "s"} no longer on the Consultants roster ({w.orphanWagePeople.map((p) => p.person_id).join(", ")}).</Banner>
            )}
            {w.unknownSpaceHours > 0 && (
              <Banner>{fmtH(w.unknownSpaceHours)} of ClickUp time was synced before space tracking, so it's classified by folder name (BDM folders as PG, anything else as client).{offset >= 2 ? " Re-sync this month to classify it properly." : " The next scheduled sync will classify it."}</Banner>
            )}
            {w.holidaysNotLoaded && (
              <Banner tone="error">Public holidays not loaded for this month — update src/publicHolidays.js. Public holiday hours (Q) are 0 for everyone until then.</Banner>
            )}
          </>}

          {view.lines.length === 0 ? (
            <div className="pg-empty">No one is set up for wages in {monthText}. Add people in Settings.</div>
          ) : prefs.view === "table" ? (
            <WagesTable lines={filtered} closed={closed} onSaveLine={saveLineReported} onOpen={openDrawer} />
          ) : groups.length === 0 ? (
            <div className="pg-empty">No one matches these filters.</div>
          ) : groups.map((g) => (
            <section key={g.key} className="wr-group" aria-labelledby={`wr-g-${g.key}`}>
              <h2 id={`wr-g-${g.key}`} className="wr-group__title">{g.title} <span className="wr-group__count">{g.lines.length}</span></h2>
              <div className="wr-grid">
                {g.lines.map((l) => <WageCard key={l.person_id} line={l} view={view} monthText={monthText} onOpen={openDrawer} />)}
              </div>
            </section>
          ))}
          <p className="pg-footnote">
            Columns follow Kelly's Monthly Wages Review workbook: H ClickUp total, L Xero, M = L − H, R = L + leave + public holidays, S expected, T = R − S.
            Client time is a task in the Clients or PG CLIENTS space outside the PG folders and internal folders; everything else is PG time. Leave comes from the Consultants module.
          </p>
        </>}
      </div>}

      {drawerLine && view && (
        <WageDrawer
          key={drawerLine.person_id}
          line={drawerLine} view={view} monthText={monthText} closed={closed} initialTab={drawerTab}
          position={drawerIdx >= 0 ? `${drawerIdx + 1} of ${ordered.length}` : ""}
          onClose={closeDrawer}
          onPrev={drawerIdx > 0 ? () => setDrawerId(ordered[drawerIdx - 1].person_id) : null}
          onNext={drawerIdx >= 0 && drawerIdx < ordered.length - 1 ? () => setDrawerId(ordered[drawerIdx + 1].person_id) : null}
          onSaveLine={saveLineReported}
        />
      )}

      {dialog === "paste" && view && !closed && (
        <XeroPasteDialog monthText={monthText} people={pastePeople}
          currentL={Object.fromEntries(view.lines.map((l) => [l.person_id, l.L]))}
          nameMap={view.settings.xero_name_map} onApply={applyPaste} onClose={() => setDialog(null)} />
      )}
      {dialog === "close" && view && (
        <ConfirmDialog title={`Close ${monthText}?`} confirmLabel={pendingCount ? "Saving…" : "Close month"} onConfirm={doClose} onClose={() => setDialog(null)}
          busy={action.busy} error={action.error} disabled={pendingCount > 0}>
          <p className="wr-note wr-note--strong">Closing reloads everything and freezes every figure as it is then. Hours become read-only; comments stay editable. You can reopen later with a reason.</p>
          {pendingCount > 0 && <p className="wr-note" role="status">Waiting for {pendingCount} change{pendingCount === 1 ? "" : "s"} to finish saving…</p>}
          {blockers.length > 0 ? (
            <Banner><b>Still open:</b><ul className="wr-banner__list">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>You can still close the month.</Banner>
          ) : <p className="wr-note">Nothing outstanding.</p>}
        </ConfirmDialog>
      )}
      {dialog === "reopen" && view && (
        <ConfirmDialog title={`Reopen ${monthText}?`} confirmLabel="Reopen month" onConfirm={doReopen} onClose={() => setDialog(null)} busy={action.busy} error={action.error} disabled={!reopenReason.trim()}>
          <p className="wr-note wr-note--strong">Reopening discards the snapshot: figures go back to live ClickUp, leave and rules until the month is closed again.</p>
          <label className="pg-field">
            <span className="pg-field__label">Reason (required)</span>
            <textarea className="pg-input wr-textarea" rows={3} value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} autoFocus />
          </label>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function WagesReview() {
  return (
    <ErrorBoundary>
      <WagesReviewInner />
    </ErrorBoundary>
  );
}
