import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, X, AlertTriangle } from "lucide-react";
import { useDismissable } from "./useDismissable.js";
import { SELECTABLE_LEAVE_TYPES, leaveTypeLabel, totalLeaveHours, deriveLeaveRows } from "./leaveSync.js";

// Rounds for display only, to avoid floating-point round-trip jitter (e.g. 38/5 = 7.6)
// making the Days/Hrs fields visually disagree with each other.
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
// "" -> 0, garbage -> NaN (caller decides what to do with NaN).
const parseNum = (v) => (v === "" ? 0 : Number(v));

/* ============================================================
   LEAVE EDITOR — Days/Hrs popover for a person's leave in one month.

   Two modes:
   - Typed (pass `typed`, used by the Consultants module): lists the person's
     typed leave entries (pginvoice_leave_entries) with type / days / hrs, an
     "+ Add leave" row, and the total. The caller persists each change and
     re-derives the cap_leaves total from the entries.
   - Simple (no `typed`, used by Capacity Planning): the original single hours
     number, passed back via onChange.
============================================================ */
export function LeaveEditor({ person, hours, onChange, typed }) {
  const dailyHrs = person && person.contracted ? person.contracted / 5 : 0;
  const menuWidth = typed ? 380 : 240;

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);

  const openMenu = () => {
    const r = btnRef.current.getBoundingClientRect();
    let left = r.right - menuWidth;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    const estMenuHeight = typed ? 320 : 170;
    if (top + estMenuHeight > window.innerHeight - 8) top = Math.max(8, r.top - estMenuHeight - 4);
    setPos({ top, left });
    setOpen(true);
  };

  const dismiss = useCallback(() => setOpen(false), []);
  const menuRef = useDismissable(dismiss, { extraRef: btnRef, onReposition: dismiss });

  const label = hours ? `${round1(hours)} h` : "—";

  return (
    <>
      <button
        ref={btnRef} type="button" className="pg-btn-ghost" style={{ padding: "2px 7px", fontSize: 11 }}
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openMenu(); }}
        title={`Total hours of leave taken this month, not a day count -- a full day off for ${person.name} is ${round1(dailyHrs)} hrs.`}
        aria-haspopup="dialog" aria-expanded={open}
      >
        {label}
      </button>
      {open && createPortal(
        <div
          ref={menuRef} className="pg-menu" role="dialog" aria-label={`Leave for ${person.name}`}
          style={{ position: "fixed", top: pos.top, left: pos.left, right: "auto", margin: 0, minWidth: menuWidth, maxWidth: menuWidth, padding: 12, zIndex: 1000 }}
        >
          {typed
            ? <TypedLeaveBody person={person} hours={hours} dailyHrs={dailyHrs} typed={typed} />
            : <SimpleLeaveBody person={person} hours={hours} dailyHrs={dailyHrs} onChange={onChange} />}
          <button className="pg-btn" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} onClick={() => setOpen(false)}>Done</button>
        </div>,
        document.body
      )}
    </>
  );
}

function DailyHoursNote({ person, dailyHrs }) {
  return (
    <p className="pg-footnote" style={{ marginTop: 8, marginBottom: 0, paddingBottom: 0 }}>
      {dailyHrs
        ? `1 day off ≈ ${round1(dailyHrs)} hrs for ${person.name}, based on their ${person.contracted} hrs/week.`
        : `${person.name} has no contracted hours/week set, so days can't be converted -- enter hours directly.`}
    </p>
  );
}

