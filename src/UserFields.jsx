import React from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { ADMIN_TIER_ROLES, CLICKUP_REQUIRED_ROLES } from "./roles.js";
import { NAV_MODULES, SCOPES, SCOPE_LABELS, resolveModuleScope } from "./permissions.js";

// Form pieces shared by Settings → Users & permissions' add-user form and UserDrawer.

// A role that needs a ClickUp identity must have one picked from the synced names.
export function isClickupNameValid(role, name, clickupNames) {
  if (!CLICKUP_REQUIRED_ROLES.has(role)) return true;
  const trimmed = (name || "").trim().toLowerCase();
  return !!trimmed && clickupNames.some((n) => n.toLowerCase() === trimmed);
}

export function ClientCheckboxList({ label, options, selected, onToggle }) {
  return (
    <div className="pg-field">
      <span className="pg-field__label">{label}</span>
      <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--border-default)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        {options.map((c) => (
          <label key={c} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={selected.includes(c)} onChange={() => onToggle(c)} />
            {c}
          </label>
        ))}
      </div>
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
      <span className="pg-field__label">ClickUp name{required ? "" : " (optional)"}</span>
      <select id={id} className="pg-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{required ? "Select who this is…" : "— none —"}</option>
        {clickupNames.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <span className="pg-footnote">This is who they are in ClickUp — it's how their worked-on clients get auto-assigned.</span>
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
        : <span className="pg-footnote">Who they are on the Consultants roster — used for their own wages and timesheet views.</span>}
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
      <AlertTriangle size={12} aria-hidden="true" /> No wage setup — Wages (own) will show nothing.
    </p>
  );
}

// Radio group with a roving tabindex: Tab enters on the checked option, arrows (and
// Home/End) move and select, matching the native radio-group pattern.
function ScopeRadioGroup({ labelledBy, options, value, onChange, disabled }) {
  const onKeyDown = (e) => {
    const i = options.indexOf(value);
    let n = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = options.length - 1;
    if (n == null || disabled) return;
    e.preventDefault();
    onChange(options[n]);
    e.currentTarget.querySelectorAll('[role="radio"]')[n]?.focus();
  };
  return (
    <span className="pg-seg" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {options.map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} tabIndex={value === s ? 0 : -1} disabled={disabled}
          className={"pg-seg__opt" + (value === s ? " is-active" : "")} onClick={() => onChange(s)}>
          {SCOPE_LABELS[s]}
        </button>
      ))}
    </span>
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
        const labelId = `${idBase}-${m.key}`;
        return (
          <div key={m.key} className="pg-access-row">
            <span className="pg-access-row__label">
              <span id={labelId}>{m.label}</span>
              <span className={"pg-access-badge" + (source === "override" ? " pg-access-badge--custom" : "")}>{source === "override" ? "Custom" : "Role default"}</span>
              {source === "override" && (
                <button type="button" className="pg-access-reset" disabled={disabled} onClick={() => set(m.key, presets[role]?.[m.key] ?? "none")}>Reset to role default</button>
              )}
            </span>
            <ScopeRadioGroup labelledBy={labelId} options={SCOPES.filter((s) => moduleScopes[m.key].includes(s))}
              value={scope} onChange={(s) => set(m.key, s)} disabled={disabled} />
          </div>
        );
      })}
    </div>
  );
}
