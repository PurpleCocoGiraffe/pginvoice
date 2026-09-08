import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  Upload, ChevronDown, ChevronLeft, ChevronRight, Download, Search,
  AlertTriangle, FileSpreadsheet, FileText, Printer, Users, Clock,
  RefreshCw, Wifi, WifiOff,
  Calendar, SlidersHorizontal,
} from "lucide-react";
import { idbGet, idbSet, PG_DATA_EVENT } from "./idbStore.js";
import { findMatch, multiFolderMatchesFor, multiFolderAccrualMatchesFor, isInternalFolder, CLIENT_TYPE_LABELS, CLIENT_TYPE_TONES, TYPE_LABELS_SHORT, dominantClientType, basisToClientType } from "./nameMatch.js";
import { fetchClickupFromSupabase, fetchSyncMeta, triggerManualSync, LIVE_SYNC_LABEL } from "./clickupSync.js";
import { fetchAccruedForReconciliation, ACCRUALS_LIVE_SYNC_LABEL } from "./accrualsSync.js";
import { SEED_CLIENTS as CAP_SEED_CLIENTS, SEED_PEOPLE, loadKey as loadCapKey } from "./capacityData.js";
import { fetchClients as fetchPgClients, fetchClientEvents, applyDueClientEvents, typeForMonth } from "./clientsSync.js";
import { ClientAvatar } from "./avatar.jsx";
import { useDismissable } from "./useDismissable.js";
import { fmt, esc, filenameSafe, timeAgo, isPackageLikeType } from "./format.js";
import { ExportItem } from "./ExportItem.jsx";
import { ClientRow } from "./ClientRow.jsx";
import { ClientDrawer } from "./ClientDrawer.jsx";
import {
  parseTimeTextToMinutes, msToMinutes, parseHeaderToMonth, monthLabel, monthKey, prevMonthKeyStr,
  parseAccruedWorkbook, findHeader, SKIP_FOLDERS, parseStartTextMonth, dateKeyStr, parseClickupCsv,
} from "./parsers.js";
import { buildPrintHtml, printClientPdf, printLineItemPdf } from "./printTemplate.js";
import { CLICKUP_DB_KEY, ACCRUED_DB_KEY, CAP_CLIENTS_KEY, CAP_PEOPLE_KEY, PG_CLIENTS_KEY } from "./storageKeys.js";
// A <label> wrapping a <select> only focuses it on click in most browsers -- opening
// the dropdown itself needs a second click directly on the control. Used as the
// onClick for every pill-style filter label so one click anywhere on the pill
// (icon, padding, chevron, not just the select's own text) opens the picker.
// showPicker() is the real native/system dropdown; falls back to a focus+click
// nudge on browsers that don't support it yet (still native, just one extra tick).
function openPillPicker(e) {
  const select = e.currentTarget.querySelector("select");
  if (!select || select.disabled || e.target === select) return;
  e.preventDefault();
  select.focus();
  if (typeof select.showPicker === "function") select.showPicker();
}

// ------------------------------ classification ------------------------------
function classifyClient(c) {
  if (c.matched && c.pkg != null) return "package";
  if (/\(qld\)/i.test(c.name)) return "queensland";
  return "hourly";
}

const TYPE_LABELS = {
  all: "All Clients",
  package: "Clients on a Package",
  hourly: "Clients on Hourly rate",
  quoted: "Quoted Clients",
  map: "MAP Clients",
  project: "Project Clients",
  strategy: "Strategy Clients",
  ad_hoc: "Ad hoc Clients",
  queensland: "Queensland Clients (prv)",
};

// isPackageLikeType now lives in ./format.js, shared with the print template.
// TYPE_LABELS_SHORT now lives in ./nameMatch.js, shared with ClientRow.jsx/ClientDrawer.jsx.

// ------------------------------- storage keys --------------------------------
const NAMEMAP_KEY = "pg-name-map-v1";
const VIEWSTATE_KEY = "pg-view-state-v1";
// Below this many hours of disagreement between the accrued sheet's recorded prior-month
// balance and what it recalculates to from current ClickUp data, treat it as rounding noise
// rather than a real edit-after-the-fact discrepancy worth flagging.
const MISMATCH_TOLERANCE_H = 0.2;

// Groups a client list by capGroup and, for any group with 2+ members, picks one
// "primary" (the Package-like one if present, else whoever logged the most hours)
// so the others can nest under it instead of showing as separate top-level cards.
// A pure function of the list handed in so it can be run against both the current
// month's clients and the prior month's without two hand-maintained copies of the
// same grouping logic quietly drifting apart from each other.
function computePrimaryNameByGroup(clientList) {
  const byGroup = new Map();
  clientList.forEach((c) => { if (!c.capGroup) return; if (!byGroup.has(c.capGroup)) byGroup.set(c.capGroup, []); byGroup.get(c.capGroup).push(c); });
  const result = new Map();
  byGroup.forEach((members, group) => {
    if (members.length < 2) return;
    const primary = members.find((m) => isPackageLikeType(m.type)) || [...members].sort((a, b) => b.worked - a.worked)[0];
    result.set(group, primary.name);
  });
  return result;
}

// Shared type/consultant/search filter + primary-group suppression (everything
// `visible` below needs except the final sort, which only the current-month list
// actually does). Used for both the current month's `visible` list and the prior
// month's `prevStats` comparison list, so "what's currently in view" can't
// silently diverge between the two -- previously prevStats hand-duplicated this
// exact filtering logic as a separate inline copy.
function filterClientList(list, { clientTypeFilter, consultantFilter, search, primaryNameByGroup }) {
  let out = clientTypeFilter === "all" ? list.slice()
    : clientTypeFilter === "map" ? list.filter((c) => c.isMap)
    : list.filter((c) => c.type === clientTypeFilter);
  if (consultantFilter) out = out.filter((c) => c.userMinutes.has(consultantFilter));
  out = out.filter((c) => {
    if (!c.capGroup) return true;
    const primaryName = primaryNameByGroup.get(c.capGroup);
    return !primaryName || c.name === primaryName;
  });
  // A folder explicitly tagged as another cost-centre client's sub-project (see
  // costCentreParentAccName in buildClientsForMonth) is always shown nested under that
  // parent's tile, never again as its own top-level card -- same rule as capGroup above,
  // just driven by nameMatch.js's rules instead of Capacity Planning's grouping.
  out = out.filter((c) => !c.costCentreParentAccName);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    out = out.filter((c) => c.name.toLowerCase().includes(q) || (c.displayName || "").toLowerCase().includes(q));
  }
  return out;
}

