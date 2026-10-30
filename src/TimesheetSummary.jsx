import React, { useState, useEffect, useMemo } from "react";
import { Search, ChevronLeft, ChevronRight, Download, Copy, Check, RefreshCw } from "lucide-react";
import { idbGet, PG_DATA_EVENT } from "./idbStore.js";
import { findPersonMatch } from "./nameMatch.js";
import { SEED_PEOPLE, loadKey } from "./capacityData.js";
import { LETTERHEAD_FOOTER_B64 } from "./letterheadFooter.js";
import { NORDIQUE_FONT_FACE_CSS } from "./nordiqueFont.js";
import { SearchBox } from "./SearchBox.jsx";
import { buildXeroTimesheetText, copyText } from "./timesheetCopy.js";
import { CLICKUP_DB_KEY, CAP_PEOPLE_KEY, CLICKUP_SYNCED_EVENT } from "./storageKeys.js";
import { fetchClickupFromSupabase, fetchSyncMeta, triggerManualSync } from "./clickupSync.js";
import { runManualSync } from "./manualSync.js";
import { timeAgo } from "./format.js";
import { loadMyRoster } from "./capacityStore.js";
import { filterOwnRows } from "./ownTime.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// The browser's "Save as PDF" dialog suggests <title> as the default filename —
// strip characters illegal in filenames on Windows/macOS.
const filenameSafe = (s) => String(s ?? "").replace(/[\\/:*?"<>|]/g, "-").trim();
const fmt2 = (n) => (n === null || n === undefined || isNaN(n)) ? "0.00" : n.toFixed(2);

function monthKeyOf(year, month0) { return `${year}-${String(month0 + 1).padStart(2, "0")}`; }
function monthLabelOf(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}
function daysInMonthOf(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
function weekdayShort(y, m, d) { return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" }); }
function dateLabel(y, m, d) { return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "2-digit", month: "short" }); }

// Weeks are sequential 7-day blocks anchored to day 1 of the month (not
// Mon-Sun/Sun-Sat calendar weeks) — week 1 is always days 1-7, week 2 is
// 8-14, and so on, with a short final week for whatever remains. Column 1
// is whichever weekday day 1 happens to fall on that month.
function computeWeeks(monthKeyStr) {
  const [y, m] = monthKeyStr.split("-").map(Number);
  const days = daysInMonthOf(monthKeyStr);
  const weeks = [];
  for (let start = 1; start <= days; start += 7) {
    const end = Math.min(start + 6, days);
    const daysArr = [];
    for (let d = start; d <= end; d++) {
      daysArr.push({ day: d, dateKey: `${monthKeyStr}-${String(d).padStart(2, "0")}`, weekday: weekdayShort(y, m, d), label: dateLabel(y, m, d) });
    }
    weeks.push({ start, end, days: daysArr });
  }
  return weeks;
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("TimesheetSummary error:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, padding: 24, margin: 24, color: "var(--status-over)", background: "var(--status-over-soft)", borderRadius: "var(--app-radius)", whiteSpace: "pre-wrap" }}>
          <b>Something broke while rendering this dashboard:</b>
          {"\n\n"}{String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

// ------------------------------- PDF (print) --------------------------------
const PRINT = { ink: "#000000", inkSoft: "#000000", brand: "#3F008E", line: "#E7E1F0", brandSoft: "#F1EAFB" };

function buildTimesheetPrintHtml(consultantName, monthKeyStr, weeksArr, personDaily, monthlyTotal) {
  const monthText = monthLabelOf(monthKeyStr);
  const weekRows = weeksArr.map((w) => {
    const cells = w.days.map((d) => {
      const hrs = (personDaily.get(d.dateKey) || 0) / 60;
      return `<td><div class="daylabel">${esc(d.weekday)}<br/>${esc(d.label)}</div><div class="dayval">${fmt2(hrs)}</div></td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${esc(filenameSafe(consultantName))}: ${esc(filenameSafe(monthText))} timesheet</title>
<style>
  ${NORDIQUE_FONT_FACE_CSS}
  @page { margin: 15mm; size: A4; }
  * { box-sizing: border-box; }
  body { font-family: 'Nordique Pro', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 600; color: ${PRINT.ink}; margin: 0; }
  /* Unlike Client Invoicing's Tasks list (which can grow to any number of
     rows and hits a real Chromium/Edge print-pagination bug with a fixed
     footer), a timesheet export is always a bounded handful of weeks —
     never enough to risk that bug in practice. So this one gets a plain
     position:fixed footer instead of the <tfoot> table trick, which pins
     it to the exact same spot on every page rather than wherever content
     happens to end. */
  .header { border-bottom: 2px solid ${PRINT.ink}; padding-bottom: 14px; margin-bottom: 22px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .brand { font-family: 'Nordique Pro', sans-serif; color: ${PRINT.brand}; font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; }
  h1 { font-family: 'Nordique Pro', sans-serif; font-weight: 700; font-size: 26px; margin: 6px 0 0; letter-spacing: -0.01em; }
  .subtitle { color: ${PRINT.inkSoft}; font-size: 14px; margin-top: 4px; }
  .totalbox { text-align: right; }
  .totalbox .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: ${PRINT.brand}; font-weight: 600; }
  .totalbox .val { font-size: 28px; font-weight: 700; margin-top: 4px; font-family: Arial, "Segoe UI", sans-serif; }
  .grid { width: 100%; border-collapse: collapse; margin-top: 22px; table-layout: fixed; }
  .grid td { border: 1px solid ${PRINT.line}; padding: 8px 6px; text-align: center; vertical-align: top; page-break-inside: avoid; break-inside: avoid; }
  .daylabel { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: ${PRINT.inkSoft}; line-height: 1.4; }
  .dayval { font-size: 16px; font-weight: 600; margin-top: 8px; font-family: Arial, "Segoe UI", sans-serif; }
  .generated-note { margin-top: 24px; font-size: 9px; color: ${PRINT.inkSoft}; text-align: right; font-style: italic; }
  .letterhead-footer {
    position: fixed; left: 0; right: 0; bottom: 0; width: 100%; height: 15mm;
    background-image: url('data:image/png;base64,${LETTERHEAD_FOOTER_B64}');
    background-repeat: no-repeat; background-position: bottom center; background-size: 100% auto;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  @media print { .noprint { display: none; } }
</style>
</head><body>
  <div class="header">
    <div>
      <div class="brand">Purple Giraffe · timesheet summary</div>
      <h1>${esc(consultantName)}</h1>
      <div class="subtitle">${esc(monthText)}</div>
    </div>
    <div class="totalbox">
      <div class="lbl">Monthly total</div>
      <div class="val">${fmt2(monthlyTotal)} h</div>
    </div>
  </div>

  <table class="grid"><tbody>${weekRows}</tbody></table>

  <div class="generated-note">Generated ${esc(new Date().toLocaleString())}</div>

  <div class="letterhead-footer"></div>

  <script>
    window.addEventListener('load', function() {
      var printed = false;
      function go() { if (!printed) { printed = true; window.print(); } }
      document.fonts.ready.then(go, go);
      setTimeout(go, 1500);
    });
  </script>
</body></html>`;
}

function printTimesheetPdf(consultantName, monthKeyStr, weeksArr, personDaily, monthlyTotal) {
  const html = buildTimesheetPrintHtml(consultantName, monthKeyStr, weeksArr, personDaily, monthlyTotal);
  const w = window.open("", "_blank", "width=900,height=1100");
  if (!w) {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  w.document.open(); w.document.write(html); w.document.close();
}

/* ============================================================
   MAIN
============================================================ */
// `own` (Timesheets scope "own", see permissions.js): { personId, userNames } -- only the
// signed-in user's time, fetched straight from the live sync filtered to their exact ClickUp
// names (never the Invoicing IndexedDB cache, which holds everyone's), with the consultant
// picker locked to their linked roster person. null = everyone (admin tier, as before).
// userNames null = pginvoice_my_access() predates clickupUserNames (migration not applied).
function TimesheetInner({ own = null }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [clickup, setClickup] = useState(null);
  const [people, setPeople] = useState(SEED_PEOPLE);

  const [qConsultant, setQConsultant] = useState("");
  const [selectedConsultant, setSelectedConsultant] = useState(null);
  const [monthKeyState, setMonthKeyState] = useState("");
  const [weekIdx, setWeekIdx] = useState(0);
  // Feedback for the Copy-for-Xero button: null, { ok: true, days } or { ok: false, msg }.
  const [copyState, setCopyState] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState(null);
  const [syncMeta, setSyncMeta] = useState(null);

  useEffect(() => { fetchSyncMeta().then(setSyncMeta).catch(() => {}); }, []);

  // Own mode: just this user's rows (the query already filters by user_name; belt and braces).
  const fetchOwn = async () => {
    const live = await fetchClickupFromSupabase(undefined, { userNames: own.userNames });
    return live ? { ...live, rows: filterOwnRows(live.rows, own.userNames) } : null;
  };

  // "Sync now". Admin tier: the same ClickUp pull as Client Invoicing's button, then handed to
  // App.jsx (CLICKUP_SYNCED_EVENT), which re-caches it for every module. Own mode can't run
  // clickup-sync (admin tier only), so it re-reads the user's own rows from the last sync.
  const handleSync = async () => {
    setSyncing(true);
    setSyncErr(null);
    try {
      if (own) {
        const [live, meta] = await Promise.all([fetchOwn(), fetchSyncMeta().catch(() => null)]);
        setClickup(live);
        if (meta) setSyncMeta(meta);
        setLoadError(null);
      } else {
        const { live, meta, error } = await runManualSync({ trigger: triggerManualSync, fetchLive: fetchClickupFromSupabase, fetchMeta: fetchSyncMeta });
        if (live) setClickup(live);
        if (meta) setSyncMeta(meta);
        if (live || meta) window.dispatchEvent(new CustomEvent(CLICKUP_SYNCED_EVENT, { detail: { live, meta } }));
        if (error) setSyncErr(error.message || String(error));
      }
    } catch (e) {
      setSyncErr(e?.message || String(e));
    } finally {
      setSyncing(false);
    }
  };

  // `own` is memoized by Shell (permissions.js moduleScopeProps): a stable dependency.
  useEffect(() => {
    if (!own) return;
    let cancelled = false;
    (async () => {
      try {
        // Capacity data is admin-only: own mode gets just the linked person's record.
        const { people } = await loadMyRoster();
        if (!cancelled) setPeople(people);
      } catch (e) {
        console.error("Timesheet Summary: couldn't load people data:", e);
      }
      if (own.personId && own.userNames) {
        try {
          const live = await fetchOwn();
          if (cancelled) return;
          setClickup(live);
        } catch (e) {
          if (cancelled) return;
          setLoadError(e?.message || String(e));
        }
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [own]);

  useEffect(() => {
    if (own) return;
    let cancelled = false;
    const load = async () => {
      const cu = await idbGet(CLICKUP_DB_KEY);
      if (cancelled) return;
      setClickup(cu || null);
      // Read-only here (this module never writes cap_people) -- a failed load just
      // means this render keeps whatever people data it already had.
      try {
        setPeople(await loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE));
      } catch (e) {
        console.error("Timesheet Summary: couldn't load people data:", e);
      }
      setLoaded(true);
    };
    load();
    const onUpdate = (e) => { if (!e.detail || [CLICKUP_DB_KEY, CAP_PEOPLE_KEY].includes(e.detail.key)) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, [!!own]); // eslint-disable-line

  // Own mode: the linked roster person (cap_people id = profiles.person_id).
  const ownPerson = own?.personId ? people.find((p) => p.id === own.personId) || null : null;

  const availableMonths = useMemo(() => {
    if (!clickup?.rows?.length) return [];
    const set = new Set();
    for (const r of clickup.rows) if (r.monthKey) set.add(r.monthKey);
    return [...set].sort();
  }, [clickup]);

  /* ---- fuzzy-match real ClickUp usernames to the roster, same rule Performance uses ---- */
  const userMatch = useMemo(() => {
    const map = new Map();
    if (!clickup?.rows?.length) return map;
    // Own mode: every row is already the user's own (exact names) -- no fuzzy roster match.
    if (own) {
      for (const r of clickup.rows) if (r.user) map.set(r.user, ownPerson?.name || r.user);
      return map;
    }
    const usernames = new Set();
    for (const r of clickup.rows) if (r.user) usernames.add(r.user);
    usernames.forEach((u) => {
      // The "Purple Giraffe" ClickUp login is a shared account DMA (an external
      // contractor) logs time under — attribute it to DMA rather than dropping it.
      if (u.trim().toLowerCase() === "purple giraffe") { map.set(u, "DMA (external)"); return; }
      const p = findPersonMatch(u, people);
      map.set(u, p ? p.name : null);
    });
    return map;
  }, [clickup, people, own, ownPerson]);

  // key -> Map(dateKey -> minutes). Total time logged, not filtered to billable/
  // client-only — this is a timesheet, not a billing report.
  const dailyMinutes = useMemo(() => {
    const map = new Map();
    if (!clickup?.rows?.length) return map;
    for (const r of clickup.rows) {
      if (!r.dateKey || !r.user) continue;
      const key = userMatch.get(r.user) || r.user;
      if (!map.has(key)) map.set(key, new Map());
      const byDate = map.get(key);
      byDate.set(r.dateKey, (byDate.get(r.dateKey) || 0) + r.minutes);
    }
    return map;
  }, [clickup, userMatch]);

  const rosterNamesSet = useMemo(() => new Set(people.map((p) => p.name)), [people]);
  const unmatchedNames = useMemo(() => [...dailyMinutes.keys()].filter((k) => !rosterNamesSet.has(k)).sort(), [dailyMinutes, rosterNamesSet]);
  const allConsultants = useMemo(() => (own
    ? (ownPerson ? [{ name: ownPerson.name, role: ownPerson.role }] : [])
    : [
      ...people.map((p) => ({ name: p.name, role: p.role })),
      ...unmatchedNames.map((n) => ({ name: n, role: "Unmatched" })),
    ]), [people, unmatchedNames, own, ownPerson]);

  // default to the first available consultant, but leave a still-valid manual pick alone
  useEffect(() => {
    if (selectedConsultant && allConsultants.some((c) => c.name === selectedConsultant)) return;
    setSelectedConsultant(allConsultants.length ? allConsultants[0].name : null);
  }, [allConsultants]); // eslint-disable-line

  // default to the latest month with data, but leave a still-valid manual pick alone
  useEffect(() => {
    if (monthKeyState && availableMonths.includes(monthKeyState)) return;
    setMonthKeyState(availableMonths.length ? availableMonths[availableMonths.length - 1] : "");
  }, [availableMonths]); // eslint-disable-line

  const weeks = useMemo(() => (monthKeyState ? computeWeeks(monthKeyState) : []), [monthKeyState]);

  // default to the week containing today, if viewing the real current month; else week 1
  useEffect(() => {
    if (!weeks.length) { setWeekIdx(0); return; }
    const now = new Date();
    if (monthKeyState === monthKeyOf(now.getFullYear(), now.getMonth())) {
      const idx = weeks.findIndex((w) => now.getDate() >= w.start && now.getDate() <= w.end);
      setWeekIdx(idx >= 0 ? idx : 0);
    } else {
      setWeekIdx(0);
    }
  }, [monthKeyState]); // eslint-disable-line

  const personDaily = selectedConsultant ? (dailyMinutes.get(selectedConsultant) || new Map()) : new Map();
  const currentWeek = weeks[weekIdx] || { start: 1, end: 1, days: [] };
  const weekDayValues = currentWeek.days.map((d) => ({ ...d, hours: (personDaily.get(d.dateKey) || 0) / 60 }));
  const weekTotal = weekDayValues.reduce((s, d) => s + d.hours, 0);
  const monthlyTotal = useMemo(() => {
    let total = 0;
    weeks.forEach((w) => w.days.forEach((d) => { total += (personDaily.get(d.dateKey) || 0) / 60; }));
    return total;
  }, [weeks, personDaily]);

  async function copyForXero() {
    const text = buildXeroTimesheetText(monthKeyState, personDaily);
    if (!text) { setCopyState({ ok: false, msg: "No time logged this month" }); }
    else {
      const ok = await copyText(text);
      setCopyState(ok ? { ok: true, days: text.split("\n").length } : { ok: false, msg: "Couldn't copy, the browser blocked the clipboard" });
    }
    setTimeout(() => setCopyState(null), 2500);
  }

  const monthIdx = availableMonths.indexOf(monthKeyState);
  const shiftMonth = (dir) => { const ni = monthIdx + dir; if (ni >= 0 && ni < availableMonths.length) setMonthKeyState(availableMonths[ni]); };
  const shiftWeek = (dir) => { const ni = weekIdx + dir; if (ni >= 0 && ni < weeks.length) setWeekIdx(ni); };

  const weekEndingLabel = monthKeyState && currentWeek.end
    ? (() => { const [y, m] = monthKeyState.split("-").map(Number); return new Date(y, m - 1, currentWeek.end).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }); })()
    : "";

  const hasData = availableMonths.length > 0;

  // Own mode can't show anything honest without a linked person / the user's ClickUp names:
  // just the header and the reason, no empty picker/table.
  const ownBlocker = !own ? null
    : !own.userNames ? "Your own timesheet isn't available yet: it needs a database update that hasn't been applied. Ask an Admin."
    : !own.personId ? "No roster person is linked to your account yet, so there's no timesheet to show. Ask an Admin to link you in Settings → Users & permissions."
    : loaded && !ownPerson ? "Your linked roster person wasn't found on the Consultants roster. Ask an Admin to check your account in Settings → Users & permissions."
    : null;
  if (!loaded && !ownBlocker) return <div className="pg-cap-container"><div className="pg-empty">Loading…</div></div>;

  const header = (
      <div className="pg-app-header">
        <div>
          <span className="pg-eyebrow">Purple Giraffe · Internal</span>
          <h1 className="pg-app-header__title">{own ? "Your timesheet: daily hours." : "Timesheet summary: daily hours by consultant."}</h1>
          <p className="pg-app-header__sub">{own
            ? "Total time you logged in ClickUp per day. Not filtered to billable hours, this mirrors the raw timesheet, not the invoicing view."
            : "Total time logged in ClickUp per day, for whichever consultant and month you pick. Not filtered to billable hours, this mirrors the raw timesheet, not the invoicing view."}</p>
        </div>
      </div>
  );
  if (ownBlocker) {
    return (
      <div className="pg-cap-container">
        {header}
        <div className="pg-banner-warn">{ownBlocker}</div>
      </div>
    );
  }

  return (
    <div className="pg-cap-container">
      {header}
      {loadError && <div className="pg-banner-warn">Couldn't load your ClickUp time: {loadError}. Reload to try again.</div>}
      {syncErr && <div className="pg-banner-warn">{own ? "Refresh" : "Sync"} failed: {syncErr}</div>}
      {own && !loadError && !hasData && (
        <div className="pg-banner-warn">No ClickUp time logged under your ClickUp name{(own.userNames || []).length > 1 ? "s" : ""} yet.</div>
      )}
      {!own && !hasData && (
        <div className="pg-banner-warn">
          No ClickUp data loaded yet, upload a CSV in Client Accruals to see daily hours here.
        </div>
      )}

      <div className="pg-panel" style={{ alignItems: "center" }}>
        {own ? (
          <div className="pg-field">
            <span className="pg-field__label">Consultant</span>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 16 }}>{ownPerson?.name || "—"}</span>
          </div>
        ) : (
          <SearchBox label="Consultant" value={qConsultant} onChange={setQConsultant} options={allConsultants.map((c) => c.name)} onSelect={(name) => setSelectedConsultant(name)} />
        )}
        <label className="pg-field">
          <span className="pg-field__label">Month</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button className="pg-btn-ghost" style={{ padding: "7px 9px" }} onClick={() => shiftMonth(-1)} disabled={monthIdx <= 0}><ChevronLeft size={13} /></button>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 16, minWidth: 130, textAlign: "center" }}>{monthKeyState ? monthLabelOf(monthKeyState) : "—"}</span>
            <button className="pg-btn-ghost" style={{ padding: "7px 9px" }} onClick={() => shiftMonth(1)} disabled={monthIdx < 0 || monthIdx >= availableMonths.length - 1}><ChevronRight size={13} /></button>
          </div>
        </label>
        <button
          className="pg-btn-ghost"
          style={{ marginLeft: "auto", gap: 6 }}
          onClick={handleSync}
          disabled={syncing}
          title={(own ? "Reload your hours from the latest ClickUp sync (it runs every 20 minutes)" : "Pull the latest time from ClickUp now")
            + (syncMeta?.last_synced_at ? ` · last synced ${timeAgo(syncMeta.last_synced_at)}` : "")}
        >
          <RefreshCw size={14} style={syncing ? { animation: "pg-spin 1s linear infinite" } : undefined} />
          {syncing ? "Syncing…" : own ? "Refresh" : "Sync now"}
        </button>
        <button
          className="pg-btn-ghost"
          style={{ gap: 6 }}
          disabled={!selectedConsultant || !monthKeyState}
          onClick={copyForXero}
          title="Copies every day with time this month, one per line (e.g. 20 Oct-6.53), for the Xero extension"
        >
          {copyState?.ok ? <Check size={14} /> : <Copy size={14} />}
          {copyState ? (copyState.ok ? `Copied ${copyState.days} day${copyState.days === 1 ? "" : "s"}` : copyState.msg) : "Copy for Xero"}
        </button>
        <button
          className="pg-btn"
          disabled={!selectedConsultant || !monthKeyState}
          onClick={() => printTimesheetPdf(selectedConsultant, monthKeyState, weeks, personDaily, monthlyTotal)}
        >
          <Download size={14} /> Export PDF
        </button>
      </div>

      {selectedConsultant && monthKeyState && (
        <div className="pg-cap-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <span className="pg-client__name" style={{ fontSize: 21 }}>
              {selectedConsultant}
              <span className="pg-tag" style={{ color: "var(--accent)" }}>[{allConsultants.find((c) => c.name === selectedConsultant)?.role || "Consultant"}]</span>
            </span>
            <div style={{ textAlign: "right" }}>
              <div className="pg-field__label">Monthly total</div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 600 }}>{fmt2(monthlyTotal)} h</div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18, flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="pg-field__label">Week ending</span>
              <button className="pg-btn-ghost" style={{ padding: "6px 8px" }} onClick={() => shiftWeek(-1)} disabled={weekIdx <= 0}><ChevronLeft size={12} /></button>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 16 }}>{weekEndingLabel}</span>
              <button className="pg-btn-ghost" style={{ padding: "6px 8px" }} onClick={() => shiftWeek(1)} disabled={weekIdx >= weeks.length - 1}><ChevronRight size={12} /></button>
            </div>
            <span className="pg-tag pg-tag--muted">Week {weekIdx + 1} of {weeks.length}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: `repeat(${weekDayValues.length}, 1fr) 90px`, gap: 10, marginTop: 14 }}>
            {weekDayValues.map((d) => (
              <div key={d.dateKey} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
                <div className="pg-field__label" style={{ textAlign: "center" }}>{d.weekday}<br />{d.label}</div>
                <div className="pg-input" style={{ width: "100%", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 15, background: "var(--bg-base)" }}>{fmt2(d.hours)}</div>
              </div>
            ))}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
              <div className="pg-field__label" style={{ textAlign: "center", color: "var(--accent)" }}>Hours</div>
              <div className="pg-input" style={{ width: "100%", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 600, color: "var(--accent)", background: "var(--accent-soft)", borderColor: "var(--accent-soft)" }}>{fmt2(weekTotal)}</div>
            </div>
          </div>
        </div>
      )}

      <p className="pg-footnote">Purple Giraffe · Timesheet Summary · Weeks run in sequential 7-day blocks from the 1st of the month (not calendar Mon-Sun), matching how the exported PDF lays out the full month.</p>
    </div>
  );
}

export default function TimesheetSummary({ own = null }) {
  return (
    <ErrorBoundary>
      <TimesheetInner own={own} />
    </ErrorBoundary>
  );
}
