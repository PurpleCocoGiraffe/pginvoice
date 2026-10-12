import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, X, AlertTriangle } from "lucide-react";
import { useDismissable } from "./useDismissable.js";
import { SELECTABLE_LEAVE_TYPES, leaveTypeLabel, totalLeaveHours, deriveLeaveRows, leaveDayHours } from "./leaveSync.js";
import { round2 } from "./wagesCalc.js";

// Rounds for display only, to avoid floating-point round-trip jitter making the Days/Hrs
// fields visually disagree with each other.
const round1 = (n) => Math.round(n * 10) / 10;
// "" -> 0, garbage -> NaN (caller decides what to do with NaN).
const parseNum = (v) => (v === "" ? 0 : Number(v));

const MENU_WIDTH = 380;
const EST_MENU_HEIGHT = 320;

/* ============================================================
   LEAVE EDITOR — typed-leave popover for one person in one month (Consultants).

   Lists the person's typed leave entries (pginvoice_leave_entries) with type / days /
   hrs, an "+ Add leave" row, and the total. The caller (TeamDashboard) persists each
   change and re-derives the person's cap_leaves total from the entries; Capacity
   Planning only displays that total.
============================================================ */
export function LeaveEditor({ person, hours, typed }) {
  const dailyHrs = leaveDayHours(person);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);

  const openMenu = () => {
    const r = btnRef.current.getBoundingClientRect();
    let left = r.right - MENU_WIDTH;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    if (top + EST_MENU_HEIGHT > window.innerHeight - 8) top = Math.max(8, r.top - EST_MENU_HEIGHT - 4);
    setPos({ top, left });
    setOpen(true);
  };

  const dismiss = useCallback(() => setOpen(false), []);
  const menuRef = useDismissable(dismiss, { extraRef: btnRef, onReposition: dismiss });

  // Keyboard users land on the first field when the popover opens (and again once the
  // entries finish loading, if focus is still on the Done button).
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const active = document.activeElement;
    if (menuRef.current.contains(active) && active.tagName !== "BUTTON") return;
    const first = menuRef.current.querySelector("select:not([disabled]), input:not([disabled])") || menuRef.current.querySelector("button:not([disabled])");
    first?.focus();
  }, [open, typed.status, menuRef]);

  const label = hours ? `${round1(hours)} h` : "—";

  return (
    <>
      <button
        ref={btnRef} type="button" className="pg-btn-ghost" style={{ padding: "2px 7px", fontSize: 11 }}
        onClick={(e) => { e.stopPropagation(); open ? setOpen(false) : openMenu(); }}
        title={`Total hours of leave taken this month for ${person.name}, not a day count.`}
        aria-haspopup="dialog" aria-expanded={open}
      >
        {label}
      </button>
      {open && createPortal(
        <div
          ref={menuRef} className="pg-menu pg-leave-popover" role="dialog" aria-label={`Leave for ${person.name}`}
          style={{ position: "fixed", top: pos.top, left: pos.left, right: "auto", margin: 0, minWidth: MENU_WIDTH, maxWidth: MENU_WIDTH, zIndex: 1000 }}
        >
          <TypedLeaveBody person={person} hours={hours} dailyHrs={dailyHrs} typed={typed} />
          <button className="pg-btn" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} onClick={() => { setOpen(false); btnRef.current?.focus(); }}>Done</button>
        </div>,
        document.body
      )}
    </>
  );
}

function DailyHoursNote({ person, dailyHrs }) {
  return (
    <p className="pg-footnote pg-leave-text pg-leave-text--spaced">
      {dailyHrs
        ? `1 day off = ${round1(dailyHrs)} hrs for ${person.name} (full-time, ${person.contracted} hrs/week).`
        : "Enter hours — days vary for part-time/casual staff."}
    </p>
  );
}

