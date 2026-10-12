import React, { useState, useEffect, useRef } from "react";
import { X, ChevronLeft, ChevronRight, Lock, AlertTriangle } from "lucide-react";
import { PersonAvatar } from "./avatar.jsx";
import { useEscape } from "./useDismissable.js";
import {
  StatusPill, PersonChips, LeaveSection, ReconSection, BillableSection, HoursSection,
  fmtH, fmtNum,
} from "./WageCard.jsx";

// Parses an hours field: "" -> null (cleared), otherwise a finite number >= 0.
export function parseHoursInput(text) {
  const t = String(text ?? "").trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 9999) return { ok: false, value: null };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

// Number input that saves on blur / Enter (Escape reverts). Clearing it saves null,
// never 0. Shows its own saving/error state so a failed write is never silent.
export function HoursInput({ value, onSave, disabled, label, placeholder, compact, id }) {
  const fmt = (v) => (v == null ? "" : String(Number(v)));
  const [text, setText] = useState(fmt(value));
  const [state, setState] = useState({ saving: false, error: null });
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(fmt(value)); }, [value]);

  const commit = async () => {
    const parsed = parseHoursInput(text);
    if (!parsed.ok) { setState({ saving: false, error: "Enter hours as a number, e.g. 152.5" }); return; }
    const current = value == null ? null : Number(value);
    if (parsed.value === current) { setState({ saving: false, error: null }); setText(fmt(value)); return; }
    setState({ saving: true, error: null });
    try {
      await onSave(parsed.value);
      setState({ saving: false, error: null });
    } catch (e) {
      setState({ saving: false, error: e?.message || String(e) });
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
          if (e.key === "Escape") { e.stopPropagation(); setText(fmt(value)); setState({ saving: false, error: null }); }
        }}
      />
      {state.saving && <span className="wr-field-state">Saving…</span>}
      {state.error && <span className="wr-field-state wr-field-state--error" role="alert">{state.error}</span>}
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
        {!parsed.ok && <span className="wr-field-state wr-field-state--error">Enter hours as a number.</span>}
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

export function WageDrawer({ line, view, monthText, closed, position, onClose, onPrev, onNext, onSaveLine }) {
  const [tab, setTab] = useState("recon");
  const closeRef = useRef(null);
  useEscape(onClose);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const save = (patch) => onSaveLine(line.person_id, patch);
  const idp = `wr-${line.person_id}`;
  const lv = line.leave || {};

  return (
    <>
      <div className="wr-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="wr-drawer" role="dialog" aria-modal="true" aria-label={`${line.name}: ${monthText} wage reconciliation`}>
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

        <div className="pg-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              className={"pg-tab" + (tab === t.key ? " pg-tab--active" : "")} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>

        {tab === "recon" && (
          <div className="wr-drawer__body">
            <LeaveSection line={line} month={monthText} />
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
              {line.split?.unknownSpace > 0 && <p className="wr-note"><AlertTriangle size={11} aria-hidden="true" /> {fmtH(line.split.unknownSpace)} synced before space tracking: classified as client time; re-sync the month to confirm.</p>}
            </section>
          </div>
        )}

        {tab === "inputs" && (
          <div className="wr-drawer__body">
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
          <div className="wr-drawer__body wr-review">
            <CommentField id={`${idp}-pg`} label="PG note" value={line.pg_comment} onSave={(v) => save({ pg_comment: v })} />
            <CommentField id={`${idp}-kw`} label="Kelly (KW)" value={line.kw_comment} onSave={(v) => save({ kw_comment: v })} />
            <CommentField id={`${idp}-ls`} label="Lynda (LS)" value={line.ls_comment} onSave={(v) => save({ ls_comment: v })} />
            <CommentField id={`${idp}-phil`} label="Phil" value={line.phil_comment} onSave={(v) => save({ phil_comment: v })} />
            <PhilCheckbox line={line} onSave={save} />
            <CommentField id={`${idp}-kw2`} label="Kelly round 2 (KW2)" value={line.kw2_comment} onSave={(v) => save({ kw2_comment: v })} />
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
