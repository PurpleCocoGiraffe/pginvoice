import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Trash2, Loader2, ShieldCheck, AlertTriangle, X, Lock } from "lucide-react";
import {
  fetchUsers, createUser, updateUserRoleAndClients, deleteUser, fetchClickupUserNames, setUserAccess,
  ROLES, ROLE_LABELS, CLIENT_SCOPED_ROLES, CLICKUP_REQUIRED_ROLES, CLIENT_SOURCE_LABELS, ADMIN_TIER_ROLES,
} from "./usersSync.js";
import { fetchClients } from "./clientsSync.js";
import { loadKey, SEED_PEOPLE } from "./capacityData.js";
import { CAP_PEOPLE_KEY } from "./storageKeys.js";
import { fetchWagePeople } from "./wagesSync.js";
import { NAV_MODULES, SCOPES, SCOPE_LABELS, resolveModuleScope, accessSummary } from "./permissions.js";
import { useEscape, useFocusTrap } from "./useDismissable.js";

const emptyDraft = { email: "", password: "", role: "consultant", clients: [], clickupUserName: "", personId: "", overrides: {} };
const toggleIn = (list, item) => (list.includes(item) ? list.filter((c) => c !== item) : [...list, item]);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const errText = (e) => e?.message || String(e);

// Shared between the "add user" form and the user drawer.
function ClientCheckboxList({ label, options, selected, onToggle }) {
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
function TeamMemberField({ id, value, onChange, clickupNames, required }) {
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
function PersonField({ id, value, onChange, roster, rosterError, linkedTo }) {
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

function WageSetupCheck({ personId, wagePeople, wageError }) {
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

// One row per grantable module (pginvoice_module_scopes), with only that module's
// allowed scopes. Picking the role default clears the override, so the user keeps
// following their role's preset if it changes later. Admin tier is locked: always full.
function ModuleAccessEditor({ role, overrides, onChange, presets, moduleScopes, disabled, idBase }) {
  if (ADMIN_TIER_ROLES.has(role)) {
    return <p className="pg-footnote" style={{ display: "flex", alignItems: "center", gap: 6 }}><Lock size={12} aria-hidden="true" /> Admins have full access.</p>;
  }
  const modules = NAV_MODULES.filter((m) => moduleScopes[m.key]);
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
        const allowed = SCOPES.filter((s) => moduleScopes[m.key].includes(s));
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
            <span className="pg-seg" role="radiogroup" aria-labelledby={labelId}>
              {allowed.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={scope === s} disabled={disabled}
                  className={"pg-seg__opt" + (scope === s ? " is-active" : "")} onClick={() => set(m.key, s)}>
                  {SCOPE_LABELS[s]}
                </button>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DrawerSection({ title, children }) {
  return (
    <section className="wr-sec">
      <header className="wr-sec__head"><h3 className="wr-sec__title">{title}</h3></header>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

// Account / Identity / Module access / Clients for one user. Role, ClickUp name and manual
// clients save through update_role_and_clients (which signs them out so it applies at
// once); roster person and module access through set_access (no sign-out -- their nav
// refetches on focus). One Save runs whichever of the two changed.
function UserDrawer({ user, ownRole, presets, moduleScopes, allClients, clickupNames, roster, rosterError, wagePeople, wageError, linkedTo, onClose, onChanged }) {
  const manualClients = (user.clientDetails || []).filter((cd) => cd.source === "manual").map((cd) => cd.client);
  const derived = (user.clientDetails || []).filter((cd) => cd.source !== "manual");
  const [draft, setDraft] = useState(() => ({
    role: user.role, clickupUserName: user.clickupUserName || "", clients: manualClients,
    personId: user.personId || "", overrides: { ...(user.moduleOverrides || {}) },
  }));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const closeRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: closeRef });
  const busy = saving || deleting;
  useEscape(useCallback(() => { if (!busy) onClose(); }, [busy, onClose]));
  const roleId = useId();
  const clickupId = useId();
  const personId = useId();
  const accessId = useId();
  const titleId = useId();

  const isAdminRole = ADMIN_TIER_ROLES.has(draft.role);
  const clickupValid = !CLICKUP_REQUIRED_ROLES.has(draft.role)
    || (!!draft.clickupUserName.trim() && clickupNames.some((n) => n.toLowerCase() === draft.clickupUserName.trim().toLowerCase()));
  const accountChanged = draft.role !== user.role
    || draft.clickupUserName.trim() !== (user.clickupUserName || "")
    || !sameSet(CLIENT_SCOPED_ROLES.has(draft.role) ? draft.clients : [], CLIENT_SCOPED_ROLES.has(user.role) ? manualClients : []);
  const before = user.moduleOverrides || {};
  const moduleChanges = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(draft.overrides)])) {
    if ((before[k] ?? null) !== (draft.overrides[k] ?? null)) moduleChanges[k] = draft.overrides[k] ?? null;
  }
  const personChanged = (draft.personId || null) !== (user.personId || null);
  // set_access refuses admin-tier targets: access fields only apply to non-admin roles.
  const accessChanged = !isAdminRole && (personChanged || Object.keys(moduleChanges).length > 0);

  async function save() {
    setSaving(true);
    setError(null);
    let accountSaved = false;
    try {
      if (accountChanged) {
        await updateUserRoleAndClients({
          userId: user.id, role: draft.role,
          clients: CLIENT_SCOPED_ROLES.has(draft.role) ? draft.clients : [],
          clickupUserName: draft.clickupUserName.trim(),
        });
        accountSaved = true;
      }
      if (accessChanged) {
        await setUserAccess({
          userId: user.id,
          personId: personChanged ? (draft.personId || null) : undefined,
          modules: moduleChanges,
        });
      }
      await onChanged(`${user.email} updated.`);
      onClose();
    } catch (e) {
      setError(accountSaved ? `Role, ClickUp name and clients were saved, but access wasn't: ${errText(e)}` : errText(e));
      if (accountSaved) await onChanged(null);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${user.email}'s access? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteUser(user.id);
      await onChanged(`${user.email} was removed.`);
      onClose();
    } catch (e) {
      setError(errText(e));
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="wr-drawer-backdrop" onClick={() => { if (!busy) onClose(); }} aria-hidden="true" />
      <aside ref={dialogRef} tabIndex={-1} className="wr-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="wr-drawer__bar">
          <button type="button" ref={closeRef} className="wr-iconbtn" style={{ marginLeft: "auto" }} onClick={onClose} disabled={busy} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="wr-drawer__title">
          <div>
            <h2 className="wr-drawer__name" id={titleId}>{user.email}</h2>
            <div className="wr-drawer__sub">{ROLE_LABELS[user.role] || user.role}{user.lastSignInAt ? ` · last signed in ${new Date(user.lastSignInAt).toLocaleDateString()}` : " · never signed in"}</div>
          </div>
        </div>

        <DrawerSection title="Account">
          <label className="pg-field" htmlFor={roleId}>
            <span className="pg-field__label">Role</span>
            <select id={roleId} className="pg-input" value={draft.role} disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}>
              {ROLES.filter((r) => r !== "super_admin" || ownRole === "super_admin" || user.role === "super_admin").map((r) => (
                <option key={r} value={r} disabled={r === "super_admin" && ownRole !== "super_admin"}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <span className="pg-footnote">Changing role, ClickUp name or clients signs them out so it applies straight away.</span>
          </label>
          <div>
            <button type="button" className="pg-btn-ghost" disabled={busy} onClick={remove} style={{ gap: 6 }}>
              {deleting ? <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} /> : <Trash2 size={13} />} Remove user
            </button>
          </div>
        </DrawerSection>

        <DrawerSection title="Identity">
          <TeamMemberField id={clickupId} value={draft.clickupUserName} onChange={(v) => setDraft((d) => ({ ...d, clickupUserName: v }))}
            clickupNames={clickupNames} required={CLICKUP_REQUIRED_ROLES.has(draft.role)} />
          {isAdminRole ? (
            <p className="pg-footnote">A roster person is only linked for Consultant and Coordinator accounts.</p>
          ) : (
            <>
              <PersonField id={personId} value={draft.personId} onChange={(v) => setDraft((d) => ({ ...d, personId: v }))}
                roster={roster} rosterError={rosterError} linkedTo={linkedTo} />
              <WageSetupCheck personId={draft.personId} wagePeople={wagePeople} wageError={wageError} />
            </>
          )}
        </DrawerSection>

        <DrawerSection title="Module access">
          <ModuleAccessEditor role={draft.role} overrides={draft.overrides} onChange={(overrides) => setDraft((d) => ({ ...d, overrides }))}
            presets={presets} moduleScopes={moduleScopes} disabled={busy} idBase={accessId} />
          {!isAdminRole && <p className="pg-footnote">Takes effect the next time they switch back to the app — no sign-out needed.</p>}
        </DrawerSection>

        <DrawerSection title="Clients">
          {isAdminRole ? <p className="pg-footnote">Admins see every client.</p> : (
            <>
              {derived.length > 0 ? (
                <div className="pg-chip-list" aria-label="Automatically assigned clients">
                  {derived.map((cd) => <span key={`${cd.client}-${cd.source}`} className="pg-source-chip">{cd.client} · {CLIENT_SOURCE_LABELS[cd.source] || cd.source}</span>)}
                </div>
              ) : <p className="pg-footnote">No clients assigned via ClickUp or Capacity Planning yet.</p>}
              {CLIENT_SCOPED_ROLES.has(draft.role) && (
                <ClientCheckboxList label="Also grant these clients manually" options={allClients} selected={draft.clients}
                  onToggle={(c) => setDraft((d) => ({ ...d, clients: toggleIn(d.clients, c) }))} />
              )}
            </>
          )}
        </DrawerSection>

        <div aria-live="polite">{error && <p className="pg-footnote" role="alert" style={{ color: "var(--status-over)" }}>{error}</p>}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="pg-btn" type="button" disabled={busy || !clickupValid || (!accountChanged && !accessChanged)} onClick={save} style={{ gap: 6 }}>
            {saving && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button className="pg-btn-ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </aside>
    </>
  );
}

// Settings → Users & permissions. Super Admin + Admin only (enforced both by Shell.jsx's
// nav gating and, for real, by the manage-users Edge Function checking the caller's role
// server-side before touching anything).
export default function Users({ ownRole, ownUserId }) {
  const [data, setData] = useState(null); // { users, presets, moduleScopes }
  const [allClients, setAllClients] = useState([]);
  const [clickupNames, setClickupNames] = useState([]);
  const [roster, setRoster] = useState([]);
  const [rosterError, setRosterError] = useState(null);
  const [wagePeople, setWagePeople] = useState([]);
  const [wageError, setWageError] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const createClickupId = useId();
  const createPersonId = useId();
  const createAccessId = useId();

  async function load() {
    try {
      const [u, c, names] = await Promise.all([fetchUsers(), fetchClients(), fetchClickupUserNames()]);
      setData(u);
      setAllClients((c || []).map((row) => row.client).sort());
      setClickupNames(names);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
    // Secondary: a failure here only disables the person picker / wage check line.
    const [r, w] = await Promise.allSettled([loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE), fetchWagePeople()]);
    if (r.status === "fulfilled") {
      setRoster((Array.isArray(r.value) ? r.value : []).filter((p) => p && p.id).sort((a, b) => String(a.name).localeCompare(String(b.name))));
      setRosterError(null);
    } else setRosterError(errText(r.reason));
    if (w.status === "fulfilled") { setWagePeople(w.value); setWageError(null); } else setWageError(errText(w.reason));
  }

  useEffect(() => { load(); }, []);

  const users = data?.users ?? null;
  const presets = data?.presets ?? {};
  const moduleScopes = data?.moduleScopes ?? {};
  const rosterName = useMemo(() => Object.fromEntries(roster.map((p) => [p.id, p.name])), [roster]);
  const linkedToFor = (excludeUserId) => Object.fromEntries((users || [])
    .filter((u) => u.personId && u.id !== excludeUserId).map((u) => [u.personId, u.email]));

  const createClickupValid = useMemo(() => {
    if (!CLICKUP_REQUIRED_ROLES.has(draft.role)) return true;
    const trimmed = draft.clickupUserName.trim();
    return !!trimmed && clickupNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  }, [draft.role, draft.clickupUserName, clickupNames]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!draft.email.trim() || draft.password.length < 8 || !createClickupValid) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    const isAdminRole = ADMIN_TIER_ROLES.has(draft.role);
    try {
      await createUser({
        email: draft.email.trim(),
        password: draft.password,
        role: draft.role,
        clients: CLIENT_SCOPED_ROLES.has(draft.role) ? draft.clients : [],
        clickupUserName: draft.clickupUserName.trim(),
        personId: isAdminRole ? undefined : (draft.personId || undefined),
        moduleOverrides: isAdminRole ? undefined : draft.overrides,
      });
      setDraft(emptyDraft);
      setNotice(`${draft.email.trim()} was added.`);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setCreating(false);
    }
  }

  const onChanged = useCallback(async (message) => {
    setError(null);
    if (message) setNotice(message);
    await load();
  }, []);
  const closeDrawer = useCallback(() => setOpenId(null), []);
  const openUser = users?.find((u) => u.id === openId) || null;

  return (
    <div>
      {/* aria-live so screen-reader users hear the outcome of create/save/delete,
          not just sighted users watching the banner appear. */}
      <div aria-live="polite">
        {error && <p className="pg-footnote" style={{ color: "var(--status-over)" }}>{error}</p>}
        {notice && !error && <p className="pg-footnote" style={{ color: "var(--status-ok)" }}>{notice}</p>}
      </div>

      <div className="pg-cap-card" style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ShieldCheck size={16} />
          <h2 style={{ margin: 0, fontSize: 15 }}>Add a user</h2>
        </div>
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label className="pg-field">
            <span className="pg-field__label">Role</span>
            <select className="pg-input" value={draft.role} onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value, clients: [], overrides: {} }))}>
              {ROLES.filter((r) => r !== "super_admin" || ownRole === "super_admin").map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </label>
          <TeamMemberField
            id={createClickupId}
            value={draft.clickupUserName}
            onChange={(v) => setDraft((d) => ({ ...d, clickupUserName: v }))}
            clickupNames={clickupNames}
            required={CLICKUP_REQUIRED_ROLES.has(draft.role)}
          />
          {CLICKUP_REQUIRED_ROLES.has(draft.role) && (
            <p className="pg-footnote">
              Picking a ClickUp name auto-assigns the clients they've logged time against — tick more below if you'd also like to grant one they haven't worked on yet.
            </p>
          )}
          {!ADMIN_TIER_ROLES.has(draft.role) && (
            <PersonField id={createPersonId} value={draft.personId} onChange={(v) => setDraft((d) => ({ ...d, personId: v }))}
              roster={roster} rosterError={rosterError} linkedTo={linkedToFor(null)} />
          )}
          <label className="pg-field">
            <span className="pg-field__label">Email address</span>
            <input className="pg-input" type="email" autoComplete="off" value={draft.email} onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))} />
          </label>
          <label className="pg-field">
            <span className="pg-field__label">Temp password</span>
            <input className="pg-input" type="text" autoComplete="off" placeholder="At least 8 characters" value={draft.password} onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))} />
          </label>
          <p className="pg-footnote">They'll be asked to set their own password the first time they sign in.</p>
          {!ADMIN_TIER_ROLES.has(draft.role) && data && (
            <div className="pg-field">
              <span className="pg-field__label">Module access</span>
              <ModuleAccessEditor role={draft.role} overrides={draft.overrides} onChange={(overrides) => setDraft((d) => ({ ...d, overrides }))}
                presets={presets} moduleScopes={moduleScopes} disabled={creating} idBase={createAccessId} />
            </div>
          )}
          {CLIENT_SCOPED_ROLES.has(draft.role) && (
            <ClientCheckboxList
              label="Also grant these clients manually"
              options={allClients}
              selected={draft.clients}
              onToggle={(c) => setDraft((d) => ({ ...d, clients: toggleIn(d.clients, c) }))}
            />
          )}
          <button className="pg-btn" type="submit" disabled={creating || !draft.email.trim() || draft.password.length < 8 || !createClickupValid} style={{ justifyContent: "center", gap: 6 }}>
            {creating && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
            {creating ? "Creating…" : "Create user"}
          </button>
        </form>
      </div>

      <div className="pg-cap-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Team</h2>
        {users === null ? (
          <p className="pg-footnote">{error ? "Couldn't load users." : "Loading…"}</p>
        ) : users.length === 0 ? (
          <p className="pg-footnote">No users yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {users.map((u) => {
              const isSelf = u.id === ownUserId;
              const clientCount = new Set(u.clients || []).size;
              return (
                <div key={u.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border-default)" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{u.email}{isSelf ? " (you)" : ""}</div>
                    <div className="pg-footnote">
                      {ROLE_LABELS[u.role] || u.role}
                      {u.personId ? ` · ${rosterName[u.personId] || u.personId}` : ""}
                      {u.clickupUserName ? ` · ClickUp: ${u.clickupUserName}` : ""}
                      {CLICKUP_REQUIRED_ROLES.has(u.role) && !u.clickupUserName && (
                        <span style={{ color: "var(--status-warn, var(--status-over))" }}> · no ClickUp name flagged</span>
                      )}
                      {` · ${u.lastSignInAt ? `last signed in ${new Date(u.lastSignInAt).toLocaleDateString()}` : "never signed in"}`}
                    </div>
                    <div className="pg-footnote" style={{ marginTop: 2 }}>
                      {accessSummary({ role: u.role, overrides: u.moduleOverrides, presets, moduleScopes, clientCount })}
                    </div>
                  </div>
                  {/* Self-editing is refused server-side too; hiding it avoids a dead-end flow. */}
                  {!isSelf && (
                    <button className="pg-btn-ghost" type="button" onClick={() => setOpenId(u.id)} aria-label={`Manage ${u.email}`}>Manage</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {openUser && (
        <UserDrawer
          key={openUser.id}
          user={openUser}
          ownRole={ownRole}
          presets={presets}
          moduleScopes={moduleScopes}
          allClients={allClients}
          clickupNames={clickupNames}
          roster={roster}
          rosterError={rosterError}
          wagePeople={wagePeople}
          wageError={wageError}
          linkedTo={linkedToFor(openUser.id)}
          onClose={closeDrawer}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
