import React, { useState, useMemo, useEffect } from "react";
import { Plus, X, Pencil, Trash2, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { PersonAvatar } from "./avatar.jsx";
import { expectedFor } from "./wagesCalc.js";
import { normaliseSettings } from "./wagesView.js";
import { upsertPerson, upsertRule, deleteRule, saveSettings } from "./wagesSync.js";
import { fmtDay, fmtNum, basisName, monthLabel } from "./WageCard.jsx";

const DAYS = [["mon_h", "Mon"], ["tue_h", "Tue"], ["wed_h", "Wed"], ["thu_h", "Thu"], ["fri_h", "Fri"], ["sat_h", "Sat"], ["sun_h", "Sun"]];
const CASUAL_OPTIONS = [
  { basis: "casual_xero", label: "Expected = Xero (no over/under)" },
  { basis: "casual_pattern", label: "Agreed weekly pattern" },
  { basis: "casual_target", label: "Monthly target" },
];
const errText = (e) => e?.message || String(e);
const toNum = (v) => (v === "" || v == null ? null : Number(v));

function ChipList({ items, onRemove, label }) {
  if (!items.length) return <span className="wr-note">None</span>;
  return (
    <ul className="wr-chips" aria-label={label}>
      {items.map((n) => (
        <li key={n} className="wr-chip">
          {n}
          <button type="button" className="wr-chip__x" onClick={() => onRemove(n)} aria-label={`Remove ${n}`}><X size={11} /></button>
        </li>
      ))}
    </ul>
  );
}

function ChipAdder({ suggestions, onAdd, placeholder, id }) {
  const [v, setV] = useState("");
  const add = () => { const t = v.trim(); if (t) { onAdd(t); setV(""); } };
  return (
    <div className="wr-inline">
      <input className="pg-input" list={`${id}-list`} value={v} placeholder={placeholder} aria-label={placeholder}
        onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <datalist id={`${id}-list`}>{(suggestions || []).map((s) => <option key={s} value={s} />)}</datalist>
      <button type="button" className="pg-btn-ghost" onClick={add} disabled={!v.trim()}><Plus size={11} /> Add</button>
    </div>
  );
}

/* ---------------------------------------------------------------- global ---------------- */
function GlobalSettings({ settingsRow, seenUsers, onSaved }) {
  const s = normaliseSettings(settingsRow);
  const [form, setForm] = useState(() => ({ ...s }));
  const [state, setState] = useState({ saving: false, error: null, saved: false });
  useEffect(() => { setForm({ ...normaliseSettings(settingsRow) }); }, [settingsRow]);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setState((st) => ({ ...st, saved: false })); };
  const numOk = ["hours_per_day", "xero_tolerance_h", "variance_threshold_h"].every((k) => form[k] !== "" && Number.isFinite(Number(form[k])) && Number(form[k]) >= 0);
  const save = async () => {
    setState({ saving: true, error: null, saved: false });
    try {
      await saveSettings({
        hours_per_day: Number(form.hours_per_day), xero_tolerance_h: Number(form.xero_tolerance_h),
        variance_threshold_h: Number(form.variance_threshold_h), pg_folders: form.pg_folders, ignored_clickup_users: form.ignored_clickup_users,
      });
      setState({ saving: false, error: null, saved: true });
      onSaved();
    } catch (e) { setState({ saving: false, error: errText(e), saved: false }); }
  };
  return (
    <section className="wr-panel">
      <h2 className="wr-panel__title">Global settings</h2>
      <div className="wr-form-row">
        <label className="pg-field"><span className="pg-field__label">Hours per day</span>
          <input className="pg-input" inputMode="decimal" value={form.hours_per_day} onChange={(e) => set("hours_per_day", e.target.value)} /></label>
        <label className="pg-field"><span className="pg-field__label">Xero ⇄ ClickUp tolerance (M), h</span>
          <input className="pg-input" inputMode="decimal" value={form.xero_tolerance_h} onChange={(e) => set("xero_tolerance_h", e.target.value)} /></label>
        <label className="pg-field"><span className="pg-field__label">Over/under threshold (T), h</span>
          <input className="pg-input" inputMode="decimal" value={form.variance_threshold_h} onChange={(e) => set("variance_threshold_h", e.target.value)} /></label>
      </div>
      <div className="wr-form-block">
        <div className="pg-field__label">PG folders (inside client spaces, counted as PG time)</div>
        <ChipList label="PG folders" items={form.pg_folders} onRemove={(n) => set("pg_folders", form.pg_folders.filter((x) => x !== n))} />
        <ChipAdder id="wr-pgf" placeholder="Add folder name" onAdd={(n) => !form.pg_folders.includes(n) && set("pg_folders", [...form.pg_folders, n])} />
      </div>
      <div className="wr-form-block">
        <div className="pg-field__label">Ignored ClickUp users (shared logins, never a payroll person)</div>
        <ChipList label="Ignored ClickUp users" items={form.ignored_clickup_users} onRemove={(n) => set("ignored_clickup_users", form.ignored_clickup_users.filter((x) => x !== n))} />
        <ChipAdder id="wr-ign" placeholder="Add ClickUp user" suggestions={seenUsers} onAdd={(n) => !form.ignored_clickup_users.includes(n) && set("ignored_clickup_users", [...form.ignored_clickup_users, n])} />
      </div>
      <div className="wr-inline">
        <button type="button" className="pg-btn" disabled={!numOk || state.saving} onClick={save}>{state.saving ? "Saving…" : "Save settings"}</button>
        {!numOk && <span className="wr-field-state wr-field-state--error">Enter numbers for hours/tolerance/threshold.</span>}
        {state.saved && <span className="wr-field-state">Saved</span>}
        {state.error && <span className="wr-field-state wr-field-state--error" role="alert">Couldn't save: {state.error}</span>}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- rules ----------------- */
const blankRule = (personId) => ({
  person_id: personId, effective_from: "", basis: "ft", daily_hours: 7.6,
  mon_h: 0, tue_h: 0, wed_h: 0, thu_h: 0, fri_h: 0, sat_h: 0, sun_h: 0, monthly_target_h: "", note: "",
});

function RuleEditor({ initial, otherRules, person, monthKey, perDay, onSave, onCancel }) {
  const [r, setR] = useState(() => ({ ...initial, monthly_target_h: initial.monthly_target_h ?? "", note: initial.note ?? "" }));
  const [state, setState] = useState({ saving: false, error: null });
  const set = (k, v) => setR((x) => ({ ...x, [k]: v }));
  const family = r.basis === "ft" ? "ft" : r.basis === "pt_pattern" ? "pt" : "casual";
  const usesPattern = r.basis === "pt_pattern" || r.basis === "casual_pattern";
  const weekly = DAYS.reduce((s, [k]) => s + (Number(r[k]) || 0), 0);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(r.effective_from || "")
    && (r.basis !== "casual_target" || (r.monthly_target_h !== "" && Number(r.monthly_target_h) >= 0))
    && (r.basis !== "ft" || Number(r.daily_hours) > 0)
    && (!usesPattern || weekly > 0)
    && !otherRules.some((o) => String(o.effective_from).slice(0, 10) === r.effective_from);

  const preview = useMemo(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.effective_from || "")) return null;
    const draft = { ...r, daily_hours: Number(r.daily_hours) || 0, monthly_target_h: toNum(r.monthly_target_h) };
    const e = expectedFor({ monthKey, person, rules: [...otherRules, draft], perDay });
    const S = e.allCasualXero ? "= Xero" : `${fmtNum(e.S, 2)} h`;
    return `${monthLabel(monthKey)}: S = ${S} (${e.segments.map((s) => s.working).join("; ") || "no rule applies"})`;
  }, [r, otherRules, person, monthKey, perDay]);

  const pick = (basis) => set("basis", basis);
  const save = async () => {
    setState({ saving: true, error: null });
    const payload = {
      ...(r.id ? { id: r.id } : {}), person_id: r.person_id, effective_from: r.effective_from, basis: r.basis,
      daily_hours: Number(r.daily_hours) || 7.6, monthly_target_h: r.basis === "casual_target" ? Number(r.monthly_target_h) : null,
      note: r.note?.trim() || null,
      ...Object.fromEntries(DAYS.map(([k]) => [k, usesPattern ? (Number(r[k]) || 0) : 0])),
    };
    try { await onSave(payload); } catch (e) { setState({ saving: false, error: errText(e) }); }
  };

  return (
    <div className="wr-rule-editor">
      <label className="pg-field" style={{ maxWidth: 200 }}>
        <span className="pg-field__label">Effective from</span>
        <input className="pg-input" type="date" value={r.effective_from || ""} onChange={(e) => set("effective_from", e.target.value)} />
      </label>
      <div className="wr-basis" role="radiogroup" aria-label="Employment basis">
        {[["ft", "Full-time", "Standard days × hours per day"], ["pt", "Part-time pattern", "Hours per weekday"], ["casual", "Casual", "No public holidays"]].map(([key, title, sub]) => (
          <button key={key} type="button" role="radio" aria-checked={family === key}
            className={"wr-basis__opt" + (family === key ? " is-active" : "")}
            onClick={() => pick(key === "ft" ? "ft" : key === "pt" ? "pt_pattern" : (family === "casual" ? r.basis : "casual_xero"))}>
            <span className="wr-basis__title">{title}</span><span className="wr-basis__sub">{sub}</span>
          </button>
        ))}
      </div>
      {family === "casual" && (
        <div className="wr-radio-list" role="radiogroup" aria-label="Casual expected hours">
          {CASUAL_OPTIONS.map((o) => (
            <label key={o.basis} className="pg-checkbox-row">
              <input type="radio" name={`casual-${r.person_id}`} checked={r.basis === o.basis} onChange={() => pick(o.basis)} /> {o.label}
            </label>
          ))}
        </div>
      )}
      {r.basis === "ft" && (
        <label className="pg-field" style={{ maxWidth: 160 }}>
          <span className="pg-field__label">Hours per day</span>
          <input className="pg-input" inputMode="decimal" value={r.daily_hours} onChange={(e) => set("daily_hours", e.target.value)} />
        </label>
      )}
      {usesPattern && (
        <div>
          <div className="wr-week">
            {DAYS.map(([k, label]) => (
              <label key={k} className="pg-field">
                <span className="pg-field__label">{label}</span>
                <input className="pg-input" inputMode="decimal" value={r[k]} onChange={(e) => set(k, e.target.value)} />
              </label>
            ))}
          </div>
          <p className="wr-note">Weekly total: {fmtNum(weekly, 2)} h</p>
        </div>
      )}
      {r.basis === "casual_target" && (
        <label className="pg-field" style={{ maxWidth: 200 }}>
          <span className="pg-field__label">Monthly target (h)</span>
          <input className="pg-input" inputMode="decimal" value={r.monthly_target_h} onChange={(e) => set("monthly_target_h", e.target.value)} />
        </label>
      )}
      <label className="pg-field">
        <span className="pg-field__label">Note (optional)</span>
        <input className="pg-input" value={r.note} onChange={(e) => set("note", e.target.value)} />
      </label>
      {preview && <p className="wr-preview">{preview}</p>}
      {otherRules.some((o) => String(o.effective_from).slice(0, 10) === r.effective_from) && <p className="wr-field-state wr-field-state--error">Another rule already starts on this date.</p>}
      <div className="wr-inline">
        <button type="button" className="pg-btn" disabled={!valid || state.saving} onClick={save}>{state.saving ? "Saving…" : "Save rule"}</button>
        <button type="button" className="pg-btn-ghost" onClick={onCancel}>Cancel</button>
        {state.error && <span className="wr-field-state wr-field-state--error" role="alert">Couldn't save: {state.error}</span>}
      </div>
    </div>
  );
}

function ruleSummary(r) {
  if (r.basis === "ft") return `${basisName(r.basis)} · ${fmtNum(r.daily_hours, 2)} h/day`;
  if (r.basis === "pt_pattern" || r.basis === "casual_pattern") {
    const days = DAYS.filter(([k]) => Number(r[k]) > 0).map(([k, l]) => `${l} ${Number(r[k])}`).join(", ");
    const total = DAYS.reduce((s, [k]) => s + (Number(r[k]) || 0), 0);
    return `${basisName(r.basis)} · ${days || "no days"} (${fmtNum(total, 2)} h/wk)`;
  }
  if (r.basis === "casual_target") return `${basisName(r.basis)} · ${fmtNum(r.monthly_target_h, 2)} h/month`;
  return basisName(r.basis);
}

/* ---------------------------------------------------------------- person ---------------- */
function PersonSettings({ rosterPerson, wageRow, rules, seenUsers, monthKey, perDay, onChanged }) {
  const pid = rosterPerson.id;
  const [form, setForm] = useState(() => toForm(wageRow));
  const [state, setState] = useState({ saving: false, error: null, saved: false });
  const [editing, setEditing] = useState(null); // rule being edited | "new"
  const [ruleError, setRuleError] = useState(null);
  useEffect(() => { setForm(toForm(wageRow)); }, [wageRow]);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setState((s) => ({ ...s, saved: false })); };
  const datesOk = !form.start_date || !form.end_date || form.end_date >= form.start_date;
  const person = { state: rosterPerson.state, start_date: form.start_date || null, end_date: form.end_date || null };
  const sortedRules = [...rules].sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));

  const save = async () => {
    setState({ saving: true, error: null, saved: false });
    try {
      await upsertPerson({
        person_id: pid, include: form.include, clickup_user_names: form.clickup_user_names,
        xero_name: form.xero_name.trim() || null, start_date: form.start_date || null, end_date: form.end_date || null,
      });
      setState({ saving: false, error: null, saved: true });
      onChanged(["wagePeople"]);
    } catch (e) { setState({ saving: false, error: errText(e), saved: false }); }
  };
  const saveRule = async (payload) => {
    await upsertRule(payload);
    setEditing(null);
    onChanged(["rules"]);
  };
  const removeRule = async (r) => {
    if (!window.confirm(`Delete the rule starting ${fmtDay(r.effective_from)} ${String(r.effective_from).slice(0, 4)}? Open months will recalculate.`)) return;
    setRuleError(null);
    try { await deleteRule(r.id); onChanged(["rules"]); } catch (e) { setRuleError(errText(e)); }
  };

  return (
    <div className="wr-person-settings">
      <div className="wr-form-row">
        <label className="pg-checkbox-row"><input type="checkbox" checked={form.include} onChange={(e) => set("include", e.target.checked)} /> Include in wages review</label>
      </div>
      <div className="wr-form-block">
        <div className="pg-field__label">ClickUp user names (exact)</div>
        <ChipList label="ClickUp user names" items={form.clickup_user_names} onRemove={(n) => set("clickup_user_names", form.clickup_user_names.filter((x) => x !== n))} />
        <ChipAdder id={`wr-cu-${pid}`} placeholder="Add ClickUp name" suggestions={seenUsers}
          onAdd={(n) => !form.clickup_user_names.some((x) => x.toLowerCase() === n.toLowerCase()) && set("clickup_user_names", [...form.clickup_user_names, n])} />
      </div>
      <div className="wr-form-row">
        <label className="pg-field"><span className="pg-field__label">Xero name</span>
          <input className="pg-input" value={form.xero_name} onChange={(e) => set("xero_name", e.target.value)} placeholder="As it appears in Xero" /></label>
        <label className="pg-field"><span className="pg-field__label">Start date</span>
          <input className="pg-input" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} /></label>
        <label className="pg-field"><span className="pg-field__label">End date</span>
          <input className="pg-input" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} /></label>
      </div>
      <div className="wr-inline">
        <button type="button" className="pg-btn-ghost" disabled={!datesOk || state.saving} onClick={save}>{state.saving ? "Saving…" : "Save person"}</button>
        {!datesOk && <span className="wr-field-state wr-field-state--error">End date must be on or after the start date.</span>}
        {state.saved && <span className="wr-field-state">Saved</span>}
        {state.error && <span className="wr-field-state wr-field-state--error" role="alert">Couldn't save: {state.error}</span>}
      </div>

      <div className="wr-form-block">
        <div className="pg-field__label">Hours rules</div>
        {!wageRow && <p className="wr-note">Save the person first to add hours rules.</p>}
        {wageRow && sortedRules.length === 0 && <p className="wr-note"><AlertTriangle size={11} aria-hidden="true" /> No hours rule: over/under can't be assessed.</p>}
        <ol className="wr-timeline">
          {sortedRules.map((r) => (
            <li key={r.id} className="wr-timeline__item">
              {editing && editing !== "new" && editing.id === r.id ? (
                <RuleEditor initial={r} otherRules={sortedRules.filter((o) => o.id !== r.id)} person={person} monthKey={monthKey} perDay={perDay}
                  onSave={saveRule} onCancel={() => setEditing(null)} />
              ) : (
                <div className="wr-inline">
                  <span className="wr-timeline__date">From {fmtDay(r.effective_from)} {String(r.effective_from).slice(0, 4)}</span>
                  <span>{ruleSummary(r)}</span>
                  {r.note && <span className="wr-note">{r.note}</span>}
                  <button type="button" className="pg-btn-ghost" onClick={() => setEditing(r)} aria-label={`Edit rule from ${r.effective_from}`}><Pencil size={11} /> Edit</button>
                  <button type="button" className="pg-btn-ghost" onClick={() => removeRule(r)} aria-label={`Delete rule from ${r.effective_from}`}><Trash2 size={11} /> Delete</button>
                </div>
              )}
            </li>
          ))}
        </ol>
        {ruleError && <p className="wr-field-state wr-field-state--error" role="alert">Couldn't delete: {ruleError}</p>}
        {wageRow && (editing === "new"
          ? <RuleEditor initial={blankRule(pid)} otherRules={sortedRules} person={person} monthKey={monthKey} perDay={perDay} onSave={saveRule} onCancel={() => setEditing(null)} />
          : <button type="button" className="pg-btn-ghost" onClick={() => setEditing("new")}><Plus size={11} /> Add rule</button>)}
      </div>
    </div>
  );
}

function toForm(w) {
  return {
    include: w ? !!w.include : true,
    clickup_user_names: [...(w?.clickup_user_names || [])],
    xero_name: w?.xero_name || "",
    start_date: w?.start_date ? String(w.start_date).slice(0, 10) : "",
    end_date: w?.end_date ? String(w.end_date).slice(0, 10) : "",
  };
}

/* ---------------------------------------------------------------- screen ---------------- */
export function WageSettings({ roster, wagePeople, rules, settingsRow, seenUsers, monthKey, onChanged }) {
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  const perDay = normaliseSettings(settingsRow).hours_per_day;
  const wpById = new Map((wagePeople || []).map((w) => [w.person_id, w]));
  const people = [...(roster || [])]
    .filter((p) => !q || String(p.name || "").toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return (
    <div className="wr-settings">
      <GlobalSettings settingsRow={settingsRow} seenUsers={seenUsers} onSaved={() => onChanged(["settings"])} />
      <section className="wr-panel">
        <div className="wr-inline" style={{ justifyContent: "space-between" }}>
          <h2 className="wr-panel__title">People</h2>
          <input className="pg-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people…" aria-label="Search people" />
        </div>
        <ul className="wr-people">
          {people.map((p) => {
            const w = wpById.get(p.id);
            const ruleList = (rules || []).filter((r) => r.person_id === p.id);
            const isOpen = open === p.id;
            const status = !w ? "Needs setup" : !w.include ? "Excluded" : ruleList.length ? `${ruleList.length} rule${ruleList.length === 1 ? "" : "s"}` : "No hours rule";
            return (
              <li key={p.id} className="wr-people__item">
                <button type="button" className="wr-people__row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.id)}>
                  {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  <PersonAvatar name={p.name} photo={p.photo} size={28} />
                  <span className="wr-people__name">{p.name}</span>
                  <span className="wr-chip">{p.state || "?"}</span>
                  <span className={"wr-chip" + (!w || (w.include && !ruleList.length) ? " wr-chip--warn" : "")}>{status}</span>
                  {w?.clickup_user_names?.length > 0 && <span className="wr-note wr-people__cu">{w.clickup_user_names.join(", ")}</span>}
                </button>
                {isOpen && (
                  <PersonSettings rosterPerson={p} wageRow={w || null} rules={ruleList} seenUsers={seenUsers} monthKey={monthKey} perDay={perDay} onChanged={onChanged} />
                )}
              </li>
            );
          })}
        </ul>
        <p className="wr-note">Name, photo and state come from the Consultants roster. A person must be on that roster to be set up here.</p>
      </section>
    </div>
  );
}
