import React, { useCallback, useId, useMemo, useRef, useState } from "react";
import { Loader2, X, Check, AlertTriangle } from "lucide-react";
import { createUser } from "./usersSync.js";
import { ROLES, ROLE_LABELS, CLICKUP_REQUIRED_ROLES, ADMIN_TIER_ROLES } from "./roles.js";
import { hasAccessConfig } from "./permissions.js";
import { useEscape, useFocusTrap } from "./useDismissable.js";
import { parseBulkUsers } from "./bulkUsers.js";

// Settings → Users & permissions → Bulk add: one role and one temporary password for a pasted
// list. Each account goes through the same manage-users `create` as the single Add drawer
// (role-default module access, Consultant clients by trigger), one after another; a row that
// fails doesn't stop the rest. The list is frozen once creating starts, so reloading the team
// (which turns the new emails into "Already has an account") doesn't rewrite the results.
const errText = (e) => e?.message || String(e);

export default function BulkAddDrawer({ ownRole, users, moduleScopes, clickupNames, roster, onClose, onChanged }) {
  const [text, setText] = useState("");
  const [role, setRole] = useState("consultant");
  const [password, setPassword] = useState("");
  const [run, setRun] = useState(null); // { rows, results: { email: "creating" | "done" | error } }
  const textRef = useRef(null);
  const dialogRef = useFocusTrap({ initialFocusRef: textRef });
  const busy = !!run && Object.values(run.results).includes("creating");
  useEscape(useCallback(() => { if (!busy) onClose(); }, [busy, onClose]));
  const ids = { text: useId(), role: useId(), password: useId(), title: useId() };

  const linkRoster = !ADMIN_TIER_ROLES.has(role) && hasAccessConfig(moduleScopes);
  const parsed = useMemo(() => parseBulkUsers(text, {
    existingEmails: (users || []).map((u) => u.email),
    clickupNames,
    roster,
    linkedPersonIds: (users || []).map((u) => u.personId).filter(Boolean),
    clickupRequired: CLICKUP_REQUIRED_ROLES.has(role),
    linkRoster,
  }), [text, users, clickupNames, roster, role, linkRoster]);
  const rows = run ? run.rows : parsed;
  const ready = rows.filter((r) => !r.problems.length);

  async function createAll() {
    if (!ready.length || password.length < 8) return;
    const results = Object.fromEntries(ready.map((r) => [r.email, "creating"]));
    setRun({ rows, results: { ...results } });
    let created = 0;
    for (const r of ready) {
      try {
        await createUser({
          email: r.email, password, role, clients: [],
          clickupUserName: r.clickupUserName,
          personId: linkRoster ? r.person?.id : undefined,
        });
        results[r.email] = "done";
        created += 1;
      } catch (e) {
        results[r.email] = errText(e);
      }
      setRun((cur) => ({ ...cur, results: { ...results } }));
    }
    await onChanged(`${created} of ${ready.length} accounts created. Give them the temporary password — they'll choose their own when they first sign in.`);
  }

  const failed = run ? ready.filter((r) => run.results[r.email] && !["creating", "done"].includes(run.results[r.email])).length : 0;
  const finished = run && !busy;

  return (
    <>
      <div className="wr-drawer-backdrop" onClick={() => { if (!busy) onClose(); }} aria-hidden="true" />
      <aside ref={dialogRef} tabIndex={-1} className="wr-drawer pg-team-drawer" role="dialog" aria-modal="true" aria-labelledby={ids.title}>
        <div className="wr-drawer__title">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="wr-drawer__name" id={ids.title}>Bulk add team members</h2>
            <div className="wr-drawer__sub">One role and one temporary password for everyone. They choose their own password when they first sign in.</div>
          </div>
          <button type="button" className="wr-iconbtn" onClick={onClose} disabled={busy} aria-label="Close"><X size={16} /></button>
        </div>

        <section className="wr-sec">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label className="pg-field" htmlFor={ids.text}>
              <span className="pg-field__label">People, one per line</span>
              <textarea id={ids.text} ref={textRef} className="pg-input pg-bulk-text" rows={7} value={text} disabled={!!run}
                placeholder={"holly@purplegiraffe.com.au, Holly Latham\nkasey@purplegiraffe.com.au, Kasey Doran"}
                onChange={(e) => setText(e.target.value)} spellCheck={false} />
              <span className="pg-footnote">Email, then their exact ClickUp name. Their roster person is linked when the name matches exactly one person on the Consultants roster; otherwise pick it later in their drawer.</span>
            </label>
            <div className="pg-team-grid">
              <label className="pg-field" htmlFor={ids.role}>
                <span className="pg-field__label">Role</span>
                <select id={ids.role} className="pg-input" value={role} disabled={!!run} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.filter((r) => r !== "super_admin" || ownRole === "super_admin").map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </label>
              <label className="pg-field" htmlFor={ids.password}>
                <span className="pg-field__label">Temporary password</span>
                <input id={ids.password} className="pg-input" type="text" autoComplete="off" placeholder="At least 8 characters"
                  value={password} disabled={!!run} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <p className="pg-footnote">Module access follows the role's defaults and Consultant clients come from the Clients module, as for a single add.</p>
          </div>
        </section>

        {rows.length > 0 && (
          <section className="wr-sec">
            <header className="wr-sec__head">
              <h3 className="wr-sec__title">{run ? "Results" : "Preview"}</h3>
              <span className="pg-footnote">{ready.length} ready{rows.length > ready.length ? ` · ${rows.length - ready.length} skipped` : ""}</span>
            </header>
            <ul className="pg-bulk-list">
              {rows.map((r) => {
                const result = run?.results[r.email];
                const bad = r.problems.length > 0 || (result && !["creating", "done"].includes(result));
                return (
                  <li key={r.line} className={"pg-bulk-row" + (bad ? " is-bad" : "")}>
                    <span className="pg-bulk-icon" aria-hidden="true">
                      {result === "creating" ? <Loader2 size={14} style={{ animation: "pg-spin 1s linear infinite" }} />
                        : result === "done" ? <Check size={14} /> : bad ? <AlertTriangle size={14} /> : null}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="pg-bulk-email">{r.email || `Line ${r.line}`}</div>
                      <div className="pg-team-email">
                        {r.problems.length ? r.problems.join(" · ")
                          : result && !["creating", "done"].includes(result) ? result
                            : [r.clickupUserName || "No ClickUp name", linkRoster ? (r.person ? `roster: ${r.person.name}` : "no roster person") : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="pg-team-foot">
          {finished ? (
            <>
              {failed > 0 && <span className="pg-footnote" style={{ marginRight: "auto", color: "var(--status-over-text)" }}>{failed} couldn't be created — see above.</span>}
              <button className="pg-btn" type="button" onClick={onClose}>Done</button>
            </>
          ) : (
            <>
              <button className="pg-btn-ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="pg-btn" type="button" disabled={busy || !ready.length || password.length < 8} onClick={createAll}>
                {busy && <Loader2 size={13} style={{ animation: "pg-spin 1s linear infinite" }} />}
                {busy ? "Creating…" : ready.length ? `Create ${ready.length} account${ready.length === 1 ? "" : "s"}` : "Create accounts"}
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
