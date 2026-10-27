import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, Plus, Search, MoreHorizontal, Pencil, KeyRound, Trash2, ChevronDown } from "lucide-react";
import { fetchUsers, fetchClickupUserNames, deleteUser } from "./usersSync.js";
import { ROLES, ROLE_LABELS, CLICKUP_REQUIRED_ROLES, ADMIN_TIER_ROLES } from "./roles.js";
import { fetchClients } from "./clientsSync.js";
import { loadKey, SEED_PEOPLE } from "./capacityData.js";
import { CAP_PEOPLE_KEY } from "./storageKeys.js";
import { fetchWagePeople } from "./wagesSync.js";
import { accessSummary } from "./permissions.js";
import { useDismissable } from "./useDismissable.js";
import { ClientAvatar } from "./avatar.jsx";
import UserDrawer, { displayNameFor } from "./UserDrawer.jsx";

const errText = (e) => e?.message || String(e);

// Invites aren't emailed: an account is "Active" once they've signed in and set their own password.
function statusOf(u) {
  if (!u.lastSignInAt) return { ok: false, label: "Not signed in yet" };
  if (u.mustChangePassword) return { ok: false, label: "Must set password" };
  return { ok: true, label: "Active" };
}

// The row's "…" menu. Self rows have none (self-editing is refused server-side too).
function RowMenu({ user, onEdit, onReset, onRemove, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(() => setOpen(false));
  const pick = (fn) => () => { setOpen(false); fn(user); };
  return (
    <div className="pg-team-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="wr-iconbtn" aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        aria-label={`Actions for ${displayNameFor(user)}`} onClick={() => setOpen((o) => !o)}><MoreHorizontal size={16} /></button>
      {open && (
        <div className="pg-menu" role="menu">
          <button type="button" role="menuitem" className="pg-menu-item" onClick={pick(onEdit)}><Pencil size={14} /> Edit</button>
          <button type="button" role="menuitem" className="pg-menu-item" onClick={pick(onReset)}><KeyRound size={14} /> Reset password</button>
          <button type="button" role="menuitem" className="pg-menu-item pg-menu-item--danger" onClick={pick(onRemove)}><Trash2 size={14} /> Remove user</button>
        </div>
      )}
    </div>
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
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  // The drawer: null = closed, { id: null } = adding, { id, reset } = editing (reset: open on Reset password).
  const [drawer, setDrawer] = useState(null);

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
  const rosterPerson = useMemo(() => Object.fromEntries(roster.map((p) => [p.id, p])), [roster]);
  const linkedToFor = (excludeUserId) => Object.fromEntries((users || [])
    .filter((u) => u.personId && u.id !== excludeUserId).map((u) => [u.personId, u.email]));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users || [])
      .filter((u) => !roleFilter || u.role === roleFilter)
      .filter((u) => !q || [u.email, u.clickupUserName, displayNameFor(u)].some((v) => (v || "").toLowerCase().includes(q)))
      .sort((x, y) => displayNameFor(x).localeCompare(displayNameFor(y)));
  }, [users, query, roleFilter]);

  const onChanged = useCallback(async (message) => {
    setError(null);
    if (message) setNotice(message);
    await load();
  }, []);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const teamHeadingRef = useRef(null);
  // After "Remove user" the row (the drawer's trigger) is gone -- land on the list heading.
  const onRemoved = useCallback(() => {
    setDrawer(null);
    setTimeout(() => teamHeadingRef.current?.focus(), 0);
  }, []);
  const [removingId, setRemovingId] = useState(null);
  async function removeUser(u) {
    if (!window.confirm(`Remove ${u.email}'s access? This cannot be undone.`)) return;
    setRemovingId(u.id);
    try {
      await deleteUser(u.id);
      await onChanged(`${u.email} was removed.`);
      teamHeadingRef.current?.focus();
    } catch (e) {
      setNotice(null);
      setError(errText(e));
    } finally {
      setRemovingId(null);
    }
  }
  const openUser = drawer?.id ? users?.find((u) => u.id === drawer.id) || null : null;

  return (
    <div className="pg-team">
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

      <div className="pg-team-head">
        <h2 ref={teamHeadingRef} tabIndex={-1}>
          Team members
          {users && <span className="pg-team-count">{users.length} {users.length === 1 ? "member" : "members"}</span>}
        </h2>
        <button type="button" className="pg-btn" onClick={() => setDrawer({ id: null })} disabled={!users}><Plus size={14} /> Add team member</button>
      </div>

      <div className="pg-team-toolbar">
        <label className="pg-pill pg-pill--search">
          <Search size={14} className="pg-pill__icon" aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email…" aria-label="Search team members" />
        </label>
        <label className="pg-pill pg-pill--select">
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          <ChevronDown size={14} className="pg-pill__chevron" aria-hidden="true" />
        </label>
      </div>

      <div className="pg-cap-card pg-team-card">
        {users === null ? (
          <p className="pg-footnote pg-team-empty">{error ? "Couldn't load team members." : "Loading…"}</p>
        ) : shown.length === 0 ? (
          <p className="pg-footnote pg-team-empty">{users.length === 0 ? "No team members yet." : "No one matches that search."}</p>
        ) : (
          <>
            <div className="pg-team-row pg-team-row--head" aria-hidden="true">
              <span>Member</span><span>Role</span><span>Status</span><span />
            </div>
            <ul className="pg-team-list">
              {shown.map((u) => {
                const isSelf = u.id === ownUserId;
                const name = displayNameFor(u);
                const status = statusOf(u);
                const missingClickup = CLICKUP_REQUIRED_ROLES.has(u.role) && !u.clickupUserName;
                const open = isSelf ? undefined : () => setDrawer({ id: u.id });
                return (
                  <li key={u.id} className={"pg-team-row" + (isSelf ? "" : " pg-team-row--clickable")} onClick={open}
                    title={accessSummary({ role: u.role, overrides: u.moduleOverrides, presets, moduleScopes, clientCount: new Set(u.clients || []).size })}>
                    <div className="pg-team-member">
                      <ClientAvatar name={name} logo={rosterPerson[u.personId]?.photo} size={34} />
                      <div style={{ minWidth: 0 }}>
                        {isSelf ? (
                          <span className="pg-team-name">{name}<span className="pg-team-you">(you)</span></span>
                        ) : (
                          <button type="button" className="pg-team-name" onClick={(e) => { e.stopPropagation(); open(); }}>{name}</button>
                        )}
                        <div className="pg-team-email">{u.email}</div>
                        {missingClickup && <div className="pg-team-warn"><AlertTriangle size={11} aria-hidden="true" /> No ClickUp user set</div>}
                      </div>
                    </div>
                    <span className={"pg-team-role" + (ADMIN_TIER_ROLES.has(u.role) ? " pg-team-role--admin" : "")}>{ROLE_LABELS[u.role] || u.role}</span>
                    <span className={"pg-team-status" + (status.ok ? " pg-team-status--ok" : "")}>{status.label}</span>
                    {isSelf ? <span /> : (
                      <RowMenu user={u} disabled={removingId === u.id}
                        onEdit={() => setDrawer({ id: u.id })} onReset={() => setDrawer({ id: u.id, reset: true })} onRemove={removeUser} />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {drawer && (drawer.id === null || openUser) && (
        <UserDrawer
          key={drawer.id ?? "new"}
          user={openUser}
          startWithReset={!!drawer.reset}
          ownRole={ownRole}
          presets={presets}
          moduleScopes={moduleScopes}
          allClients={allClients}
          clickupNames={clickupNames}
          roster={roster}
          rosterError={rosterError}
          wagePeople={wagePeople}
          wageError={wageError}
          linkedTo={linkedToFor(openUser?.id ?? null)}
          onClose={closeDrawer}
          onChanged={onChanged}
          onRemoved={onRemoved}
        />
      )}
    </div>
  );
}
