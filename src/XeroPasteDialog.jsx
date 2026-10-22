import React, { useState, useMemo, useRef } from "react";
import { X, AlertTriangle, CheckCircle2, ClipboardPaste, Info } from "lucide-react";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import { parseXeroPaste, matchXeroNames, normName, resolveXeroBatch, pendingXeroPlan } from "./wagesCalc.js";
import { fmtH, fmtSigned } from "./wagesFormat.js";

const METHOD_LABEL = {
  remembered: "remembered", xero_name: "Xero name", name: "name", first_name: "first name only: confirm",
  ambiguous: "ambiguous: pick", unmatched: "no match: pick",
};
const IGNORE = "__ignore";

// people: [{ person_id, full_name, display_name, xero_name, clickup_user_names }] (this
// month's lines only). currentL: { [person_id]: L or null }.
// Xero hours can come in several batches: each Apply only touches the people in that
// paste, then "Paste next batch" clears the box for the next one. A person pasted twice,
// or already holding different saved hours from an earlier batch, is a conflict and is not
// saved until someone picks which value to use (resolveXeroBatch).
// Nothing is applied while any pasted line is unreadable (unless the admin ticks "Ignore
// N unreadable lines") or any row is unresolved. A first-name-only match is preselected
// but stays unresolved until it's confirmed (tick, or picking the person explicitly).
export function XeroPasteDialog({ monthText, people, currentL, nameMap, onApply, onClose }) {
  const [text, setText] = useState("");
  const [picks, setPicks] = useState({}); // row index -> person_id | IGNORE
  const [confirmed, setConfirmed] = useState({}); // row index -> true (first-name suggestion accepted)
  const [choices, setChoices] = useState({}); // person_id -> resolveXeroBatch option key
  const [ignoreErrors, setIgnoreErrors] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null); // { saved, total, failed: [{name, error}], mapError }
  // Frozen at the first Apply (absolute hours per person). A retry after a partial failure
  // re-sends only what isn't saved yet -- never re-resolves the batch, which would re-add an
  // "Add together" choice on top of the hours the first attempt already saved.
  const [plan, setPlan] = useState(null);
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
  const batch = resolveXeroBatch(rows.filter((r) => r.target && !r.awaitingConfirm), currentL || {}, choices);
  const openConflicts = batch.conflicts.filter((c) => !c.choice);
  const toApply = plan ? pendingXeroPlan(plan, currentL || {}) : batch.apply;
  const errorsOk = parsed.errors.length === 0 || ignoreErrors;
  // Remembered in settings.xero_name_map: a pick that differs from the automatic match, or
  // a first-name suggestion a person confirmed (by tick or by picking it). Exact matches
  // need no memory.
  const remembers = (r) => !!r.target && (r.manual ? (r.target !== r.person_id || r.needsConfirm) : (r.needsConfirm && !!confirmed[r.i]));
  const canApply = toApply.length > 0 && (plan ? true : unresolved.length === 0 && openConflicts.length === 0 && errorsOk) && !applying && !(result && !result.failed?.length);
  const reset = () => { setPicks({}); setConfirmed({}); setChoices({}); setIgnoreErrors(false); setResult(null); setPlan(null); };
  const nextBatch = () => { setText(""); reset(); textRef.current?.focus(); };

  const apply = async () => {
    setApplying(true);
    const remember = {};
    if (!plan) rows.filter(remembers).forEach((r) => { remember[normName(r.name)] = r.target; });
    const items = toApply.map((a) => ({ person_id: a.person_id, hours: a.hours, name: a.names.join(", "), names: a.names }));
    if (!plan) setPlan(items);
    try {
      const res = await onApply(items.map(({ names, ...rest }) => rest), remember);
      setResult({ ...res, total: items.length });
    } catch (e) {
      setResult({ saved: 0, total: items.length, failed: [{ name: "All rows", error: e?.message || String(e) }] });
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
          <span className="pg-field__label">Xero hours: paste the report (or one batch of it); each batch only updates the people in it</span>
          <textarea ref={textRef} className="pg-input wr-textarea wr-textarea--big" value={text}
            onChange={(e) => { setText(e.target.value); reset(); }}
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
                          value={r.ignored ? IGNORE : (r.target || "")} disabled={!!plan}
                          onChange={(e) => setPicks((p) => ({ ...p, [r.i]: e.target.value || undefined }))}>
                          <option value="">Pick a person…</option>
                          {people.map((p) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
                          <option value={IGNORE}>Ignore this row</option>
                        </select>
                        <div className="wr-tile__sub">
                          {r.ignored ? "ignored" : remembers(r) ? (r.manual ? "picked (will be remembered)" : "confirmed (will be remembered)") : r.manual ? "picked" : METHOD_LABEL[r.method]}
                          {r.target && counts.get(r.target) > 1 && <span className="wr-field-state--warn"> · {nameOf(r.target)} is in this paste twice: choose below</span>}
                        </div>
                        {r.needsConfirm && !r.manual && !r.ignored && (
                          <label className="pg-checkbox-row wr-checkbox">
                            <input type="checkbox" checked={!!confirmed[r.i]} disabled={!!plan} onChange={(e) => setConfirmed((c) => ({ ...c, [r.i]: e.target.checked }))} />
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

        {batch.conflicts.length > 0 && !result && (
          <div className="wr-banner wr-banner--warn" role="group" aria-labelledby="wr-paste-conflicts">
            <AlertTriangle size={13} aria-hidden="true" />
            <div className="wr-conflicts">
              <b id="wr-paste-conflicts">{batch.conflicts.length} {batch.conflicts.length === 1 ? "person has" : "people have"} more than one value: choose which to use</b>
              {batch.conflicts.map((c) => (
                <fieldset key={c.person_id} className="wr-conflict">
                  <legend>
                    {nameOf(c.person_id)}
                    <span className="wr-tile__sub"> · {c.saved != null ? `saved ${fmtH(c.saved, 2)} from an earlier batch` : "in this paste more than once"}{c.rows.length > 1 || c.saved != null ? `; pasted ${c.rows.map((r) => fmtH(r.hours, 2)).join(" and ")}` : ""}</span>
                  </legend>
                  {c.options.map((o) => (
                    <label key={o.key} className="pg-checkbox-row wr-checkbox">
                      <input type="radio" name={`wr-conflict-${c.person_id}`} value={o.key} checked={c.choice === o.key}
                        onChange={() => setChoices((ch) => ({ ...ch, [c.person_id]: o.key }))} />
                      {o.label}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </div>
        )}

        {result && (
          <div className={"wr-banner " + (result.failed?.length ? "wr-banner--error" : "wr-banner--ok")} role="status">
            {result.failed?.length ? <AlertTriangle size={13} aria-hidden="true" /> : <CheckCircle2 size={13} aria-hidden="true" />}
            <div>
              <b>Saved {result.saved} of {result.total}.{!result.failed?.length && " Paste the next batch, or close."}</b>
              {result.failed?.length > 0 && <ul className="wr-banner__list">{result.failed.map((f, i) => <li key={i}>{f.name}: {f.error}</li>)}</ul>}
              {result.mapError && <div>Couldn't remember the picked names: {result.mapError}</div>}
            </div>
          </div>
        )}

        <div className="wr-modal__foot">
          <span className="wr-note">
            {rows.length === 0 ? "Paste the Xero hours report to preview matches." :
              unresolved.length ? `${unresolved.length} row${unresolved.length === 1 ? " needs" : "s need"} a person, a confirmation or "Ignore".` :
              openConflicts.length ? `Choose which hours to use for ${openConflicts.length} ${openConflicts.length === 1 ? "person" : "people"}.` :
              !errorsOk ? "Fix the unreadable lines or tick \"Ignore\" above." :
              `${toApply.length} to save${batch.unchanged.length ? ` · ${batch.unchanged.length} already match` : ""}${batch.keep.length ? ` · ${batch.keep.length} kept as saved` : ""}.`}
          </span>
          <button type="button" className="pg-btn-ghost" onClick={onClose}>{result && !result.failed?.length ? "Done" : "Cancel"}</button>
          {result && !result.failed?.length
            ? <button type="button" className="pg-btn" onClick={nextBatch}>Paste next batch</button>
            : <button type="button" className="pg-btn" disabled={!canApply} onClick={apply}>{applying ? "Saving…" : "Apply"}</button>}
        </div>
      </div>
    </>
  );
}
