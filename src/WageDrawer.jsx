import React, { useState, useEffect, useRef } from "react";
import { X, ChevronLeft, ChevronRight, Lock, AlertTriangle } from "lucide-react";
import { PersonAvatar } from "./avatar.jsx";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import { parseHoursInput } from "./wagesCalc.js";
import { REVIEW_FIELDS } from "./wagesView.js";
import { fmtH, fmtNum } from "./wagesFormat.js";
import {
  StatusPill, PersonChips, LeaveSection, ReconSection, BillableSection, HoursSection, TabBar, tabPanelProps,
} from "./WageCard.jsx";

// Number input that saves on blur / Enter (Escape reverts). Clearing it saves null,
// never 0. Shows its own saving/error state so a failed write is never silent; a value
// parseHoursInput warns about (> 400 h) still saves, with the warning shown alongside.
export function HoursInput({ value, onSave, disabled, label, placeholder, compact, id }) {
  const fmt = (v) => (v == null ? "" : String(Number(v)));
  const [text, setText] = useState(fmt(value));
  const [state, setState] = useState({ saving: false, error: null, warning: null });
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(fmt(value)); }, [value]);

  const commit = async () => {
    const parsed = parseHoursInput(text);
    if (!parsed.ok) { setState({ saving: false, error: parsed.error, warning: null }); return; }
    const warning = parsed.warning || null;
    const current = value == null ? null : Number(value);
    if (parsed.value === current) { setState({ saving: false, error: null, warning }); setText(fmt(value)); return; }
    setState({ saving: true, error: null, warning });
    try {
      await onSave(parsed.value);
      setState({ saving: false, error: null, warning });
    } catch (e) {
      setState({ saving: false, error: e?.message || String(e), warning });
    }
  };
  return (
    <span className={"wr-hours-input" + (compact ? " wr-hours-input--compact" : "")}>
      <input
        id={id}
        className="pg-input"
        inputMode="decimal"
        aria-label={label}
        placeholder={placeholder ?? "—"}
        value={text}
        disabled={disabled || state.saving}
        aria-invalid={!!state.error}
        title={state.error || undefined}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { focused.current = false; commit(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === "Escape") { e.stopPropagation(); setText(fmt(value)); setState({ saving: false, error: null, warning: null }); }
        }}
      />
      {state.saving && <span className="wr-field-state">Saving…</span>}
      {state.error && <span className="wr-field-state wr-field-state--error" role="alert">{state.error}</span>}
      {!state.error && state.warning && <span className="wr-field-state wr-field-state--warn" role="status">{state.warning}</span>}
    </span>
  );
}

function CommentField({ label, value, onSave, id }) {
  const [text, setText] = useState(value || "");
  const [state, setState] = useState({ saving: false, error: null, saved: false });
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value || ""); }, [value]);
  const commit = async () => {
    const next = text.trim() === "" ? null : text;
    if ((next ?? "") === (value ?? "")) return;
    setState({ saving: true, error: null, saved: false });
    try { await onSave(next); setState({ saving: false, error: null, saved: true }); }
    catch (e) { setState({ saving: false, error: e?.message || String(e), saved: false }); }
  };
  return (
    <div className="pg-field">
      <label className="pg-field__label" htmlFor={id}>{label}</label>
      <textarea id={id} className="pg-input wr-textarea" rows={3} value={text}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => { setText(e.target.value); setState((s) => ({ ...s, saved: false })); }}
        onBlur={() => { focused.current = false; commit(); }} />
      {state.saving && <span className="wr-field-state">Saving…</span>}
      {state.saved && <span className="wr-field-state">Saved</span>}
      {state.error && <span className="wr-field-state wr-field-state--error" role="alert">Couldn't save: {state.error}</span>}
    </div>
  );
}