// ================================ COMPONENT =================================
export default function PGReconciliation({ onNavigateClients }) {
  const [clickup, setClickup] = useState(null);
  const [accrued, setAccrued] = useState(null);
  const [invoiceMonth, setInvoiceMonth] = useState("");
  const [dataMonthKey, setDataMonthKey] = useState("");
  const [priorMonthKey, setPriorMonthKey] = useState("");
  const [billableOnly, setBillableOnly] = useState(true);
  const [nameMap, setNameMap] = useState({});
  const [search, setSearch] = useState("");
  const [drawerClientName, setDrawerClientName] = useState(null);
  const [copied, setCopied] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [clickupErr, setClickupErr] = useState(null);
  const [accruedErr, setAccruedErr] = useState(null);
  const [clientTypeFilter, setClientTypeFilter] = useState("package");
  const [consultantFilter, setConsultantFilter] = useState("");
  const [sortMode, setSortMode] = useState("risk");
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const clickupInput = useRef(null);
  const accruedInput = useRef(null);
  const saveTimer = useRef(null);
  const viewSaveTimer = useRef(null);
  const invoiceMonthAutoRef = useRef("");
  const justHydratedClickupRef = useRef(undefined);
  const justHydratedAccruedRef = useRef(undefined);
  const [hydrated, setHydrated] = useState(false);
  const [syncMeta, setSyncMeta] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [clickupSource, setClickupSource] = useState(null); // "supabase" | "manual"
  const manualOverrideRef = useRef(false);
  const [accruedSource, setAccruedSource] = useState(null); // "supabase" | "manual"
  const accruedManualOverrideRef = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(NAMEMAP_KEY);
      if (raw) setNameMap(JSON.parse(raw));
    } catch (e) {}
  }, []);

  // Capacity Planning's client list (Supabase-backed), read-only here — used only to
  // cross-reference a client's current "basis" (Package/Project/Quoted/MAP/Strategy/
  // Hourly/Ad hoc) so a client on a Marketing Action Plan shows up as its own "MAP"
  // type below instead of whatever Client Invoicing's own package/hourly heuristic
  // would otherwise guess. Reactive to the same PG_DATA_EVENT Capacity Planning
  // broadcasts on every edit, so a basis change there is reflected here live.
  const [capClients, setCapClients] = useState(CAP_SEED_CLIENTS);
  useEffect(() => {
    let cancelled = false;
    const load = () => loadCapKey(CAP_CLIENTS_KEY, CAP_SEED_CLIENTS).then((v) => { if (!cancelled) setCapClients(v || CAP_SEED_CLIENTS); });
    load();
    const onUpdate = (e) => { if (!e.detail || e.detail.key === CAP_CLIENTS_KEY) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);

  // The Consultants module's roster (Supabase-backed), read-only here — used only to look
  // up a consultant's photo by their ClickUp username, so an avatar uploaded once in
  // Consultants shows up in the Consultant contributions list below without duplicating it.
  const [capPeople, setCapPeople] = useState(SEED_PEOPLE);
  useEffect(() => {
    let cancelled = false;
    const load = () => loadCapKey(CAP_PEOPLE_KEY, SEED_PEOPLE).then((v) => { if (!cancelled) setCapPeople(v || SEED_PEOPLE); });
    load();
    const onUpdate = (e) => { if (!e.detail || e.detail.key === CAP_PEOPLE_KEY) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);
  const capTypeByGroup = useMemo(() => {
    const byGroup = new Map();
    capClients.forEach((c) => { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); });
    const result = new Map();
    byGroup.forEach((rows, group) => result.set(group, dominantClientType(rows)));
    return result;
  }, [capClients]);
  // A group is offboarded once every sub-project/row under it is inactive — as long as
  // even one row is still active, the group as a whole is still live. offboardedFrom is
  // the latest of its rows' dates, since that's when the last bit of work actually stopped.
  const capOffboardedByGroup = useMemo(() => {
    const byGroup = new Map();
    capClients.forEach((c) => { if (!byGroup.has(c.group)) byGroup.set(c.group, []); byGroup.get(c.group).push(c); });
    const result = new Map();
    byGroup.forEach((rows, group) => {
      if (!rows.every((r) => r.status === "inactive")) return;
      const dates = rows.map((r) => r.offboardedFrom).filter(Boolean).sort();
      result.set(group, { offboardedFrom: dates.length ? dates[dates.length - 1] : null, note: rows.find((r) => r.offboardNote)?.offboardNote || "" });
    });
    return result;
  }, [capClients]);
  const capGroupNames = useMemo(() => [...capTypeByGroup.keys()], [capTypeByGroup]);
  // Exact folder-name -> Capacity Planning row, for clients with more than one real
  // ClickUp folder under the same group (e.g. Warrina Homes: a Package folder plus a
  // separate one-off Quoted sub-project folder). classifyClient() below only asks "did
  // some accrued-sheet row match this folder's name," so when a sub-project's name is
  // close enough to fuzzy-match the SAME accrued row as the main package, it silently
  // inherited that package's full $ balance/pacing treatment -- two folders both showing
  // the exact same "package 24h, over-used 7.67h" figures as if each were its own
  // independent copy of the same commitment, which is exactly backwards. Capacity
  // Planning's own per-row basis is more precise than the accrued sheet can be here (the
  // accrued sheet only tracks Package-type clients at all), so it wins when they disagree.
  const capRowByClientName = useMemo(() => new Map(capClients.map((c) => [c.client, c])), [capClients]);

  // The Clients module's roster + scheduled type-change events (Supabase-backed) — the
  // authoritative source for "what type was this client actually on in a given month,"
  // including temporary transitions like a package client billing hourly for a couple of
  // months before reverting (e.g. GPEx, June-July 2026). Client Accruals already replays
  // this history correctly (see accrualsSync.js's recomputeAccruals); Client Invoicing's
  // own classifyClient() below only ever guessed from whatever accrued workbook happened
  // to be uploaded, with no month- or history-awareness, so a scheduled transition never
  // showed up here. Cross-referenced by ClickUp folder name below so each client card's
  // type reflects whatever was actually in effect for the month currently in view.
  const [pgClients, setPgClients] = useState([]);
  const [pgClientEvents, setPgClientEvents] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try { await applyDueClientEvents(); } catch (e) { /* best-effort */ }
      const [profiles, events] = await Promise.all([fetchPgClients(), fetchClientEvents()]);
      if (!cancelled) { setPgClients(profiles); setPgClientEvents(events); }
    };
    load();
    const onUpdate = (e) => { if (!e.detail || e.detail.key === PG_CLIENTS_KEY) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);
  const pgClientNames = useMemo(() => pgClients.map((p) => p.client), [pgClients]);
  // Exact ClickUp-folder -> profile lookup first (the authoritative mapping set via the
  // Clients module's own folder field), falling back to fuzzy name matching only for
  // profiles that haven't had their folder set yet.
  const pgProfileByFolder = useMemo(() => {
    const m = new Map();
    pgClients.forEach((p) => {
      if (!p.clickupFolder) return;
      const existing = m.get(p.clickupFolder);
      // More than one Clients-module record can point at the same ClickUp folder
      // (e.g. a since-offboarded sub-engagement that used to share a client's
      // main folder) -- prefer whichever one is still active, so lookups here
      // (type, logo, consultant, …) reflect the client actually using that
      // folder today rather than whichever row happened to sort last.
      if (!existing || (existing.status !== "active" && p.status === "active")) {
        m.set(p.clickupFolder, p);
      }
    });
    return m;
  }, [pgClients]);
  const pgClientByName = useMemo(() => new Map(pgClients.map((p) => [p.client, p])), [pgClients]);

  // Restore the uploaded data and filters from a previous session. The parsed CSV can run
  // several MB as JSON, too close to localStorage's shared per-origin quota to risk — so the
  // two large datasets live in IndexedDB, and just the small filter/view settings use
  // localStorage. Both setClickup/setAccrued and the filter setters land in the same commit,
  // so the auto-select effects below (which only override an *invalid* selection) see the
  // restored values already in place and leave them alone.
  useEffect(() => {
    (async () => {
      const [savedClickup, savedAccrued] = await Promise.all([idbGet(CLICKUP_DB_KEY), idbGet(ACCRUED_DB_KEY)]);
      if (savedClickup) {
        setClickup(savedClickup);
        justHydratedClickupRef.current = savedClickup;
        // IndexedDB caches whatever's in `clickup` state regardless of its origin --
        // both a manual upload AND a successful live sync end up here (see the
        // idbSet(CLICKUP_DB_KEY, clickup) effect below). Unconditionally marking
        // restored data "manual" was wrong: once live sync had ever run once, every
        // later reload restored that live data from cache and permanently mislabeled
        // it manual, which also set manualOverrideRef -- silently blocking the live
        // fetch below from ever taking over again, even on a working sync. Only
        // treat it as manual if it's NOT the live-sync payload (fetchClickupFromSupabase
        // always stamps its own fileName; a real manual upload never matches it).
        if (savedClickup.fileName !== LIVE_SYNC_LABEL) {
          manualOverrideRef.current = true;
          setClickupSource("manual");
        } else {
          setClickupSource("supabase");
        }
      }
      if (savedAccrued) {
        setAccrued(savedAccrued);
        justHydratedAccruedRef.current = savedAccrued;
        // Same manual-vs-live distinction as the ClickUp cache above -- a cached
        // live-sync payload restored from IndexedDB shouldn't be mislabeled manual,
        // or it'd permanently block the live fetch below from ever refreshing it.
        if (savedAccrued.fileName !== ACCRUALS_LIVE_SYNC_LABEL) {
          accruedManualOverrideRef.current = true;
          setAccruedSource("manual");
        } else {
          setAccruedSource("supabase");
        }
      }
      try {
        const raw = window.localStorage.getItem(VIEWSTATE_KEY);
        if (raw) {
          const v = JSON.parse(raw);
          if (v.invoiceMonth != null) { setInvoiceMonth(v.invoiceMonth); invoiceMonthAutoRef.current = v.invoiceMonth; }
          if (v.dataMonthKey != null) setDataMonthKey(v.dataMonthKey);
          if (v.priorMonthKey != null) setPriorMonthKey(v.priorMonthKey);
          if (v.billableOnly != null) setBillableOnly(v.billableOnly);
          if (v.clientTypeFilter != null) setClientTypeFilter(v.clientTypeFilter);
          if (v.consultantFilter != null) setConsultantFilter(v.consultantFilter);
          if (v.sortMode != null) setSortMode(v.sortMode);
          if (v.search != null) setSearch(v.search);
        }
      } catch (e) { /* ignore */ }
      setHydrated(true);

      // Live ClickUp data, kept fresh by a Supabase-scheduled sync (see
      // clickupSync.js) — this is what makes the app auto-populate on every
      // reload, without waiting for a manual upload. A manual upload later in
      // this same session still wins until the next reload (see handleClickup
      // and handleManualSync below), guarded by manualOverrideRef so a slow
      // network response can't clobber a file the user just chose.
      fetchSyncMeta().then(setSyncMeta).catch(() => {});
      fetchClickupFromSupabase().then((live) => {
        if (!live || manualOverrideRef.current) return;
        setClickup(live);
        setClickupSource("supabase");
      }).catch((e) => console.error("Supabase ClickUp fetch failed:", e));

      // Accrual balances kept current in pginvoice_accruals by the Client Accruals
      // module's recomputeAccruals() -- fetching them here means a new device/browser
      // has real accrual data immediately, no manual sheet upload required. A manual
      // upload later in this session still wins (accruedManualOverrideRef), same
      // pattern as ClickUp's live sync above.
      fetchAccruedForReconciliation().then((live) => {
        if (!live || accruedManualOverrideRef.current) return;
        setAccrued(live);
        setAccruedSource("supabase");
      }).catch((e) => console.error("Supabase accruals fetch failed:", e));
    })();
  }, []);

  const handleManualSync = async () => {
    setSyncing(true);
    manualOverrideRef.current = false; // an explicit "Sync now" click means: give me live data
    try {
      await triggerManualSync();
      const live = await fetchClickupFromSupabase();
      if (live) { setClickup(live); setClickupSource("supabase"); }
      setSyncMeta(await fetchSyncMeta());
    } catch (e) {
      setClickupErr("Sync failed: " + (e && e.message ? e.message : String(e)));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    // skip the one redundant write-back right after hydration set this to the exact object
    // we just read out of IndexedDB — no need to round-trip several MB back in immediately
    if (clickup === justHydratedClickupRef.current) { justHydratedClickupRef.current = undefined; return; }
    idbSet(CLICKUP_DB_KEY, clickup);
  }, [clickup, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    if (accrued === justHydratedAccruedRef.current) { justHydratedAccruedRef.current = undefined; return; }
    idbSet(ACCRUED_DB_KEY, accrued);
  }, [accrued, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    if (viewSaveTimer.current) clearTimeout(viewSaveTimer.current);
    const snapshot = { invoiceMonth, dataMonthKey, priorMonthKey, billableOnly, clientTypeFilter, consultantFilter, sortMode, search };
    viewSaveTimer.current = setTimeout(() => {
      try { window.localStorage.setItem(VIEWSTATE_KEY, JSON.stringify(snapshot)); } catch (e) {}
    }, 400);
  }, [hydrated, invoiceMonth, dataMonthKey, priorMonthKey, billableOnly, clientTypeFilter, consultantFilter, sortMode, search]);

  useEffect(() => {
    if (!accrued) return;
    if (priorMonthKey && accrued.balanceCols.find((c) => monthKey(c.year, c.month) === priorMonthKey)) return;
    const last = accrued.balanceCols[accrued.balanceCols.length - 1];
    if (last) setPriorMonthKey(monthKey(last.year, last.month));
  }, [accrued]); // eslint-disable-line

  // when a new ClickUp export loads, default the reporting period to the most recent month
  // it contains (or "" — no filter — for older exports with no Start Text column to detect
  // months from at all) — but leave a still-valid selection alone, since that's exactly what
  // lets a restored session (see hydration effect above) keep its previously-chosen period.
  useEffect(() => {
    if (!clickup) { setDataMonthKey(""); return; }
    if (dataMonthKey && availableMonths.some((m) => m.key === dataMonthKey)) return;
    setDataMonthKey(availableMonths.length ? availableMonths[availableMonths.length - 1].key : "");
  }, [clickup]); // eslint-disable-line

  // Whenever the reporting period changes, chain "prior balance from" to the month
  // right before it — this is what makes reconciling an older month in a multi-month
  // export line up with the right historical balance instead of always the latest.
  // Chains there even when the accrued sheet doesn't have that column yet (rather than
  // silently falling back to whatever the last available column happens to be, which
  // would understate the real carry-in by a month or more); buildClientsForMonth
  // estimates the missing balance from ClickUp hours in that case, and the dropdown
  // below shows it as an "(estimated)" option so it's never mistaken for sheet data.
  useEffect(() => {
    if (!accrued || !dataMonthKey) return;
    setPriorMonthKey(prevMonthKeyStr(dataMonthKey));
  }, [dataMonthKey, accrued]); // eslint-disable-line

  // pre-fill the (still freely editable) invoice-month label from the detected period,
  // without clobbering anything the user typed themselves
  useEffect(() => {
    if (!dataMonthKey) return;
    const label = availableMonths.find((m) => m.key === dataMonthKey)?.label;
    if (!label) return;
    if (!invoiceMonth || invoiceMonth === invoiceMonthAutoRef.current) {
      setInvoiceMonth(label);
      invoiceMonthAutoRef.current = label;
    }
  }, [dataMonthKey]); // eslint-disable-line

  const persistNameMap = useCallback((next) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { try { window.localStorage.setItem(NAMEMAP_KEY, JSON.stringify(next)); } catch (e) {} }, 400);
  }, []);

  const setManualMatch = (clickupName, accruedName) => {
    setNameMap((prev) => {
      const next = { ...prev };
      if (accruedName === "__none__") delete next[clickupName];
      else next[clickupName] = accruedName;
      persistNameMap(next);
      return next;
    });
  };

  const handleClickup = (file) => {
    if (!file) return;
    setClickupErr(null);
    setDataMonthKey(""); // force fresh period auto-detection for this new file, rather than
                          // keeping whatever was selected for the previous one
    manualOverrideRef.current = true; // wins over live sync until the next reload
    setClickupSource("manual");
    parseClickupCsv(file,
      (r) => setClickup({ ...r, fileName: file.name, uploadedAt: Date.now() }),
      (msg) => { setClickupErr(msg); setClickup(null); });
  };
  const handleAccrued = (file) => {
    if (!file) return;
    setAccruedErr(null);
    accruedManualOverrideRef.current = true; // wins over live-synced accruals until the next reload
    const isXlsx = /\.xls[mx]?$/i.test(file.name);
    if (isXlsx) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try { setAccrued({ ...parseAccruedWorkbook(e.target.result), fileName: file.name }); setAccruedSource("manual"); }
        catch (err) { setAccruedErr("Couldn't read the accrued file: " + err.message); }
      };
      reader.onerror = () => setAccruedErr("Couldn't read the file.");
      reader.readAsArrayBuffer(file);
    } else {
      Papa.parse(file, {
        header: false, skipEmptyLines: "greedy",
        complete: (result) => {
          try {
            const ws = XLSX.utils.aoa_to_sheet(result.data);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Accrued Hours");
            const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
            setAccrued({ ...parseAccruedWorkbook(out), fileName: file.name });
            setAccruedSource("manual");
          } catch (err) { setAccruedErr("Couldn't read the accrued CSV: " + err.message); }
        },
        error: (e) => setAccruedErr("Couldn't read the file: " + e.message),
      });
    }
  };

  const accruedNames = useMemo(() => (accrued ? accrued.clients.map((c) => c.name) : []), [accrued]);

  // billable, non-internal minutes per folder for a given month — used to independently
  // re-derive what that month's ending balance would be from current ClickUp data, to
  // cross-check against what the accrued sheet already has recorded for it. Parametrized
  // (rather than reading priorMonthKey directly) so the KPI trend comparison below can
  // run this same check for the month before priorMonthKey too. Returns null when the
  // export doesn't cover that month at all (nothing to check).
  const computeMonthWorked = useCallback((monthKey) => {
    if (!clickup || !monthKey) return null;
    const byFolder = new Map();
    let covered = false;
    for (const r of clickup.rows) {
      if (r.monthKey === monthKey) covered = true; else continue;
      if (clickup.hasBillable && billableOnly && !r.billable) continue;
      if (r.isInternal) continue;
      byFolder.set(r.folder, (byFolder.get(r.folder) || 0) + r.minutes);
    }
    return covered ? byFolder : null;
  }, [clickup, billableOnly]);
  const priorMonthWorked = useMemo(() => computeMonthWorked(priorMonthKey), [computeMonthWorked, priorMonthKey]);

  // Same shape as computeMonthWorked's per-folder map, but summed across every synced
  // month rather than one -- a Quoted client's remaining balance is the quoted amount
  // minus everything ever billed against it, not just this month's hours, since a quoted
  // project runs until its budget is spent rather than resetting monthly like a package.
  const lifetimeWorkedByFolder = useMemo(() => {
    if (!clickup) return new Map();
    const byFolder = new Map();
    for (const r of clickup.rows) {
      if (clickup.hasBillable && billableOnly && !r.billable) continue;
      if (r.isInternal) continue;
      byFolder.set(r.folder, (byFolder.get(r.folder) || 0) + r.minutes);
    }
    return byFolder;
  }, [clickup, billableOnly]);

  // Full per-client reconciliation, parametrized by (monthKey, priorKey) instead of
  // reading dataMonthKey/priorMonthKey directly — so the KPI trend row below can call
  // this exact same logic for the previous month too, instead of a separate, drift-prone
  // copy of the classification/matching pipeline. WITHOUT consultant filter (base data).
  const buildClientsForMonth = useCallback((monthKey, priorKey) => {
    if (!clickup) return [];
    const monthWorked = computeMonthWorked(priorKey);
    const map = new Map();
    for (const r of clickup.rows) {
      if (clickup.hasBillable && billableOnly && !r.billable) continue;
      if (r.isInternal) continue;
      if (monthKey && r.monthKey && r.monthKey !== monthKey) continue;
      if (!map.has(r.folder))
        map.set(r.folder, { name: r.folder, totalMin: 0, tasksAll: new Map(), userMinutes: new Map(), tasksByUser: new Map(), taskUsers: new Map(), taskIds: new Map() });
      const c = map.get(r.folder);
      c.totalMin += r.minutes;
      c.tasksAll.set(r.task, (c.tasksAll.get(r.task) || 0) + r.minutes);
      const u = r.user || "";
      c.userMinutes.set(u, (c.userMinutes.get(u) || 0) + r.minutes);
      if (!c.tasksByUser.has(u)) c.tasksByUser.set(u, new Map());
      const t = c.tasksByUser.get(u);
      t.set(r.task, (t.get(r.task) || 0) + r.minutes);
      // who logged time against each task, regardless of the consultant filter
      if (!c.taskUsers.has(r.task)) c.taskUsers.set(r.task, new Map());
      const tu = c.taskUsers.get(r.task);
      tu.set(u, (tu.get(u) || 0) + r.minutes);
      // Every row sharing a task NAME should also share the same real ClickUp task id --
      // but names aren't actually unique (e.g. two different "Untitled"/task-less rows,
      // or two genuinely different tasks that happen to be named the same). Track every
      // distinct id seen per name; a link is only shown when there's exactly one, so an
      // ambiguous name never links to the wrong task.
      if (r.taskId) {
        if (!c.taskIds.has(r.task)) c.taskIds.set(r.task, new Set());
        c.taskIds.get(r.task).add(r.taskId);
      }
    }

    // Some clients (Aus3C, Majestic Plumbing, Clarke Energy, Magain, etc.) run real work
    // across several sibling ClickUp folders ("cost centres") instead of one umbrella
    // folder -- Client Accruals and Capacity Planning already merge these via
    // multiFolderAccrualMatchesFor, but until now Client Invoicing showed each sibling
    // folder as its own unrelated top-level row, each independently matching (and each
    // separately claiming) the SAME accrued-sheet package -- e.g. Aus3C's four active
    // folders would all show "package 20h" as if each had its own independent 20h
    // commitment, instead of the four together sharing one.
    // A folder deliberately EXCLUDED from a client's package/accrual math (e.g. Majestic
    // Plumbing's "Quoted Web Project", BAMSS Childcare, Apex Comms Website, Warrina Homes'
    // Employee Guide project -- real client work, billed separately from the retainer) is
    // left completely alone here -- it stays its own normal map entry, which the existing
    // capacity-group sibling nesting below (siblingsByPrimaryName) already renders directly
    // under its cost-centre parent as a "Sub project" row. Only the accrual-eligible
    // folders get folded into one merged row.
    //
    // The candidate list is every REGISTERED client (pgClientNames), not just ones with
    // accrual history (accruedNames) -- accruedNames only covers clients recomputeAccruals
    // has ever written a package/strategy row for, which misses purely-hourly cost-centre
    // clients entirely (Vegetation Solutions, Brisbane Alarm Monitoring, Magain Real
    // Estate's rarer single-folder months, ...). Those clients still need their folders
    // merged for display even though there's no accrual math to run on them.
    const folderNames = [...map.keys()];
    const costCentreCandidates = new Set([...pgClientNames, ...accruedNames]);
    for (const accName of costCentreCandidates) {
      const accrualFolders = multiFolderAccrualMatchesFor(accName, folderNames);
      const matchedInMap = accrualFolders ? accrualFolders.filter((f) => map.has(f)) : [];
      // A hardcoded MULTI_FOLDER_CLIENTS rule's match set always includes the client's own
      // primary folder alongside real siblings; a DYNAMIC client's (pginvoice_cost_centres)
      // does not unless someone remembers to add the primary folder as its own row too --
      // easy to miss, and when missed with at least one real (non-sub-project) sibling
      // present, the primary folder drops out of the roll-up entirely and a sibling gets
      // wrongly promoted to "primary" instead, splitting the client into two conflicting
      // rows (reproduced with Majestic Plumbing + CLT: its own folder's 26.88h vanished
      // from the roll-up, with "MP - Commercial Leak Tech"'s 3.50h standing in as if it
      // were the whole client). Folding the registered clickupFolder in here, whether or
      // not it's an explicit dynamic row, makes this impossible regardless of what the
      // cost-centre table actually contains.
      const ownFolder = pgClientByName.get(accName)?.clickupFolder;
      if (ownFolder && map.has(ownFolder) && matchedInMap.length > 0 && !matchedInMap.includes(ownFolder)) {
        matchedInMap.push(ownFolder);
      }
      // A registered client whose own folder has ALREADY been claimed and deleted from `map`
      // by an earlier candidate in this same loop (two different client names both matching
      // the same real folder -- e.g. a hardcoded MULTI_FOLDER_CLIENTS rule and a dynamic
      // pginvoice_cost_centres row both covering the same client, exactly what happened with
      // Brisbane Alarm Monitoring/BAMSS Childcare) silently loses that folder to whichever
      // candidate happened to process first, with no signal anywhere that it occurred. Loop
      // order is deterministic (alphabetical, from pgClientNames/accruedNames), so this is a
      // logged-but-not-crashing warning rather than a fix -- fixing it properly means picking
      // a real precedence rule between two DIFFERENT client names claiming the same folder,
      // which is a data-modelling decision, not something safe to guess at silently here.
      if (ownFolder && !map.has(ownFolder) && folderNames.includes(ownFolder)) {
        console.warn(`[buildClientsForMonth] "${accName}"'s own folder "${ownFolder}" was already claimed by another client's cost-centre match this month -- check for a hardcoded MULTI_FOLDER_CLIENTS rule and a dynamic pginvoice_cost_centres row both covering the same folder.`);
      }
      // Folders this same rule matches but deliberately excludes from the accrual (billed
      // separately -- Majestic Plumbing's web project, BAMSS Childcare, Apex Comms Website,
      // Warrina Homes' Employee Guide project) are tagged with their true parent's identity
      // right here, rather than left to the capacity-planning capGroup mechanism to (maybe)
      // catch by name similarity -- that mechanism has its own, unrelated grouping data and
      // has no reason to know these two specific client names are related. Tagged folders
      // are left in `map` untouched (not merged, not deleted) so they still become their
      // own ordinary client row below, just carrying a pointer to their real parent.
      const allFolders = multiFolderMatchesFor(accName, folderNames) || [];
      for (const f of allFolders) {
        if (matchedInMap.includes(f) || !map.has(f)) continue;
        map.get(f).costCentreParentAccName = accName;
      }
      if (matchedInMap.length < 1) {
        // No accrual-eligible sibling this month -- true for any client whose dynamic
        // cost-centre rows are ALL sub-projects (billed separately, excluded from the
        // accrual by definition -- see multiFolderAccrualMatchesFor), since a dynamic
        // client's own registered clickupFolder is never itself part of its
        // multiFolderMatchesFor/AccrualMatchesFor result (unlike a hardcoded
        // MULTI_FOLDER_CLIENTS prefix rule, whose match set naturally includes the
        // primary folder alongside real siblings). Below, the rest of this branch
        // renames the primary folder's row to `accName` and stamps costCentreAccruedName
        // so a sibling lookup keyed by the client's real name (allSiblingsFor(c.name),
        // and the accrued-sheet match below) still finds this row and its just-tagged
        // sub-project(s) -- without this, the tag above is written but orphaned: the
        // parent row keeps showing under its raw ClickUp folder name, which nothing
        // else in the app is looking up, so the tagged sub-project never renders nested
        // under it (e.g. ARAS's own folder never gets renamed off of "Aged Rights
        // Advocacy Services", so its Website Optimisation Project sub-project silently
        // has nowhere to attach).
        const profile = pgClientByName.get(accName);
        if (profile?.clickupFolder && map.has(profile.clickupFolder) && !map.get(profile.clickupFolder).costCentreParentAccName) {
          const entry = map.get(profile.clickupFolder);
          entry.name = accName;
          entry.costCentreAccruedName = accName;
        }
        continue;
      }
      // The client's own registered ClickUp folder (set in the Clients module) is the
      // right "identity" folder for this roll-up when it actually logged hours this month
      // -- picking whichever sibling folder happens to have logged the most hours instead
      // used to promote essentially arbitrary folders (e.g. "Aus3C IRAP", or Magain's
      // busiest agent folder that month) to stand in for the whole client, with the real
      // parent ("Australian Cyber Collaboration Centre") demoted to just another line
      // item -- backwards from what the roll-up is meant to show. Vegetation Solutions and
      // Magain have no umbrella folder of their own at all (hasDirectFolder stays false),
      // so every line item below is labelled with its own real folder name instead.
      const profile = pgClientByName.get(accName);
      const hasDirectFolder = !!(profile?.clickupFolder && matchedInMap.includes(profile.clickupFolder));
      let primary = hasDirectFolder ? profile.clickupFolder : matchedInMap[0];
      if (!hasDirectFolder) {
        for (const f of matchedInMap) if (map.get(f).totalMin > map.get(primary).totalMin) primary = f;
      }
      const primaryEntry = map.get(primary);
      // The primary folder's own hours, captured before any sibling gets merged in --
      // labelled with the client's real name only when it's genuinely the registered
      // umbrella folder; otherwise it's just another sibling folder and gets its own name.
      // `tasksByUser` is a snapshot of THIS folder's own tasks (pre-merge) -- kept so the
      // drawer's task list can show a rolled-up client's tasks grouped by which real
      // ClickUp folder they came from, instead of one flat merged list with no way to
      // tell a BAMSS Childcare task from a Brisbane Alarm Monitoring one.
      // Cloned (not a reference) -- primaryEntry.tasksByUser itself gets mutated below as
      // siblings merge into it, and a sibling's own map would otherwise get merged into a
      // shared object too if any two folders happened to share a reference.
      const cloneTasksByUser = (m) => new Map([...m].map(([u, t]) => [u, new Map(t)]));
      const lineItems = [{ name: hasDirectFolder ? accName : primary, hours: primaryEntry.totalMin / 60, tasksByUser: cloneTasksByUser(primaryEntry.tasksByUser) }];
      for (const f of matchedInMap) {
        if (f === primary) continue;
        const entry = map.get(f);
        lineItems.push({ name: f, hours: entry.totalMin / 60, tasksByUser: cloneTasksByUser(entry.tasksByUser) });
        primaryEntry.totalMin += entry.totalMin;
        for (const [task, min] of entry.tasksAll) primaryEntry.tasksAll.set(task, (primaryEntry.tasksAll.get(task) || 0) + min);
        for (const [u, min] of entry.userMinutes) primaryEntry.userMinutes.set(u, (primaryEntry.userMinutes.get(u) || 0) + min);
        for (const [u, tm] of entry.tasksByUser) {
          if (!primaryEntry.tasksByUser.has(u)) primaryEntry.tasksByUser.set(u, new Map());
          const t = primaryEntry.tasksByUser.get(u);
          for (const [task, min] of tm) t.set(task, (t.get(task) || 0) + min);
        }
        for (const [task, tu] of entry.taskUsers) {
          if (!primaryEntry.taskUsers.has(task)) primaryEntry.taskUsers.set(task, new Map());
          const t = primaryEntry.taskUsers.get(task);
          for (const [u, min] of tu) t.set(u, (t.get(u) || 0) + min);
        }
        for (const [task, ids] of entry.taskIds) {
          if (!primaryEntry.taskIds.has(task)) primaryEntry.taskIds.set(task, new Set());
          for (const id of ids) primaryEntry.taskIds.get(task).add(id);
        }
        map.delete(f);
      }
      lineItems.sort((a, b) => b.hours - a.hours);
      // Only worth a "Rolled Up" breakdown when there's an actual sibling folder to show
      // alongside the parent's own -- a client whose only accrual-eligible "match" is its
      // own registered umbrella folder (e.g. Brisbane Alarm Monitoring or Warrina Homes,
      // once their one real sibling is excluded as a billed-separately sub-project) would
      // otherwise show a roll-up panel containing nothing but itself.
      const isTrivialRollup = hasDirectFolder && lineItems.length === 1;
      if (!isTrivialRollup) {
        primaryEntry.costCentre = {
          lineItems, totalWorked: primaryEntry.totalMin / 60,
          accrualFolderNames: matchedInMap,
        };
      }
      // The merged entry's true identity is the accrued client itself, not whichever raw
      // ClickUp folder ended up "primary" -- e.g. Magain Real Estate's busiest folder is
      // literally named "Magain Sales", nothing like the client's own name, so leaving
      // c.name as that folder name would make the accrued-sheet match below fail or
      // misfire. We already know the identity here, so stamp it directly instead of
      // making the per-client loop re-derive it via fuzzy matching.
      primaryEntry.name = accName;
      primaryEntry.costCentreAccruedName = accName;
    }

    const out = [];
    for (const c of map.values()) {
      const worked = c.totalMin / 60;
      let accruedClient = null;
      let matchInfo = null;
      if (accrued) {
        if (c.costCentreAccruedName) {
          accruedClient = accrued.clients.find((a) => a.name === c.costCentreAccruedName) || null;
          if (accruedClient) matchInfo = { name: accruedClient.name, confidence: 1, method: "cost-centre" };
        } else if (nameMap[c.name]) {
          accruedClient = accrued.clients.find((a) => a.name === nameMap[c.name]) || null;
          if (accruedClient) matchInfo = { name: accruedClient.name, confidence: 1, method: "manual" };
        } else if (pgProfileByFolder.get(c.name)) {
          // The Clients module's own registered clickup_folder -> profile mapping is
          // authoritative (same reasoning as recomputeAccruals in accrualsSync.js) --
          // prefer it over re-deriving a match from c.name's raw ClickUp folder string.
          // Without this, a client whose real folder doesn't fuzzy-match its own accrued-
          // table name (e.g. "Coonwarra" vs. folder "Coonawarra Grape and Wine Inc", or
          // "PRG Strategic Advisors" vs. folder "PRG Financial Services Outsourced
          // Marketing") shows up correctly typed as Package but with no package figure at
          // all -- worked hours real, pkg permanently null, "No package on file".
          const profileName = pgProfileByFolder.get(c.name).client;
          accruedClient = accrued.clients.find((a) => a.name === profileName) || null;
          if (accruedClient) matchInfo = { name: accruedClient.name, confidence: 1, method: "client-folder" };
        } else if (!c.costCentreParentAccName) {
          // A row already tagged as another client's sub-project (see costCentreParentAccName
          // above) must NEVER fall through to fuzzy name matching -- its folder name often
          // shares words with its own parent's name by construction (e.g. "ARAS Website
          // Optimisation Project" vs. accrued client "ARAS"), so findMatch would confidently
          // "match" it to the parent (or some unrelated client) and silently overwrite its
          // displayName with the parent's -- exactly the bug that made ARAS's sub-project
          // display as plain "ARAS" instead of its own name. A sub-project keeps showing
          // under its own real folder name unless it has its own EXPLICIT registration
          // (pgProfileByFolder above), which is a name collision fuzzy matching can't cause.
          const m = findMatch(c.name, accruedNames);
          if (m) { accruedClient = accrued.clients.find((a) => a.name === m.name) || null; matchInfo = m; }
        }
      }
      // monthWorked is keyed by raw ClickUp folder name, one entry per folder -- a
      // cost-centre client's identity (c.name) is the accrued client name, not a real
      // folder, so a plain monthWorked.get(c.name) would always miss. Sum across every
      // folder this client's roll-up actually draws from instead.
      const priorMonthWorkedMin = c.costCentre
        ? c.costCentre.accrualFolderNames.reduce((a, f) => a + (monthWorked?.get(f) || 0), 0)
        : (monthWorked?.get(c.name) || 0);
      // Prefer this exact month's agreed hours over the client-level `package` scalar --
      // a package whose hours changed (or that moved off package for a stretch) needs the
      // figure for the month actually being viewed. Falls back to the scalar for a client
      // that only has that (e.g. a manually uploaded workbook, which has no per-month
      // agreed-hours column at all).
      const monthAgreed = accruedClient?.agreedByMonth?.[monthKey];
      const pkg = monthAgreed !== undefined ? monthAgreed : (accruedClient?.package ?? null);
      let priorBalance = accruedClient && priorKey ? (accruedClient.balances[priorKey] ?? null) : null;
      // The accrued sheet doesn't have a column for the prior month (e.g. it hasn't
      // been re-uploaded with last month's closing balance yet) — estimate it the same
      // way the mismatch cross-check below does: worked hours that month (from the
      // live ClickUp data, if it covers that month) minus package, plus whatever
      // balance the sheet DOES have for the month before that. Flagged as estimated
      // rather than presented as verified accrued-sheet data.
      let priorBalanceEstimated = false;
      if (priorBalance === null && accruedClient && pkg !== null && pkg > 0 && monthWorked) {
        const priorWorkedH = priorMonthWorkedMin / 60;
        const priorPriorBalance = accruedClient.balances[prevMonthKeyStr(priorKey)] ?? 0;
        priorBalance = priorWorkedH - pkg + priorPriorBalance;
        priorBalanceEstimated = true;
      }
      let newBalance = null, remaining = null, kpiPct = null, status = "no-pkg";
      if (pkg !== null && pkg > 0) {
        const prior = priorBalance ?? 0;
        newBalance = worked - pkg + prior;
        remaining = pkg - prior - worked;
        kpiPct = (newBalance / pkg) * 100;
        if (kpiPct > 10) status = "over";
        else if (kpiPct < -10) status = "under";
        else status = "ok";
      }
      // Cross-check the sheet's own recorded balance for the PRIOR month (the figure being
      // used as this month's carry-in) against what it would be if recalculated from the
      // ClickUp data we have for that month right now. A mismatch usually means ClickUp
      // entries were edited after the accrued sheet was last updated for that period.
      let priorMismatch = null;
      if (!priorBalanceEstimated && pkg !== null && pkg > 0 && priorBalance !== null && monthWorked) {
        const priorWorkedH = priorMonthWorkedMin / 60;
        const priorPriorBalance = accruedClient.balances[prevMonthKeyStr(priorKey)] ?? 0;
        const recomputed = priorWorkedH - pkg + priorPriorBalance;
        if (Math.abs(recomputed - priorBalance) > MISMATCH_TOLERANCE_H) {
          priorMismatch = { sheetValue: priorBalance, recomputed };
        }
      }
      const clientObj = {
        ...c, worked, accruedClient, matchInfo,
        pkg, priorBalance, priorBalanceEstimated, newBalance, remaining, kpiPct, status, priorMismatch,
        matched: !!accruedClient,
        displayName: accruedClient?.name ?? c.name,
        costCentre: c.costCentre || null,
      };
      clientObj.type = classifyClient(clientObj);
      // The Clients module knows what this client was actually billing as for THIS
      // specific month (typeForMonth replays its scheduled type-change events) — that
      // always wins over the accrued-workbook guess above, since a temporary transition
      // (e.g. GPEx briefly moving to hourly for a couple of months before reverting to
      // its package) has no way to be reflected in classifyClient()'s static, upload-only
      // logic otherwise. Falls back to classifyClient()'s result for any client not yet
      // registered in the Clients module.
      const pgProfile = pgProfileByFolder.get(c.name) || (() => {
        const m = findMatch(c.name, pgClientNames);
        return m ? pgClientByName.get(m.name) : null;
      })();
      if (pgProfile && monthKey) {
        const seg = typeForMonth(pgProfile, pgClientEvents, monthKey);
        if (seg?.type) {
          clientObj.type = seg.type;
          // Only worth flagging as a transition when it actually changed something from
          // the client's normal baseline — otherwise every already-registered client would
          // show a "scheduled" badge for no reason.
          clientObj.typeTransitioned = seg.type !== pgProfile.baseType;
          clientObj.typeTransitionNote = seg.note;
        }
      }
      // Quoted: a single fixed hour budget for the whole project, not a monthly one --
      // "remaining" is the quoted amount minus every billable hour ever logged against it,
      // across every synced month, not just the one currently being viewed. Reuses the
      // same agreed_hours column package/strategy clients use (set via the Clients module),
      // just interpreted as a lifetime total instead of a per-month figure for this type.
      if (clientObj.type === "quoted") {
        // c.name may already have been renamed to the accrued/registered client's display
        // name by the cost-centre merge loop above (e.g. "ARAS", "PRG Strategic Advisors")
        // even when there's no actual multi-folder rollup (c.costCentre null) -- the exact
        // same class of bug fixed earlier this session for other figures (ARAS's real
        // ClickUp folder is "Aged Rights Advocacy Services", nothing like its display name).
        // lifetimeWorkedByFolder is keyed by REAL ClickUp folder names, so looking it up by
        // c.name here would silently return 0 for any such client. pgProfile.clickupFolder
        // (the Clients module's own registered mapping, already resolved above) is the
        // right key; c.name is only a safe fallback for a client with no registration at
        // all, where it's still the raw folder name because nothing renamed it.
        const quotedFolders = c.costCentre ? c.costCentre.accrualFolderNames : [pgProfile?.clickupFolder || c.name];
        const lifetimeWorkedMin = quotedFolders.reduce((a, f) => a + (lifetimeWorkedByFolder.get(f) || 0), 0);
        clientObj.lifetimeWorked = lifetimeWorkedMin / 60;
        clientObj.quotedAmount = pgProfile?.agreedHours ?? null;
        clientObj.quotedRemaining = clientObj.quotedAmount != null ? clientObj.quotedAmount - clientObj.lifetimeWorked : null;
      }
      // This exact folder's own Capacity Planning row (not just a fuzzy group match) --
      // corrects classifyClient()'s "matched an accrued row with a package figure, so it
      // must be a package" assumption for a sub-project folder that only fuzzy-matched
      // the MAIN package's accrued-sheet row by name coincidence. When Capacity Planning
      // already knows this specific folder is really Quoted/Hourly/etc, that overrides
      // the false "package" guess -- this folder stops carrying the main package's $
      // balance/pacing math (which was never really its own), instead of two folders
      // both showing an identical "package 24h, over-used 7.67h" as if each independently
      // owned the same commitment.
      const capRow = capRowByClientName.get(c.name);
      if (capRow) {
        const capType = basisToClientType(capRow.basis);
        if (!isPackageLikeType(capType) && isPackageLikeType(clientObj.type)) {
          clientObj.type = capType;
          clientObj.packageOverriddenBy = capRow.basis;
        }
        clientObj.capGroup = capRow.group;
      }
      // Client Invoicing has no independent way to know a client is on a Marketing
      // Action Plan (MAP) — that's tracked only in Capacity Planning's "basis" field.
      // Cross-reference it here by name, purely additively: c.type (which the
      // package/hourly/Queensland UI below is built around, including the real
      // accrued-balance tracking) is left exactly as classifyClient() already
      // determines it, so a MAP client that's also tracked with a package-style
      // accrual keeps that UI. isMap just layers a separate "MAP" filter option and
      // an inline tag on top, visible regardless of which type bucket a client
      // otherwise falls into. Reads live capacity data, so a client moving off MAP
      // is reflected here automatically next time this recomputes.
      const capMatch = findMatch(c.name, capGroupNames);
      clientObj.isMap = capMatch ? capTypeByGroup.get(capMatch.name) === "map" : false;
      const offboarded = capMatch ? capOffboardedByGroup.get(capMatch.name) : null;
      clientObj.isOffboarded = !!offboarded && (!monthKey || !offboarded.offboardedFrom || monthKey >= offboarded.offboardedFrom);
      clientObj.offboardNote = offboarded?.note || "";
      if (!clientObj.capGroup && capMatch) clientObj.capGroup = capMatch.name;
      // Logo set in the Clients module (uploaded, or auto-fetched from the client's
      // website favicon) — purely cosmetic, falls back to initials when absent.
      clientObj.logoUrl = pgProfile?.logoUrl || null;
      out.push(clientObj);
    }
    return out;
  }, [clickup, accrued, accruedNames, nameMap, billableOnly, computeMonthWorked, lifetimeWorkedByFolder, capGroupNames, capTypeByGroup, capOffboardedByGroup, capRowByClientName, pgProfileByFolder, pgClientNames, pgClientByName, pgClientEvents]);

  const clients = useMemo(() => buildClientsForMonth(dataMonthKey, priorMonthKey), [buildClientsForMonth, dataMonthKey, priorMonthKey]);

  // Same reconciliation, one month earlier — real, fully-computed numbers (not a
  // fabricated estimate), used only to power the "vs last month" KPI comparisons.
  // Shifts both the reporting month and the balance-lookup month back by one, mirroring
  // what the "prior balance from" auto-chain effect does when you step the month picker.
  const prevMonthDataKey = dataMonthKey ? prevMonthKeyStr(dataMonthKey) : "";
  const prevClients = useMemo(
    () => (dataMonthKey ? buildClientsForMonth(prevMonthDataKey, prevMonthKeyStr(priorMonthKey || prevMonthDataKey)) : []),
    [buildClientsForMonth, dataMonthKey, prevMonthDataKey, priorMonthKey]
  );

  // counts by type — "map" counts c.isMap (an overlay tag), not c.type, since a MAP
  // client keeps whatever c.type its own package/hourly classification landed on.
  const typeCounts = useMemo(() => {
    const counts = { all: clients.length, package: 0, hourly: 0, queensland: 0, quoted: 0, map: 0, project: 0, strategy: 0, ad_hoc: 0 };
    for (const c of clients) {
      counts[c.type] = (counts[c.type] || 0) + 1;
      if (c.isMap) counts.map++;
    }
    return counts;
  }, [clients]);

  // consultant list from clickup rows (across all clients, all types — same scope as `clients`)
  const consultants = useMemo(() => {
    if (!clickup) return [];
    const set = new Set();
    for (const r of clickup.rows) {
      if (r.isInternal) continue;
      if (dataMonthKey && r.monthKey && r.monthKey !== dataMonthKey) continue;
      if (r.user) set.add(r.user);
    }
    return [...set].sort();
  }, [clickup, dataMonthKey]);

  // distinct months detected in the export (from Start Text), for the data-period picker
  const availableMonths = useMemo(() => {
    if (!clickup) return [];
    const map = new Map();
    for (const r of clickup.rows) {
      if (!r.monthKey) continue;
      map.set(r.monthKey, r.monthLabel);
    }
    return [...map.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.key.localeCompare(b.key));
  }, [clickup]);

  // folders excluded as internal/non-client (onboarding, WIP, etc. — NOT Purple Giraffe, which is
  // DMA's real consultant hours) — surfaced for transparency rather than silently dropped, since the
  // keyword rule can misfire on a client-named onboarding folder (see the billable-hours guide, §3.1).
  const excludedInternal = useMemo(() => {
    if (!clickup) return { total: 0, folders: [] };
    const byFolder = new Map();
    for (const r of clickup.rows) {
      if (!r.isInternal) continue;
      if (clickup.hasBillable && billableOnly && !r.billable) continue;
      if (dataMonthKey && r.monthKey && r.monthKey !== dataMonthKey) continue;
      byFolder.set(r.folder, (byFolder.get(r.folder) || 0) + r.minutes);
    }
    const folders = [...byFolder.entries()].map(([folder, min]) => ({ folder, hours: min / 60 })).sort((a, b) => b.hours - a.hours);
    return { total: folders.reduce((a, f) => a + f.hours, 0), folders };
  }, [clickup, billableOnly, dataMonthKey]);

  // A client with more than one real ClickUp folder under the same Capacity Planning
  // group (e.g. Warrina Homes: the main Package folder plus a one-off Quoted sub-project
  // folder) previously showed as two unrelated-looking top-level cards, both titled the
  // same thing -- easy to mistake for a duplicate/broken entry. Pick one member per group
  // as the "primary" (the Package one, since that's the ongoing relationship; otherwise
  // whichever logged the most hours) so the other(s) can nest underneath it instead.
  const primaryNameByGroup = useMemo(() => computePrimaryNameByGroup(clients), [clients]);
  // primary's folder name -> its sibling sub-project(s), computed against the FULL client
  // list (not the type-filtered one below) -- a sub-project's own type would otherwise make
  // it invisible whenever the view is scoped to its parent's type, which is exactly the
  // "where did the other Warrina Homes card go" confusion this is meant to fix.
  const siblingsByPrimaryName = useMemo(() => {
    const byGroup = new Map();
    clients.forEach((c) => { if (!c.capGroup) return; if (!byGroup.has(c.capGroup)) byGroup.set(c.capGroup, []); byGroup.get(c.capGroup).push(c); });
    const result = new Map();
    byGroup.forEach((members, group) => {
      const primaryName = primaryNameByGroup.get(group);
      if (!primaryName) return;
      result.set(primaryName, members.filter((m) => m.name !== primaryName));
    });
    return result;
  }, [clients, primaryNameByGroup]);
  // A second, independent source of sub-projects: folders nameMatch.js's
  // MULTI_FOLDER_CLIENTS rules explicitly exclude from a cost-centre client's accrual
  // (billed separately -- BAMSS Childcare, Apex Comms Website, ...), tagged directly onto
  // the row during the merge in buildClientsForMonth (costCentreParentAccName). Deliberately
  // NOT routed through capGroup/siblingsByPrimaryName above -- that grouping comes from
  // Capacity Planning's own, unrelated data and two client names this different from each
  // other (e.g. "BAMSS Childcare Security Services" vs "Brisbane Alarm Monitoring Security
  // Services") have no reason to already be grouped there.
  const costCentreSubProjectsByParentName = useMemo(() => {
    const m = new Map();
    clients.forEach((c) => {
      if (!c.costCentreParentAccName) return;
      if (!m.has(c.costCentreParentAccName)) m.set(c.costCentreParentAccName, []);
      m.get(c.costCentreParentAccName).push(c);
    });
    return m;
  }, [clients]);
  // Every "extra row nested under this one" a primary might have, from either source
  // (capGroup-based siblings and nameMatch.js-tagged sub-projects) -- one lookup so the
  // six places below that need "what's nested under this client" don't each have to
  // remember to check both maps and merge/dedupe them by hand.
  const allSiblingsFor = (name) => {
    const a = siblingsByPrimaryName.get(name) || [];
    const b = costCentreSubProjectsByParentName.get(name) || [];
    if (!a.length) return b;
    if (!b.length) return a;
    const seen = new Set(a.map((s) => s.name));
    return [...a, ...b.filter((s) => !seen.has(s.name))];
  };

  function withConsultantFilter(c, consultant) {
    const tasksFiltered = consultant ? (c.tasksByUser.get(consultant) || new Map()) : c.tasksAll;
    const workedFiltered = consultant ? ((c.userMinutes.get(consultant) || 0) / 60) : c.worked;
    // narrow each task's contributor breakdown to the selected consultant too, when filtering
    const taskUsersFiltered = consultant
      ? new Map([...tasksFiltered.keys()].map((task) => [task, new Map([[consultant, tasksFiltered.get(task)]])]))
      : c.taskUsers;
    return { ...c, tasksFiltered, workedFiltered, taskUsersFiltered };
  }

  // filtered + sorted + consultant-scoped clients for display -- the non-primary
  // member of a multi-folder group is only ever shown nested under its primary
  // (see siblingsByPrimaryName above), never again as its own top-level card.
  const visible = useMemo(() => {
    let list = filterClientList(clients, { clientTypeFilter, consultantFilter, search, primaryNameByGroup });
    list = list.map((c) => withConsultantFilter(c, consultantFilter));
    // sort
    if (sortMode === "alpha") {
      list.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
    } else {
      // risk: package by |kpiPct| desc, others by worked desc
      list.sort((a, b) => {
        if (isPackageLikeType(clientTypeFilter)) return Math.abs(b.kpiPct ?? 0) - Math.abs(a.kpiPct ?? 0);
        return (b.workedFiltered ?? b.worked) - (a.workedFiltered ?? a.worked);
      });
    }
    return list;
  }, [clients, clientTypeFilter, consultantFilter, search, sortMode, primaryNameByGroup]);

  // Same filter pipeline as `visible` above, applied to prevClients — real,
  // fully-computed prior-month numbers (not an estimate) so the KPI cards can show a
  // genuine "vs last month" comparison on an apples-to-apples basis with what's on
  // screen right now (same type/consultant/search filters).
  const prevPrimaryNameByGroup = useMemo(() => computePrimaryNameByGroup(prevClients), [prevClients]);

  const prevMonthShortLabel = useMemo(() => {
    if (!prevMonthDataKey) return "";
    const [y, m] = prevMonthDataKey.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "short", year: "numeric" });
  }, [prevMonthDataKey]);

  // Flat lookup (visible clients + their nested sub-project siblings) so the drawer
  // can resolve whichever client name was clicked, regardless of nesting.
  const allDisplayable = useMemo(() => {
    const map = new Map();
    visible.forEach((c) => map.set(c.name, c));
    visible.forEach((c) => {
      const siblings = allSiblingsFor(c.name);
      if (siblings) siblings.forEach((s) => map.set(s.name, withConsultantFilter(s, consultantFilter)));
    });
    return map;
  }, [visible, siblingsByPrimaryName, costCentreSubProjectsByParentName, consultantFilter]);
  const drawerClient = drawerClientName ? allDisplayable.get(drawerClientName) : null;

  // The set of ClickUp folder names the KPI row/sparkline currently represent -- a
  // single client (plus its sub-project siblings) while its drawer is open, so the
  // header snapshot reads as "this client's numbers" instead of staying pinned to
  // the whole filtered list; otherwise every folder behind the currently filtered/
  // searched client list, so the snapshot tracks search/type/consultant filtering
  // the same way the row list below it already does.
  const kpiScopeFolders = useMemo(() => {
    if (drawerClient) {
      const names = new Set([drawerClient.name]);
      allSiblingsFor(drawerClient.name).forEach((s) => names.add(s.name));
      return names;
    }
    const names = new Set();
    visible.forEach((c) => {
      names.add(c.name);
      allSiblingsFor(c.name).forEach((s) => names.add(s.name));
    });
    return names;
  }, [drawerClient, visible, siblingsByPrimaryName, costCentreSubProjectsByParentName]);

  // KPI row scope: the selected client (+ siblings) while its drawer is open,
  // otherwise every currently filtered/searched client -- same idea as
  // kpiScopeFolders above, just as client objects rather than folder names.
  const statsScope = useMemo(() => {
    if (drawerClient) {
      const sibs = allSiblingsFor(drawerClient.name);
      return [drawerClient, ...sibs.map((s) => withConsultantFilter(s, consultantFilter))];
    }
    return visible;
  }, [drawerClient, visible, siblingsByPrimaryName, costCentreSubProjectsByParentName, consultantFilter]);

  const stats = useMemo(() => {
    const hrs = statsScope.reduce((a, c) => a + (c.workedFiltered ?? c.worked), 0);
    const over = statsScope.filter((c) => c.status === "over").length;
    const under = statsScope.filter((c) => c.status === "under").length;
    // "Carry-over / Accrued" KPI — total absolute prior-month balance across every
    // package client currently in view, whichever direction (credit carried in or
    // over-used), since both represent a balance still being carried forward.
    const carry = statsScope.reduce((a, c) => a + (c.priorBalance != null ? Math.abs(c.priorBalance) : 0), 0);
    return { hrs, count: statsScope.length, over, under, carry };
  }, [statsScope]);

  const prevStats = useMemo(() => {
    let list;
    if (drawerClient) {
      const sibNames = new Set(allSiblingsFor(drawerClient.name).map((s) => s.name));
      list = prevClients.filter((c) => c.name === drawerClient.name || sibNames.has(c.name));
    } else {
      list = filterClientList(prevClients, { clientTypeFilter, consultantFilter, search, primaryNameByGroup: prevPrimaryNameByGroup });
    }
    list = list.map((c) => withConsultantFilter(c, consultantFilter));
    const hrs = list.reduce((a, c) => a + (c.workedFiltered ?? c.worked), 0);
    const over = list.filter((c) => c.status === "over").length;
    const carry = list.reduce((a, c) => a + (c.priorBalance != null ? Math.abs(c.priorBalance) : 0), 0);
    // Only meaningful once the export actually has rows for that month — otherwise
    // "0 vs last month" would misleadingly read as a 100% drop rather than "no data".
    const available = !!(clickup && prevMonthDataKey && clickup.rows.some((r) => r.monthKey === prevMonthDataKey));
    return { hrs, count: list.length, over, carry, available };
  }, [drawerClient, prevClients, clientTypeFilter, consultantFilter, search, prevPrimaryNameByGroup, siblingsByPrimaryName, costCentreSubProjectsByParentName, clickup, prevMonthDataKey]);

  // Trailing up-to-6-month hours trend for the "Total billable hours" sparkline —
  // scoped to kpiScopeFolders above, so it tracks the same client(s) the KPI cards
  // currently represent (search/type/consultant filters, or a single selected client).
  const hoursTrend = useMemo(() => {
    if (!clickup) return [];
    const byMonth = new Map();
    for (const r of clickup.rows) {
      if (clickup.hasBillable && billableOnly && !r.billable) continue;
      if (r.isInternal) continue;
      if (consultantFilter && r.user !== consultantFilter) continue;
      if (!kpiScopeFolders.has(r.folder)) continue;
      if (!r.monthKey) continue;
      byMonth.set(r.monthKey, (byMonth.get(r.monthKey) || 0) + r.minutes);
    }
    const keys = [...byMonth.keys()].sort();
    const upto = dataMonthKey ? keys.filter((k) => k <= dataMonthKey) : keys;
    return upto.slice(-6).map((k) => byMonth.get(k) / 60);
  }, [clickup, billableOnly, consultantFilter, dataMonthKey, kpiScopeFolders]);
  const usedAccruedNames = useMemo(() => new Set(clients.filter((x) => x.matched).map((x) => x.accruedClient.name)), [clients]);

  // Only meaningful when the reporting period IS the current real-world month — a mid-month
  // check on a still-open month, e.g. "accrued sheet stops at June, it's July 17th, how's the
  // team tracking against package so far this month". A closed historical month has no "pace".
  const monthProgress = useMemo(() => {
    if (!dataMonthKey) return null;
    const [y, m] = dataMonthKey.split("-").map(Number); // m is 1-12
    const now = new Date();
    if (now.getFullYear() !== y || now.getMonth() + 1 !== m) return null;
    const totalDays = new Date(y, m, 0).getDate();
    const dayOfMonth = now.getDate();
    return { dayOfMonth, totalDays, pct: (dayOfMonth / totalDays) * 100 };
  }, [dataMonthKey]);

  // ------------------------------- exports ----------------------------------
  const priorMonthPretty = useMemo(() => {
    if (!priorMonthKey || !accrued) return "";
    const bc = accrued.balanceCols.find((c) => monthKey(c.year, c.month) === priorMonthKey);
    if (bc) return bc.label;
    // Not in the sheet yet — still show a readable month name rather than blank
    // (the value itself is the ClickUp-estimated fallback, flagged separately).
    const [py, pm] = priorMonthKey.split("-").map(Number);
    return monthLabel(py, pm - 1);
  }, [priorMonthKey, accrued]);
  const fileMonthTag = (invoiceMonth || new Date().toLocaleString(undefined, { month: "short", year: "numeric" }))
    .replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  const download = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 200);
  };
  const buildSummaryRows = () =>
    clients.map((c) => ({
      "Client (ClickUp)": c.name,
      "Client type": TYPE_LABELS_SHORT[c.type],
      "Matched to (Accrued)": c.accruedClient?.name ?? "",
      "Match confidence": c.matchInfo ? `${Math.round(c.matchInfo.confidence * 100)}% (${c.matchInfo.method})` : "unmatched",
      "Package (h/month)": c.pkg ?? "",
      "Prior balance (signed)": c.priorBalance ?? "",
      "Carried in (h)": c.priorBalance != null && c.priorBalance < 0 ? Math.abs(c.priorBalance) : "",
      "Over used prior (h)": c.priorBalance != null && c.priorBalance > 0 ? c.priorBalance : "",
      "Worked this month (h)": Math.round(c.worked * 100) / 100,
      "Remaining (h)": c.remaining != null ? Math.round(c.remaining * 100) / 100 : "",
      "New balance (signed)": c.newBalance != null ? Math.round(c.newBalance * 100) / 100 : "",
      "KPI variance (%)": c.kpiPct != null ? Math.round(c.kpiPct * 10) / 10 : "",
      "Status": { over: "OVER (+10%)", under: "UNDER (−10%)", ok: "on track", "no-pkg": "no package" }[c.status],
      // Quoted has no monthly package/remaining figure (the columns above stay blank for
      // it) -- its own fixed-budget-vs-lifetime-worked figures get their own columns
      // instead of being squeezed into fields that mean something different for it.
      "Quoted amount (h)": c.type === "quoted" ? (c.quotedAmount ?? "") : "",
      "Total worked all time (h)": c.type === "quoted" ? Math.round((c.lifetimeWorked ?? 0) * 100) / 100 : "",
      "Quoted remaining (h)": c.type === "quoted" && c.quotedRemaining != null ? Math.round(c.quotedRemaining * 100) / 100 : "",
      "Consultants": [...c.userMinutes.entries()].map(([u, m]) => `${u || "—"} (${fmt(m / 60)}h)`).join("; "),
    }));
  const buildPendingRows = () =>
    clients
      .filter((c) => isPackageLikeType(c.type) && (c.status === "over" || c.status === "under"))
      .sort((a, b) => Math.abs(b.newBalance) - Math.abs(a.newBalance))
      .map((c) => ({
        "Client": c.accruedClient?.name ?? c.name,
        "Package (h/month)": c.pkg,
        "Prior month balance": Math.round((c.priorBalance ?? 0) * 100) / 100,
        "Worked this month (h)": Math.round(c.worked * 100) / 100,
        "New balance (h)": Math.round(c.newBalance * 100) / 100,
        "Direction": c.newBalance > 0 ? "OVER-SERVED (owe next month)" : "UNDER-SERVED (client credit)",
        "Available next month (h)": Math.round((c.pkg - c.newBalance) * 100) / 100,
        "KPI variance (%)": Math.round(c.kpiPct * 10) / 10,
      }));
  // Ready-to-merge accrued-hours export for the real last calendar month (not
  // whatever reporting period happens to be selected) — e.g. if it's August
  // right now, this always exports July's closing balances. Uses the same
  // buildClientsForMonth pipeline as everything else, so a client whose July
  // balance the sheet doesn't have yet gets the same ClickUp-estimated
  // fallback the rest of the app uses, clearly labelled as such.
  const buildLastMonthAccruedRows = () => {
    const now = new Date();
    const thisRealMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const lastMonthKey = prevMonthKeyStr(thisRealMonthKey);
    const priorToLast = prevMonthKeyStr(lastMonthKey);
    const [ly, lm] = lastMonthKey.split("-").map(Number);
    const colLabel = monthLabel(ly, lm - 1);
    const list = buildClientsForMonth(lastMonthKey, priorToLast).filter((c) => c.pkg != null && c.pkg > 0);
    return {
      rows: list.map((c) => ({
        "Client": c.displayName,
        "Agreed h.p.m": c.pkg,
        [colLabel]: c.newBalance != null ? Math.round(c.newBalance * 100) / 100 : "",
        "Estimated (no sheet data for this month yet)": c.priorBalanceEstimated ? "Yes" : "",
      })),
      lastMonthKey, colLabel,
    };
  };
  const exportLastMonthAccrued = () => {
    setExportOpen(false);
    const { rows, lastMonthKey, colLabel } = buildLastMonthAccruedRows();
    exportXlsx(rows, `PG-accrued-${lastMonthKey}.xlsx`, colLabel);
  };

  const exportCsv = (rows, filename) => {
    if (rows.length === 0) { download(new Blob(["No records"], { type: "text/csv" }), filename); return; }
    download(new Blob([Papa.unparse(rows)], { type: "text/csv;charset=utf-8" }), filename);
  };
  const exportXlsx = (rows, filename, sheetName) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  };
  const doExport = (kind, format) => {
    setExportOpen(false);
    const rows = kind === "pending" ? buildPendingRows() : buildSummaryRows();
    const stem = kind === "pending" ? `PG-pending-hours-${fileMonthTag}` : `PG-monthly-summary-${fileMonthTag}`;
    if (format === "csv") exportCsv(rows, `${stem}.csv`);
    else exportXlsx(rows, `${stem}.xlsx`, kind === "pending" ? "Pending" : "Summary");
  };

  // -------------------- per-client copy summary & PDF -----------------------
  const summaryText = (c) => {
    const lines = [];
    const monthText = invoiceMonth || "this month";
    lines.push(`${c.displayName}: hours for ${monthText}`);
    if (c.accruedClient && c.accruedClient.name !== c.name) lines.push(`(ClickUp folder: ${c.name})`);
    lines.push(`Client type: ${TYPE_LABELS_SHORT[c.type]}`);
    if (consultantFilter) lines.push(`Filtered to consultant: ${consultantFilter}`);
    lines.push("");
    lines.push("Tasks:");
    for (const [task, min] of [...c.tasksFiltered.entries()].sort((a, b) => b[1] - a[1]))
      lines.push(`  ${fmt(min / 60)} h  ${task}`);
    lines.push("");
    if (c.userMinutes.size > 0) {
      lines.push("Consultants involved:");
      for (const [u, min] of [...c.userMinutes.entries()].sort((a, b) => b[1] - a[1]))
        lines.push(`  ${fmt(min / 60)} h  ${u || "—"}`);
      lines.push("");
    }
    lines.push(`Time tracked this month: ${fmt(c.workedFiltered)} h`);
    if (isPackageLikeType(c.type) && c.pkg != null) {
      lines.push(`Package: ${fmt(c.pkg)} h`);
      const p = c.priorBalance ?? 0;
      if (p < 0) lines.push(`Carried in from ${priorMonthPretty}: ${fmt(Math.abs(p))} h`);
      else if (p > 0) lines.push(`Over-used in ${priorMonthPretty}: ${fmt(p)} h`);
      else lines.push(`Prior balance: 0 h`);
      lines.push(`Total accrued time: ${fmt(c.worked + p)} h`);
      lines.push(c.remaining >= 0 ? `Remaining this month: ${fmt(c.remaining)} h` : `Over by ${fmt(Math.abs(c.remaining))} h`);
      if (c.status === "over") lines.push(`⚠ Over the +10% KPI (${fmt(c.kpiPct, 1)}% of package)`);
      if (c.status === "under") lines.push(`⚠ Under the −10% KPI (${fmt(c.kpiPct, 1)}% of package), accruing`);
    } else if (c.type === "quoted" && c.quotedAmount != null) {
      lines.push(`Quoted amount: ${fmt(c.quotedAmount)} h`);
      lines.push(`Total time tracked (all time): ${fmt(c.lifetimeWorked ?? 0)} h`);
      lines.push(c.quotedRemaining >= 0 ? `Remaining of quoted amount: ${fmt(c.quotedRemaining)} h` : `Over the quoted amount by: ${fmt(Math.abs(c.quotedRemaining))} h`);
    }
    return lines.join("\n");
  };
  const copySummary = async (c) => {
    try { await navigator.clipboard.writeText(summaryText(c)); setCopied(c.name); setTimeout(() => setCopied(null), 1500); }
    catch (e) {}
  };
  const downloadPdf = (c) => {
    const monthText = invoiceMonth || new Date().toLocaleString(undefined, { month: "long", year: "numeric" });
    printClientPdf(c, monthText, priorMonthPretty);
  };
  const downloadLineItemPdf = (c, lineItem) => {
    const monthText = invoiceMonth || new Date().toLocaleString(undefined, { month: "long", year: "numeric" });
    printLineItemPdf(c, lineItem, monthText, consultantFilter);
  };

  // ------------------------------- render -----------------------------------
  const ready = clickup && accrued;

  return (
    <div className={"pg-app pg-app--invoicing" + (drawerClient ? " pg-app--drawer-open" : "")}>
      <div className={"pg-container" + (drawerClient ? " pg-container--dimmed" : "")}>
        {/* header + command row combined — title on the left, search centered in
            the remaining space, actions pinned right, all on the same top line. */}
        <div className="pg-app-header">
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <div className="pg-app-header__icon"><FileText size={18} /></div>
            <div>
              <span className="pg-eyebrow">Purple Giraffe · Internal</span>
              <h1 className="pg-app-header__title">Client Invoicing</h1>
              <p className="pg-app-header__sub">
                Reconcile monthly hours, review client servicing and generate invoice-ready summaries.
              </p>
            </div>
          </div>

          <div className="pg-cmdrow">
            <CommandSearch clients={clients} onSelect={(name) => setDrawerClientName(name)} />
          </div>

          <div className="pg-cmdrow__actions" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="pg-btn-ghost" onClick={handleManualSync} disabled={syncing} title={syncing ? "Syncing…" : "Sync now"}>
              <RefreshCw size={12} style={syncing ? { animation: "pg-spin 1s linear infinite" } : undefined} /> <span className="pg-btn-label">{syncing ? "Syncing…" : "Sync now"}</span>
            </button>
            {ready && (
              <div style={{ position: "relative" }}>
                <button onClick={() => setExportOpen((x) => !x)} className="pg-btn-ghost" title="Export">
                  <Download size={12} /> <span className="pg-btn-label">Export</span> <ChevronDown size={12} />
                </button>
                {exportOpen && (
                  <div className="pg-menu">
                    <ExportItem icon={<Printer size={14} />} label="Generate PDF" onClick={() => { setExportOpen(false); drawerClient && downloadPdf(drawerClient); }} disabled={!drawerClient} title={drawerClient ? undefined : "Select a client first"} />
                    <div className="pg-menu-sep" />
                    <ExportItem icon={<FileText size={14} />} label="Pending hours (CSV)" onClick={() => doExport("pending", "csv")} />
                    <ExportItem icon={<FileSpreadsheet size={14} />} label="Pending hours (Excel)" onClick={() => doExport("pending", "xlsx")} />
                    <div className="pg-menu-sep" />
                    <ExportItem icon={<FileText size={14} />} label="Full monthly summary (CSV)" onClick={() => doExport("summary", "csv")} />
                    <ExportItem icon={<FileSpreadsheet size={14} />} label="Full monthly summary (Excel)" onClick={() => doExport("summary", "xlsx")} />
                    <div className="pg-menu-sep" />
                    <ExportItem
                      icon={<FileSpreadsheet size={14} />} label="Accrued hours — last month (Excel)"
                      onClick={exportLastMonthAccrued}
                      title="Closing balances for last calendar month, ready to merge into the master accrued sheet"
                    />
                  </div>
                )}
              </div>
            )}
            <SyncStatusIcon clickupSource={clickupSource} clickup={clickup} syncMeta={syncMeta} />
            <WarningIcon title="ClickUp export" warnings={clickup?.warnings} />
            <WarningIcon title="Accrued sheet" warnings={accrued?.warnings} />
            {clickupSource !== "manual" && syncMeta?.last_synced_at && syncMeta?.last_sync_status !== "error" && (
              <span className="pg-status-pill" style={{ color: "var(--status-ok)", background: "var(--status-ok-soft)" }}>Synced</span>
            )}
            <ImportButton
              clickup={clickup} accrued={accrued} clickupErr={clickupErr} accruedErr={accruedErr}
              onPickClickup={() => clickupInput.current?.click()}
              onPickAccrued={() => accruedInput.current?.click()}
            />
            <input ref={clickupInput} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => handleClickup(e.target.files?.[0])} />
            <input ref={accruedInput} type="file" accept=".xlsx,.xlsm,.csv" style={{ display: "none" }} onChange={(e) => handleAccrued(e.target.files?.[0])} />
          </div>
        </div>

        {/* KPI summary — the page's headline numbers, before any raw data. Deltas are
            real prior-month figures (see prevStats above), not estimates — they're
            simply hidden when the export doesn't cover the prior month at all. */}
        {ready && (
          <div className="pg-kpi-row">
            {(() => {
              // Computed once and passed to both the delta chip and the sparkline,
              // so they always agree on which direction this month's change is
              // (the sparkline colors itself from this exact same object).
              const hoursDelta = prevStats.available && prevStats.hrs > 0
                ? { pct: ((stats.hrs - prevStats.hrs) / prevStats.hrs) * 100, label: prevMonthShortLabel }
                : null;
              return (
                <KpiCard
                  label="Total billable hours" value={`${fmt(stats.hrs)} h`}
                  delta={hoursDelta}
                  spark={hoursTrend.length > 1 ? <Sparkline values={hoursTrend} delta={hoursDelta} /> : null}
                />
              );
            })()}
            <KpiCard
              label="Clients in view" value={stats.count} icon={<Users size={15} />}
              delta={prevStats.available ? { count: stats.count - prevStats.count, label: prevMonthShortLabel } : null}
            />
            <KpiCard
              label="Over-serviced clients" value={stats.over} tone={stats.over > 0 ? "var(--status-over)" : undefined} icon={<AlertTriangle size={15} />}
              delta={prevStats.available ? { count: stats.over - prevStats.over, label: prevMonthShortLabel, invert: true } : null}
            />
            <KpiCard
              label="Carry-over / Accrued" value={`${fmt(stats.carry)} h`} icon={<Clock size={15} />}
              sub={prevStats.available ? undefined : "from prior months"}
              delta={prevStats.available ? { hours: stats.carry - prevStats.carry, label: prevMonthShortLabel } : null}
            />
          </div>
        )}


        {/* config + filter row, combined into one panel (previously two stacked
            panels) so there's one less thing to scroll past before reaching the
            client list — a divider keeps the two groups visually distinct. */}
        {ready && (
          <div className="pg-panel" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
          <div className="pg-pillbar">
            {availableMonths.length > 1 && (() => {
              const idx = availableMonths.findIndex((m) => m.key === dataMonthKey);
              const label = idx >= 0 ? availableMonths[idx].label : dataMonthKey;
              return (
                <div className="pg-pill pg-pill--stepper" title="Reporting period">
                  <button
                    type="button" className="pg-pill__step" aria-label="Previous month"
                    disabled={idx <= 0}
                    onClick={() => idx > 0 && setDataMonthKey(availableMonths[idx - 1].key)}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="pg-pill__step-label"><Calendar size={13} className="pg-pill__icon" /> {label}</span>
                  <button
                    type="button" className="pg-pill__step" aria-label="Next month"
                    disabled={idx < 0 || idx >= availableMonths.length - 1}
                    onClick={() => idx >= 0 && idx < availableMonths.length - 1 && setDataMonthKey(availableMonths[idx + 1].key)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              );
            })()}
            <label className="pg-pill pg-pill--select" title="Client type" onClick={openPillPicker}>
              <select value={clientTypeFilter} onChange={(e) => setClientTypeFilter(e.target.value)}>
                <option value="all">All Clients ({typeCounts.all})</option>
                <option value="package">Clients on a Package ({typeCounts.package})</option>
                <option value="strategy">Strategy Clients ({typeCounts.strategy})</option>
                <option value="hourly">Clients on Hourly rate ({typeCounts.hourly})</option>
                <option value="ad_hoc">Ad hoc Clients ({typeCounts.ad_hoc})</option>
                <option value="quoted">Quoted Clients ({typeCounts.quoted})</option>
                <option value="project" disabled>Project Clients ({typeCounts.project}), coming later</option>
                <option value="map">MAP Clients ({typeCounts.map})</option>
                <option value="queensland">Queensland Clients (prv) ({typeCounts.queensland})</option>
              </select>
              <ChevronDown size={13} className="pg-pill__chevron" />
            </label>
            <label className="pg-pill pg-pill--select" title="Consultant" onClick={openPillPicker}>
              <select value={consultantFilter} onChange={(e) => setConsultantFilter(e.target.value)}
                disabled={!clickup?.hasUser}>
                <option value="">All Consultants</option>
                {consultants.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <ChevronDown size={13} className="pg-pill__chevron" />
            </label>
            <label className="pg-pill pg-pill--select" title="Sort" onClick={openPillPicker}>
              <select value={sortMode} onChange={(e) => setSortMode(e.target.value)}>
                <option value="risk">Sort: Risk</option>
                <option value="alpha">Sort: Alphabetical</option>
              </select>
              <ChevronDown size={13} className="pg-pill__chevron" />
            </label>
            {clickup.hasBillable && (
              <label className="pg-pill pg-pill--checkbox">
                <input type="checkbox" checked={billableOnly} onChange={(e) => setBillableOnly(e.target.checked)} />
                Billable only
              </label>
            )}
            <label className="pg-pill pg-pill--search">
              <Search size={13} className="pg-pill__icon" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter clients…" title="Filters the currently visible, already-filtered client list below. To jump straight to any client regardless of filters, use the search bar in the header (⌘K)." />
            </label>
            <button type="button"
              className={`pg-pill pg-pill--iconbtn${advancedFiltersOpen ? " is-active" : ""}`}
              onClick={() => setAdvancedFiltersOpen((v) => !v)}
              title="More filters: invoice month, prior balance">
              <SlidersHorizontal size={15} />
            </button>
          </div>

          {advancedFiltersOpen && (
            <>
              <div style={{ borderTop: "1px solid var(--border-subtle)" }} />
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 14 }}>
                <label className="pg-field">
                  <span className="pg-field__label">Invoice month</span>
                  <input value={invoiceMonth} onChange={(e) => setInvoiceMonth(e.target.value)} placeholder="e.g. July 2026"
                    className="pg-input" style={{ width: 160 }} />
                </label>
                <label className="pg-field">
                  <span className="pg-field__label">Prior balance from</span>
                  <select value={priorMonthKey} onChange={(e) => setPriorMonthKey(e.target.value)}
                    className="pg-select" style={{ minWidth: 180 }}>
                    {accrued.balanceCols.map((bc) => (
                      <option key={monthKey(bc.year, bc.month)} value={monthKey(bc.year, bc.month)}>{bc.label}</option>
                    ))}
                    {/* The desired prior month isn't in the sheet yet — shown as its own
                        clearly-labelled option so the select never silently shows a stale
                        column instead. Selecting it just keeps the estimated fallback. */}
                    {priorMonthKey && !accrued.balanceCols.some((bc) => monthKey(bc.year, bc.month) === priorMonthKey) && (
                      <option value={priorMonthKey}>{priorMonthPretty} (estimated — not in sheet yet)</option>
                    )}
                  </select>
                </label>
              </div>
            </>
          )}
          </div>
        )}

        {/* mid-month pace banner — only shown when the reporting period is the current, still-open month */}
        {ready && monthProgress && (
          <div className="pg-banner-warn" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            Mid-month check: day {monthProgress.dayOfMonth} of {monthProgress.totalDays} ({fmt(monthProgress.pct, 0)}% of the month elapsed). Package figures below are hours worked so far this month, not a final total.
          </div>
        )}

        {/* excluded internal / non-client folders — transparency, not a warning */}
        {ready && excludedInternal.folders.length > 0 && (
          <div className="pg-panel" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span className="pg-tag pg-tag--muted pg-tag--pill">excluded as internal / non-client</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-tertiary)" }}>
                {fmt(excludedInternal.total)} h across {excludedInternal.folders.length} folder{excludedInternal.folders.length === 1 ? "" : "s"}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
              {excludedInternal.folders.map((f) => (
                <span key={f.folder} style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-secondary)" }}>
                  {f.folder} <span style={{ color: "var(--fg-tertiary)" }}>({fmt(f.hours)} h)</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* client list — numbered rows, click one to open its full detail in the drawer */}
        {ready && (
          <div className="pg-rowlist">
            <div className="pg-rowlist__head pg-row-grid-cols" aria-hidden="true">
              <span />
              <span />
              <span>Client</span>
              <span>Type</span>
              <span>Carry</span>
              <span>Package</span>
              <span>Worked</span>
              <span>Remaining</span>
              <span>Status</span>
              <span />
            </div>
            {visible.map((c, i) => {
              const siblings = allSiblingsFor(c.name);
              // A client with sub-projects (siblings, e.g. a quoted one-off billed
              // separately) and/or a cost-centre breakdown renders inside one shared
              // .pg-tile card instead of each row getting its own floating card --
              // ClientRow's `tileRow`/`hasMoreBelow` props drop each row's own
              // border/shadow/radius in favor of the tile's, with divider lines
              // between rows instead of gaps between separate cards.
              if (!c.costCentre && siblings.length === 0) {
                return <ClientRow key={c.name} index={i + 1} client={c} active={drawerClientName === c.name} onOpen={() => setDrawerClientName(c.name)} onCopy={copySummary} onPdf={downloadPdf} />;
              }
              return (
                <div className="pg-tile" key={c.name}>
                  <ClientRow index={i + 1} client={c} tileRow hasMoreBelow={siblings.length > 0} active={drawerClientName === c.name} onOpen={() => setDrawerClientName(c.name)} onCopy={copySummary} onPdf={downloadPdf} />
                  {siblings.map((s, idx) => {
                    const sc = withConsultantFilter(s, consultantFilter);
                    return (
                      <ClientRow
                        key={sc.name} client={sc} nested tileRow hasMoreBelow={idx < siblings.length - 1}
                        subIndex={`${i + 1}s${idx === 0 ? "" : idx + 1}`}
                        avatarOf={{ name: c.displayName, logo: c.logoUrl }}
                        parentName={c.displayName} active={drawerClientName === sc.name}
                        onOpen={() => setDrawerClientName(sc.name)} onCopy={copySummary} onPdf={downloadPdf}
                      />
                    );
                  })}
                </div>
              );
            })}
            {visible.length === 0 && (
              <div className="pg-empty">
                {clientTypeFilter === "project"
                  ? `${TYPE_LABELS[clientTypeFilter]} aren't tracked here yet, this bucket is a placeholder.`
                  : consultantFilter
                    ? `${consultantFilter} didn't work on any ${TYPE_LABELS[clientTypeFilter].toLowerCase()} this month.`
                    : `No ${TYPE_LABELS[clientTypeFilter].toLowerCase()} in this view.`}
              </div>
            )}
          </div>
        )}

        {ready && (
          <p className="pg-footnote">
            <b>Maths:</b> new balance = worked − package + prior · remaining = package − prior − worked · total accrued = worked + prior (signed).{" "}
            <b>Signs:</b> negative prior = client credit carried in; positive prior = over-used prior month.{" "}
            <b>Types:</b> matched to accrued sheet → Package; unmatched with (Qld) in name → Queensland; unmatched otherwise → Hourly rate.{" "}
            <b>Name matches</b> you set here are saved between sessions.
          </p>
        )}
      </div>

      {drawerClient && (
        <ClientDrawer
          client={drawerClient}
          invoiceMonth={invoiceMonth}
          priorMonthPretty={priorMonthPretty}
          monthProgress={monthProgress}
          hasUser={clickup.hasUser}
          consultantFilter={consultantFilter}
          accruedNames={accruedNames}
          usedAccruedNames={usedAccruedNames}
          syncMeta={syncMeta}
          capPeople={capPeople}
          onClose={() => setDrawerClientName(null)}
          onSetMatch={(v) => setManualMatch(drawerClient.name, v)}
          onCopy={() => copySummary(drawerClient)}
          onPdf={() => downloadPdf(drawerClient)}
          onPdfLineItem={(lineItem) => downloadLineItemPdf(drawerClient, lineItem)}
          onViewProfile={onNavigateClients}
          copied={copied === drawerClient.name}
        />
      )}
    </div>
  );
}

