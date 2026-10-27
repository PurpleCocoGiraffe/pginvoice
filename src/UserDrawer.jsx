import React, { useCallback, useId, useRef, useState } from "react";
import { Trash2, Loader2, X, KeyRound } from "lucide-react";
import { createUser, updateUserRoleAndClients, deleteUser, setUserAccess, resetUserPassword } from "./usersSync.js";
import { ROLES, ROLE_LABELS, CLIENT_SCOPED_ROLES, CLICKUP_REQUIRED_ROLES, CLIENT_SOURCE_LABELS, ADMIN_TIER_ROLES } from "./roles.js";
import { overrideChanges, hasAccessConfig } from "./permissions.js";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import { ClientAvatar } from "./avatar.jsx";
import {
  ClientPicker, TeamMemberField, PersonField, WageSetupCheck, ModuleAccessEditor, isClickupNameValid,
} from "./UserFields.jsx";

// Settings → Users & permissions: one drawer for adding (user = null) and editing a team
// member. Modal (wages.css's .wr-drawer overlay), focus-trapped, Escape closes unless a
// save/delete is in flight.

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const errText = (e) => e?.message || String(e);

// No separate name field: an account's name is its ClickUp name, else its email's local part.
export const displayNameFor = (u) => u.clickupUserName || (u.email || "").split("@")[0] || u.email;

function DrawerSection({ title, action, children }) {
  return (
    <section className="wr-sec">
      <header className="wr-sec__head"><h3 className="wr-sec__title">{title}</h3>{action}</header>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
    </section>
  );
}

const newDraft = () => ({ email: "", password: "", role: "consultant", clickupUserName: "", clients: [], personId: "", overrides: {} });