function ExpectedOverride({ line, disabled, onSave }) {
  const [h, setH] = useState(line.expected_override_h == null ? "" : String(line.expected_override_h));
  const [reason, setReason] = useState(line.expected_override_reason || "");
  const [state, setState] = useState({ saving: false, error: null });
  useEffect(() => {
    setH(line.expected_override_h == null ? "" : String(line.expected_override_h));
    setReason(line.expected_override_reason || "");
  }, [line.person_id, line.expected_override_h, line.expected_override_reason]);
  const parsed = parseHoursInput(h);
  const needsReason = parsed.ok && parsed.value != null && !reason.trim();
  const unchanged = parsed.ok && parsed.value === line.expected_override_h && (reason.trim() || null) === (line.expected_override_reason || null);
  const save = async (clear) => {
    setState({ saving: true, error: null });
    try {
      await onSave(clear || parsed.value == null
        ? { expected_override_h: null, expected_override_reason: null }
        : { expected_override_h: parsed.value, expected_override_reason: reason.trim() });
      setState({ saving: false, error: null });
    } catch (e) { setState({ saving: false, error: e?.message || String(e) }); }
  };
  return (
    <div className="wr-override">
      <div className="wr-override__row">
        <label className="pg-field">
          <span className="pg-field__label">Expected (S) override</span>
          <input className="pg-input" inputMode="decimal" value={h} disabled={disabled} placeholder={fmtNum(line.expected?.S, 2)}
            onChange={(e) => setH(e.target.value)} aria-invalid={!parsed.ok} />
        </label>
        <label className="pg-field" style={{ flex: 1 }}>
          <span className="pg-field__label">Reason (required with an override)</span>
          <input className="pg-input" value={reason} disabled={disabled} onChange={(e) => setReason(e.target.value)} placeholder="e.g. agreed reduced hours for October" />
        </label>
      </div>
      <div className="wr-override__actions">
        <button type="button" className="pg-btn-ghost" disabled={disabled || state.saving || !parsed.ok || needsReason || unchanged} onClick={() => save(false)}>Save override</button>
        {line.expected_override_h != null && (
          <button type="button" className="pg-btn-ghost" disabled={disabled || state.saving} onClick={() => save(true)}>Clear override</button>
        )}
        {needsReason && <span className="wr-field-state wr-field-state--error">A reason is required.</span>}
        {!parsed.ok && <span className="wr-field-state wr-field-state--error">{parsed.error}</span>}
        {parsed.ok && parsed.warning && <span className="wr-field-state wr-field-state--warn">{parsed.warning}</span>}
        {state.saving && <span className="wr-field-state">Saving…</span>}
        {state.error && <span className="wr-field-state wr-field-state--error" role="alert">Couldn't save: {state.error}</span>}
      </div>
    </div>
  );
}

const TABS = [
  { key: "recon", label: "Reconciliation" },
  { key: "inputs", label: "Inputs" },
  { key: "review", label: "Review" },
];

// The drawer remounts per person (keyed by person_id), so the page restores focus to the
// card/row that opened it on close; this only moves focus in and keeps Tab inside.
export function WageDrawer({ line, view, monthText, closed, initialTab = "recon", position, onClose, onPrev, onNext, onSaveLine }) {
  const [tab, setTab] = useState(initialTab);
  const closeRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: closeRef, restoreFocus: false });
  useEscape(onClose);
  const save = (patch) => onSaveLine(line.person_id, patch);
  const idp = `wr-${line.person_id}`;
  const lv = line.leave || {};

  return (
    <>
      <div className="wr-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside ref={dialogRef} tabIndex={-1} className="wr-drawer" role="dialog" aria-modal="true" aria-label={`${line.name}: ${monthText} wage reconciliation`}>
        <div className="wr-drawer__bar">
          <button type="button" className="wr-iconbtn" onClick={onPrev} disabled={!onPrev} aria-label="Previous person"><ChevronLeft size={16} /></button>
          <span className="wr-drawer__pos">{position}</span>
          <button type="button" className="wr-iconbtn" onClick={onNext} disabled={!onNext} aria-label="Next person"><ChevronRight size={16} /></button>
          <button type="button" ref={closeRef} className="wr-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close details"><X size={16} /></button>
        </div>
        <div className="wr-drawer__title">
          <PersonAvatar name={line.name} photo={line.photo} size={48} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="wr-drawer__name">{line.name}</h2>
            <div className="wr-drawer__sub">{line.role ? `${line.role} · ` : ""}{monthText}</div>
          </div>
          <StatusPill status={line.status} />
        </div>
        <PersonChips line={line} />
        {closed && <p className="wr-chip"><Lock size={11} aria-hidden="true" /> Month closed: hours are locked, comments stay editable.</p>}

        <TabBar tabs={TABS} active={tab} onChange={setTab} idBase={idp} label={`${line.name} details`} />

        {tab === "recon" && (
          <div className="wr-drawer__body" {...tabPanelProps(idp, "recon")}>
            <LeaveSection line={line} month={monthText} perDay={view.perDay} />
            <ReconSection line={line} settings={view.settings} />
            <BillableSection line={line} />
            <HoursSection line={line} view={view} />
            <section className="wr-sec">
              <header className="wr-sec__head"><h3 className="wr-sec__title">By folder</h3></header>
              {(line.byFolder || []).length === 0 ? <p className="wr-note">No ClickUp time this month.</p> : (
                <div className="wr-tablewrap">
                  <table className="pg-table wr-mini-table">
                    <thead><tr><th>Folder</th><th>PG / Client</th><th className="right num">Billable</th><th className="right num">Non-billable</th></tr></thead>
                    <tbody>
                      {line.byFolder.map((f, i) => (
                        <tr key={i}><td>{f.folder}</td><td>{f.pg ? "PG" : "Client"}</td><td className="right num">{fmtH(f.billableH, 2)}</td><td className="right num">{fmtH(f.nonBillableH, 2)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {line.split?.unknownSpace > 0 && <p className="wr-note"><AlertTriangle size={11} aria-hidden="true" /> {fmtH(line.split.unknownSpace)} synced before space tracking: classified by folder name; re-sync the month to confirm.</p>}
            </section>
          </div>
        )}

        {tab === "inputs" && (
          <div className="wr-drawer__body" {...tabPanelProps(idp, "inputs")}>
            <section className="wr-sec">
              <header className="wr-sec__head"><h3 className="wr-sec__title">Xero hours (L)</h3></header>
              <div className="wr-inline">
                <HoursInput id={`${idp}-xero`} label={`Xero hours for ${line.name}`} value={line.L} disabled={closed}
                  onSave={(v) => save({ xero_hours: v, xero_source: v == null ? null : "manual" })} />
                <span className="wr-note">{line.L == null ? "Not entered yet. Clear the field to remove a value." : `Source: ${line.xero_source === "paste" ? "pasted from Xero" : "entered manually"}`}</span>
              </div>
            </section>
            <section className="wr-sec">
              <header className="wr-sec__head"><h3 className="wr-sec__title">Public holiday hours (Q)</h3></header>
              <div className="wr-inline">
                <HoursInput id={`${idp}-q`} label={`Public holiday override for ${line.name}`} value={line.ph_override_h} disabled={closed}
                  placeholder={`${fmtNum(line.expected?.Q, 2)} (calculated)`} onSave={(v) => save({ ph_override_h: v })} />
                <span className="wr-note">Leave blank to use the calculated {fmtH(line.expected?.Q, 2)}.</span>
              </div>
            </section>
            <section className="wr-sec">
              <header className="wr-sec__head"><h3 className="wr-sec__title">Expected hours (S)</h3></header>
              <p className="wr-note">Calculated: {line.expected?.allCasualXero ? "equals Xero (casual)" : fmtH(line.expected?.S, 2)}</p>
              <ExpectedOverride line={line} disabled={closed} onSave={save} />
            </section>
            <section className="wr-sec">
              <header className="wr-sec__head"><h3 className="wr-sec__title">Leave (read-only)</h3></header>
              <ul className="wr-kv">
                <li><span>Annual leave (N)</span><span>{fmtH(lv.annual, 2)}</span></li>
                <li><span>Sick / Personal (O)</span><span>{fmtH(lv.personal, 2)}</span></li>
                <li><span>LWOP (P)</span><span>{fmtH(lv.lwop, 2)}</span></li>
                {lv.unspecified > 0 && <li><span>Untyped{lv.legacy ? " (legacy total)" : ""}</span><span>{fmtH(lv.unspecified, 2)}</span></li>}
              </ul>
              <p className="wr-note">Edit leave by type in Consultants.</p>
            </section>
          </div>
        )}

        {tab === "review" && (
          <div className="wr-drawer__body wr-review" {...tabPanelProps(idp, "review")}>
            {REVIEW_FIELDS.map((f) => (
              <React.Fragment key={f.key}>
                <CommentField id={`${idp}-${f.key}`} label={f.label} value={line[f.key]} onSave={(v) => save({ [f.key]: v })} />
                {/* Phil's sign-off checkbox sits under his comment, as in the workbook. */}
                {f.key === "phil_comment" && <PhilCheckbox line={line} onSave={save} />}
              </React.Fragment>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}

function PhilCheckbox({ line, onSave }) {
  const [state, setState] = useState({ saving: false, error: null });
  return (
    <label className="pg-checkbox-row wr-checkbox">
      <input type="checkbox" checked={!!line.phil_leave_applied} disabled={state.saving}
        onChange={async (e) => {
          setState({ saving: true, error: null });
          try { await onSave({ phil_leave_applied: e.target.checked }); setState({ saving: false, error: null }); }
          catch (err) { setState({ saving: false, error: err?.message || String(err) }); }
        }} />
      Leave change applied in Xero
      {state.error && <span className="wr-field-state wr-field-state--error" role="alert">Couldn't save: {state.error}</span>}
    </label>
  );
}
