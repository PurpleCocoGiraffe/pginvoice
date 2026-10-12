import React, { useState, useMemo } from "react";
import { X, AlertTriangle, CheckCircle2, ClipboardPaste } from "lucide-react";
import { useEscape } from "./useDismissable.js";
import { parseXeroPaste, matchXeroNames, normaliseXeroName } from "./wagesCalc.js";
import { fmtH, fmtSigned } from "./WageCard.jsx";

const METHOD_LABEL = {
  remembered: "remembered", xero_name: "Xero name", name: "name", first_name: "first name",
  ambiguous: "ambiguous: pick", unmatched: "no match: pick",
};
const IGNORE = "__ignore";

// people: [{ person_id, full_name, display_name, xero_name, clickup_user_names }] (this
// month's lines only). currentL: { [person_id]: L or null }.
export function XeroPasteDialog({ monthText, people, currentL, nameMap, onApply, onClose }) {
  const [text, setText] = useState("");
  const [picks, setPicks] = useState({}); // row index -> person_id | IGNORE
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null); // { saved, failed: [{name, error}], mapError }
  useEscape(onClose);

  const parsed = useMemo(() => parseXeroPaste(text), [text]);
  const matched = useMemo(() => matchXeroNames(parsed.rows, people, nameMap || {}), [parsed, people, nameMap]);
  const nameOf = (pid) => people.find((p) => p.person_id === pid)?.display_name || pid;
  const rows = matched.map((m, i) => {
    const picked = picks[i];
    const target = picked === undefined ? m.person_id : picked === IGNORE ? null : picked;
    return { ...m, i, target, ignored: picked === IGNORE, manual: picked !== undefined && picked !== IGNORE && picked !== m.person_id };
  });
  const counts = new Map();
  rows.forEach((r) => { if (r.target) counts.set(r.target, (counts.get(r.target) || 0) + 1); });
  const unresolved = rows.filter((r) => !r.target && !r.ignored);
  const duplicates = rows.filter((r) => r.target && counts.get(r.target) > 1);
  const toApply = rows.filter((r) => r.target);
  const canApply = toApply.length > 0 && unresolved.length === 0 && duplicates.length === 0 && !applying;

  const apply = async () => {
    setApplying(true);
    const remember = {};
    rows.filter((r) => r.manual && r.target).forEach((r) => { remember[normaliseXeroName(r.name)] = r.target; });
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
      <div className="wr-modal" role="dialog" aria-modal="true" aria-labelledby="wr-paste-title">
        <div className="wr-modal__head">
          <h2 id="wr-paste-title" className="wr-modal__title"><ClipboardPaste size={16} aria-hidden="true" /> Paste from Xero · {monthText}</h2>
          <button type="button" className="wr-iconbtn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <label className="pg-field">
          <span className="pg-field__label">Xero hours (one "name, hours" per line; tabs, commas or columns all work)</span>
          <textarea className="pg-input wr-textarea wr-textarea--big" value={text} autoFocus
            onChange={(e) => { setText(e.target.value); setPicks({}); setResult(null); }}
            placeholder={"Holly Nguyen\t152.5\nLucy Walker\t160:30"} />
        </label>

        {parsed.errors.length > 0 && (
          <div className="wr-banner wr-banner--warn" role="status">
            <AlertTriangle size={13} aria-hidden="true" />
            <div>
              <b>{parsed.errors.length} line{parsed.errors.length === 1 ? "" : "s"} couldn't be read</b>
              <ul className="wr-banner__list">{parsed.errors.map((e, i) => <li key={i}>{e.message}</li>)}</ul>
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
                          {r.ignored ? "ignored" : r.manual ? "picked (will be remembered)" : METHOD_LABEL[r.method]}
                          {r.target && counts.get(r.target) > 1 && <span className="wr-field-state--error"> · {nameOf(r.target)} is matched twice</span>}
                        </div>
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
              unresolved.length ? `${unresolved.length} row${unresolved.length === 1 ? " needs" : "s need"} a person or "Ignore".` :
              duplicates.length ? "Each person can only be matched once." : `${toApply.length} to save.`}
          </span>
          <button type="button" className="pg-btn-ghost" onClick={onClose}>{result && !result.failed?.length ? "Done" : "Cancel"}</button>
          <button type="button" className="pg-btn" disabled={!canApply} onClick={apply}>{applying ? "Saving…" : "Apply"}</button>
        </div>
      </div>
    </>
  );
}
