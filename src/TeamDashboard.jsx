import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, Plus, X, MoreVertical, AlertTriangle, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { SEED_PEOPLE, loadKey, MONTHS, CURRENT_MONTH, MONTH_LABELS, computeMonthlyAvailability } from "./capacityData.js";
import { normalizeName } from "./nameMatch.js";
import { loadState, saveState } from "./capacityStore.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { PersonAvatar, resizePhotoFile } from "./avatar.jsx";
import { useDismissable } from "./useDismissable.js";
import { LeaveEditor } from "./LeaveEditor.jsx";
import { CAP_PEOPLE_KEY, CAP_LEAVES_KEY, LEAVE_ENTRIES_KEY } from "./storageKeys.js";
import {
  fetchLeaveEntries, addLeaveEntry, updateLeaveEntry, deleteLeaveEntry, notifyLeaveEntriesChanged,
  entriesForPerson, totalLeaveHours, leaveTypeLabel,
} from "./leaveSync.js";

const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const ROLES = ["Consultant", "Coordinator"];
const STATES = ["SA", "WA", "QLD"];

function Picker({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button type="button" className="pg-select" style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <span>{current ? current.label : "Select…"}</span>
      </button>
      {open && (
        <div className="pg-menu" style={{ minWidth: 120 }}>
          {options.map((o) => (
            <button key={o.value} type="button" className="pg-menu-item" onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   PHOTO UPLOAD — click a person's avatar in edit mode to set/replace their
   photo, or clear it back to the initial-letter placeholder.
============================================================ */
function PhotoUpload({ name, photo, onChange }) {
  const inputRef = useRef(null);
  const [error, setError] = useState("");

  const pick = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    setError("");
    resizePhotoFile(file, (dataUrl) => onChange(dataUrl), (msg) => setError(msg));
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button
        type="button"
        onClick={() => inputRef.current && inputRef.current.click()}
        title="Set photo"
        style={{ border: 0, background: "none", padding: 0, cursor: "pointer", borderRadius: "50%" }}
      >
        <PersonAvatar name={name} photo={photo} size={30} />
      </button>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={pick} />
      {photo && (
        <button type="button" className="pg-btn-ghost" style={{ padding: "3px 5px" }} title="Remove photo" onClick={() => onChange("")}>
          <X size={11} />
        </button>
      )}
      {error && <span className="pg-footnote" style={{ color: "var(--status-over)" }}>{error}</span>}
    </div>
  );
}

/* ============================================================
   ROSTER MENU — per-person "⋮" popover for resignation date + ClickUp alias.
   Rendered via a portal into document.body with fixed positioning, same as
   Capacity Planning previously did, so it escapes any scrolling ancestor.
============================================================ */
function RosterMenu({ person, onUpdate, aliasConflict }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);

  const openMenu = () => {
    const r = btnRef.current.getBoundingClientRect();
    const menuWidth = 260;
    let left = r.right - menuWidth;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    const estMenuHeight = 260;
    if (top + estMenuHeight > window.innerHeight - 8) top = Math.max(8, r.top - estMenuHeight - 4);
    setPos({ top, left });
    setOpen(true);
  };

  const dismiss = useCallback(() => setOpen(false), []);
  const menuRef = useDismissable(dismiss, { extraRef: btnRef, onReposition: dismiss });

  return (
    <>
      <button ref={btnRef} type="button" className="pg-btn-ghost" style={{ padding: "4px 7px" }} onClick={() => (open ? setOpen(false) : openMenu())}>
        <MoreVertical size={13} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="pg-menu" style={{ position: "fixed", top: pos.top, left: pos.left, right: "auto", margin: 0, minWidth: 260, padding: 12, zIndex: 1000 }}>
          <div className="pg-field__label">Resignation date</div>
          <input
            className="pg-input" type="date" style={{ marginTop: 4, width: "100%" }}
            value={person.resignationDate || ""}
            onChange={(e) => onUpdate("resignationDate", e.target.value || null)}
          />
          {person.resignationDate && (
            <button className="pg-btn-ghost" style={{ marginTop: 6 }} onClick={() => onUpdate("resignationDate", null)}>
              <X size={11} /> Clear resignation date
            </button>
          )}

          <div className="pg-field__label" style={{ marginTop: 12 }}>ClickUp alias</div>
          <p className="pg-footnote" style={{ marginTop: 2, marginBottom: 4 }}>
            Only needed if their ClickUp username doesn't match "{person.name}", e.g. a full name ClickUp shows that this roster's short name can't fuzzy-match.
          </p>
          <input
            className="pg-input" type="text" style={{ width: "100%" }}
            placeholder="e.g. Kelly Wagner"
            value={person.alias || ""}
            onChange={(e) => onUpdate("alias", e.target.value)}
          />
          {aliasConflict && (
            <div className="pg-banner-warn" style={{ marginTop: 8, padding: "8px 10px", fontSize: 11 }}>
              <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              Also matched to {aliasConflict.join(", ")} — hours for this alias will be double-counted until only one person uses it.
            </div>
          )}

          <button className="pg-btn" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} onClick={() => setOpen(false)}>Done</button>
        </div>,
        document.body
      )}
    </>
  );
}

/* ============================================================
   ADD PERSON — small inline form shown under the roster table in edit mode
============================================================ */
function AddPersonForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", role: "Consultant", state: "SA", contracted: 38, rate: 0.7 });
  const set = (field) => (v) => setForm((f) => ({ ...f, [field]: v }));

  if (!open) {
    return (
      <button className="pg-btn-ghost" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        <Plus size={12} /> Add person
      </button>
    );
  }
  return (
    <div className="pg-cap-addform" style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="pg-input" style={{ width: 140 }} placeholder="Name" value={form.name} onChange={(e) => set("name")(e.target.value)} />
        <div style={{ width: 140 }}>
          <Picker value={form.role} options={[{ value: "Consultant", label: "Consultant" }, { value: "Coordinator", label: "Coordinator" }]} onChange={set("role")} />
        </div>
        <div style={{ width: 90 }}>
          <Picker value={form.state} options={[{ value: "SA", label: "SA" }, { value: "WA", label: "WA" }, { value: "QLD", label: "QLD" }]} onChange={set("state")} />
        </div>
        <input className="pg-input" type="number" step="any" style={{ width: 110 }} placeholder="Hrs/wk" value={form.contracted} onChange={(e) => set("contracted")(e.target.value)} />
        <input className="pg-input" type="number" min="0" max="100" step="1" style={{ width: 110 }} placeholder="Billable %" value={Math.round(form.rate * 100)} onChange={(e) => set("rate")((Number(e.target.value) || 0) / 100)} />
        <button className="pg-btn" onClick={() => { onAdd(form); setForm({ name: "", role: "Consultant", state: "SA", contracted: 38, rate: 0.7 }); setOpen(false); }} disabled={!form.name.trim()}>
          <Plus size={13} /> Add
        </button>
        <button className="pg-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("TeamDashboard error:", error, info); }
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

function TeamDashboardInner() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedFlashTimer = useRef(null);
  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    savedFlashTimer.current = setTimeout(() => setSavedFlash(false), 1800);
  }, []);
  const [people, setPeople] = useState(SEED_PEOPLE);
  const [editing, setEditing] = useState(false);
  const [qRoster, setQRoster] = useState("");
  const [month, setMonth] = useState(CURRENT_MONTH);
  const [leaves, setLeaves] = useState({}); // key: `${personId}_${month}` -> hours, shared with Capacity Planning's cap_leaves
  // cap_leaves load state. Until it has loaded once, `leaves` is a placeholder {} -- writing
  // it back would wipe every other person's/month's total, so writes are refused.
  const [leavesStatus, setLeavesStatus] = useState({ loaded: false, error: null });
  const leavesLoadedRef = useRef(false);
  const ownWrite = useRef(false); // suppress reloading our own save's echoed PG_DATA_EVENT
  const ownWriteLeaves = useRef(false);
  const leaveWriteChain = useRef(Promise.resolve()); // serialises cap_leaves read-modify-writes

  // Leaves are month-specific and stored as one cap_leaves map shared with Capacity
  // Planning (which now only displays it). Same PG_DATA_EVENT, so a leave entered here
  // updates Capacity Planning's numbers immediately.
  useEffect(() => {
    let cancelled = false;
    const load = () => loadKey(CAP_LEAVES_KEY, {}).then(
      (v) => { if (cancelled) return; setLeaves(v); leavesLoadedRef.current = true; setLeavesStatus({ loaded: true, error: null }); },
      (e) => { if (!cancelled) setLeavesStatus((st) => ({ ...st, error: e.message || String(e) })); },
    );
    load();
    const onUpdate = (e) => {
      if (e.detail && e.detail.key !== CAP_LEAVES_KEY) return;
      if (ownWriteLeaves.current) { ownWriteLeaves.current = false; return; }
      load();
    };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);
  const leaveFor = useCallback((personId) => Number(leaves[`${personId}_${month}`] ?? 0), [leaves, month]);
  // Writes ONE person+month total into cap_leaves. Refuses until cap_leaves has loaded,
  // and re-reads the stored map right before writing so only this key changes -- the
  // local copy may be stale (another tab, Capacity Planning) and must never be written
  // back wholesale. Resolves once saved; rejects (and reports) on failure.
  const setLeaveFor = useCallback((personId, hrs, monthKey = month) => {
    const run = async () => {
      if (!leavesLoadedRef.current) throw new Error("Leave totals haven't loaded, so nothing was saved. Reload and try again");
      const key = `${personId}_${monthKey}`;
      const value = hrs === "" ? 0 : Number(hrs);
      const fresh = await loadState(CAP_LEAVES_KEY, {});
      const next = { ...fresh, [key]: value };
      ownWriteLeaves.current = true;
      try {
        await saveState(CAP_LEAVES_KEY, next);
      } catch (e) {
        ownWriteLeaves.current = false;
        throw e;
      }
      setLeaves(next);
      flashSaved();
    };
    const p = leaveWriteChain.current.then(run, run);
    leaveWriteChain.current = p.catch(() => {});
    return p.catch((e) => {
      setSaveError(`Couldn't save leave hours: ${e.message || e}`);
      throw e;
    });
  }, [month, flashSaved]);

  // Typed leave entries (pginvoice_leave_entries) for the selected month, loaded once here
  // for every row rather than per LeaveEditor. cap_leaves stays the stored per-person
  // total (what Capacity Planning reads); after each typed add/update/delete we recompute
  // that person's total from their entries and write it via setLeaveFor.
  //
  // A failed load is kept as status "error" -- never treated as "no typed entries" --
  // so the editor goes read-only instead of offering to overwrite a real total.
  const [leaveEntries, setLeaveEntries] = useState({ month: null, status: "loading", entries: [], error: null });
  const leaveEntriesRef = useRef(leaveEntries); // latest value, for computing totals inside async handlers
  const leaveLoadSeq = useRef(0);
  const ownWriteLeaveEntries = useRef(false);
  const commitLeaveEntries = useCallback((value) => { leaveEntriesRef.current = value; setLeaveEntries(value); }, []);
  const loadLeaveEntries = useCallback((monthKey) => {
    const seq = ++leaveLoadSeq.current;
    if (leaveEntriesRef.current.month !== monthKey) commitLeaveEntries({ month: monthKey, status: "loading", entries: [], error: null });
    fetchLeaveEntries(monthKey).then(
      (entries) => { if (seq === leaveLoadSeq.current) commitLeaveEntries({ month: monthKey, status: "ready", entries, error: null }); },
      (e) => { if (seq === leaveLoadSeq.current) commitLeaveEntries({ month: monthKey, status: "error", entries: [], error: e.message || String(e) }); },
    );
  }, [commitLeaveEntries]);
  useEffect(() => {
    loadLeaveEntries(month);
    const onUpdate = (e) => {
      if (e.detail && e.detail.key !== LEAVE_ENTRIES_KEY) return;
      if (ownWriteLeaveEntries.current) return;
      loadLeaveEntries(month);
    };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { leaveLoadSeq.current++; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, [month, loadLeaveEntries]);

  // Runs one typed-leave write, folds its result into the loaded entries, then rewrites
  // the person's cap_leaves total from their typed entries. `apply(entries)` returns the
  // month's entries after the write succeeded. Errors propagate to the editor.
  const mutateLeave = useCallback(async (personId, monthKey, write, apply) => {
    const result = await write();
    const current = leaveEntriesRef.current;
    let monthEntries;
    if (current.month === monthKey && current.status === "ready") {
      monthEntries = apply(current.entries, result);
      leaveLoadSeq.current++; // an in-flight reload may predate this write -- drop it
      commitLeaveEntries({ ...current, entries: monthEntries });
    } else {
      // The user moved to another month mid-write -- get this month's truth from the server.
      monthEntries = await fetchLeaveEntries(monthKey);
    }
    await setLeaveFor(personId, totalLeaveHours(entriesForPerson(monthEntries, personId, monthKey)), monthKey);
    // Our own state is already up to date; just tell other modules (dispatch is synchronous).
    ownWriteLeaveEntries.current = true;
    try { notifyLeaveEntriesChanged(); } finally { ownWriteLeaveEntries.current = false; }
  }, [commitLeaveEntries, setLeaveFor]);

  // Every failure is also put in the page's saveError banner: the editor shows it inline
  // too, but that disappears when the popover closes.
  const reportLeave = useCallback((fn) => fn().catch((e) => {
    setSaveError(`Couldn't save leave: ${e?.message || e}`);
    throw e;
  }), []);
  const leaveHandlersFor = useCallback((personId) => ({
    onAdd: (fields) => reportLeave(() => mutateLeave(personId, month,
      () => addLeaveEntry({ ...fields, person_id: personId, month_key: month }),
      (entries, row) => [...entries, row])),
    onUpdate: (id, patch) => reportLeave(() => mutateLeave(personId, month,
      () => updateLeaveEntry(id, patch),
      (entries, row) => entries.map((e) => (e.id === id ? row : e)))),
    onDelete: (id) => reportLeave(() => mutateLeave(personId, month,
      () => deleteLeaveEntry(id),
      (entries) => entries.filter((e) => e.id !== id))),
    // Only offered for a legacy (untyped, no entries) total, on explicit confirmation.
    onDeleteLegacy: () => reportLeave(() => setLeaveFor(personId, 0)),
    // Only offered when typed entries exist and the stored total disagrees with them.
    onSyncTotal: (total) => reportLeave(() => setLeaveFor(personId, total)),
  }), [month, mutateLeave, setLeaveFor, reportLeave]);

  // Read-only ("error") until BOTH typed entries and the cap_leaves totals have loaded:
  // every typed edit rewrites the person's cap_leaves total.
  const typedStatus = () => {
    if (leavesStatus.error && !leavesStatus.loaded) return { status: "error", error: `Couldn't load leave totals: ${leavesStatus.error}` };
    if (leaveEntries.month !== month || leaveEntries.status === "loading" || !leavesStatus.loaded) return { status: "loading", error: null };
    if (leaveEntries.status === "error") return { status: "error", error: `Couldn't load leave types: ${leaveEntries.error}` };
    return { status: "ready", error: null };
  };
  const typedLeaveFor = (personId) => ({
    ...typedStatus(),
    entries: leaveEntries.month === month ? entriesForPerson(leaveEntries.entries, personId, month) : [],
    ...leaveHandlersFor(personId),
  });
  const leaveBreakdownTitle = (personId) => {
    if (leaveEntries.month !== month || leaveEntries.status !== "ready") return undefined;
    const mine = entriesForPerson(leaveEntries.entries, personId, month);
    if (!mine.length) return undefined;
    return mine.map((e) => `${leaveTypeLabel(e.leave_type)}: ${e.hours} h`).join("\n");
  };

  // Reads/writes the same "cap_people" key Capacity Planning uses (Supabase-backed via
  // capacityStore.js), so a person added, removed, or edited here is immediately reflected
  // there — and vice versa — via the shared PG_DATA_EVENT both modules listen for.
  useEffect(() => {
    let cancelled = false;
    const load = () => loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE).then((v) => { if (!cancelled) setPeople(v); });
    // `loaded` (which gates the save-effect below) is only set true on a confirmed
    // successful load -- a failed load leaves it false, so the save-effect never runs
    // and this component's still-SEED_PEOPLE in-memory state never gets written back
    // over real Supabase data (see capacityStore.js for why that matters).
    load().then(() => { if (!cancelled) setLoaded(true); }).catch((e) => { if (!cancelled) setLoadError(e.message || String(e)); });
    const onUpdate = (e) => {
      if (e.detail && e.detail.key !== CAP_PEOPLE_KEY) return;
      if (ownWrite.current) { ownWrite.current = false; return; }
      load().catch((e) => console.error("Couldn't reload people:", e));
    };
    window.addEventListener(PG_DATA_EVENT, onUpdate);
    return () => { cancelled = true; window.removeEventListener(PG_DATA_EVENT, onUpdate); };
  }, []);
  useEffect(() => {
    if (!loaded) return;
    ownWrite.current = true;
    saveState(CAP_PEOPLE_KEY, people).then(() => { setSaveError(null); flashSaved(); }).catch((e) => setSaveError(`Couldn't save: ${e.message || e}`));
  }, [people, loaded, flashSaved]);

  const updatePerson = useCallback((id, field, value) => {
    setPeople((ps) => ps.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  }, []);
  const removePerson = useCallback((id) => {
    setPeople((ps) => {
      const person = ps.find((p) => p.id === id);
      if (!window.confirm(`Remove ${person?.name || "this person"} from the roster? This cannot be undone.`)) return ps;
      return ps.filter((p) => p.id !== id);
    });
  }, []);
  const addPerson = useCallback((form) => {
    const name = (form.name || "").trim();
    if (!name) return;
    setPeople((ps) => [...ps, {
      id: uid("p"), name, role: form.role || "Consultant", state: form.state || "SA",
      contracted: Number(form.contracted) || 0, rate: Number(form.rate) || 0,
      note: "", resignationDate: null, alias: "", photo: "",
    }]);
  }, []);

  // A person's alias identifies who owns a ClickUp username for downstream matching — if
  // two people end up sharing an alias, or someone's alias collides with another person's
  // own name, that ClickUp user's hours would silently get attributed to (and thus
  // double-counted for) more than one person. Detect that here for the per-row menu and banner.
  const aliasConflicts = useMemo(() => {
    const owners = new Map();
    people.forEach((p) => {
      const keys = new Set([normalizeName(p.name)]);
      if (p.alias && p.alias.trim()) keys.add(normalizeName(p.alias));
      keys.forEach((k) => {
        if (!k) return;
        if (!owners.has(k)) owners.set(k, []);
        owners.get(k).push(p);
      });
    });
    const conflicts = new Map();
    owners.forEach((owningPeople) => {
      if (owningPeople.length < 2) return;
      owningPeople.forEach((p) => {
        const others = owningPeople.filter((o) => o.id !== p.id).map((o) => o.name);
        if (others.length) conflicts.set(p.id, [...(conflicts.get(p.id) || []), ...others]);
      });
    });
    return conflicts;
  }, [people]);

  const visiblePeople = people.filter((p) => !qRoster || p.name.toLowerCase().includes(qRoster.toLowerCase()));

  // One row per roster entry, carrying that person's capacity/hours for the currently
  // selected month — computed via computeMonthlyAvailability, the exact same function
  // Capacity Planning's peopleMap calls, so the numbers here and there never drift.
  // Unlike the old separate Availability table, this doesn't drop anyone who isn't
  // active this month (resigned earlier, etc) — they still need to be editable — it
  // just shows "—" for their hours instead of a row.
  const rows = useMemo(() => {
    return visiblePeople.map((p) => {
      const leaveHrs = Number(leaves[`${p.id}_${month}`] ?? 0);
      return { person: p, avail: computeMonthlyAvailability(p, month, leaveHrs) };
    });
  }, [visiblePeople, leaves, month]);

  const monthIdx = MONTHS.indexOf(month);
  const shiftMonth = (d) => setMonth(MONTHS[Math.max(0, Math.min(MONTHS.length - 1, monthIdx + d))]);

  if (loadError) {
    return (
      <div className="pg-cap-container">
        <div className="pg-empty" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <p>Couldn't load the team roster: {loadError}</p>
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
          <h1 className="pg-app-header__title">Team — the roster that drives Capacity Planning &amp; Performance.</h1>
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

      {aliasConflicts.size > 0 && (
        <div className="pg-banner-warn" style={{ marginTop: 14 }}>
          {[...aliasConflicts.entries()].map(([id, others]) => {
            const p = people.find((pp) => pp.id === id);
            if (!p) return null;
            return <div key={id}>{p.name}'s name/alias is shared with {others.join(", ")} — their ClickUp hours will be double-counted until this is fixed.</div>;
          })}
        </div>
      )}

      <div className="pg-table-wrap" style={{ marginTop: 14 }}>
        <div className="pg-table-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>Team roster</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ position: "relative" }}>
              <Search size={11} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--fg-tertiary)" }} />
              <input
                className="pg-input"
                style={{ width: 160, padding: "5px 8px 5px 24px", fontSize: 12 }}
                placeholder="Search consultant…"
                value={qRoster}
                onChange={(e) => setQRoster(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button className="pg-btn-ghost" style={{ padding: "5px 8px" }} onClick={() => shiftMonth(-1)} disabled={monthIdx === 0}><ChevronLeft size={12} /></button>
              <span style={{ fontFamily: "var(--font-display)", fontSize: 14, minWidth: 60, textAlign: "center" }}>{MONTH_LABELS[month]}</span>
              <button className="pg-btn-ghost" style={{ padding: "5px 8px" }} onClick={() => shiftMonth(1)} disabled={monthIdx === MONTHS.length - 1}><ChevronRight size={12} /></button>
            </div>
            <button className="pg-btn-ghost" onClick={() => setEditing((v) => !v)}>{editing ? <><Check size={11} /> done</> : <><Pencil size={11} /> edit</>}</button>
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
        <table className="pg-table" style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>Name</th><th>Role</th><th>State</th>
              <th className="right num">Contracted Hrs/wk</th>
              <th className="right num">Billable %</th>
              <th className="right num">Leave Hrs ({MONTH_LABELS[month]})</th>
              <th className="right num">Monthly Hrs</th>
              <th className="right num">Billable Hrs</th>
              <th className="right num">Non-billable Hrs</th>
              <th>Note</th>
              {editing && <th></th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={editing ? 11 : 10} className="empty">No consultants match this search.</td></tr>}
            {rows.map(({ person: p, avail }) => (
              <tr key={p.id}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {editing
                      ? <PhotoUpload name={p.name} photo={p.photo} onChange={(dataUrl) => updatePerson(p.id, "photo", dataUrl)} />
                      : <PersonAvatar name={p.name} photo={p.photo} size={26} />}
                    {editing
                      ? <input className="pg-input" style={{ width: 120, padding: "4px 6px" }} value={p.name} onChange={(e) => updatePerson(p.id, "name", e.target.value)} />
                      : <span>{p.name} {p.resignationDate && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 5 }}>[resigns {p.resignationDate}]</span>} {p.alias && <span className="pg-tag pg-tag--muted" style={{ marginLeft: 5 }}>[alias: {p.alias}]</span>}</span>}
                  </div>
                </td>
                <td>
                  {editing ? (
                    <select className="pg-select" value={p.role} onChange={(e) => updatePerson(p.id, "role", e.target.value)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className="pg-tag" style={{ color: p.role === "Consultant" ? "var(--accent)" : "var(--accent-orchid)" }}>{p.role}</span>
                  )}
                </td>
                <td>
                  {editing ? (
                    <select className="pg-select" value={p.state} onChange={(e) => updatePerson(p.id, "state", e.target.value)}>
                      {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : p.state}
                </td>
                <td className="right num">
                  {editing
                    ? <input className="pg-input" type="number" min="0" step="any" style={{ width: 64, padding: "4px 6px" }} value={p.contracted} onChange={(e) => updatePerson(p.id, "contracted", e.target.value === "" ? 0 : Number(e.target.value))} />
                    : p.contracted}
                </td>
                <td className="right num">
                  {editing
                    ? <input className="pg-input" type="number" min="0" max="100" step="1" style={{ width: 52, padding: "4px 6px" }} value={Math.round(p.rate * 100)} onChange={(e) => updatePerson(p.id, "rate", (e.target.value === "" ? 0 : Number(e.target.value)) / 100)} />
                    : `${(p.rate * 100).toFixed(0)}%`}
                </td>
                <td className="right num">
                  {editing
                    ? <LeaveEditor person={p} hours={leaveFor(p.id)} typed={typedLeaveFor(p.id)} />
                    : <span title={leaveBreakdownTitle(p.id)}>{leaveFor(p.id)} h</span>}
                </td>
                <td className="right num">{avail ? avail.totalMonthlyHours.toFixed(1) : "—"}</td>
                <td className="right num">{avail ? <b>{avail.billableHours.toFixed(1)}</b> : "—"}</td>
                <td className="right num">{avail ? avail.nonBillableHours.toFixed(1) : "—"}</td>
                <td>
                  {editing
                    ? <input className="pg-input" style={{ width: 200, padding: "4px 6px" }} value={p.note || ""} onChange={(e) => updatePerson(p.id, "note", e.target.value)} />
                    : <span style={{ color: "var(--fg-tertiary)", fontSize: 12 }}>{p.note}</span>}
                </td>
                {editing && (
                  <td style={{ display: "flex", gap: 4 }}>
                    <RosterMenu person={p} onUpdate={(field, value) => updatePerson(p.id, field, value)} aliasConflict={aliasConflicts.get(p.id)} />
                    <button className="pg-btn-ghost pg-icon-btn-sm pg-icon-btn-sm--tight" style={{ color: "var(--status-over)", padding: "4px 7px" }} onClick={() => removePerson(p.id)} aria-label={`Remove ${p.name || "this person"} from roster`}><X size={12} /></button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      {editing && <AddPersonForm onAdd={addPerson} />}
      <p className="pg-footnote">This roster is the shared source of truth for Capacity Planning and Performance — changes here take effect immediately in both. Leaves and Monthly/Billable/Non-billable Hrs are all specific to {MONTH_LABELS[month]} (use the arrows above to move to other months, including future ones) — Monthly Hrs already has that month's Leaves subtracted before it's split into Billable/Non-billable by billable %, and editing Leaves here updates Capacity Planning's numbers immediately too, since both read and write the same shared record. Shown as "—" for months a person wasn't active in. A resignation date set via the ⋮ menu prorates that month's capacity to their last working day, and drops them from later months.</p>
    </div>
  );
}

export default function TeamDashboard() {
  return (
    <ErrorBoundary>
      <TeamDashboardInner />
    </ErrorBoundary>
  );
}