/* ---------- Simple mode: one hours number (Capacity Planning) ---------- */
function SimpleLeaveBody({ person, hours, dailyHrs, onChange }) {
  const hoursForDays = (days) => days * dailyHrs;
  const daysForHours = (hrs) => (dailyHrs ? hrs / dailyHrs : 0);

  const [daysStr, setDaysStr] = useState(String(round1(daysForHours(hours))));
  const [hrsStr, setHrsStr] = useState(String(round1(hours)));

  // `hours` prop is always the source of truth (the stored number) -- if it changes
  // externally (e.g. another module/tab updates cap_leaves and it echoes back via
  // PG_DATA_EVENT), resync local fields rather than holding a stale copy.
  useEffect(() => {
    setDaysStr(String(round1(daysForHours(hours))));
    setHrsStr(String(round1(hours)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours, dailyHrs]);

  const onDaysChange = (v) => {
    setDaysStr(v);
    const days = parseNum(v);
    if (Number.isNaN(days)) return;
    const newHours = round1(hoursForDays(days));
    setHrsStr(String(newHours));
    onChange(newHours);
  };

  const onHrsChange = (v) => {
    setHrsStr(v);
    const hrs = parseNum(v);
    if (Number.isNaN(hrs)) return;
    setDaysStr(String(round1(daysForHours(hrs))));
    onChange(hrs);
  };

  return (
    <>
      <div className="pg-field__label">Leave this month</div>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <label style={{ flex: 1 }}>
          <div className="pg-footnote" style={{ margin: "0 0 2px", padding: 0 }}>Days</div>
          <input
            className="pg-input" type="number" min="0" step="0.5" style={{ width: "100%" }}
            value={daysStr} disabled={!dailyHrs}
            onChange={(e) => onDaysChange(e.target.value)}
          />
        </label>
        <label style={{ flex: 1 }}>
          <div className="pg-footnote" style={{ margin: "0 0 2px", padding: 0 }}>Hrs</div>
          <input
            className="pg-input" type="number" min="0" step="any" style={{ width: "100%" }}
            value={hrsStr}
            onChange={(e) => onHrsChange(e.target.value)}
          />
        </label>
      </div>
      <DailyHoursNote person={person} dailyHrs={dailyHrs} />
    </>
  );
}

/* ---------- Typed mode (Consultants) ---------- */

const GRID = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 58px 64px 26px", gap: 6, alignItems: "center" };
const CELL_INPUT = { width: "100%", padding: "4px 6px", fontSize: 12 };

// `typed`: { status: 'loading'|'ready'|'error', error, entries (this person + month),
//            onAdd(fields), onUpdate(id, patch), onDelete(id), onDeleteLegacy(), onSyncTotal(total) }
// Each handler returns a promise; a rejection is shown inline here.
function TypedLeaveBody({ person, hours, dailyHrs, typed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e?.message || String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (typed.status === "loading") {
    return (
      <>
        <div className="pg-field__label">Leave this month</div>
        <p className="pg-footnote" style={{ margin: "6px 0 0", padding: 0 }}>Loading leave entries…</p>
      </>
    );
  }

  if (typed.status === "error") {
    // Typed entries couldn't be loaded, so we can't know whether the stored total is
    // typed or legacy -- show it read-only and write nothing.
    return (
      <>
        <div className="pg-field__label">Leave this month</div>
        <div className="pg-banner-warn" role="alert" style={{ marginTop: 6, padding: "8px 10px", fontSize: 11 }}>
          <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          Couldn't load leave types: {typed.error}. Leave is read-only until this loads.
        </div>
        <label style={{ display: "block", marginTop: 8 }}>
          <div className="pg-footnote" style={{ margin: "0 0 2px", padding: 0 }}>Total hrs (saved)</div>
          <input className="pg-input" type="number" style={CELL_INPUT} value={round2(hours)} disabled readOnly />
        </label>
      </>
    );
  }

  const rows = deriveLeaveRows(typed.entries, hours);
  const hasLegacy = rows.some((r) => r.legacy);
  const typedTotal = totalLeaveHours(typed.entries);
  const shownTotal = hasLegacy ? round2(hours) : typedTotal;
  // Typed entries exist but the saved total disagrees (e.g. edited as a bare number in
  // Capacity Planning). Don't silently overwrite either way -- surface it.
  const totalMismatch = !hasLegacy && typed.entries.length > 0 && Math.abs(typedTotal - Number(hours ?? 0)) > 0.005;

  return (
    <>
      <div className="pg-field__label">Leave this month</div>

      {rows.length > 0 && (
        <div style={{ ...GRID, marginTop: 6 }} aria-hidden="true">
          <span className="pg-footnote" style={{ margin: 0, padding: 0 }}>Type</span>
          <span className="pg-footnote" style={{ margin: 0, padding: 0 }}>Days</span>
          <span className="pg-footnote" style={{ margin: 0, padding: 0 }}>Hrs</span>
          <span />
        </div>
      )}

      {rows.map((row) => (
        <LeaveEntryRow
          key={row.id || "legacy"} row={row} person={person} dailyHrs={dailyHrs} disabled={busy}
          onCommit={(patch) => run(() => (row.legacy
            ? typed.onAdd({ leave_type: patch.leave_type, hours: row.hours, days: null })
            : typed.onUpdate(row.id, patch)))}
          onDelete={() => {
            if (row.legacy) {
              if (!window.confirm(`Clear ${person.name}'s ${round2(row.hours)} h of untyped leave this month?`)) return;
              run(() => typed.onDeleteLegacy());
            } else {
              run(() => typed.onDelete(row.id));
            }
          }}
        />
      ))}

      {hasLegacy && (
        <p className="pg-footnote" style={{ margin: "4px 0 0", padding: 0, color: "var(--status-warn)" }}>
          Set a type for these hours — they were entered before leave types existed.
        </p>
      )}

      <AddLeaveRow person={person} dailyHrs={dailyHrs} disabled={busy || hasLegacy} onAdd={(fields) => run(() => typed.onAdd(fields))} />
      {hasLegacy && (
        <p className="pg-footnote" style={{ margin: "2px 0 0", padding: 0 }}>Type the untyped hours above before adding more leave.</p>
      )}

      {error && (
        <div className="pg-banner-warn" role="alert" style={{ marginTop: 8, padding: "8px 10px", fontSize: 11 }}>
          <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          Couldn't save leave: {error}
        </div>
      )}

      {totalMismatch && (
        <div className="pg-banner-warn" style={{ marginTop: 8, padding: "8px 10px", fontSize: 11 }}>
          <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
          The saved total ({round2(hours)} h) differs from these entries ({typedTotal} h) — it may have been edited in Capacity Planning.
          <button type="button" className="pg-btn-ghost" style={{ marginTop: 6, padding: "3px 7px", fontSize: 11 }} disabled={busy} onClick={() => run(() => typed.onSyncTotal(typedTotal))}>
            Set total to {typedTotal} h
          </button>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border-subtle)", fontSize: 12 }}>
        <span className="pg-field__label" style={{ margin: 0 }}>Total</span>
        <b className="num">
          {shownTotal} h{dailyHrs ? <span style={{ fontWeight: 400, color: "var(--fg-tertiary)" }}> · {round1(shownTotal / dailyHrs)} d</span> : null}
        </b>
      </div>

      <DailyHoursNote person={person} dailyHrs={dailyHrs} />
      <p className="pg-footnote" style={{ marginTop: 2, marginBottom: 0, paddingBottom: 0 }}>Public holidays are added automatically.</p>
    </>
  );
}

// Days input value for an entry: as entered if stored, otherwise derived from hours.
function daysStrFor(row, dailyHrs) {
  if (row.days != null) return String(round2(row.days));
  return dailyHrs ? String(round2(row.hours / dailyHrs)) : "";
}

function LeaveEntryRow({ row, person, dailyHrs, disabled, onCommit, onDelete }) {
  const [daysStr, setDaysStr] = useState(daysStrFor(row, dailyHrs));
  const [hrsStr, setHrsStr] = useState(String(round2(row.hours)));
  const lastEdited = useRef(null); // "days" | "hours" -- which field the user typed into

  // The stored row is the source of truth; resync after a save or an external reload.
  useEffect(() => {
    setDaysStr(daysStrFor(row, dailyHrs));
    setHrsStr(String(round2(row.hours)));
    lastEdited.current = null;
  }, [row.hours, row.days, dailyHrs]);

  const onDaysChange = (v) => {
    setDaysStr(v);
    lastEdited.current = "days";
    const d = parseNum(v);
    if (!Number.isNaN(d)) setHrsStr(String(round2(d * dailyHrs)));
  };
  const onHrsChange = (v) => {
    setHrsStr(v);
    lastEdited.current = "hours";
    const h = parseNum(v);
    if (!Number.isNaN(h)) setDaysStr(dailyHrs ? String(round2(h / dailyHrs)) : "");
  };

  // Commit on blur/Enter rather than per keystroke -- each commit is a DB write.
  const commit = () => {
    const which = lastEdited.current;
    if (!which || row.legacy) return;
    lastEdited.current = null;
    if (which === "days") {
      const d = parseNum(daysStr);
      if (Number.isNaN(d) || d < 0) { setDaysStr(daysStrFor(row, dailyHrs)); setHrsStr(String(round2(row.hours))); return; }
      const h = round2(d * dailyHrs);
      if (h === round2(row.hours) && round2(d) === (row.days == null ? null : round2(row.days))) return;
      onCommit({ days: d, hours: h });
    } else {
      const h = parseNum(hrsStr);
      if (Number.isNaN(h) || h < 0) { setDaysStr(daysStrFor(row, dailyHrs)); setHrsStr(String(round2(row.hours))); return; }
      if (round2(h) === round2(row.hours)) return;
      // Hours entered directly: there's no "as entered" day count to keep.
      onCommit({ hours: h, days: null });
    }
  };
  const onKeyDown = (e) => { if (e.key === "Enter") e.currentTarget.blur(); };

  const typeName = leaveTypeLabel(row.leave_type);
  return (
    <div style={{ ...GRID, marginTop: 4 }}>
      <select
        className="pg-select" style={CELL_INPUT} value={row.leave_type} disabled={disabled}
        aria-label={row.legacy ? `Set a type for ${person.name}'s untyped leave` : `Leave type (${typeName})`}
        onChange={(e) => { if (e.target.value !== row.leave_type) onCommit({ leave_type: e.target.value }); }}
      >
        {row.leave_type === "unspecified" && <option value="unspecified" disabled>{row.legacy ? "Set a type…" : leaveTypeLabel("unspecified")}</option>}
        {SELECTABLE_LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      <input
        className="pg-input" type="number" min="0" step="0.5" style={CELL_INPUT}
        aria-label={`${typeName} days`} value={daysStr} disabled={disabled || row.legacy || !dailyHrs}
        onChange={(e) => onDaysChange(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      />
      <input
        className="pg-input" type="number" min="0" step="any" style={CELL_INPUT}
        aria-label={`${typeName} hours`} value={hrsStr} disabled={disabled || row.legacy}
        onChange={(e) => onHrsChange(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      />
      <button
        type="button" className="pg-btn-ghost" style={{ padding: "4px 6px", color: "var(--status-over)" }}
        disabled={disabled} onClick={onDelete} aria-label={`Delete ${typeName} entry`} title="Delete"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function AddLeaveRow({ person, dailyHrs, disabled, onAdd }) {
  const [type, setType] = useState("annual");
  const [daysStr, setDaysStr] = useState("");
  const [hrsStr, setHrsStr] = useState("");
  const [enteredDays, setEnteredDays] = useState(false);

  const onDaysChange = (v) => {
    setDaysStr(v);
    setEnteredDays(true);
    const d = Number(v);
    setHrsStr(v === "" || Number.isNaN(d) ? "" : String(round2(d * dailyHrs)));
  };
  const onHrsChange = (v) => {
    setHrsStr(v);
    setEnteredDays(false);
    const h = Number(v);
    setDaysStr(v === "" || Number.isNaN(h) || !dailyHrs ? "" : String(round2(h / dailyHrs)));
  };

  const hrs = Number(hrsStr);
  const canAdd = !disabled && hrsStr !== "" && !Number.isNaN(hrs) && hrs > 0;

  const submit = async () => {
    if (!canAdd) return;
    const ok = await onAdd({ leave_type: type, hours: round2(hrs), days: enteredDays ? Number(daysStr) : null });
    if (!ok) return; // keep what they typed so they can retry
    setDaysStr("");
    setHrsStr("");
    setEnteredDays(false);
  };
  const onKeyDown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="pg-footnote" style={{ margin: "0 0 2px", padding: 0 }} id={`add-leave-${person.id}`}>Add leave</div>
      <div style={GRID} role="group" aria-labelledby={`add-leave-${person.id}`}>
        <select className="pg-select" style={CELL_INPUT} value={type} disabled={disabled} aria-label="New leave type" onChange={(e) => setType(e.target.value)}>
          {SELECTABLE_LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <input
          className="pg-input" type="number" min="0" step="0.5" style={CELL_INPUT} placeholder="Days"
          aria-label="New leave days" value={daysStr} disabled={disabled || !dailyHrs}
          onChange={(e) => onDaysChange(e.target.value)} onKeyDown={onKeyDown}
        />
        <input
          className="pg-input" type="number" min="0" step="any" style={CELL_INPUT} placeholder="Hrs"
          aria-label="New leave hours" value={hrsStr} disabled={disabled}
          onChange={(e) => onHrsChange(e.target.value)} onKeyDown={onKeyDown}
        />
        <button type="button" className="pg-btn-ghost" style={{ padding: "4px 6px" }} disabled={!canAdd} onClick={submit} aria-label="Add leave" title="Add leave">
          <Plus size={11} />
        </button>
      </div>
    </div>
  );
}