// ================================ subcomponents =============================
// delta shapes: { pct, label } | { count, label, invert? } | { hours, label }
// invert=true means a smaller number is the improvement (e.g. over-serviced clients).
// Shared by DeltaChip and Sparkline so a card's trend line and its delta
// arrow always agree on which direction counts as "good" — `invert` flips
// which direction is favorable (e.g. over-serviced clients: fewer is better).
function deltaRaw(delta) {
  if (!delta) return undefined;
  if (delta.pct !== undefined) return delta.pct;
  if (delta.count !== undefined) return delta.count;
  return delta.hours;
}
function deltaTone(delta) {
  const raw = deltaRaw(delta);
  if (raw === undefined) return null;
  if (raw === 0) return "var(--fg-tertiary)";
  const improving = delta.invert ? raw <= 0 : raw >= 0;
  return improving ? "var(--status-ok)" : "var(--status-over)";
}

function DeltaChip({ delta }) {
  if (!delta) return null;
  let raw, text;
  if (delta.pct !== undefined) { raw = delta.pct; text = `${raw >= 0 ? "↑" : "↓"}${fmt(Math.abs(raw), 0)}% vs ${delta.label}`; }
  else if (delta.count !== undefined) { raw = delta.count; text = raw === 0 ? `No change vs ${delta.label}` : `${raw > 0 ? "↑" : "↓"}${Math.abs(raw)} vs ${delta.label}`; }
  else { raw = delta.hours; text = raw === 0 ? `No change vs ${delta.label}` : `${raw > 0 ? "↑" : "↓"}${fmt(Math.abs(raw))} h vs ${delta.label}`; }
  return <div className="pg-kpi-card__delta" style={{ color: deltaTone(delta) }}>{text}</div>;
}

