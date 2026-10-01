import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  ChevronDown, ChevronRight, ChevronLeft, ChevronsDown, ChevronsUp, Check, X, Plus, Pencil, Search, Download, AlertTriangle, Zap,
} from "lucide-react";
import { idbGet, PG_DATA_EVENT } from "./idbStore.js";
import { findMatch, multiFolderMatchesFor, basisToClientType, CLIENT_TYPE_LABELS, CLIENT_TYPE_TONES } from "./nameMatch.js";
import { PersonAvatar } from "./avatar.jsx";
import { fetchClients as fetchPgClients, createClient as createPgClient, createClientEvent, applyDueClientEvents } from "./clientsSync.js";
import {
  MONTHS, CURRENT_MONTH, MONTH_LABELS, resignationStatus, computeMonthlyAvailability,
  holidaysInMonthGrouped, uid, FIXED_BASES, agreedAt,
  SEED_PEOPLE, SEED_CLIENTS, SEED_SUPPORT, OWNERS, loadKey, saveKey,
  computeDynamicAverages, demandFor, demandForGroup,
} from "./capacityData.js";
import { useDismissable } from "./useDismissable.js";
import { LeaveEditor } from "./LeaveEditor.jsx";
import { syncCapacityLeads } from "./usersSync.js";
import {
  CLICKUP_DB_KEY, CAP_CLIENTS_KEY, CAP_PEOPLE_KEY, CAP_SUPPORT_KEY,
  CAP_NOTES_KEY, CAP_LEAVES_KEY, CAP_OVERRIDES_KEY, PG_CLIENTS_KEY,
} from "./storageKeys.js";


