import React, { useCallback, useId, useRef, useState } from "react";
import { Trash2, Loader2, X, KeyRound } from "lucide-react";
import { updateUserRoleAndClients, deleteUser, setUserAccess, resetUserPassword } from "./usersSync.js";
import { ROLES, ROLE_LABELS, CLIENT_SCOPED_ROLES, CLICKUP_REQUIRED_ROLES, CLIENT_SOURCE_LABELS, ADMIN_TIER_ROLES } from "./roles.js";
import { overrideChanges, hasAccessConfig } from "./permissions.js";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import {
  ClientCheckboxList, TeamMemberField, PersonField, WageSetupCheck, ModuleAccessEditor, isClickupNameValid,
} from "./UserFields.jsx";

// Settings → Users & permissions: the per-user drawer. Modal (wages.css's .wr-drawer
// overlay), focus-trapped, Escape closes unless a save/delete is in flight.

const toggleIn = (list, item) => (list.includes(item) ? list.filter((c) => c !== item) : [...list, item]);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const errText = (e) => e?.message || String(e);

function DrawerSection({ title, children }) {
  return (
    <section className="wr-sec">
      <header className="wr-sec__head"><h3 className="wr-sec__title">{title}</h3></header>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

// Account / Identity / Module access / Clients for one user. Role, ClickUp name and manual
// clients save through update_role_and_clients (signs them out only if the role changed);
// roster person and module access through set_access (no sign-out). Data access changes at
// once (RLS), and their nav refetches on focus. One Save runs whichever of the two changed.
// Access fields (roster person, module access) only show once `list` returned the grantable
// modules (hasAccessConfig) -- an older manage-users would silently drop them.
export default function UserDrawer({ user, ownRole, presets, moduleScopes, allClients, clickupNames, roster, rosterError, wagePeople, wageError, linkedTo, onClose, onChanged, onRemoved }) {
  const manualClients = (user.clientDetails || []).filter((cd) => cd.source === "manual").map((cd) => cd.client);
  const derived = (user.clientDetails || []).filter((cd) => cd.source !== "manual");
  const [draft, setDraft] = useState(() => ({
    role: user.role, clickupUserName: user.clickupUserName || "", clients: manualClients,
    personId: user.personId || "", overrides: { ...(user.moduleOverrides || {}) },
  }));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  // Reset password: null = closed, string = the temporary password being typed.
  const [tempPassword, setTempPassword] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const closeRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: closeRef });
  const busy = saving || deleting || resetting;
  useEscape(useCallback(() => { if (!busy) onClose(); }, [busy, onClose]));
  const roleId = useId();
  const clickupId = useId();
  const personFieldId = useId();
  const accessId = useId();
  const titleId = useId();
  const passwordId = useId();

  const isAdminRole = ADMIN_TIER_ROLES.has(draft.role);
  const accessEditable = !isAdminRole && hasAccessConfig(moduleScopes);
  const clickupValid = isClickupNameValid(draft.role, draft.clickupUserName, clickupNames);
  const accountChanged = draft.role !== user.role
    || draft.clickupUserName.trim() !== (user.clickupUserName || "")
    || !sameSet(CLIENT_SCOPED_ROLES.has(draft.role) ? draft.clients : [], CLIENT_SCOPED_ROLES.has(user.role) ? manualClients : []);
  const moduleChanges = overrideChanges(user.moduleOverrides || {}, draft.overrides);
  const personChanged = (draft.personId || null) !== (user.personId || null);
  // set_access refuses admin-tier targets: access fields only apply to non-admin roles.
  const accessChanged = accessEditable && (personChanged || Object.keys(moduleChanges).length > 0);

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
          moduleChanges,
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

  // Only a Super Admin may reset a Super Admin's password (checked server-side too).
  const canResetPassword = user.role !== "super_admin" || ownRole === "super_admin";
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
            <span className="pg-footnote">Changing role signs them out. ClickUp name and client changes apply as soon as you save, without signing them out.</span>
          </label>
          {!canResetPassword ? (
            <p className="pg-footnote">Only a Super Admin can reset a Super Admin's password.</p>
          ) : tempPassword === null ? (
            <div>
              <button type="button" className="pg-btn-ghost" disabled={busy} onClick={() => { setTempPassword(""); setResetDone(false); }} style={{ gap: 6 }}>
                <KeyRound size={13} /> Reset password
              </button>
              {resetDone && <p className="pg-footnote" role="status">Password reset. Give them the temporary password — they'll choose their own when they next sign in.</p>}
            </div>
          ) : (
            <div className="pg-field">
              <label className="pg-field__label" htmlFor={passwordId}>New temporary password</label>
              <input id={passwordId} className="pg-input" type="text" autoComplete="off" placeholder="At least 8 characters" value={tempPassword}
                disabled={resetting} onChange={(e) => setTempPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); resetPassword(); } }} />
              <span className="pg-footnote">Signs them out everywhere. They'll be asked to choose their own password when they next sign in.</span>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button type="button" className="pg-btn" disabled={busy || tempPassword.length < 8} onClick={resetPassword} style={{ gap: 6 }}>
                  {resetting && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
                  {resetting ? "Resetting…" : "Set temporary password"}
                </button>
                <button type="button" className="pg-btn-ghost" disabled={resetting} onClick={() => setTempPassword(null)}>Cancel</button>
              </div>
            </div>
          )}
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
          ) : !accessEditable ? (
            <p className="pg-footnote">Roster person and module access need the updated user-management service — not available yet.</p>
          ) : (
            <>
              <PersonField id={personFieldId} value={draft.personId} onChange={(v) => setDraft((d) => ({ ...d, personId: v }))}
                roster={roster} rosterError={rosterError} linkedTo={linkedTo} />
              <WageSetupCheck personId={draft.personId} wagePeople={wagePeople} wageError={wageError} />
            </>
          )}
        </DrawerSection>

        <DrawerSection title="Module access">
          {isAdminRole || accessEditable ? (
            <ModuleAccessEditor role={draft.role} overrides={draft.overrides} onChange={(overrides) => setDraft((d) => ({ ...d, overrides }))}
              presets={presets} moduleScopes={moduleScopes} disabled={busy} idBase={accessId} />
          ) : <p className="pg-footnote">Their role default applies. Per-user module access isn't available yet.</p>}
          {accessEditable && <p className="pg-footnote">Takes effect the next time they switch back to the app — no sign-out needed.</p>}
        </DrawerSection>

        <DrawerSection title="Clients">
          {isAdminRole ? <p className="pg-footnote">Admins see every client.</p> : (
            <>
              {derived.length > 0 ? (
                <div className="pg-chip-list" aria-label="Automatically assigned clients">
                  {derived.map((cd) => <span key={`${cd.client}-${cd.source}`} className="pg-source-chip">{cd.client} · {CLIENT_SOURCE_LABELS[cd.source] || cd.source}</span>)}
                </div>
              ) : <p className="pg-footnote">No clients name them as Consultant yet (Clients module), and none via Capacity Planning.</p>}
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

