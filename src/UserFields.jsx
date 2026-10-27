import React, { useState } from "react";
import { AlertTriangle, Lock, Search, X } from "lucide-react";
import { useDismissable } from "./useDismissable.js";
import { ADMIN_TIER_ROLES, CLICKUP_REQUIRED_ROLES } from "./roles.js";
import { NAV_MODULES, SCOPES, SCOPE_LABELS, resolveModuleScope } from "./permissions.js";

// Form pieces for Settings → Users & permissions' add / edit drawer (UserDrawer).

// A role that needs a ClickUp identity must have one picked from the synced names.
export function isClickupNameValid(role, name, clickupNames) {
  if (!CLICKUP_REQUIRED_ROLES.has(role)) return true;
  const trimmed = (name || "").trim().toLowerCase();
  return !!trimmed && clickupNames.some((n) => n.toLowerCase() === trimmed);
}

// Search-and-pick for extra clients: picked ones show as removable chips. `exclude` = clients
// they already have another way (not offered again).
export function ClientPicker({ id, label, options, selected, onChange, exclude = [], disabled }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useDismissable(() => setOpen(false));
  const listId = `${id}-list`;
  const q = query.trim().toLowerCase();
  const matches = options.filter((c) => !selected.includes(c) && !exclude.includes(c) && (!q || c.toLowerCase().includes(q))).slice(0, 8);
  const add = (c) => { onChange([...selected, c]); setQuery(""); setActive(0); };
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && open && matches[active]) { e.preventDefault(); add(matches[active]); }
  };
  return (
    <div className="pg-field">
      <label className="pg-field__label" htmlFor={id}>{label}</label>
      <div className="pg-client-picker" ref={ref}>
        <span className="pg-client-picker__icon" aria-hidden="true"><Search size={14} /></span>
        <input id={id} className="pg-input pg-client-picker__input" placeholder="Search clients…" autoComplete="off" disabled={disabled}
          role="combobox" aria-expanded={open && matches.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          value={query} onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
        {open && matches.length > 0 && (
          <ul className="pg-menu pg-client-picker__menu" id={listId} role="listbox">
            {matches.map((c, i) => (
              <li key={c} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                className={"pg-menu-item" + (i === active ? " is-active" : "")}
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => add(c)}>{c}</li>
            ))}
          </ul>
        )}
      </div>
      {selected.length > 0 && (
        <div className="pg-chip-list" aria-label="Additional clients">
          {selected.map((c) => (
            <span key={c} className="pg-pick-chip">
              {c}
              <button type="button" disabled={disabled} onClick={() => onChange(selected.filter((x) => x !== c))} aria-label={`Remove ${c}`}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Picks a real ClickUp person from the synced names (rather than free-text) — picking
// from the list makes an unmatched name impossible by construction, so the only
// thing left to flag is leaving it unset on a role that requires one.
export function TeamMemberField({ id, value, onChange, clickupNames, required }) {
  const showRequiredFlag = required && !value;
  return (
    <label className="pg-field" htmlFor={id}>
      <span className="pg-field__label">ClickUp user{required ? "" : " (optional)"}</span>
      <select id={id} className="pg-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? "Select who this is…" : "— none —"}</option>
        {clickupNames.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <span className="pg-footnote">Who they are in ClickUp. Also their name here, and how the Consultant field in Clients finds them.</span>
      {showRequiredFlag && (
        <span className="pg-footnote" style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--status-warn, var(--status-over))" }}>
          <AlertTriangle size={12} />
          Required for this role.
        </span>
      )}
    </label>
  );
}

// The Consultants roster person (cap_people id) this account is. One account per person:
// people already linked to another account are listed but disabled.
export function PersonField({ id, value, onChange, roster, rosterError, linkedTo }) {
  return (
    <label className="pg-field" htmlFor={id}>
      <span className="pg-field__label">Roster person (optional)</span>
      <select id={id} className="pg-input" value={value} disabled={!!rosterError} onChange={(e) => onChange(e.target.value)}>
        <option value="">— none —</option>
        {roster.map((p) => (
          <option key={p.id} value={p.id} disabled={!!linkedTo[p.id]}>
            {p.name}{linkedTo[p.id] ? ` (linked to ${linkedTo[p.id]})` : ""}
          </option>
        ))}
        {value && !roster.some((p) => p.id === value) && <option value={value}>{value} (not on the roster)</option>}
      </select>
      {rosterError
        ? <span className="pg-footnote" style={{ color: "var(--status-over)" }}>Couldn't load the Consultants roster: {rosterError}</span>
        : <span className="pg-footnote">Their Consultants roster record, for their own billability and timesheet views.</span>}
    </label>
  );
}

export function WageSetupCheck({ personId, wagePeople, wageError }) {
  if (!personId) return null;
  if (wageError) return <p className="pg-footnote" style={{ color: "var(--status-warn, var(--status-over))" }}>Couldn't check wage setup: {wageError}</p>;
  const w = wagePeople.find((p) => p.person_id === personId);
  if (w) return <p className="pg-footnote" style={{ color: "var(--status-ok)" }}>Wage setup found{w.xero_name ? `: Xero name ${w.xero_name}` : " (no Xero name yet)"}.</p>;
  return (
    <p className="pg-footnote" style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--status-warn, var(--status-over))" }}>
      <AlertTriangle size={12} aria-hidden="true" /> No wage setup — Billability Overview (own) will show nothing.
    </p>
  );
}

// One row per grantable module (pginvoice_module_scopes), with only that module's
// allowed scopes. Picking the role default clears the override, so the user keeps
// following their role's preset if it changes later. Admin tier is locked: always full.
export function ModuleAccessEditor({ role, overrides, onChange, presets, moduleScopes, disabled, idBase }) {
  if (ADMIN_TIER_ROLES.has(role)) {
    return <p className="pg-footnote" style={{ display: "flex", alignItems: "center", gap: 6 }}><Lock size={12} aria-hidden="true" /> Admins have full access.</p>;
  }
  const modules = NAV_MODULES.filter((m) => Object.hasOwn(moduleScopes, m.key));
  if (!modules.length) return <p className="pg-footnote">No modules can be granted yet.</p>;
  const set = (key, scope) => {
    const next = { ...overrides };
    if (scope === (presets[role]?.[key] ?? "none")) delete next[key];
    else next[key] = scope;
    onChange(next);
  };
  return (
    <div>
      {modules.map((m) => {
        const { scope, source } = resolveModuleScope({ role, overrides, presets }, m.key);
        const preset = presets[role]?.[m.key] ?? "none";
        const selectId = `${idBase}-${m.key}`;
        return (
          <div key={m.key} className="pg-access-row">
            <span className="pg-access-row__label">
              <label htmlFor={selectId}>{m.label}</label>
              {source === "override" && <span className="pg-access-badge pg-access-badge--custom">Custom</span>}
            </span>
            <select id={selectId} className="pg-input pg-access-select" value={scope} disabled={disabled} onChange={(e) => set(m.key, e.target.value)}>
              {SCOPES.filter((s) => moduleScopes[m.key].includes(s)).map((s) => (
                <option key={s} value={s}>{SCOPE_LABELS[s]}{s === preset ? " (role default)" : ""}</option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