/* ---------- body ---------- */

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
        <p className="pg-footnote pg-leave-text pg-leave-text--spaced">Loading leave entries…</p>
      </>
    );
  }

  if (typed.status === "error") {
    // Typed entries (or the cap_leaves totals) couldn't be loaded, so we can't know whether
    // the stored total is typed or legacy, or safely rewrite it -- show it read-only.
    return (
      <>
        <div className="pg-field__label">Leave this month</div>
        <div className="pg-banner-warn pg-leave-alert" role="alert">
          <AlertTriangle size={11} aria-hidden="true" />
          {typed.error}. Leave is read-only until this loads.
        </div>
        <label style={{ display: "block", marginTop: 8 }}>
          <div className="pg-footnote pg-leave-text">Total hrs (saved)</div>
          <input className="pg-input pg-leave-input" type="number" value={round2(hours)} disabled readOnly />
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
        <div className="pg-leave-grid" style={{ marginTop: 6 }} aria-hidden="true">
          <span className="pg-footnote pg-leave-text">Type</span>
          <span className="pg-footnote pg-leave-text">Days</span>
          <span className="pg-footnote pg-leave-text">Hrs</span>
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
        <p className="pg-footnote pg-leave-text" style={{ marginTop: 4, color: "var(--status-warn)" }}>
          Set a type for these hours — they were entered before leave types existed.
        </p>
      )}

      <AddLeaveRow person={person} dailyHrs={dailyHrs} disabled={busy || hasLegacy} onAdd={(fields) => run(() => typed.onAdd(fields))} />
      {hasLegacy && (
        <p className="pg-footnote pg-leave-text" style={{ marginTop: 2 }}>Type the untyped hours above before adding more leave.</p>
      )}

      {error && (
        <div className="pg-banner-warn pg-leave-alert" role="alert">
          <AlertTriangle size={11} aria-hidden="true" />
          Couldn't save leave: {error}
        </div>
      )}

      {totalMismatch && (
        <div className="pg-banner-warn pg-leave-alert">
          <AlertTriangle size={11} aria-hidden="true" />
          The saved total ({round2(hours)} h) differs from these entries ({typedTotal} h) — it may have been edited in Capacity Planning.
          <button type="button" className="pg-btn-ghost" style={{ marginTop: 6, padding: "3px 7px", fontSize: 11 }} disabled={busy} onClick={() => run(() => typed.onSyncTotal(typedTotal))}>
            Set total to {typedTotal} h
          </button>
        </div>
      )}

      <div className="pg-leave-total">
        <span className="pg-field__label" style={{ margin: 0 }}>Total</span>
        <b className="num">
          {shownTotal} h{dailyHrs ? <span className="pg-leave-total__days"> · {round1(shownTotal / dailyHrs)} d</span> : null}
        </b>
      </div>

      <DailyHoursNote person={person} dailyHrs={dailyHrs} />
      <p className="pg-footnote pg-leave-text" style={{ marginTop: 2 }}>Public holidays are added automatically.</p>
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
    <div className="pg-leave-grid" style={{ marginTop: 4 }}>
      <select
        className="pg-select pg-leave-input" value={row.leave_type} disabled={disabled}
        aria-label={row.legacy ? `Set a type for ${person.name}'s untyped leave` : `Leave type (${typeName})`}
        onChange={(e) => { if (e.target.value !== row.leave_type) onCommit({ leave_type: e.target.value }); }}
      >
        {row.leave_type === "unspecified" && <option value="unspecified" disabled>{row.legacy ? "Set a type…" : leaveTypeLabel("unspecified")}</option>}
        {SELECTABLE_LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      <input
        className="pg-input pg-leave-input" type="number" min="0" step="0.5"
        aria-label={`${typeName} days`} value={daysStr} disabled={disabled || row.legacy || !dailyHrs}
        onChange={(e) => onDaysChange(e.target.value)} onBlur={commit} onKeyDown={onKeyDown}
      />
      <input
        className="pg-input pg-leave-input" type="number" min="0" step="any"
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
      <div className="pg-footnote pg-leave-text" style={{ marginBottom: 2 }} id={`add-leave-${person.id}`}>Add leave</div>
      <div className="pg-leave-grid" role="group" aria-labelledby={`add-leave-${person.id}`}>
        <select className="pg-select pg-leave-input" value={type} disabled={disabled} aria-label="New leave type" onChange={(e) => setType(e.target.value)}>
          {SELECTABLE_LEAVE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <input
          className="pg-input pg-leave-input" type="number" min="0" step="0.5" placeholder="Days"
          aria-label="New leave days" value={daysStr} disabled={disabled || !dailyHrs}
          onChange={(e) => onDaysChange(e.target.value)} onKeyDown={onKeyDown}
        />
        <input
          className="pg-input pg-leave-input" type="number" min="0" step="any" placeholder="Hrs"
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