// Smoothed trend line (Catmull-Rom points converted to cubic Bézier segments)
// with a gradient area fill underneath — replaces the old straight-segment
// polyline, which read as jagged/rough at this size. Kept as a small inline
// SVG component in the app's own convention (see LineChart.jsx/Sparkline.jsx)
// rather than a separate reusable component + CSS file: this card's the only
// caller today, and its color/sizing already need to follow this card's own
// design tokens (var(--accent), the KPI card's icon-slot proportions), not a
// generic hardcoded palette.
function Sparkline({ values, delta, color }) {
  // useId() must run unconditionally on every render (Rules of Hooks) --
  // called before the early return below, even though its result only
  // matters once we know there's actually something to render.
  const gradientId = `pg-spark-grad-${useId().replace(/:/g, "")}`;
  // Same red/green logic as this card's own delta arrow (deltaTone), so the
  // trend line and the chip below it never disagree about which way is good.
  // Falls back to the neutral accent purple when there's no prior-period
  // comparison to judge direction from yet (e.g. first month of data).
  const resolvedColor = color || deltaTone(delta) || "var(--accent)";
  const w = 72, h = 28, pad = 3;
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = values.map((v, i) => ({
    x: pad + (i / (values.length - 1)) * (w - pad * 2),
    y: pad + (1 - (v - min) / range) * (h - pad * 2),
  }));

  const linePath = points.reduce((path, p, i) => {
    if (i === 0) return `M ${p.x} ${p.y}`;
    const prev = points[i - 1];
    const prevPrev = points[i - 2] ?? prev;
    const next = points[i + 1] ?? p;
    const c1x = prev.x + (p.x - prevPrev.x) / 6;
    const c1y = prev.y + (p.y - prevPrev.y) / 6;
    const c2x = p.x - (next.x - prev.x) / 6;
    const c2y = p.y - (next.y - prev.y) / 6;
    return `${path} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p.x} ${p.y}`;
  }, "");
  const baseline = h - pad;
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${baseline} L ${points[0].x} ${baseline} Z`;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="pg-kpi-card__spark" role="img" aria-label="Trend over recent months">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={resolvedColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={resolvedColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={resolvedColor} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function KpiCard({ label, value, sub, tone, icon, delta, spark }) {
  return (
    <div className="pg-kpi-card">
      <div className="pg-kpi-card__top">
        <span className="pg-kpi-card__label">{label}</span>
        {spark || (icon && <span className="pg-kpi-card__icon" style={tone ? { color: tone, background: "transparent" } : undefined}>{icon}</span>)}
      </div>
      <div className="pg-kpi-card__value" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="pg-kpi-card__sub">{sub}</div>}
      <DeltaChip delta={delta} />
    </div>
  );
}
// Compact icon trigger — replaces the old full-width banner. The full warning
// text still lives behind a click, just in a small balloon instead of taking
// over a whole row.
// Compact replacement for the old always-visible "live-sync status" bar — same
// 4 states (manual override / sync error / synced / never synced), but as a
// single icon+balloon next to Import, matching how ClickUp/Accrued warnings
// already work, instead of a full-width row that was mostly empty space when
// everything was fine.
function SyncStatusIcon({ clickupSource, clickup, syncMeta }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));

  let status, Icon, color, message;
  if (clickupSource === "manual") {
    status = "manual"; Icon = WifiOff; color = "var(--status-warn)";
    message = clickup?.uploadedAt
      ? `Showing a manually uploaded file (${clickup.fileName || "no name"}), uploaded ${timeAgo(new Date(clickup.uploadedAt).toISOString())} — not the live sync. Overrides live sync until the next reload.`
      : "Showing a manually uploaded file from a previous session — not the live sync. Overrides live sync until the next reload.";
  } else if (syncMeta?.last_sync_status === "error") {
    status = "error"; Icon = WifiOff; color = "var(--status-warn)";
    message = `Live sync not set up yet (${syncMeta.last_sync_message}). Upload a CSV in the meantime.`;
  } else if (syncMeta?.last_synced_at) {
    status = "ok"; Icon = Wifi; color = "var(--status-ok)";
    message = `Live sync from ClickUp · last synced ${timeAgo(syncMeta.last_synced_at)} · ${syncMeta.rows_synced ?? "—"} entries.`;
  } else {
    status = "never"; Icon = WifiOff; color = "var(--fg-tertiary)";
    message = "Live sync hasn't run yet.";
  }
  const needsAttention = status !== "ok";

  return (
    <div className="pg-warn-icon-wrap" ref={ref}>
      <button
        className="pg-warn-icon" onClick={() => setOpen((o) => !o)}
        style={{ color }}
        title={message}
        aria-label={`ClickUp sync status: ${status}`}
      >
        <Icon size={14} />
        {needsAttention && <span className="pg-warn-icon__count">!</span>}
      </button>
      {open && (
        <div className="pg-warn-balloon">
          <div className="pg-warn-balloon__title">ClickUp sync</div>
          <div className="pg-warn-balloon__item">{message}</div>
        </div>
      )}
    </div>
  );
}

function WarningIcon({ title, warnings }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="pg-warn-icon-wrap" ref={ref}>
      <button
        className="pg-warn-icon" onClick={() => setOpen((o) => !o)}
        title={`${title}: ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}
        aria-label={`Show ${title} warnings`}
      >
        <AlertTriangle size={14} />
        {warnings.length > 1 && <span className="pg-warn-icon__count">{warnings.length}</span>}
      </button>
      {open && (
        <div className="pg-warn-balloon">
          <div className="pg-warn-balloon__title">{title}</div>
          {warnings.map((w, i) => <div key={i} className="pg-warn-balloon__item">{w}</div>)}
        </div>
      )}
    </div>
  );
}
// Global client search — real, not decorative: filters the full client list (not
// just the currently-visible/type-filtered rows) and opens the drawer on selection.
// Cmd/Ctrl+K focuses it from anywhere on the page, matching the mockup's convention.
function CommandSearch({ clients, onSelect }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const wrapRef = useDismissable(() => setOpen(false));

  const q = query.trim().toLowerCase();
  const matches = q
    ? clients.filter((c) => c.displayName.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 8)
    : [];

  return (
    <div className="pg-cmdsearch" ref={wrapRef}>
      <Search size={14} className="pg-cmdsearch__icon" />
      <input
        ref={inputRef}
        className="pg-cmdsearch__input"
        placeholder="Jump to a client…"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      <span className="pg-cmdsearch__kbd">⌘K</span>
      {open && q && (
        <div className="pg-menu" style={{ left: 0, right: "auto", top: "calc(100% + 6px)", minWidth: "100%" }}>
          {matches.length === 0 && <div className="pg-menu-item" style={{ cursor: "default", color: "var(--fg-tertiary)" }}>No clients match "{query}"</div>}
          {matches.map((c) => (
            <ExportItem
              key={c.name}
              icon={<Users size={14} />}
              label={c.displayName}
              onClick={() => { onSelect(c.name); setQuery(""); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Overall connection status across both required files — three-state, since
// "one of two connected" is a meaningfully different state from either extreme.
function importTone(clickup, accrued) {
  if (clickup && accrued) return "var(--status-ok)";
  if (clickup || accrued) return "var(--status-warn)";
  return "var(--status-over)";
}
function StatusDot({ tone, size = 8 }) {
  return <span style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: tone, flex: "none" }} />;
}

// Replaces the old always-visible upload cards — same two file inputs, now
// triggered from a dropdown so the page opens straight into real content
// instead of leading with upload prompts once files are already connected.
function ImportButton({ clickup, accrued, clickupErr, accruedErr, onPickClickup, onPickAccrued }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button className="pg-btn-ghost" onClick={() => setOpen((o) => !o)} title="Import">
        <StatusDot tone={importTone(clickup, accrued)} /> <span className="pg-btn-label">Import</span> <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pg-menu" style={{ minWidth: 280 }}>
          <button className="pg-menu-item" onClick={() => { onPickClickup(); setOpen(false); }} style={{ justifyContent: "space-between" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Upload size={14} />
              <span>
                ClickUp time export
                {clickup?.fileName && <div style={{ fontSize: 11, color: "var(--fg-tertiary)", fontWeight: 400 }}>{clickup.fileName}</div>}
                {clickupErr && <div style={{ fontSize: 11, color: "var(--status-over)", fontWeight: 400 }}>{clickupErr}</div>}
              </span>
            </span>
            <StatusDot tone={clickup ? "var(--status-ok)" : "var(--status-warn)"} />
          </button>
          <button className="pg-menu-item" onClick={() => { onPickAccrued(); setOpen(false); }} style={{ justifyContent: "space-between" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Upload size={14} />
              <span>
                Accrued Hours report
                {accrued?.fileName && <div style={{ fontSize: 11, color: "var(--fg-tertiary)", fontWeight: 400 }}>{accrued.fileName}</div>}
                {accruedErr && <div style={{ fontSize: 11, color: "var(--status-over)", fontWeight: 400 }}>{accruedErr}</div>}
              </span>
            </span>
            <StatusDot tone={accrued ? "var(--status-ok)" : "var(--status-warn)"} />
          </button>
        </div>
      )}
    </div>
  );
}

