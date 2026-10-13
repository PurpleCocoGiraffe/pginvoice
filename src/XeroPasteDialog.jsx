import React, { useState, useMemo, useRef } from "react";
import { X, AlertTriangle, CheckCircle2, ClipboardPaste, Info } from "lucide-react";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import { parseXeroPaste, matchXeroNames, normName } from "./wagesCalc.js";
import { fmtH, fmtSigned } from "./wagesFormat.js";

const METHOD_LABEL = {
  remembered: "remembered", xero_name: "Xero name", name: "name", first_name: "first name only: confirm",
  ambiguous: "ambiguous: pick", unmatched: "no match: pick",
};
const IGNORE = "__ignore";

// people: [{ person_id, full_name, display_name, xero_name, clickup_user_names }] (this
// month's lines only). currentL: { [person_id]: L or null }.
// Nothing is applied while any pasted line is unreadable (unless the admin ticks "Ignore
// N unreadable lines") or any row is unresolved. A first-name-only match is preselected
// but stays unresolved until it's confirmed (tick, or picking the person explicitly).
export function XeroPasteDialog({ monthText, people, currentL, nameMap, onApply, onClose }) {
  const [text, setText] = useState("");
  const [picks, setPicks] = useState({}); // row index -> person_id | IGNORE
  const [confirmed, setConfirmed] = useState({}); // row index -> true (first-name suggestion accepted)
  const [ignoreErrors, setIgnoreErrors] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null); // { saved, failed: [{name, error}], mapError }
  const textRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: textRef });
  useEscape(onClose);

  const parsed = useMemo(() => parseXeroPaste(text), [text]);
  const matched = useMemo(() => matchXeroNames(parsed.rows, people, nameMap || {}), [parsed, people, nameMap]);
  const nameOf = (pid) => people.find((p) => p.person_id === pid)?.display_name || pid;
  const rows = matched.map((m, i) => {
    const picked = picks[i];
    const target = picked === undefined ? m.person_id : picked === IGNORE ? null : picked;
    const manual = picked !== undefined && picked !== IGNORE;
    // A suggestion only counts once confirmed or picked explicitly.
    const awaitingConfirm = !manual && picked !== IGNORE && m.needsConfirm && !confirmed[i];
    return { ...m, i, target, ignored: picked === IGNORE, manual, awaitingConfirm };
  });
  const counts = new Map();
  rows.forEach((r) => { if (r.target) counts.set(r.target, (counts.get(r.target) || 0) + 1); });
  const unresolved = rows.filter((r) => (!r.target && !r.ignored) || r.awaitingConfirm);
  const duplicates = rows.filter((r) => r.target && counts.get(r.target) > 1);
  const toApply = rows.filter((r) => r.target);
  const errorsOk = parsed.errors.length === 0 || ignoreErrors;
  // Remembered in settings.xero_name_map: a pick that differs from the automatic match, or
  // a first-name suggestion a person confirmed (by tick or by picking it). Exact matches
  // need no memory.
  const remembers = (r) => !!r.target && (r.manual ? (r.target !== r.person_id || r.needsConfirm) : (r.needsConfirm && !!confirmed[r.i]));
  const canApply = toApply.length > 0 && unresolved.length === 0 && duplicates.length === 0 && errorsOk && !applying;

  const apply = async () => {
    setApplying(true);
    const remember = {};
    rows.filter(remembers).forEach((r) => { remember[normName(r.name)] = r.target; });
    try {
      setResult(await onApply(toApply.map((r) => ({ person_id: r.target, hours: r.hours, name: r.name })), remember));
    } catch (e) {
      setResult({ saved: 0, failed: [{ name: "All rows", error: e?.message || String(e) }] });
    }
    setApplying(false);
  };

  return (
    <>
      <div className="wr-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={dialogRef} tabIndex={-1} className="wr-modal" role="dialog" aria-modal="true" aria-labelledby="wr-paste-title">
        <div className="wr-modal__head">
          <h2 id="wr-paste-title" className="wr-modal__title"><ClipboardPaste size={16} aria-hidden="true" /> Paste from Xero · {monthText}</h2>
          <button type="button" className="wr-iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <label className="pg-field">
          <span className="pg-field__label">Xero hours (one "name, hours" per line; tabs, commas or columns all work)</span>
          <textarea ref={textRef} className="pg-input wr-textarea wr-textarea--big" value={text}
            onChange={(e) => { setText(e.target.value); setPicks({}); setConfirmed({}); setIgnoreErrors(false); setResult(null); }}
            placeholder={"Paste the Xero report (Employee … Units columns), or name + hours pairs:\nHolly Latham\t154.76"} />
        </label>

        {parsed.errors.length > 0 && (
          <div className="wr-banner wr-banner--warn" role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            <div>
              <b>{parsed.errors.length} line{parsed.errors.length === 1 ? "" : "s"} couldn't be read</b>
              <ul className="wr-banner__list">{parsed.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
              <label className="pg-checkbox-row wr-checkbox">
                <input type="checkbox" checked={ignoreErrors} onChange={(e) => setIgnoreErrors(e.target.checked)} />
                Ignore {parsed.errors.length} unreadable line{parsed.errors.length === 1 ? "" : "s"} (their hours won't be saved)
              </label>
            </div>
          </div>
        )}

        {parsed.notes?.length > 0 && (
          <div className="wr-banner wr-banner--info" role="status">
            <Info size={13} aria-hidden="true" />
            <div>
              <b>Read as a Xero report: employee name and Units only</b>
              <ul className="wr-banner__list">{parsed.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          </div>
        )}

        {rows.length > 0 && (
          <div className="wr-tablewrap">
            <table className="pg-table">
              <thead>
                <tr><th>Pasted name</th><th className="right num">Hours</th><th>Person</th><th className="right num">Saved now</th><th className="right num">Change</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cur = r.target ? currentL[r.target] ?? null : null;
                  return (
                    <tr key={r.i}>
                      <td>{r.name}</td>
                      <td className="right num">{fmtH(r.hours, 2)}</td>
                      <td>
                        <select className="pg-select wr-select" aria-label={`Person for ${r.name}`}
                          value={r.ignored ? IGNORE : (r.target || "")}
                          onChange={(e) => setPicks((p) => ({ ...p, [r.i]: e.target.value || undefined }))}>
                          <option value="">Pick a person…</option>
                          {people.map((p) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
                          <option value={IGNORE}>Ignore this row</option>
                        </select>
                        <div className="wr-tile__sub">
                          {r.ignored ? "ignored" : remembers(r) ? (r.manual ? "picked (will be remembered)" : "confirmed (will be remembered)") : r.manual ? "picked" : METHOD_LABEL[r.method]}
                          {r.target && counts.get(r.target) > 1 && <span className="wr-field-state--error"> · {nameOf(r.target)} is matched twice</span>}
                        </div>
                        {r.needsConfirm && !r.manual && !r.ignored && (
                          <label className="pg-checkbox-row wr-checkbox">
                            <input type="checkbox" checked={!!confirmed[r.i]} onChange={(e) => setConfirmed((c) => ({ ...c, [r.i]: e.target.checked }))} />
                            Confirm {nameOf(r.target)}
                          </label>
                        )}
                      </td>
                      <td className="right num">{r.target ? fmtH(cur, 2) : ""}</td>
                      <td className="right num">{r.target ? (cur == null ? "new" : fmtSigned(r.hours - cur, 2)) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {result && (
          <div className={"wr-banner " + (result.failed?.length ? "wr-banner--error" : "wr-banner--ok")} role="status">
            {result.failed?.length ? <AlertTriangle size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
            <div>
              <b>Saved {result.saved} of {toApply.length}.</b>
              {result.failed?.length > 0 && <ul className="wr-banner__list">{result.failed.map((f, i) => <li key={i}>{f.name}: {f.error}</li>)}</ul>}
              {result.mapError && <div>Couldn't remember the picked names: {result.mapError}</div>}
            </div>
          </div>
        )}

        <div className="wr-modal__foot">
          <span className="wr-note">
            {rows.length === 0 ? "Paste the Xero hours report to preview matches." :
              unresolved.length ? `${unresolved.length} row${unresolved.length === 1 ? " needs" : "s need"} a person, a confirmation or "Ignore".` :
              duplicates.length ? "Each person can only be matched once." :
              !errorsOk ? "Fix the unreadable lines or tick \"Ignore\" above." : `${toApply.length} to save.`}
          </span>
          <button type="button" className="pg-btn-ghost" onClick={onClose}>{result && !result.failed?.length ? "Done" : "Cancel"}</button>
          <button type="button" className="pg-btn" disabled={!canApply} onClick={apply}>{applying ? "Saving…" : "Apply"}</button>
        </div>
      </div>
    </>
  );
}