/* ============================================================
   PICKER — dropdown trigger + menu, styled like the app's export menu
============================================================ */
function Picker({ value, label, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className="pg-select" style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <span>{current ? current.label : (label || "Select…")}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="pg-menu" style={{ minWidth: 220, maxHeight: 240, overflow: "auto" }}>
          {options.map((o) => (
            <button key={o.value} type="button" className="pg-menu-item" style={{ justifyContent: "space-between" }} onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>{o.label}</span>
              {o.sub && <span style={{ color: "var(--fg-tertiary)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Lets an allocation be edited as either a percentage of the supporter's capacity or a
// fixed number of hours -- editing either field recomputes the other for display (from
// `baseHours`) and calls onChange with whichever the person actually typed into, since
// that's the one that becomes the stored, canonical definition (see updateSupportAllocation).
function round1(n) { return Math.round(n * 10) / 10; }
function DualAllocationInput({ type, value, baseHours, onChange, width = 60 }) {
  const pct = type === "pct" ? Number(value || 0) * 100 : (baseHours > 0 ? (Number(value || 0) / baseHours) * 100 : 0);
  const hrs = type === "pct" ? Number(value || 0) * baseHours : Number(value || 0);
  // A supporter with zero recognized capacity this month (e.g. resigned before this
  // month, or DMA external) has no "% of their time" to speak of -- a % entered
  // against a zero base silently computes to 0 hrs everywhere with no indication why.
  // Disabling it here, rather than letting it accept a number that means nothing,
  // is the difference between an obviously-inert field and a confusing dead end.
  const pctDisabled = baseHours <= 0;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      <input
        className="pg-input" type="number" step="any" style={{ width, padding: "4px 6px" }}
        value={round1(pct)} disabled={pctDisabled}
        title={pctDisabled ? "No recognized capacity this month for this person -- use fixed hours instead" : "% of their time"}
        onChange={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); onChange("pct", v / 100); }}
      />
      <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>%</span>
      <input
        className="pg-input" type="number" step="any" style={{ width, padding: "4px 6px" }}
        value={round1(hrs)} title="Fixed hours"
        onChange={(e) => { const v = e.target.value === "" ? 0 : Number(e.target.value); onChange("hours", v); }}
      />
      <span style={{ fontSize: 11, color: "var(--fg-tertiary)" }}>hrs</span>
    </span>
  );
}

function SearchBox({ label, value, onChange }) {
  return (
    <label className="pg-field">
      <span className="pg-field__label"><Search size={11} /> {label}</span>
      <input className="pg-input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} />
    </label>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("CapacityDashboard error:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, padding: 24, margin: 24, color: "var(--status-over)", background: "var(--status-over-soft)", borderRadius: "var(--app-radius)", whiteSpace: "pre-wrap" }}>
          <b>Something broke while rendering this dashboard:</b>
          {"\n\n"}{String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)}
          {"\n\n"}{this.state.error && this.state.error.stack}
        </div>
      );
    }
    return this.props.children;
  }
}

/* ============================================================
   MAIN COMPONENT
============================================================ */
function CapacityDashboardInner({ onNavigateTeam }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimer = useRef(null);
  const [people, setPeople] = useState(SEED_PEOPLE);
  const [clients, setClients] = useState(SEED_CLIENTS);
  const [support, setSupport] = useState(SEED_SUPPORT);
  const [notes, setNotes] = useState([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [editNotes, setEditNotes] = useState(false);
  const [editRoster, setEditRoster] = useState(false);
  const [leaves, setLeaves] = useState({}); // key: `${personId}_${month}` -> hours
  const [overrides, setOverrides] = useState({}); // key: `${clientId}_${month}` -> manually-set Projected Hrs
  const [editingDemand, setEditingDemand] = useState(null); // which consultant's client table is in edit mode
  const [month, setMonth] = useState(CURRENT_MONTH);
  const [collapsed, setCollapsed] = useState({});
  const [expandedGroups, setExpandedGroups] = useState({});
  const [editingCard, setEditingCard] = useState(null);
  const [addForm, setAddForm] = useState({ from: "", type: "pct", value: "" });

  const [qConsultant, setQConsultant] = useState("");
  const [qClient, setQClient] = useState("");
  const [qCombined, setQCombined] = useState("");
  const [utilView, setUtilView] = useState("billable"); // mobile Billable/Non-billable toggle
  const [qRoster, setQRoster] = useState("");
  const [expandedUtil, setExpandedUtil] = useState({});
  const [showAllUtil, setShowAllUtil] = useState(false);

  // The same parsed ClickUp export Client Invoicing has already loaded (and persisted to
  // IndexedDB) — read here too so "Average Hrs" can be driven from real billable hours
  // instead of the seed data's hardcoded actuals. Re-reads whenever Client Invoicing saves
  // a fresh upload, via the PG_DATA_EVENT the shared idbStore fires on every write.
  const [clickupData, setClickupData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => idbGet(CLICKUP_DB_KEY).then((v) => { if (!cancelled) setClickupData(v || null); });
    load();
    const onUpdate = (e) => { if (!e.detail || e.detail.key === CLICKUP_DB_KEY) load(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);

  // The Clients module (pginvoice_clients, Supabase) is the single source of truth for a
  // client's status and consultant/owner -- reload it here too so Capacity Planning shows
  // the same active/inactive state and the same consultant assignment, and stays in sync
  // when either module edits it (a client/consultant change made in either place can only
  // land in this same table, via createClient/createClientEvent).
  const [pgClients, setPgClients] = useState([]);
  const [pgLoaded, setPgLoaded] = useState(false);
  const loadPgClients = useCallback(async () => {
    try {
      await applyDueClientEvents();
      const data = await fetchPgClients();
      setPgClients(data);
      return data;
    } catch (e) { /* best-effort -- local SEED/cap_clients data still renders on its own */ }
    finally { setPgLoaded(true); }
  }, []);
  useEffect(() => {
    loadPgClients();
    // Every module reading pginvoice_clients stays mounted for the session (no remount on
    // tab switch), so a change made in the Clients module needs this explicit signal to be
    // picked up here without a full page reload.
    const onUpdate = (e) => { if (!e.detail || e.detail.key === PG_CLIENTS_KEY) loadPgClients(); };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => window.removeEventListener(PG_DATA_EVENT, onUpdate);
  }, [loadPgClients]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ppl, clis, supp, loadedNotes, lvs, ovr] = await Promise.all([
          loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE),
          loadKey(CAP_CLIENTS_KEY, SEED_CLIENTS),
          loadKey(CAP_SUPPORT_KEY, SEED_SUPPORT),
          loadKey(CAP_NOTES_KEY, []),
          loadKey(CAP_LEAVES_KEY, {}),
          loadKey(CAP_OVERRIDES_KEY, {}),
        ]);
        if (cancelled) return;
        setPeople(ppl);
        setClients(clis);
        setSupport(supp);

        if (Array.isArray(loadedNotes)) {
          setNotes(loadedNotes.every((n) => n && typeof n.text === "string") ? loadedNotes : []);
        } else if (typeof loadedNotes === "string" && loadedNotes.trim()) {
          setNotes([{ id: uid("n"), text: loadedNotes.trim(), ts: Date.now() }]);
        } else {
          setNotes([]);
        }

        setLeaves(lvs);
        setOverrides(ovr);
        // Only now -- on confirmed success -- is it safe to mark this loaded and let
        // the save-effects below start running. If any load above failed, `loaded`
        // stays false: the save-effects never fire, so the in-memory SEED_* fallback
        // this component still holds never gets written back over real Supabase data.
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setLoadError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Every save-effect below fires only once `loaded` is true (see above), and each
  // reports a failure instead of silently pretending the edit persisted -- a save
  // that didn't actually reach Supabase is worse to hide than to show.
  const guardedSave = useCallback((key, value) => {
    saveKey(key, value).then(() => {
      setSaveError(null);
      // Brief, unobtrusive "Saved" confirmation -- the only feedback these edits
      // otherwise get is that they stay on screen, which looks identical to a
      // save that silently failed to persist.
      setSavedFlash(true);
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
      savedFlashTimer.current = setTimeout(() => setSavedFlash(false), 1800);
    }).catch((e) => setSaveError(`Couldn't save (${key.replace("cap_", "")}): ${e.message || e}`));
  }, []);
  useEffect(() => { if (loaded) guardedSave(CAP_PEOPLE_KEY, people); }, [people, loaded, guardedSave]);
  useEffect(() => { if (loaded) guardedSave(CAP_CLIENTS_KEY, clients); }, [clients, loaded, guardedSave]);

  // Reconciles Consultant/Coordinator client access with whoever's currently
  // lead on an active project here (point 7 of the RBAC/ClickUp assignment
  // feature) -- debounced since `clients` can change on every keystroke while
  // editing an unrelated field (agreed hours, notes, etc), and this doesn't
  // need to fire that often. Offboarded projects are left out on purpose: an
  // offboarded client's lead shouldn't keep RBAC access to it just because
  // they were last assigned before it went inactive.
  const leadSyncTimer = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    if (leadSyncTimer.current) clearTimeout(leadSyncTimer.current);
    leadSyncTimer.current = setTimeout(() => {
      const assignments = clients.filter((c) => c.status !== "inactive").map((c) => ({ client: c.client, lead: c.lead }));
      syncCapacityLeads(assignments).catch(() => {
        // Best-effort -- RBAC assignment lagging behind an edit here shouldn't
        // block or error out Capacity Planning itself, which already saved fine
        // via guardedSave above regardless of whether this succeeds.
      });
    }, 1500);
    return () => { if (leadSyncTimer.current) clearTimeout(leadSyncTimer.current); };
  }, [clients, loaded]);
  useEffect(() => { if (loaded) guardedSave(CAP_SUPPORT_KEY, support); }, [support, loaded, guardedSave]);
  useEffect(() => { if (loaded) guardedSave(CAP_NOTES_KEY, notes); }, [notes, loaded, guardedSave]);
  useEffect(() => { if (loaded) guardedSave(CAP_LEAVES_KEY, leaves); }, [leaves, loaded, guardedSave]);
  useEffect(() => { if (loaded) guardedSave(CAP_OVERRIDES_KEY, overrides); }, [overrides, loaded, guardedSave]);

  const resetSample = useCallback(() => {
    if (!window.confirm("Reset to sample data? This replaces every current person, client, support allocation, note, leave entry, and override with the seed data — this cannot be undone.")) return;
    setPeople(SEED_PEOPLE); setClients(SEED_CLIENTS); setSupport(SEED_SUPPORT); setNotes([]); setLeaves({}); setOverrides({});
  }, []);
  const addNote = () => {
    if (!noteDraft.trim()) return;
    setNotes((ns) => [{ id: uid("n"), text: noteDraft.trim(), ts: Date.now() }, ...ns]);
    setNoteDraft("");
  };
  const removeNote = (id) => {
    if (!window.confirm("Delete this note? This cannot be undone.")) return;
    setNotes((ns) => ns.filter((n) => n.id !== id));
  };
  const leaveFor = (personId) => Number(leaves[`${personId}_${month}`] || 0);
  const setLeaveFor = (personId, hrs) => setLeaves((prev) => ({ ...prev, [`${personId}_${month}`]: hrs === "" ? 0 : Number(hrs) }));

  /* ---------- capacity math ----------
     Delegates the actual per-person formula to computeMonthlyAvailability, the same
     function the Team module's Availability list calls — so this view and Team's can
     never quietly compute different numbers for the same person/month. */
  const peopleMap = useMemo(() => {
    const m = {};
    people.forEach((p) => {
      const avail = computeMonthlyAvailability(p, month, leaveFor(p.id));
      if (!avail) return; // resigned in an earlier month — not staff this month at all
      m[p.name] = { ...p, ...avail, monthly: avail.billableHours };
    });
    return m;
  }, [people, month, leaves]);

  const hoursOf = useCallback((entry) => {
    if (entry.type === "pct") { const base = peopleMap[entry.from] ? peopleMap[entry.from].monthly : 0; return base * Number(entry.value || 0); }
    return Number(entry.value || 0);
  }, [peopleMap]);

  const givenAway = useMemo(() => { const m = {}; support.forEach((s) => { m[s.from] = (m[s.from] || 0) + hoursOf(s); }); return m; }, [support, hoursOf]);
  const receivedBy = useMemo(() => { const m = {}; support.forEach((s) => { if (!m[s.to]) m[s.to] = []; m[s.to].push({ ...s, hours: hoursOf(s) }); }); return m; }, [support, hoursOf]);
  // The reverse of receivedBy — who a consultant is giving hours away to, and how many.
  // Powers both the "Supporting other consultants" section on each card and the
  // click-to-expand breakdown under the Capacity Utilization bars.
  const givenBy = useMemo(() => { const m = {}; support.forEach((s) => { if (!m[s.from]) m[s.from] = []; m[s.from].push({ ...s, hours: hoursOf(s) }); }); return m; }, [support, hoursOf]);

  // Every real ClickUp folder name currently synced -- used only to flag a client group
  // whose `group` text (the field findMatch actually matches folders against) doesn't
  // correspond to any real folder right now, the same silent-mismatch bug that hid Mary
  // Di Marco, HTSA, ARAS, Better Medical, and PRG Consulting's real hours until caught by hand.
  const realFolderSet = useMemo(() => new Set((clickupData?.rows || []).map((r) => r.folder).filter(Boolean)), [clickupData]);

  // Real billable-hours average per client GROUP, from whatever ClickUp export Client
  // Invoicing currently has loaded — trailing 6 real calendar months, billable only,
  // internal folders excluded, averaged only over the months that actually have data
  // (not padded to 6 with zeros). Matched to a group by fuzzy folder-name match, same
  // logic Client Invoicing uses to match ClickUp folders to the accrued sheet. Per-group
  // only (not split across a combined client's sub-projects) — see demandForGroup below.
  const dynamicAverages = useMemo(() => computeDynamicAverages(clickupData, clients), [clickupData, clients]);
  const setOverride = (clientId, m, value) => setOverrides((prev) => ({ ...prev, [`${clientId}_${m}`]: value === "" ? null : Number(value) }));
  const todayStr = () => new Date().toISOString().slice(0, 10);

  // A pginvoice_clients consultant is stored as "Holly L", "Alice FS", etc.; SEED_PEOPLE/OWNERS
  // use just the first name -- this is the only bit of translation needed to treat the two
  // systems' consultant field as the same value.
  const firstName = (s) => (s || "").trim().split(" ")[0];
  // Best-effort reverse lookup for writing a consultant back to Supabase in its full style,
  // by finding another client already on record with that same first name. Falls back to the
  // bare first name if this is the first client ever assigned to that person (matches the
  // "Added from live ClickUp sync, please confirm" pattern already used elsewhere for that case).
  const fullConsultantName = useCallback((first) => {
    const hit = pgClients.find((p) => p.consultant && firstName(p.consultant) === first);
    return hit ? hit.consultant : first;
  }, [pgClients]);

  // Reassigning a client's consultant/owner writes through to pginvoice_clients (the same
  // table the Clients module edits) via the same scheduled-event mechanism its own Modify
  // panel uses, so the change is visible there too -- not just a local-only edit here.
  const changeConsultant = useCallback(async (row, newLead) => {
    if (row._pgClient) {
      try {
        await createClientEvent(row._pgClient, "consultant", todayStr(), { new_consultant: fullConsultantName(newLead) });
        await applyDueClientEvents();
        await loadPgClients();
      } catch (e) { alert("Couldn't update the consultant in the Clients module: " + (e.message || e)); return; }
    }
    setClients((prev) => prev.map((c) => (c.group === row.group ? { ...c, lead: newLead } : c)));
  }, [fullConsultantName, loadPgClients]);

  const [showAddClient, setShowAddClient] = useState(false);
  const [addClientForm, setAddClientForm] = useState({ name: "", lead: OWNERS[0], basis: "Package", agreed: "" });
  const submitAddClient = useCallback(async () => {
    const name = addClientForm.name.trim();
    if (!name) return;
    const typeMap = { Package: "package", Project: "project", Quoted: "quoted", MAP: "map", Strategy: "strategy", Hourly: "hourly", "Ad hoc": "ad_hoc", Digital: "digital" };
    const agreedNum = addClientForm.agreed === "" ? null : Number(addClientForm.agreed);
    let freshPgClients = pgClients;
    try {
      await createPgClient(name, { type: typeMap[addClientForm.basis] || "hourly", agreedHours: agreedNum, consultant: fullConsultantName(addClientForm.lead) });
      freshPgClients = await loadPgClients();
    } catch (e) { alert("Couldn't create the client in the Clients module: " + (e.message || e)); return; }
    setClients((prev) => [...prev, {
      id: uid("c"), client: name, group: name, lead: addClientForm.lead, basis: addClientForm.basis,
      agreed: agreedNum, actuals: null, note: "", status: "active", offboardedFrom: null, offboardNote: "", history: null,
    }]);
    // The Clients-module write above succeeded, but this dashboard only ever links the
    // two records by fuzzy name matching (see matchPgClient, confidence >= 0.8) -- if that
    // wouldn't actually match this exact name, the client now exists in two disconnected
    // places (a real pginvoice_clients row, and this local Capacity Planning entry) with no
    // link between them. Better to say so now than let it look like a duplicate later with
    // no explanation.
    const wouldLink = (freshPgClients || []).some((p) => {
      const m = findMatch(name, [p.client]);
      return m && m.confidence >= 0.8;
    });
    if (!wouldLink) {
      alert(`"${name}" was created in the Clients module, but its name doesn't closely match anything Capacity Planning can auto-link. It'll show here as a separate, disconnected entry until the names match -- consider renaming one to match the other.`);
    }
    setShowAddClient(false);
    setAddClientForm({ name: "", lead: OWNERS[0], basis: "Package", agreed: "" });
  }, [addClientForm, fullConsultantName, loadPgClients, pgClients]);

  const pgClientNames = useMemo(() => pgClients.map((p) => p.client), [pgClients]);
  // A confirmed link (c.pgLink, persisted below) takes priority over re-running fuzzy
  // matching every render -- once a client has been matched with high confidence, the
  // pairing is locked in so it can't silently flip if the roster grows and a
  // coincidentally-closer-scoring name shows up. If the linked row no longer exists
  // (renamed/deleted in the Clients module), falls through to fuzzy matching below so
  // the client isn't left orphaned until someone notices.
  const matchPgClient = useCallback((c) => {
    if (!pgClients.length) return null;
    if (c.pgLink) {
      const linked = pgClients.find((p) => p.client === c.pgLink);
      if (linked) return linked;
    }
    const byClient = findMatch(c.client, pgClientNames);
    if (byClient && byClient.confidence >= 0.8) return pgClients.find((p) => p.client === byClient.name) || null;
    const byGroup = findMatch(c.group, pgClientNames);
    if (byGroup && byGroup.confidence >= 0.8) return pgClients.find((p) => p.client === byGroup.name) || null;
    return byClient ? pgClients.find((p) => p.client === byClient.name) || null : null;
  }, [pgClients, pgClientNames]);

  // Persists a confident match onto the cap_clients record itself (see matchPgClient
  // above) instead of leaving every module to silently re-derive the same pairing via
  // fuzzy string matching on every render -- this is the only place c.pgLink is ever
  // written, so a link, once established, is stable until the linked row disappears.
  useEffect(() => {
    if (!loaded || !pgClients.length) return;
    const pgByName = new Set(pgClientNames);
    setClients((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        if (c.pgLink && pgByName.has(c.pgLink)) return c;
        const pg = matchPgClient(c);
        if (!pg || pg.client === c.pgLink) return c;
        changed = true;
        return { ...c, pgLink: pg.client };
      });
      return changed ? next : prev;
    });
  }, [loaded, pgClients, pgClientNames, matchPgClient]);

  // The list actually used for the owner-grouped ledger: each row's status and lead come
  // from the matched pginvoice_clients record when one exists (so a status/consultant change
  // made in the Clients module is reflected here without any local edit), falling back to the
  // local SEED/cap_clients value when a client genuinely isn't in that table yet -- e.g. one
  // just added here, before the Supabase round-trip completes on next load.
  const syncedClients = useMemo(() => clients.map((c) => {
    const pg = matchPgClient(c);
    if (!pg) return { ...c, _pgClient: null, _effectiveStatus: c.status };
    const mappedLead = pg.consultant ? firstName(pg.consultant) : null;
    return {
      ...c,
      lead: (mappedLead && OWNERS.includes(mappedLead)) ? mappedLead : c.lead,
      _pgClient: pg.client,
      _effectiveStatus: pg.status === "active" ? "active" : "inactive",
    };
  }), [clients, matchPgClient]);

  const groupedByOwner = useMemo(() => {
    const m = {};
    OWNERS.forEach((o) => m[o] = []);
    const seenGroups = {};
    syncedClients.forEach((c) => {
      if (!pgLoaded) return; // avoid a flash of the un-filtered list before the sync data arrives
      if (c._effectiveStatus !== "active") return;
      if (!m[c.lead]) return;
      if (!seenGroups[c.group]) { seenGroups[c.group] = { group: c.group, lead: c.lead, rows: [] }; m[c.lead].push(seenGroups[c.group]); }
      seenGroups[c.group].rows.push(c);
    });
    return m;
  }, [syncedClients, pgLoaded]);

  const demandByOwner = useMemo(() => {
    const m = {};
    Object.entries(groupedByOwner).forEach(([owner, groups]) => {
      groups.forEach((g) => { m[owner] = (m[owner] || 0) + demandForGroup(g.group, g.rows, month, overrides, dynamicAverages).demand; });
    });
    return m;
  }, [groupedByOwner, month, overrides, dynamicAverages]);

  const personCalc = useMemo(() => {
    const m = {};
    people.forEach((p) => {
      if (!peopleMap[p.name]) return; // resigned in an earlier month — excluded from this month's ledger entirely
      const base = peopleMap[p.name].monthly;
      const away = givenAway[p.name] || 0;
      const remainderAfterAway = base - away; // what's left after committing hours to others — can go negative if over-promised
      const ownAvailable = Math.max(0, remainderAfterAway);
      const received = receivedBy[p.name] || [];
      const receivedTotal = received.reduce((s, r) => s + r.hours, 0);
      const given = givenBy[p.name] || [];
      const pool = ownAvailable + receivedTotal;
      const demand = demandByOwner[p.name] || 0;
      const headroom = pool - demand;
      const usedOwnOnClients = Math.min(demand, ownAvailable); // her own claim, capped — can't claim more than she actually has left
      const allocatedTotal = away + usedOwnOnClients; // Allocated Hours = given to others + spent on her own clients
      const spare = remainderAfterAway - usedOwnOnClients; // Availability = capacity − Allocated Hours. Never goes negative just because her own client list is bigger than her capacity — only if she's over-promised hours to others.
      const overAllocated = spare < 0;
      m[p.name] = { base, away, ownAvailable, received, receivedTotal, given, pool, demand, headroom, spare, overAllocated, usedOwnOnClients, allocatedTotal };
    });
    return m;
  }, [people, peopleMap, givenAway, receivedBy, givenBy, demandByOwner]);

  const totalDemand = useMemo(() => {
    let s = 0;
    Object.values(groupedByOwner).forEach((groups) => groups.forEach((g) => { s += demandForGroup(g.group, g.rows, month, overrides, dynamicAverages).demand; }));
    return s;
  }, [groupedByOwner, month, overrides, dynamicAverages]);
  const totalCapacity = useMemo(() => people.reduce((s, p) => s + (peopleMap[p.name] ? peopleMap[p.name].monthly : 0), 0), [people, peopleMap]);
  const totalDMA = useMemo(() => support.filter((s) => s.from === "DMA (external)").reduce((s, x) => s + hoursOf(x), 0), [support, hoursOf]);
  const totalBillableAllocation = totalCapacity + totalDMA; // total hours the team+DMA is available to deliver
  const difference = totalBillableAllocation - totalDemand;

  /* ---------- filtering ---------- */
  // Mobile has one combined "search consultant or client" field instead of the
  // desktop's two separate ones (see the mobile-only input below) -- it needs
  // OR semantics (name matches OR has a matching client) rather than the
  // desktop pair's AND (must match this consultant AND have this client),
  // since a single query filled into both queries under AND would demand a
  // consultant literally named e.g. "bee" to ever show a "Bee Squared" match.
  const clientMatches = (owner, q) => (groupedByOwner[owner] || []).some((g) => g.group.toLowerCase().includes(q) || g.rows.some((r) => r.client.toLowerCase().includes(q)));
  const visibleOwners = OWNERS.filter((owner) => {
    if (!peopleMap[owner]) return false; // resigned as of this month — hide their card entirely
    if (qCombined) {
      const q = qCombined.toLowerCase();
      return owner.toLowerCase().includes(q) || clientMatches(owner, q);
    }
    const okConsultant = !qConsultant || owner.toLowerCase().includes(qConsultant.toLowerCase());
    const okClient = !qClient || clientMatches(owner, qClient.toLowerCase());
    return okConsultant && okClient;
  });

  const toggleCollapse = (owner) => setCollapsed((prev) => ({ ...prev, [owner]: !prev[owner] }));
  const toggleGroup = (key) => setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  const allExpanded = visibleOwners.length > 0 && visibleOwners.every((o) => !collapsed[o]);
  const toggleAllCollapse = () => {
    const next = { ...collapsed };
    visibleOwners.forEach((o) => { next[o] = allExpanded; }); // if all currently expanded, collapse them; otherwise expand them
    setCollapsed(next);
  };
  const fmt = (n) => (n === null || n === undefined) ? "—" : Number(n).toFixed(1);
  const monthIdx = MONTHS.indexOf(month);
  const shiftMonth = (d) => setMonth(MONTHS[Math.max(0, Math.min(MONTHS.length - 1, monthIdx + d))]);
  const monthKind = month < CURRENT_MONTH ? "past" : (month === CURRENT_MONTH ? "now" : "future");

  const allocatableNames = ["DMA (external)", ...people.filter((p) => peopleMap[p.name]).map((p) => p.name)];

  const removeSupport = (id) => {
    if (!window.confirm("Remove this support allocation? This cannot be undone.")) return;
    setSupport((ss) => ss.filter((s) => s.id !== id));
  };
  // Whichever field the person actually edited (% or fixed hrs) becomes the stored
  // definition going forward -- a %-based allocation scales with the supporter's future
  // capacity changes, a fixed-hrs one doesn't, so only one can be canonical at a time.
  const updateSupportAllocation = (id, type, value) => setSupport((ss) => ss.map((s) => s.id === id ? { ...s, type, value } : s));
  function proposedHours(from, type, value) {
    if (type === "pct") { const base = peopleMap[from] ? peopleMap[from].monthly : 0; return base * Number(value || 0); }
    return Number(value || 0);
  }
  function wouldExceed(from, newHours) {
    if (from === "DMA (external)") return { over: false, base: null, currentAway: 0, total: newHours };
    const base = peopleMap[from] ? peopleMap[from].monthly : 0;
    const currentAway = givenAway[from] || 0;
    const ownDemand = demandByOwner[from] || 0; // if `from` is themselves a consultant, their own clients get first call on their hours
    const total = currentAway + newHours + ownDemand;
    return { over: total > base, base, currentAway, ownDemand, total };
  }
  function submitAllocation(toConsultant) {
    const { from, type, value } = addForm;
    if (!from || value === "" || value === null) return;
    setSupport((ss) => [...ss, { id: uid("s"), from, to: toConsultant, type, value: Number(value) }]);
    setAddForm({ from: "", type: "pct", value: "" });
  }

  // A proper multi-sheet workbook rather than one flat CSV: a Summary sheet up top,
  // then Team Roster / Client Demand / Support Allocations / Notes as their own
  // filterable, sensibly-widened sheets — each one usable on its own.
  function exportXlsx() {
    const wb = XLSX.utils.book_new();
    const setCols = (ws, headerLen, widths) => { ws["!cols"] = widths; ws["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(headerLen - 1)}1` }; };

    const summaryRows = [
      ["Purple Giraffe: Capacity Ledger"],
      [`Month: ${MONTH_LABELS[month]}`],
      [`Generated: ${new Date().toLocaleString()}`],
      [],
      ["Metric", "Hours"],
      ["Total demand", Number(totalDemand.toFixed(1))],
      ["Total team capacity", Number(totalCapacity.toFixed(1))],
      ["DMA (external) hours", Number(totalDMA.toFixed(1))],
      ["Total billable allocation (team + DMA)", Number(totalBillableAllocation.toFixed(1))],
      ["Difference (allocation − demand)", Number(difference.toFixed(1))],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary["!cols"] = [{ wch: 36 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

    const rosterHeader = ["Consultant", "Role", "State", "Resource Hrs", "Leaves", "Public Holidays (hrs)", "Public Holidays (days)", "Monthly Hrs", "Billable %", "Billable Capacity", "Allocated Hrs", "Availability"];
    const rosterRows = [rosterHeader];
    people.forEach((p) => {
      if (!peopleMap[p.name]) return; // resigned before this month
      const pc = personCalc[p.name]; const pm = peopleMap[p.name];
      rosterRows.push([p.name, p.role, p.state, Number(pm.resourceHours.toFixed(1)), Number(pm.leaveHrs.toFixed(1)), Number(pm.publicHolidayHrs.toFixed(1)), pm.holidayDays, Number(pm.totalMonthlyHours.toFixed(1)), p.rate, Number(pc.base.toFixed(1)), Number(pc.allocatedTotal.toFixed(1)), Number(pc.spare.toFixed(1))]);
    });
    const wsRoster = XLSX.utils.aoa_to_sheet(rosterRows);
    setCols(wsRoster, rosterHeader.length, rosterHeader.map((h) => ({ wch: Math.max(13, h.length + 2) })));
    XLSX.utils.book_append_sheet(wb, wsRoster, "Team Roster");

    const demandHeader = ["Consultant", "Client", "Client Group", "Basis", "Agreed Hrs", "Average Hrs (trailing)", "Projected Hrs", "Manually Overridden?"];
    const demandRows = [demandHeader];
    syncedClients.filter((c) => c._effectiveStatus === "active").forEach((c) => {
      const { demand, avg, isOverridden } = demandFor(c, month, overrides);
      demandRows.push([c.lead, c.client, c.group, c.basis, agreedAt(c, month) ?? "", avg !== null ? Number(avg.toFixed(1)) : "", Number(demand.toFixed(1)), isOverridden ? "Yes" : "No"]);
    });
    const wsDemand = XLSX.utils.aoa_to_sheet(demandRows);
    setCols(wsDemand, demandHeader.length, demandHeader.map((h) => ({ wch: Math.max(15, h.length + 2) })));
    XLSX.utils.book_append_sheet(wb, wsDemand, "Client Demand");

    const supportHeader = ["From", "To", "Allocation Type", "Value", "Computed Hrs"];
    const supportRows = [supportHeader];
    support.forEach((s) => {
      supportRows.push([s.from, s.to, s.type === "pct" ? "% of their time" : "Fixed hours", s.type === "pct" ? `${(s.value * 100).toFixed(0)}%` : s.value, Number(hoursOf(s).toFixed(1))]);
    });
    const wsSupport = XLSX.utils.aoa_to_sheet(supportRows);
    setCols(wsSupport, supportHeader.length, supportHeader.map((h) => ({ wch: Math.max(15, h.length + 2) })));
    XLSX.utils.book_append_sheet(wb, wsSupport, "Support Allocations");

    const notesHeader = ["Date", "Note"];
    const notesRows = [notesHeader, ...notes.map((n) => [new Date(n.ts).toLocaleString(), n.text])];
    const wsNotes = XLSX.utils.aoa_to_sheet(notesRows);
    wsNotes["!cols"] = [{ wch: 20 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, wsNotes, "Notes");

    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `capacity-ledger-${month}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  }

  // A failed load must never fall through to "Loading…" forever, and must never
  // silently render on SEED_* data as if it were real -- that's exactly the state
  // that used to get written back to Supabase over real data (see capacityStore.js).
  if (loadError) {
    return (
      <div className="pg-cap-container">
        <div className="pg-empty" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <p>Couldn't load Capacity Planning data: {loadError}</p>
          <button className="pg-btn" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!loaded) {
    return <div className="pg-cap-container"><div className="pg-empty">Loading…</div></div>;
  }

  return (
    <div className="pg-cap-container">
      <div className="pg-app-header">
        <div>
          <span className="pg-eyebrow">Purple Giraffe · Internal</span>
          <h1 className="pg-app-header__title">Capacity ledger: team hours vs. client demand, by month.</h1>
        </div>
        {savedFlash && !saveError && (
          <span className="pg-status-pill" style={{ color: "var(--status-ok)", background: "var(--status-ok-soft)" }}>
            <Check size={11} style={{ marginRight: 3, verticalAlign: -1 }} />Saved
          </span>
        )}
      </div>

      {saveError && (
        <div className="pg-alertbar" style={{ background: "var(--status-over-soft)", color: "var(--status-over)" }}>
          <AlertTriangle size={13} />
          <span className="pg-alertbar__text">{saveError} — your edit is only held in this browser tab until this is resolved.</span>
          <button className="pg-btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}

      <div className="pg-panel" style={{ alignItems: "center" }}>
        <span className="pg-field__label">Month</span>
        <button className="pg-btn-ghost" style={{ padding: "7px 9px" }} onClick={() => shiftMonth(-1)} disabled={monthIdx === 0}><ChevronLeft size={13} /></button>
        <span style={{ fontFamily: "var(--font-display)", fontSize: 18, minWidth: 76, textAlign: "center" }}>{MONTH_LABELS[month]}</span>
        <button className="pg-btn-ghost" style={{ padding: "7px 9px" }} onClick={() => shiftMonth(1)} disabled={monthIdx === MONTHS.length - 1}><ChevronRight size={13} /></button>
        <span className="pg-tag pg-tag--pill" style={{ color: monthKind === "past" ? "var(--fg-tertiary)" : monthKind === "now" ? "var(--status-ok)" : "var(--accent)" }}>
          {monthKind === "past" ? "past record" : monthKind === "now" ? "latest actuals" : "forecast"}
        </span>
        <button className="pg-btn-ghost pg-cap-addclient-btn" onClick={() => setShowAddClient((s) => !s)}><Plus size={11} /> <span>Add client</span></button>
        <button className="pg-btn-ghost pg-cap-desktop-only" style={{ marginLeft: "auto" }} onClick={resetSample}>Reset sample data</button>
      </div>

      {showAddClient && (
        <div className="pg-cap-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span className="pg-field__label">New client -- creates it in the Clients module too, so both stay in sync</span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="pg-field" style={{ width: 220 }}>
              <span className="pg-field__label">Client name</span>
              <input className="pg-input" value={addClientForm.name} onChange={(e) => setAddClientForm((f) => ({ ...f, name: e.target.value }))} placeholder="Client name" />
            </label>
            <label className="pg-field">
              <span className="pg-field__label">Consultant</span>
              <select className="pg-input" value={addClientForm.lead} onChange={(e) => setAddClientForm((f) => ({ ...f, lead: e.target.value }))}>
                {OWNERS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="pg-field">
              <span className="pg-field__label">Type</span>
              <select className="pg-input" value={addClientForm.basis} onChange={(e) => setAddClientForm((f) => ({ ...f, basis: e.target.value }))}>
                {FIXED_BASES.concat(["Hourly", "Ad hoc", "Digital"]).map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <label className="pg-field" style={{ width: 120 }}>
              <span className="pg-field__label">Agreed hrs</span>
              <input className="pg-input" type="number" step="any" value={addClientForm.agreed} onChange={(e) => setAddClientForm((f) => ({ ...f, agreed: e.target.value }))} placeholder="e.g. 16" />
            </label>
            <button className="pg-btn" disabled={!addClientForm.name.trim()} onClick={submitAddClient}>Create</button>
            <button className="pg-btn-ghost" onClick={() => setShowAddClient(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="pg-panel pg-cap-desktop-only">
        <SearchBox label="Consultant" value={qConsultant} onChange={setQConsultant} />
        <SearchBox label="Client" value={qClient} onChange={setQClient} />
        <button className="pg-btn" style={{ marginLeft: "auto" }} onClick={exportXlsx}><Download size={14} /> Export</button>
      </div>
      {/* Mobile only -- one combined field instead of two separate ones, plus a
          filter icon standing in for Export (a file download isn't a mobile-
          native action; kept reachable rather than duplicated as an icon). */}
      <div className="pg-cap-mobile-search">
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={13} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--fg-tertiary)" }} />
          <input
            className="pg-input" style={{ width: "100%", padding: "10px 12px 10px 34px" }}
            placeholder="Search consultant or client"
            value={qCombined} onChange={(e) => setQCombined(e.target.value)}
          />
        </div>
        <button className="pg-btn-ghost pg-cap-mobile-search__filter" onClick={exportXlsx} title="Export" aria-label="Export">
          <Download size={14} />
        </button>
      </div>

      <div className="pg-cap-grid">

        {/* ===================== LEFT: CONSULTANT CARDS ===================== */}
        <div className="pg-cap-pane-left">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <button className="pg-btn-ghost" onClick={toggleAllCollapse}>
              {allExpanded ? <><ChevronsUp size={12} /> Collapse all</> : <><ChevronsDown size={12} /> Expand all</>}
            </button>
          </div>
          <div className="pg-cap-pane">
          {visibleOwners.length === 0 && <div className="pg-empty">No consultant matches all three search filters.</div>}

          {visibleOwners.map((owner) => {
            const pc = personCalc[owner];
            const groups = groupedByOwner[owner] || [];
            const isCollapsed = collapsed[owner];
            const isEditing = editingCard === owner;
            const candidateOptions = allocatableNames.filter((n) => n !== owner).map((n) => {
              const spare = n === "DMA (external)" ? null : (personCalc[n] ? personCalc[n].spare : 0);
              return { value: n, label: n, sub: spare === null ? "external" : `${spare.toFixed(1)} hrs spare` };
            });
            const preview = addForm.from ? proposedHours(addForm.from, addForm.type, addForm.value) : 0;
            const check = addForm.from ? wouldExceed(addForm.from, preview) : null;

            return (
              <div className="pg-cap-card" key={owner}>
                <button className="pg-client__name" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => toggleCollapse(owner)}>
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  {owner}
                  <span className="pg-tag pg-tag--pill" style={{ color: "var(--accent)" }}>Consultant</span>
                </button>

                {!isCollapsed && (
                  <>
                    {(() => {
                      const cardCapacity = pc.usedOwnOnClients + pc.receivedTotal;
                      const cardDiff = cardCapacity - pc.demand;
                      return (
                        <div className="pg-cap-card-statrow">
                          <div><div className="pg-cap-card-statrow__value">{pc.demand.toFixed(1)} h</div><div className="pg-cap-card-statrow__label">Demand</div></div>
                          <div><div className="pg-cap-card-statrow__value">{cardCapacity.toFixed(1)} h</div><div className="pg-cap-card-statrow__label">Capacity</div></div>
                          <div><div className="pg-cap-card-statrow__value" style={{ color: cardDiff < 0 ? "var(--status-over)" : "var(--status-ok)" }}>{cardDiff > 0 ? "+" : ""}{cardDiff.toFixed(1)} h</div><div className="pg-cap-card-statrow__label">Difference</div></div>
                        </div>
                      );
                    })()}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
                      <span className="pg-field__label">Client projects</span>
                      <button className="pg-btn-ghost" onClick={() => setEditingDemand(editingDemand === owner ? null : owner)}>
                        {editingDemand === owner ? <><Check size={11} /> done</> : <><Pencil size={11} /> edit</>}
                      </button>
                    </div>
                    <div className="pg-table-wrap pg-cap-clientprojects-table">
                    <table className="pg-table">
                      <thead><tr><th>Client</th><th>Type</th><th className="right num">Agreed Hrs</th><th className="right num">Average Hrs</th><th className="right num">Projected Hrs</th></tr></thead>
                      <tbody>
                        {groups.map((g) => {
                          const isMulti = g.rows.length > 1;
                          if (!isMulti) {
                            const r = g.rows[0];
                            const { demand, avg, isOverridden, isDynamic, dyn } = demandForGroup(g.group, g.rows, month, overrides, dynamicAverages);
                            return (
                              <tr key={g.group}>
                                <td>
                                  {r.client}{r.offboardedFrom && month >= r.offboardedFrom && <span className="pg-tag pg-tag--muted pg-tag--pill" style={{ marginLeft: 5 }} title={r.offboardNote}>Offboarded</span>}{r.status === "archived" && <span className="pg-tag pg-tag--muted pg-tag--pill" style={{ marginLeft: 5 }} title={r.note}>Archived</span>}{realFolderSet.size > 0 && !multiFolderMatchesFor(r.group, [...realFolderSet])?.length && !findMatch(r.group, [...realFolderSet]) && <AlertTriangle size={11} style={{ marginLeft: 5, verticalAlign: -1, color: "var(--status-warn)" }} title={`"${r.group}" doesn't match any real ClickUp folder right now -- this client's actuals may be silently missing.`} />}
                                  {editingDemand === owner && (
                                    <select className="pg-input" style={{ marginLeft: 8, padding: "2px 4px", fontSize: 11, width: 100 }}
                                      value={owner} onChange={(e) => changeConsultant(r, e.target.value)} title="Reassign consultant -- also updates the Clients module">
                                      {OWNERS.map((o) => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                  )}
                                </td>
                                <td><span className="pg-tag pg-tag--pill" style={{ color: CLIENT_TYPE_TONES[basisToClientType(r.basis)] }} title={r.basis}>{CLIENT_TYPE_LABELS[basisToClientType(r.basis)]}</span></td>
                                <td className="right num">{fmt(agreedAt(r, month))}</td>
                                <td className="right num">
                                  {fmt(avg)}
                                  {isDynamic && (
                                    <Zap size={11} style={{ marginLeft: 4, verticalAlign: -1, color: "var(--accent)" }}
                                      title={`Live average from ClickUp: "${dyn.matchedFolder}" (${dyn.monthsCounted} month${dyn.monthsCounted === 1 ? "" : "s"} of billable data)`} />
                                  )}
                                </td>
                                <td className="right num">
                                  {editingDemand === owner ? (
                                    <input className="pg-input" type="number" step="any" style={{ width: 72, padding: "4px 6px" }}
                                      value={demand} onChange={(e) => setOverride(r.id, month, e.target.value)} />
                                  ) : (
                                    <>
                                      <b>{demand.toFixed(1)}</b>
                                      {isOverridden && <span className="pg-tag pg-tag--pill" style={{ color: "var(--accent)", marginLeft: 6 }}>manual</span>}
                                    </>
                                  )}
                                </td>
                              </tr>
                            );
                          }
                          const groupKey = `${owner}::${g.group}`;
                          const groupOpen = !!expandedGroups[groupKey];
                          const { demand: gDemand, isDynamic: gIsDynamic, dyn: gDyn } = demandForGroup(g.group, g.rows, month, overrides, dynamicAverages);
                          return (
                            <React.Fragment key={g.group}>
                              <tr>
                                <td>
                                  <button className="pg-btn-ghost" style={{ padding: "2px 6px", marginRight: 6 }} onClick={() => toggleGroup(groupKey)}>
                                    {groupOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                  </button>
                                  {g.group} <span style={{ fontSize: 10, color: "var(--fg-tertiary)" }}>({g.rows.length} sub-projects)</span>
                                </td>
                                <td><span className="pg-tag pg-tag--muted pg-tag--pill">Combined</span></td>
                                <td className="right num">—</td>
                                <td className="right num">
                                  {gIsDynamic && (
                                    <Zap size={11} style={{ verticalAlign: -1, color: "var(--accent)" }}
                                      title={`Live group average from ClickUp: "${gDyn.matchedFolder}" (${gDyn.monthsCounted} month${gDyn.monthsCounted === 1 ? "" : "s"} of billable data), applied to the group total, not split across sub-projects`} />
                                  )}
                                </td>
                                <td className="right num"><b>{gDemand.toFixed(1)}</b></td>
                              </tr>
                              {groupOpen && g.rows.map((r) => {
                                const { demand, avg, isOverridden } = demandFor(r, month, overrides);
                                return (
                                  <tr key={r.id}>
                                    <td style={{ paddingLeft: 34, color: "var(--fg-tertiary)" }}>{r.client}{r.offboardedFrom && month >= r.offboardedFrom && <span className="pg-tag pg-tag--muted pg-tag--pill" style={{ marginLeft: 5 }} title={r.offboardNote}>Offboarded</span>}{r.status === "archived" && <span className="pg-tag pg-tag--muted pg-tag--pill" style={{ marginLeft: 5 }} title={r.note}>Archived</span>}{realFolderSet.size > 0 && !multiFolderMatchesFor(r.group, [...realFolderSet])?.length && !findMatch(r.group, [...realFolderSet]) && <AlertTriangle size={11} style={{ marginLeft: 5, verticalAlign: -1, color: "var(--status-warn)" }} title={`"${r.group}" doesn't match any real ClickUp folder right now -- this client's actuals may be silently missing.`} />}</td>
                                    <td><span className="pg-tag pg-tag--pill" style={{ color: CLIENT_TYPE_TONES[basisToClientType(r.basis)] }} title={r.basis}>{CLIENT_TYPE_LABELS[basisToClientType(r.basis)]}</span></td>
                                    <td className="right num">{fmt(agreedAt(r, month))}</td>
                                    <td className="right num">{fmt(avg)}</td>
                                    <td className="right num">
                                      {editingDemand === owner ? (
                                        <input className="pg-input" type="number" step="any" style={{ width: 72, padding: "4px 6px" }}
                                          value={demand} onChange={(e) => setOverride(r.id, month, e.target.value)} />
                                      ) : (
                                        <>
                                          {demand.toFixed(1)}
                                          {isOverridden && <span className="pg-tag pg-tag--pill" style={{ color: "var(--accent)", marginLeft: 6 }}>manual</span>}
                                        </>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </React.Fragment>
                          );
                        })}
                        <tr className="total"><td colSpan={4}>Total</td><td className="right num">{pc.demand.toFixed(1)}</td></tr>
                      </tbody>
                    </table>
                    </div>
                    {editingDemand === owner && <p className="pg-footnote" style={{ marginTop: 8 }}>Click the arrow next to a combined client (e.g. Clarke Energy) to expand it and edit each sub-project's projected hours individually.</p>}

                    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed var(--border-soft)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span className="pg-field__label">Capacity planning</span>
                        <button className="pg-btn-ghost" onClick={() => { setEditingCard(isEditing ? null : owner); setAddForm({ from: "", type: "pct", value: "" }); }}>
                          {isEditing ? <><Check size={11} /> done</> : <><Pencil size={11} /> edit</>}
                        </button>
                      </div>
                      <div className="pg-table-wrap">
                      <table className="pg-table">
                        <thead><tr><th>Capacity</th><th>Allocation</th><th className="right num">Hrs</th>{isEditing && <th></th>}</tr></thead>
                        <tbody>
                          <tr>
                            <td>{owner} (own time)</td>
                            <td>{pc.base > 0 ? ((pc.usedOwnOnClients / pc.base) * 100).toFixed(0) : 0}% of their time</td>
                            <td className="right num">{pc.usedOwnOnClients.toFixed(1)}</td>
                            {isEditing && <td></td>}
                          </tr>
                          {pc.received.length === 0 && <tr><td colSpan={4} className="empty">No additional support currently allocated.</td></tr>}
                          {pc.received.map((r, i) => {
                            const supporterOver = r.from !== "DMA (external)" && personCalc[r.from] && personCalc[r.from].overAllocated;
                            return (
                              <tr key={i}>
                                <td>{r.from} {supporterOver && <span className="pg-tag pg-tag--pill" style={{ color: "var(--status-over)", marginLeft: 6 }}>over cap</span>}</td>
                                <td>
                                  {isEditing ? (
                                    <DualAllocationInput
                                      type={r.type} value={r.value}
                                      baseHours={r.from === "DMA (external)" ? 0 : (peopleMap[r.from] ? peopleMap[r.from].monthly : 0)}
                                      onChange={(type, value) => updateSupportAllocation(r.id, type, value)}
                                    />
                                  ) : (
                                    r.type === "pct" ? `${(r.value * 100).toFixed(0)}% of their time` : `${r.value} fixed hrs`
                                  )}
                                </td>
                                <td className="right num">{r.hours.toFixed(1)}</td>
                                {isEditing && <td><button className="pg-btn-ghost pg-icon-btn-sm" style={{ color: "var(--status-over)", padding: "4px 7px" }} onClick={() => removeSupport(r.id)} aria-label={`Remove support allocation from ${r.from}`}><X size={12} /></button></td>}
                              </tr>
                            );
                          })}
                          <tr className="total"><td colSpan={2}>Total capacity assembled for {owner}</td><td className="right num">{(pc.usedOwnOnClients + pc.receivedTotal).toFixed(1)}</td>{isEditing && <td></td>}</tr>
                        </tbody>
                      </table>
                      </div>

                      {isEditing && (
                        <div className="pg-cap-addform">
                          <div className="pg-cap-addform-grid">
                            <div><Picker value={addForm.from} label="Choose person" options={candidateOptions} onChange={(v) => setAddForm((f) => ({ ...f, from: v }))} /></div>
                            <DualAllocationInput
                              type={addForm.type} value={addForm.value === "" ? 0 : addForm.value}
                              baseHours={addForm.from && addForm.from !== "DMA (external)" && peopleMap[addForm.from] ? peopleMap[addForm.from].monthly : 0}
                              onChange={(type, value) => setAddForm((f) => ({ ...f, type, value }))}
                              width={68}
                            />
                            <button className="pg-btn" style={{ padding: "9px 14px" }} onClick={() => submitAllocation(owner)} disabled={!addForm.from || addForm.value === ""}><Plus size={13} /> Add</button>
                          </div>
                          {check && check.over && (
                            <div className="pg-alertbar" style={{ background: "var(--status-over-soft)", color: "var(--status-over)", marginTop: 10 }}>
                              <AlertTriangle size={13} />
                              <span className="pg-alertbar__text">
                                Risk: {addForm.from} would be committing {check.total.toFixed(1)} hrs in total (their own {check.ownDemand.toFixed(1)} hrs of client work + {(check.currentAway + preview).toFixed(1)} hrs given to others) against a capacity of {check.base.toFixed(1)} hrs, {(check.total - check.base).toFixed(1)} hrs over.
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Reverse of "Capacity planning" above — hours THIS consultant is giving
                        away to help other consultants, rather than receiving. Searching for a
                        consultant by name shows her own card with this section right in it, so
                        her time-spent and who-she's-supporting are visible together. */}
                    {pc.given.length > 0 && (
                      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px dashed var(--border-soft)" }}>
                        <span className="pg-field__label">Supporting other consultants</span>
                        <div className="pg-table-wrap" style={{ marginTop: 8 }}>
                        <table className="pg-table">
                          <thead><tr><th>Consultant</th><th>Allocation</th><th className="right num">Hrs</th></tr></thead>
                          <tbody>
                            {pc.given.map((g, i) => (
                              <tr key={i}>
                                <td>{g.to}</td>
                                <td>{g.type === "pct" ? `${(g.value * 100).toFixed(0)}% of ${owner}'s time` : `${g.value} fixed hrs`}</td>
                                <td className="right num">{g.hours.toFixed(1)}</td>
                              </tr>
                            ))}
                            <tr className="total"><td colSpan={2}>Total given away</td><td className="right num">{pc.away.toFixed(1)}</td></tr>
                          </tbody>
                        </table>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          </div>
        </div>

        {/* ===================== RIGHT: STATS + ROSTER + NOTES ===================== */}
        <div className="pg-cap-pane">
          <div className="pg-cap-statrow">
            <div className="pg-cap-stat"><div className="pg-stat__value">{totalDemand.toFixed(0)}</div><div className="pg-stat__label">Total demand</div></div>
            <div className="pg-cap-stat"><div className="pg-stat__value">{totalBillableAllocation.toFixed(0)}</div><div className="pg-stat__label">Billable allocation</div></div>
            <div className="pg-cap-stat"><div className="pg-stat__value" style={{ color: difference < 0 ? "var(--status-over)" : "var(--status-ok)" }}>{difference > 0 ? "+" : ""}{difference.toFixed(0)}</div><div className="pg-stat__label">Difference</div></div>
          </div>

          <div className="pg-cap-card" style={{ marginTop: 14, maxWidth: 460 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span className="pg-field__label">Capacity utilization</span>
              <div style={{ display: "flex", gap: 6 }}>
                {onNavigateTeam && <button className="pg-btn-ghost" onClick={onNavigateTeam}>Go to team</button>}
                <button className="pg-btn-ghost" onClick={() => setEditRoster((v) => !v)}>{editRoster ? <><Check size={11} /> done</> : <><Pencil size={11} /> edit</>}</button>
              </div>
            </div>

            <div style={{ position: "relative", marginTop: 12 }}>
              <Search size={11} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--fg-tertiary)" }} />
              <input
                className="pg-input"
                style={{ width: "100%", padding: "7px 10px 7px 28px", fontSize: 12, borderRadius: "var(--app-radius-pill)" }}
                placeholder="Search consultant…"
                value={qRoster}
                onChange={(e) => setQRoster(e.target.value)}
              />
            </div>

            {/* Desktop: static column headers, both bars always shown side by side.
                Mobile: a real toggle -- there isn't room for two bars per row at
                phone width, so one view replaces the other instead of both being
                squeezed in (see .pg-cap-util-list--nonbillable in app.css). */}
            <div className="pg-cap-desktop-only pg-cap-util-header-row">
              <div className="pg-footnote" style={{ flex: 1, margin: 0, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center" }}>Billable</div>
              <div className="pg-footnote" style={{ width: 92, flex: "none", margin: 0, textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center" }}>Non-billable</div>
            </div>
            <div className="pg-cap-util-toggle">
              <button type="button" className={utilView === "billable" ? "pg-cap-util-toggle__btn pg-cap-util-toggle__btn--active" : "pg-cap-util-toggle__btn"} onClick={() => setUtilView("billable")}>Billable</button>
              <button type="button" className={utilView === "non-billable" ? "pg-cap-util-toggle__btn pg-cap-util-toggle__btn--active" : "pg-cap-util-toggle__btn"} onClick={() => setUtilView("non-billable")}>Non-billable</button>
            </div>

            <div className={utilView === "non-billable" ? "pg-cap-util-list pg-cap-util-list--nonbillable" : "pg-cap-util-list"}>
            {(() => {
              const filtered = people.filter((p) => peopleMap[p.name] && (!qRoster || p.name.toLowerCase().includes(qRoster.toLowerCase())));
              const visible = (showAllUtil || qRoster) ? filtered : filtered.slice(0, 3);
              return visible;
            })().map((p) => {
              const pc = personCalc[p.name];
              const pm = peopleMap[p.name];
              // Her own personal utilization: how much of HER OWN billable time is committed
              // — to her own clients (usedOwnOnClients) plus whatever she's giving away to
              // help other consultants (away) — against her own billable capacity. This is
              // exactly the "<name> (own time) X% of their time" row in her Capacity Planning
              // card above; it deliberately ignores what other consultants are covering for
              // her clients, since that's their own utilization, tracked on their own row.
              const capacity = pm.billableHours;
              const allocated = pc.allocatedTotal;      // her own clients' hours she personally covers + hours she gives away to support others
              const overflow = Math.max(0, allocated - capacity);
              const unbillableCapacity = pm.nonBillableHours;
              const billablePct = capacity > 0 ? Math.min(100, (allocated / capacity) * 100) : (allocated > 0 ? 100 : 0);
              const unbillablePct = unbillableCapacity > 0 ? Math.min(100, (overflow / unbillableCapacity) * 100) : (overflow > 0 ? 100 : 0);
              // Green = fully (100%) using her own billable capacity — the target. Yellow =
              // under-allocated, spare capacity available. Red = over-committed — she's promised
              // more of her own time (to her clients + to others) than she actually has,
              // spilling into her non-billable hours.
              const status = overflow > 0 ? "over" : (capacity > 0 && allocated >= capacity - 0.05) ? "full" : "under";
              const barColor = status === "over" ? "var(--status-over)" : status === "full" ? "var(--status-ok)" : "var(--status-warn)";
              const hasGiven = pc.given.length > 0;
              const isExpanded = hasGiven && !!expandedUtil[p.name];
              return (
                <div key={p.id} style={{ marginTop: 10 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 10, cursor: hasGiven ? "pointer" : "default" }}
                    onClick={hasGiven ? () => setExpandedUtil((prev) => ({ ...prev, [p.name]: !prev[p.name] })) : undefined}
                    title={hasGiven ? `${isExpanded ? "Hide" : "Show"} who ${p.name} is supporting` : undefined}
                  >
                    <PersonAvatar name={p.name} photo={p.photo} size={34} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--font-body)", fontWeight: 600, fontSize: 13, color: "var(--fg-primary)", display: "flex", alignItems: "center" }}>
                        {p.name}
                        {pm.resigningThisMonth && <AlertTriangle size={11} style={{ marginLeft: 5, verticalAlign: -1, color: "var(--status-warn)" }} />}
                        {hasGiven && (isExpanded ? <ChevronDown size={12} style={{ marginLeft: 5, color: "var(--fg-tertiary)" }} /> : <ChevronRight size={12} style={{ marginLeft: 5, color: "var(--fg-tertiary)" }} />)}
                      </div>
                      <div style={{ display: "flex", gap: 16, marginTop: 4, alignItems: "flex-start" }}>
                        <div className="pg-cap-util-col--billable" style={{ flex: 1 }}>
                          <div className="pg-bar-track" style={{ height: 8, margin: 0 }}>
                            <div className="pg-bar-fill" style={{ width: `${billablePct}%`, background: barColor }} />
                          </div>
                          {editRoster ? (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                              <span className="pg-footnote" style={{ margin: 0 }}>Leave hrs</span>
                              <LeaveEditor person={p} hours={leaveFor(p.id)} onChange={(hrs) => setLeaveFor(p.id, hrs)} />
                            </div>
                          ) : (
                            <p className="pg-footnote" style={{ margin: "4px 0 0", textAlign: "center" }}>{allocated.toFixed(1)} / {capacity.toFixed(1)} hrs billable</p>
                          )}
                        </div>
                        <div className="pg-cap-util-col--nonbillable" style={{ width: 92, flex: "none" }} title={overflow > 0 ? `${overflow.toFixed(1)} hrs of billable overflow eating into non-billable time` : undefined}>
                          <div className="pg-bar-track" style={{ height: 8, margin: 0 }}>
                            <div className="pg-bar-fill" style={{ width: `${unbillablePct}%`, background: overflow > 0 ? "var(--status-over)" : "var(--fg-tertiary)" }} />
                          </div>
                          <p className="pg-footnote" style={{ margin: "4px 0 0", textAlign: "center", color: overflow > 0 ? "var(--status-over)" : undefined }}>
                            {overflow.toFixed(1)} / {unbillableCapacity.toFixed(1)} hrs
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div style={{ marginLeft: 44, marginTop: 6, padding: "8px 10px", background: "var(--bg-subtle, var(--accent-soft))", borderRadius: "var(--app-radius-sm)" }}>
                      <p className="pg-footnote" style={{ margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.04em" }}>Supporting</p>
                      {pc.given.map((g, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
                          <span>{g.to}</span>
                          <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-secondary)" }}>{g.hours.toFixed(1)} hrs</span>
                        </div>
                      ))}
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0 0", marginTop: 4, borderTop: "1px solid var(--border-soft)", fontWeight: 600 }}>
                        <span>Total</span>
                        <span style={{ fontFamily: "var(--font-mono)" }}>{pc.away.toFixed(1)} hrs</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </div>
          {(() => {
            const filteredCount = people.filter((p) => peopleMap[p.name] && (!qRoster || p.name.toLowerCase().includes(qRoster.toLowerCase()))).length;
            return !showAllUtil && !qRoster && filteredCount > 3 && (
              <button className="pg-btn-ghost" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} onClick={() => setShowAllUtil(true)}>
                View all consultants <ChevronRight size={12} />
              </button>
            );
          })()}
          <p className="pg-footnote" style={{ maxWidth: 460 }}>Each bar is that consultant's own personal utilization — the hours she personally spends on her own clients plus whatever she gives away to support other consultants — against her own billable capacity, exactly the "(own time) X%" row in her Capacity Planning card above. Yellow = under-allocated, spare capacity available. Green = fully using her own billable hours — the target. Red = over-committed — she's promised more of her own time than she has, spilling into her non-billable hours. Roster details (role, state, billable %, resignation dates, ClickUp aliases) live in the Team module.</p>

          <div className="pg-cap-card" style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="pg-field__label">Reference &amp; notes log</span>
              <button className="pg-btn-ghost" onClick={() => setEditNotes((v) => !v)}>{editNotes ? <><Check size={11} /> done</> : <><Pencil size={11} /> edit</>}</button>
            </div>

            <div style={{ marginTop: 12 }}>
              <span className="pg-field__label">Public holidays in {MONTH_LABELS[month]}</span>
              {(() => {
                const STATE_NAMES = { SA: "South Australia", WA: "Western Australia", QLD: "Queensland" };
                const items = holidaysInMonthGrouped(month);
                if (items.length === 0) return <p style={{ fontFamily: "var(--font-body)", fontSize: 12.5, color: "var(--fg-secondary)", marginTop: 8 }}>No public holidays fall in {MONTH_LABELS[month]} for SA, WA, or QLD.</p>;
                return items.map((item) => {
                  const parts = Object.entries(item.states).map(([st, name]) => `${STATE_NAMES[st]} (${name})`);
                  const sentence = parts.length === 1
                    ? `${item.dayLabel} ${MONTH_LABELS[month].split(" ")[0]} is a public holiday in ${parts[0]}.`
                    : `${item.dayLabel} ${MONTH_LABELS[month].split(" ")[0]} is a public holiday in ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
                  return <p key={item.date} style={{ fontFamily: "var(--font-body)", fontSize: 12.5, color: "var(--fg-secondary)", marginTop: 8 }}>{sentence}</p>;
                });
              })()}
              <p className="pg-footnote" style={{ marginTop: 8 }}>Sourced from each state's official 2026 public holiday calendar. Christmas Eve/New Year's Eve part-day holidays and weekend-falling dates with no substitute aren't counted here since they don't affect a working day.</p>
            </div>

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px dashed var(--border-soft)" }}>
              <span className="pg-field__label">Added notes</span>
              {notes.length === 0 && <p style={{ fontFamily: "var(--font-body)", fontSize: 11.5, color: "var(--fg-tertiary)", marginTop: 8 }}>No notes added yet.</p>}
              {notes.map((n) => (
                <div key={n.id} className="pg-cap-note-row">
                  <div>
                    <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-secondary)" }}>{n.text}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-tertiary)", marginTop: 2 }}>{new Date(n.ts).toLocaleString()}</div>
                  </div>
                  {editNotes && <button className="pg-btn-ghost pg-icon-btn-sm" style={{ color: "var(--status-over)", padding: "4px 7px" }} onClick={() => removeNote(n.id)} aria-label={`Delete note: ${(n.text || "").slice(0, 40)}${(n.text || "").length > 40 ? "…" : ""}`}><X size={12} /></button>}
                </div>
              ))}
            </div>
          </div>

          <div className="pg-cap-card" style={{ marginTop: 14 }}>
            <span className="pg-field__label">Add a note</span>
            <textarea className="pg-cap-textarea" style={{ marginTop: 8 }} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="e.g. why a client is running over, staffing changes expected next month…" />
            <button className="pg-btn" style={{ marginTop: 8 }} onClick={addNote} disabled={!noteDraft.trim()}><Plus size={13} /> Add note</button>
          </div>
        </div>
      </div>

      <p className="pg-footnote">Purple Giraffe · Capacity Ledger · "Total Billable Allocation" = total team capacity + DMA hours · "Difference" = that total minus Total Demand</p>
    </div>
  );
}

export default function CapacityDashboard({ onNavigateTeam }) {
  return (
    <ErrorBoundary>
      <CapacityDashboardInner onNavigateTeam={onNavigateTeam} />
    </ErrorBoundary>
  );
}
