import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, ShieldCheck, AlertTriangle, Info } from "lucide-react";
import { fetchUsers, createUser, fetchClickupUserNames } from "./usersSync.js";
import { ROLES, ROLE_LABELS, CLIENT_SCOPED_ROLES, CLICKUP_REQUIRED_ROLES, ADMIN_TIER_ROLES } from "./roles.js";
import { fetchClients } from "./clientsSync.js";
import { loadKey, SEED_PEOPLE } from "./capacityData.js";
import { CAP_PEOPLE_KEY } from "./storageKeys.js";
import { fetchWagePeople } from "./wagesSync.js";
import { accessSummary, hasAccessConfig } from "./permissions.js";
import { ClientCheckboxList, TeamMemberField, PersonField, ModuleAccessEditor, isClickupNameValid } from "./UserFields.jsx";
import UserDrawer from "./UserDrawer.jsx";

const emptyDraft = { email: "", password: "", role: "consultant", clients: [], clickupUserName: "", personId: "", overrides: {} };
const toggleIn = (list, item) => (list.includes(item) ? list.filter((c) => c !== item) : [...list, item]);
const errText = (e) => e?.message || String(e);

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
  const matchIssues = data?.consultantMatchIssues ?? [];
  const clashes = matchIssues.filter((m) => (m.matches || []).length > 1);
  const noAccount = matchIssues.filter((m) => (m.matches || []).length === 0);
  const rosterName = useMemo(() => Object.fromEntries(roster.map((p) => [p.id, p.name])), [roster]);
  const linkedToFor = (excludeUserId) => Object.fromEntries((users || [])
    .filter((u) => u.personId && u.id !== excludeUserId).map((u) => [u.personId, u.email]));

  const createClickupValid = isClickupNameValid(draft.role, draft.clickupUserName, clickupNames);
  // Only offer roster person / module access once `list` returned the grantable modules.
  const createAccessEditable = !ADMIN_TIER_ROLES.has(draft.role) && hasAccessConfig(moduleScopes);

  async function handleCreate(e) {
    e.preventDefault();
    if (!draft.email.trim() || draft.password.length < 8 || !createClickupValid) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      await createUser({
        email: draft.email.trim(),
        password: draft.password,
        role: draft.role,
        clients: CLIENT_SCOPED_ROLES.has(draft.role) ? draft.clients : [],
        clickupUserName: draft.clickupUserName.trim(),
        personId: createAccessEditable ? (draft.personId || undefined) : undefined,
        moduleOverrides: createAccessEditable ? draft.overrides : undefined,
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
  const teamHeadingRef = useRef(null);
  // After "Remove user" the row (the drawer's trigger) is gone -- land on the list heading.
  const onRemoved = useCallback(() => {
    setOpenId(null);
    setTimeout(() => teamHeadingRef.current?.focus(), 0);
  }, []);
  const openUser = users?.find((u) => u.id === openId) || null;

  return (
    <div>
      {/* aria-live so screen-reader users hear the outcome of create/save/delete,
          not just sighted users watching the banner appear. */}
      <div aria-live="polite">
        {error && <p className="pg-footnote" style={{ color: "var(--status-over)" }}>{error}</p>}
        {notice && !error && <p className="pg-footnote" style={{ color: "var(--status-ok)" }}>{notice}</p>}
      </div>

      {/* Consultants get the active clients whose Consultant field names them (20261026_consultant_clients.sql).
          A name matching several accounts is a real problem (nobody gets those clients); a name with
          no account yet is normal while people are being set up, so it's one quiet line. */}
      {clashes.length > 0 && (
        <div className="wr-banner wr-banner--warn" role="status" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} aria-hidden="true" />
          <div className="wr-banner__body">
            These Consultant names in the Clients module match more than one team account, so nobody gets those clients automatically. Fix the name in Clients, remove the duplicate account, or tick the client for the right person here.
            <ul className="wr-banner__list">
              {clashes.map((m) => (
                <li key={m.consultant}><b>{m.consultant}</b> ({(m.clients || []).join(", ")}): matches {m.matches.join(" and ")}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {noAccount.length > 0 && (
        <div className="wr-banner wr-banner--info" role="status" style={{ marginBottom: 16 }}>
          <Info size={14} aria-hidden="true" />
          <div className="wr-banner__body">
            {noAccount.length} {noAccount.length === 1 ? "consultant named" : "consultants named"} in the Clients module {noAccount.length === 1 ? "doesn't" : "don't"} have a login yet. Create their account with their exact ClickUp name and their clients are assigned automatically.
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer" }}>Show names</summary>
              <ul className="wr-banner__list">
                {noAccount.map((m) => (
                  <li key={m.consultant}><b>{m.consultant}</b> ({(m.clients || []).join(", ")})</li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      )}

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
              They automatically get the active clients that name them as Consultant in the Clients module. Tick more below to grant extra clients.
            </p>
          )}
          {createAccessEditable && (
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
          {createAccessEditable && (
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
        <h2 ref={teamHeadingRef} tabIndex={-1} style={{ margin: 0, fontSize: 15 }}>Team</h2>
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
          onRemoved={onRemoved}
        />
      )}
    </div>
  );
}