// Edit: role, ClickUp name and manual clients save through update_role_and_clients (signs
// them out only if the role changed); roster person and module access through set_access
// (no sign-out). Data access changes at once (RLS), and their nav refetches on focus. One
// Save runs whichever of the two changed. Add: one create call carries everything.
// Access fields (roster person, module access) only show once `list` returned the grantable
// modules (hasAccessConfig) -- an older manage-users would silently drop them.
export default function UserDrawer({ user, ownRole, presets, moduleScopes, allClients, clickupNames, roster, rosterError, wagePeople, wageError, linkedTo, startWithReset = false, onClose, onChanged, onRemoved }) {
  const isNew = !user;
  const manualClients = (user?.clientDetails || []).filter((cd) => cd.source === "manual").map((cd) => cd.client);
  const derived = (user?.clientDetails || []).filter((cd) => cd.source !== "manual");
  const [draft, setDraft] = useState(() => (isNew ? newDraft() : {
    role: user.role, clickupUserName: user.clickupUserName || "", clients: manualClients,
    personId: user.personId || "", overrides: { ...(user.moduleOverrides || {}) },
  }));
  // Only a Super Admin may reset a Super Admin's password (checked server-side too).
  const canResetPassword = !isNew && (user.role !== "super_admin" || ownRole === "super_admin");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  // Reset password: null = closed, string = the temporary password being typed.
  const [tempPassword, setTempPassword] = useState(startWithReset && canResetPassword ? "" : null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const closeRef = useRef(null);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: isNew ? emailRef : tempPassword !== null ? passwordRef : closeRef });
  const busy = saving || deleting || resetting;
  useEscape(useCallback(() => { if (!busy) onClose(); }, [busy, onClose]));
  const ids = { role: useId(), name: useId(), email: useId(), password: useId(), clickup: useId(), person: useId(), access: useId(), clients: useId(), reset: useId(), title: useId() };

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const isAdminRole = ADMIN_TIER_ROLES.has(draft.role);
  const accessEditable = !isAdminRole && hasAccessConfig(moduleScopes);
  const clickupValid = isClickupNameValid(draft.role, draft.clickupUserName, clickupNames);
  const clientScoped = CLIENT_SCOPED_ROLES.has(draft.role);
  const hasOverrides = Object.keys(draft.overrides).length > 0;

  const accountChanged = !isNew && (draft.role !== user.role
    || draft.clickupUserName.trim() !== (user.clickupUserName || "")
    || !sameSet(clientScoped ? draft.clients : [], CLIENT_SCOPED_ROLES.has(user.role) ? manualClients : []));
  const moduleChanges = isNew ? {} : overrideChanges(user.moduleOverrides || {}, draft.overrides);
  const personChanged = !isNew && (draft.personId || null) !== (user.personId || null);
  // set_access refuses admin-tier targets: access fields only apply to non-admin roles.
  const accessChanged = accessEditable && (personChanged || Object.keys(moduleChanges).length > 0);
  const canSave = isNew
    ? draft.email.trim().includes("@") && draft.password.length >= 8 && clickupValid
    : clickupValid && (accountChanged || accessChanged);

  async function create() {
    const email = draft.email.trim();
    await createUser({
      email,
      password: draft.password,
      role: draft.role,
      clients: clientScoped ? draft.clients : [],
      clickupUserName: draft.clickupUserName.trim(),
      personId: accessEditable ? (draft.personId || undefined) : undefined,
      moduleOverrides: accessEditable ? draft.overrides : undefined,
    });
    await onChanged(`${email} was added. Give them the temporary password — they'll choose their own when they first sign in.`);
    onClose();
  }

  async function update() {
    let accountSaved = false;
    try {
      if (accountChanged) {
        await updateUserRoleAndClients({
          userId: user.id, role: draft.role,
          clients: clientScoped ? draft.clients : [],
          clickupUserName: draft.clickupUserName.trim(),
        });
        accountSaved = true;
      }
      if (accessChanged) {
        await setUserAccess({
          userId: user.id,
          personId: personChanged ? (draft.personId || null) : undefined,
          moduleChanges,
        });
      }
      await onChanged(`${user.email} updated.`);
      onClose();
    } catch (e) {
      if (!accountSaved) throw e;
      await onChanged(null);
      throw new Error(`Role, ClickUp user and clients were saved, but access wasn't: ${errText(e)}`);
    }
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await (isNew ? create() : update());
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword() {
    if (!tempPassword || tempPassword.length < 8) return;
    setResetting(true);
    setError(null);
    try {
      await resetUserPassword(user.id, tempPassword);
      setTempPassword(null);
      setResetDone(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setResetting(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${user.email}'s access? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteUser(user.id);
      await onChanged(`${user.email} was removed.`);
      onRemoved(); // closes the drawer; the trigger row is gone, so focus moves to the list heading
    } catch (e) {
      setError(errText(e));
      setDeleting(false);
    }
  }

  // Add: switching role starts the role-specific parts (clients, module overrides) over.
  const onRole = (role) => set(isNew ? { role, clients: [], overrides: {} } : { role });
  const name = isNew ? draft.clickupUserName : displayNameFor({ ...user, clickupUserName: draft.clickupUserName });

  return (
    <>
      <div className="wr-drawer-backdrop" onClick={() => { if (!busy) onClose(); }} aria-hidden="true" />
      <aside ref={dialogRef} tabIndex={-1} className="wr-drawer pg-team-drawer" role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <div className="wr-drawer__title">
          {!isNew && <ClientAvatar name={name} size={40} />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="wr-drawer__name" id={ids.title}>{isNew ? "Add team member" : name}</h2>
            <div className="wr-drawer__sub">
              {isNew ? "They sign in with a temporary password, then choose their own."
                : `${user.email} · ${user.lastSignInAt ? `last signed in ${new Date(user.lastSignInAt).toLocaleDateString()}` : "never signed in"}`}
            </div>
          </div>
          <button type="button" ref={closeRef} className="wr-iconbtn" onClick={onClose} disabled={busy} aria-label="Close"><X size={16} /></button>
        </div>

        <DrawerSection title="Profile">
          <div className="pg-team-grid">
            <label className="pg-field" htmlFor={ids.name}>
              <span className="pg-field__label">Full name</span>
              <input id={ids.name} className="pg-input" readOnly value={draft.clickupUserName} placeholder="Comes from their ClickUp user" />
            </label>
            <label className="pg-field" htmlFor={ids.role}>
              <span className="pg-field__label">Role</span>
              <select id={ids.role} className="pg-input" value={draft.role} disabled={busy} onChange={(e) => onRole(e.target.value)}>
                {ROLES.filter((r) => r !== "super_admin" || ownRole === "super_admin" || user?.role === "super_admin").map((r) => (
                  <option key={r} value={r} disabled={r === "super_admin" && ownRole !== "super_admin"}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </label>
          </div>
          {!isNew && draft.role !== user.role && <p className="pg-footnote">Changing role signs them out when you save.</p>}
          <label className="pg-field" htmlFor={ids.email}>
            <span className="pg-field__label">Email</span>
            <input id={ids.email} ref={emailRef} className="pg-input" type="email" autoComplete="off" placeholder="name@purplegiraffe.com.au"
              readOnly={!isNew} value={isNew ? draft.email : user.email} disabled={busy && isNew} onChange={(e) => set({ email: e.target.value })} />
          </label>
          {isNew && (
            <label className="pg-field" htmlFor={ids.password}>
              <span className="pg-field__label">Temporary password</span>
              <input id={ids.password} className="pg-input" type="text" autoComplete="off" placeholder="At least 8 characters"
                value={draft.password} disabled={busy} onChange={(e) => set({ password: e.target.value })} />
            </label>
          )}
          <div className="pg-team-grid">
            <TeamMemberField id={ids.clickup} value={draft.clickupUserName} onChange={(v) => set({ clickupUserName: v })}
              clickupNames={clickupNames} required={CLICKUP_REQUIRED_ROLES.has(draft.role)} />
            {accessEditable && (
              <PersonField id={ids.person} value={draft.personId} onChange={(v) => set({ personId: v })}
                roster={roster} rosterError={rosterError} linkedTo={linkedTo} />
            )}
          </div>
          {accessEditable && <WageSetupCheck personId={draft.personId} wagePeople={wagePeople} wageError={wageError} />}
          {isAdminRole ? <p className="pg-footnote">A roster person is only linked for Consultant and Coordinator accounts.</p>
            : !accessEditable && <p className="pg-footnote">Roster person and module access need the updated user-management service — not available yet.</p>}
        </DrawerSection>

        <DrawerSection title="Module access" action={accessEditable && hasOverrides && (
          <button type="button" className="pg-access-reset" disabled={busy} onClick={() => set({ overrides: {} })}>Reset to role defaults</button>
        )}>
          {isAdminRole || accessEditable ? (
            <ModuleAccessEditor role={draft.role} overrides={draft.overrides} onChange={(overrides) => set({ overrides })}
              presets={presets} moduleScopes={moduleScopes} disabled={busy} idBase={ids.access} />
          ) : <p className="pg-footnote">Their role default applies. Per-user module access isn't available yet.</p>}
          {accessEditable && !isNew && <p className="pg-footnote">Takes effect the next time they switch back to the app — no sign-out needed.</p>}
        </DrawerSection>

        <DrawerSection title="Client access">
          {isAdminRole ? <p className="pg-footnote">Admins see every client.</p> : (
            <>
              {!isNew && (derived.length > 0 ? (
                <div className="pg-field">
                  <span className="pg-field__label">Automatic</span>
                  <div className="pg-chip-list" aria-label="Automatically assigned clients">
                    {derived.map((cd) => <span key={`${cd.client}-${cd.source}`} className="pg-source-chip">{cd.client} · {CLIENT_SOURCE_LABELS[cd.source] || cd.source}</span>)}
                  </div>
                </div>
              ) : <p className="pg-footnote">No active client names them as Consultant yet (Clients module).</p>)}
              <p className="pg-footnote">
                {isNew ? "They automatically get the active clients that name them as Consultant in the Clients module." : "These follow the Consultant field in the Clients module and update by themselves."}
                {" "}A client they log time on in a month also shows in their Client Accruals for that month, with its package figures hidden.
              </p>
              {clientScoped && (
                <ClientPicker id={ids.clients} label="Additional client access (optional)" options={allClients} selected={draft.clients}
                  exclude={derived.map((cd) => cd.client)} disabled={busy} onChange={(clients) => set({ clients })} />
              )}
            </>
          )}
        </DrawerSection>

        {!isNew && (
          <DrawerSection title="Account">
            {!canResetPassword ? (
              <p className="pg-footnote">Only a Super Admin can reset a Super Admin's password.</p>
            ) : tempPassword === null ? (
              <div>
                <button type="button" className="pg-btn-ghost" disabled={busy} onClick={() => { setTempPassword(""); setResetDone(false); }}>
                  <KeyRound size={13} /> Reset password
                </button>
                {resetDone && <p className="pg-footnote" role="status" style={{ marginTop: 6 }}>Password reset. Give them the temporary password — they'll choose their own when they next sign in.</p>}
              </div>
            ) : (
              <div className="pg-field">
                <label className="pg-field__label" htmlFor={ids.reset}>New temporary password</label>
                <input id={ids.reset} ref={passwordRef} className="pg-input" type="text" autoComplete="off" placeholder="At least 8 characters" value={tempPassword}
                  disabled={resetting} onChange={(e) => setTempPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resetPassword(); } }} />
                <span className="pg-footnote">Signs them out everywhere. They'll be asked to choose their own password when they next sign in.</span>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button type="button" className="pg-btn-ghost pg-btn-ghost--accent" disabled={busy || tempPassword.length < 8} onClick={resetPassword}>
                    {resetting && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
                    {resetting ? "Resetting…" : "Set temporary password"}
                  </button>
                  <button type="button" className="pg-btn-ghost" disabled={resetting} onClick={() => setTempPassword(null)}>Cancel</button>
                </div>
              </div>
            )}
            <div>
              <button type="button" className="pg-btn-ghost pg-btn-ghost--danger" disabled={busy} onClick={remove}>
                {deleting ? <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} /> : <Trash2 size={13} />} Remove user
              </button>
            </div>
          </DrawerSection>
        )}

        <div aria-live="polite">{error && <p className="pg-footnote" role="alert" style={{ color: "var(--status-over-text)" }}>{error}</p>}</div>
        <div className="pg-team-foot">
          <button className="pg-btn-ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="pg-btn" type="button" disabled={busy || !canSave} onClick={save}>
            {saving && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
            {saving ? (isNew ? "Creating…" : "Saving…") : (isNew ? "Create account" : "Save changes")}
          </button>
        </div>
      </aside>
    </>
  );
}
