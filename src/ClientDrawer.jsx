import React, { useState, useEffect } from "react";
import { ArrowLeft, MoreVertical, Copy, Printer, X, ChevronDown, Link2, AlertTriangle, Users, Check, BarChart3 } from "lucide-react";
import { fmt, timeAgo, isPackageLikeType, clickupTaskUrl } from "./format.js";
import { TYPE_LABELS_SHORT, findPersonMatch } from "./nameMatch.js";
import { ClientAvatar, PersonAvatar } from "./avatar.jsx";
import { useEscape } from "./useDismissable.js";
import { ExportItem } from "./ExportItem.jsx";

// Same link as the task itself -- ClickUp doesn't expose a way to deep-link to
// one specific person's time entry within a task, only the task page itself
// (where the Time Tracked panel shows everyone who logged against it).
function TaskUsersCell({ userMinutesMap, taskUrl }) {
  if (!userMinutesMap || userMinutesMap.size === 0) return "—";
  const entries = [...userMinutesMap.entries()].sort((a, b) => b[1] - a[1]);
  const single = entries.length === 1;
  return (
    <>
      {entries.map(([u, min], i) => (
        <React.Fragment key={u || i}>
          {i > 0 && ", "}
          {taskUrl ? (
            <a href={taskUrl} target="_blank" rel="noopener noreferrer" title="Open this task in ClickUp" className="pg-clickup-link">
              {u || "—"}
            </a>
          ) : (u || "—")}
          {!single && ` (${fmt(min / 60)}h)`}
        </React.Fragment>
      ))}
    </>
  );
}

// Full client detail — right-side drawer, opened by clicking a row. Reuses exactly
// the same computed fields ClientRow reads from (client.*), just laid out for
// a deeper single-client view: reconciliation bar, consultant contributions, tasks.
export function ClientDrawer({ client: c, invoiceMonth, priorMonthPretty, monthProgress, hasUser, consultantFilter, accruedNames, usedAccruedNames, syncMeta, capPeople, onClose, onSetMatch, onCopy, onPdf, onPdfLineItem, onViewProfile, copied }) {
  const isPackage = isPackageLikeType(c.type);
  const isQuoted = c.type === "quoted";
  const isQld = c.type === "queensland";
  const [drillConsultant, setDrillConsultant] = useState(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [consultantsOpen, setConsultantsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Reset local drill/expand state whenever a different client is opened, so the
  // drawer never opens already scrolled into a previous client's drill-down.
  useEffect(() => { setDrillConsultant(null); setTasksOpen(false); setOpenGroups(new Set()); setConsultantsOpen(false); }, [c.name]);

  useEscape(onClose);

  const drillTasks = drillConsultant ? (c.tasksByUser.get(drillConsultant) || new Map()) : null;
  const tasksShown = drillTasks ?? c.tasksFiltered;
  const taskUsersShown = drillConsultant
    ? new Map([...tasksShown.keys()].map((task) => [task, new Map([[drillConsultant, tasksShown.get(task)]])]))
    : c.taskUsersFiltered;
  const workedShown = drillConsultant ? ((c.userMinutes.get(drillConsultant) || 0) / 60) : c.workedFiltered;

  const selectConsultant = (u) => {
    setDrillConsultant((prev) => (prev === u ? null : u));
    setTasksOpen(true);
  };

  const consultantEntries = [...c.userMinutes.entries()].sort((a, b) => b[1] - a[1]);
  const consultantTotal = consultantEntries.reduce((a, [, min]) => a + min, 0);
  const shownConsultants = consultantsOpen ? consultantEntries : consultantEntries.slice(0, 3);
  const taskEntries = [...tasksShown.entries()].sort((a, b) => b[1] - a[1]);
  const shownTasks = tasksOpen ? taskEntries : taskEntries.slice(0, 3);

  // A rolled-up client's tasks (see App.jsx's cost-centre merge) come from several real
  // ClickUp folders folded into one row -- shown here as separate groups, each with its
  // own subtotal and export, instead of one flat merged list with no way to tell a BAMSS
  // Childcare task from a Brisbane Alarm Monitoring one. Built from each line item's own
  // (pre-merge) tasksByUser snapshot, filtered the same way the top-level task list is
  // (drilled into one consultant, or the page's consultant filter).
  const folderGroups = c.costCentre
    ? c.costCentre.lineItems.map((item) => {
      let tasks;
      const who = drillConsultant || consultantFilter;
      if (who) tasks = item.tasksByUser.get(who) || new Map();
      else {
        tasks = new Map();
        for (const [, tm] of item.tasksByUser) for (const [task, min] of tm) tasks.set(task, (tasks.get(task) || 0) + min);
      }
      const entries = [...tasks.entries()].sort((a, b) => b[1] - a[1]);
      return { name: item.name, item, entries, total: entries.reduce((a, [, min]) => a + min, 0) };
    })
    : null;
  const toggleGroup = (name) => setOpenGroups((prev) => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

  const statusLabel = !isPackage ? null : c.pkg == null ? "No package on file"
    : c.status === "over" ? "Over-serviced" : c.status === "under" ? "Under-serviced" : "On track";
  const statusTone = !isPackage ? undefined : c.status === "over" ? "var(--status-over)" : c.status === "under" ? "var(--status-warn)" : c.status === "ok" ? "var(--status-ok)" : "var(--fg-tertiary)";
  const iconTone = isPackage
    ? (c.status === "over" ? "var(--status-over)" : c.status === "under" ? "var(--status-warn)" : "var(--status-ok)")
    : isQld ? "var(--status-info)" : "var(--accent)";

  return (
    <>
      <aside className="pg-drawer pg-drawer--push" role="dialog" aria-label={`${c.displayName} detail`}>
        <div className="pg-drawer__header">
          <button className="pg-drawer__icon-btn" onClick={onClose} aria-label="Back" title="Back">
            <ArrowLeft size={16} />
          </button>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, position: "relative" }}>
            <button className="pg-drawer__icon-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="More actions" title="More actions">
              <MoreVertical size={16} />
            </button>
            {menuOpen && (
              <div className="pg-menu" style={{ top: "calc(100% + 4px)" }}>
                <ExportItem icon={<Copy size={14} />} label="Copy summary" onClick={() => { setMenuOpen(false); onCopy(); }} />
                <ExportItem icon={<Printer size={14} />} label="Generate PDF" onClick={() => { setMenuOpen(false); onPdf(); }} />
              </div>
            )}
            <button className="pg-drawer__icon-btn" onClick={onClose} aria-label="Close" title="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="pg-drawer__title-row">
          {c.logoUrl ? (
            <ClientAvatar name={c.displayName} logo={c.logoUrl} size={40} style={{ borderRadius: "var(--app-radius-sm)" }} />
          ) : (
            <div className="pg-drawer__avatar" style={{ color: iconTone, background: "var(--accent-soft)" }}>
              <BarChart3Icon />
            </div>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="pg-drawer__name">
              {c.displayName}
              {c.isOffboarded && <span className="pg-tag pg-tag--muted pg-tag--pill" style={{ marginLeft: 6 }} title={c.offboardNote}>Offboarded</span>}
            </div>
            <div className="pg-drawer__sub">
              {TYPE_LABELS_SHORT[c.type]}
              {c.isMap && " · MAP"}
              {c.typeTransitioned && " · scheduled change"}
            </div>
          </div>
          {statusLabel && (
            <span className="pg-status-pill pg-status-pill--computed" style={{ color: statusTone, background: "var(--bg-elevated)" }} title="Computed automatically from worked hours vs. package — not manually settable">
              {statusLabel} <ChevronDown size={11} />
            </span>
          )}
        </div>

        {c.matched && c.accruedClient.name !== c.name && (
          <div className="pg-drawer__linked">
            <Link2 size={12} /> ClickUp folder: {c.name}
            {c.matchInfo && c.matchInfo.confidence < 1 && (
              <span className="pg-tag" style={{ color: "var(--accent)" }}>{Math.round(c.matchInfo.confidence * 100)}% match</span>
            )}
          </div>
        )}

        {!isPackage && (
          <div className="pg-alertbar" style={{ marginTop: 12, background: isQld ? "var(--status-info-soft)" : "var(--accent-soft)", color: isQld ? "var(--status-info)" : "var(--accent)" }}>
            <AlertTriangle size={13} />
            <span className="pg-alertbar__text">
              {isQld
                ? "Queensland (previously) client, not on the accrued sheet, no reconciliation."
                : "Hourly-rate client, no package on file. If this looks like a name mismatch, match it below."}
            </span>
            <select defaultValue="__none__" onChange={(e) => onSetMatch(e.target.value)}>
              <option value="__none__">Match to accrued client…</option>
              {accruedNames.map((n) => (
                <option key={n} value={n} disabled={usedAccruedNames.has(n)}>{n} {usedAccruedNames.has(n) ? "(taken)" : ""}</option>
              ))}
            </select>
          </div>
        )}
        {isPackage && c.matchInfo?.method === "manual" && (
          <div className="pg-manual-note">
            <span>Manual match set.</span>
            <button onClick={() => onSetMatch("__none__")}>clear</button>
          </div>
        )}

        <div className="pg-drawer__section">
          <div className="pg-drawer__field-row">
            <div className="pg-drawer__field">
              <span className="pg-field__label">Invoice month</span>
              <span className="pg-drawer__field-value">{invoiceMonth || "—"}</span>
            </div>
            {statusLabel && (
              <div className="pg-drawer__field">
                <span className="pg-field__label">Status</span>
                <span className="pg-drawer__field-value" style={{ color: statusTone, fontSize: 14 }}>{statusLabel}</span>
              </div>
            )}
          </div>

          {isPackage ? (
            <div className="pg-metrics" style={{ marginTop: 14 }}>
              <Metric label={consultantFilter ? `Worked (by ${consultantFilter})` : "Worked"} value={`${fmt(c.workedFiltered)} h`} big />
              <Metric label="Package" value={c.pkg != null ? `${fmt(c.pkg)} h` : "—"} />
              <Metric
                label={c.priorBalance != null && c.priorBalance < 0 ? "Carried in" : c.priorBalance != null && c.priorBalance > 0 ? "Over-used prior" : "Carry-over"}
                value={c.priorBalance != null ? `${fmt(Math.abs(c.priorBalance))} h` : "—"}
                tone={c.priorBalance != null && c.priorBalance > 0 ? "var(--status-over)" : c.priorBalance != null && c.priorBalance < 0 ? "var(--status-ok)" : undefined}
                sub={priorMonthPretty ? `from ${priorMonthPretty}` : null}
                flag={c.priorBalanceEstimated ? {
                  text: "estimated",
                  title: `The accrued sheet has no column for ${priorMonthPretty || "the prior month"} — this figure is estimated from ClickUp hours worked that month instead of the sheet's own recorded balance. Re-upload the accrued sheet with that month's column once it's available for the verified number.`,
                } : c.priorMismatch ? {
                  text: "mismatch identified",
                  title: `Accrued sheet says ${fmt(c.priorMismatch.sheetValue)} h${priorMonthPretty ? ` for ${priorMonthPretty}` : ""}, but recalculating from the current ClickUp data for that month gives ${fmt(c.priorMismatch.recomputed)} h. Likely a ClickUp entry was edited after the sheet was last updated.`,
                } : null} />
            </div>
          ) : isQuoted ? (
            <div className="pg-metrics" style={{ marginTop: 14 }}>
              <Metric label="Worked this month" value={`${fmt(c.workedFiltered)} h`} big />
              <Metric label="Quoted amount" value={c.quotedAmount != null ? `${fmt(c.quotedAmount)} h` : "—"} />
              <Metric
                label="Total worked (all time)"
                value={`${fmt(c.lifetimeWorked ?? 0)} h`}
                sub="cumulative across every month, not just this one"
              />
            </div>
          ) : (
            <div className="pg-metrics pg-metrics--2" style={{ marginTop: 14 }}>
              <Metric label={consultantFilter ? `Worked (by ${consultantFilter})` : "Worked"} value={`${fmt(c.workedFiltered)} h`} big />
              <Metric label="All consultants total" value={`${fmt(c.worked)} h`} sub={consultantFilter ? "regardless of filter" : null} />
            </div>
          )}

          {isPackage && c.remaining != null && (
            <div className="pg-drawer__overunder">
              <span className="pg-drawer__overunder-label">{c.remaining < 0 ? "Over by" : "Remaining this month"}</span>
              <span className="pg-drawer__overunder-value" style={{ color: c.remaining < 0 ? "var(--status-over)" : c.remaining > 0 ? "var(--status-ok)" : undefined }}>
                {fmt(Math.abs(c.remaining))} h
              </span>
              <span className="pg-drawer__overunder-tag">{c.remaining < 0 ? "over-served" : c.remaining > 0 ? "under-served" : ""}</span>
            </div>
          )}

          {isQuoted && c.quotedRemaining != null && (
            <div className="pg-drawer__overunder">
              <span className="pg-drawer__overunder-label">{c.quotedRemaining < 0 ? "Over the quoted amount by" : "Remaining of quoted amount"}</span>
              <span className="pg-drawer__overunder-value" style={{ color: c.quotedRemaining < 0 ? "var(--status-over)" : "var(--status-ok)" }}>
                {fmt(Math.abs(c.quotedRemaining))} h
              </span>
              <span className="pg-drawer__overunder-tag">{c.quotedRemaining < 0 ? "over quote" : "within budget"}</span>
            </div>
          )}
        </div>

        {isPackage && c.pkg != null && c.pkg > 0 && (
          <div className="pg-drawer__section">
            <div className="pg-drawer__section-title">Reconciliation</div>
            <div className="pg-drawer__recon-row">
              <span>Adjustments (non-billable)</span>
              <span title="Not tracked per-client in this tool yet — always empty">—</span>
            </div>
            <div className="pg-drawer__recon-row">
              <span>Billable total</span>
              <span>{fmt(c.workedFiltered)} h</span>
            </div>
            <PackageBar pkg={c.pkg} worked={c.worked} prior={c.priorBalance ?? 0} status={c.status} monthProgress={monthProgress} />
          </div>
        )}

        {consultantEntries.length > 0 && (
          <div className="pg-drawer__section">
            <div className="pg-drawer__section-title">Consultant contributions</div>
            <div className="pg-drawer__contrib-list">
              {shownConsultants.map(([u, min]) => {
                const active = drillConsultant ? u === drillConsultant : (consultantFilter && u === consultantFilter);
                const pct = consultantTotal > 0 ? Math.round((min / consultantTotal) * 100) : 0;
                const matchedPerson = u ? findPersonMatch(u, capPeople) : null;
                return (
                  <button
                    key={u || "unknown"}
                    type="button"
                    onClick={() => selectConsultant(u)}
                    className={"pg-drawer__contrib" + (active ? " pg-drawer__contrib--active" : "")}
                    title={drillConsultant === u ? "Clear — show all tasks again" : `See the tasks behind ${u || "this consultant"}'s hours`}
                  >
                    <PersonAvatar name={u} photo={matchedPerson?.photo} size={26} style={{ borderRadius: "var(--app-radius-pill)" }} />
                    <span className="pg-drawer__contrib-name">{u || "—"}</span>
                    <span className="pg-drawer__contrib-hrs">{fmt(min / 60)} h</span>
                    <span className="pg-drawer__contrib-pct">{pct}%</span>
                  </button>
                );
              })}
            </div>
            {consultantEntries.length > 3 && (
              <button className="pg-manual-note" style={{ background: "none", border: 0, cursor: "pointer", padding: 0 }} onClick={() => setConsultantsOpen((o) => !o)}>
                <span style={{ color: "var(--accent)" }}>{consultantsOpen ? "Show fewer" : `View all ${consultantEntries.length} consultants`}</span>
              </button>
            )}
          </div>
        )}

        {folderGroups ? (
          // Rolled-up client -- one group per real ClickUp folder that feeds this
          // package, each with its own subtotal and its own "export PDF" (scoped to
          // just that folder's hours), rather than one flat merged task list. The
          // client's own combined PDF (drawer footer, below) still covers everything.
          folderGroups.map((group) => {
            const open = openGroups.has(group.name);
            const shown = open ? group.entries : group.entries.slice(0, 3);
            return (
              <div className="pg-drawer__section" key={group.name}>
                <div className="pg-drawer__section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>{group.name}</span>
                  <span style={{ fontWeight: 400, color: "var(--fg-tertiary)" }}>{fmt(group.total / 60)} h</span>
                </div>
                <div className="pg-drawer__bubble">
                  <table className="pg-table">
                    <thead><tr><th>Task</th><th className="right num" style={{ width: 90 }}>Hours</th></tr></thead>
                    <tbody>
                      {shown.map(([task, min]) => {
                        const taskUrl = clickupTaskUrl(c.taskIds?.get(task));
                        return (
                          <tr key={task}>
                            <td>
                              {taskUrl ? (
                                <a href={taskUrl} target="_blank" rel="noopener noreferrer" title="Open this task in ClickUp" className="pg-clickup-link">{task}</a>
                              ) : task}
                            </td>
                            <td className="right num">{fmt(min / 60)}</td>
                          </tr>
                        );
                      })}
                      {group.entries.length === 0 && (
                        <tr><td colSpan={2} className="empty">No tasks in this filter.</td></tr>
                      )}
                      <tr className="total"><td>Total</td><td className="right num">{fmt(group.total / 60)}</td></tr>
                    </tbody>
                  </table>
                  {group.entries.length > 3 && (
                    <button className="pg-manual-note" style={{ background: "none", border: 0, cursor: "pointer", padding: 0, marginTop: 8 }} onClick={() => toggleGroup(group.name)}>
                      <span style={{ color: "var(--accent)" }}>{open ? "Show fewer" : `View all ${group.entries.length} tasks`}</span>
                    </button>
                  )}
                  {onPdfLineItem && (
                    <button className="pg-btn-ghost" style={{ marginTop: 10 }} onClick={() => onPdfLineItem(group.item)} title={`Export PDF for ${group.name}`}>
                      <Printer size={12} /> Export PDF
                    </button>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="pg-drawer__section">
            <div className="pg-drawer__section-title">
              Tasks {drillConsultant ? `worked by ${drillConsultant}` : consultantFilter ? `worked by ${consultantFilter}` : "worked this month"}
            </div>
            <div className="pg-drawer__bubble">
              <table className="pg-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th className="right num" style={{ width: 90 }}>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {shownTasks.map(([task, min]) => {
                    const taskUrl = clickupTaskUrl(c.taskIds?.get(task));
                    return (
                      <tr key={task}>
                        <td>
                          {taskUrl ? (
                            <a href={taskUrl} target="_blank" rel="noopener noreferrer" title="Open this task in ClickUp" className="pg-clickup-link">
                              {task}
                            </a>
                          ) : task}
                          {hasUser && <div style={{ fontSize: 11, color: "var(--fg-tertiary)", marginTop: 2 }}><TaskUsersCell userMinutesMap={taskUsersShown?.get(task)} taskUrl={taskUrl} /></div>}
                        </td>
                        <td className="right num">{fmt(min / 60)}</td>
                      </tr>
                    );
                  })}
                  {taskEntries.length === 0 && (
                    <tr><td colSpan={2} className="empty">No tasks in this filter.</td></tr>
                  )}
                  <tr className="total">
                    <td>Total</td>
                    <td className="right num">{fmt(workedShown)}</td>
                  </tr>
                </tbody>
              </table>
              {taskEntries.length > 3 && (
                <button className="pg-manual-note" style={{ background: "none", border: 0, cursor: "pointer", padding: 0, marginTop: 8 }} onClick={() => setTasksOpen((o) => !o)}>
                  <span style={{ color: "var(--accent)" }}>{tasksOpen ? "Show fewer" : `View all ${taskEntries.length} tasks`}</span>
                </button>
              )}
            </div>
          </div>
        )}

        <div className="pg-drawer__footer">
          {onViewProfile && (
            <button onClick={onViewProfile} className="pg-btn-ghost" title="Open this client in the Clients module">
              <Users size={12} /> View full profile
            </button>
          )}
          <button onClick={onCopy} className="pg-btn-ghost">
            {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "copied" : "Copy summary"}
          </button>
          <button onClick={onPdf} className="pg-btn">
            <Printer size={12} /> Generate PDF
          </button>
        </div>
        <div className="pg-drawer__meta">
          {syncMeta?.last_synced_at ? `Last updated ${timeAgo(syncMeta.last_synced_at)}` : "Not synced yet"}
          {syncMeta?.last_synced_at && <span className="pg-status-pill pg-status-pill--dot" style={{ color: "var(--status-ok)" }}>Synced</span>}
        </div>
      </aside>
    </>
  );
}

// Small inline glyph — avoids importing yet another lucide icon just for the
// drawer's avatar tile; a simple bar-chart mark reads fine at this size.
function BarChart3Icon() {
  return <BarChart3 size={16} />;
}

function Metric({ label, value, sub, tone, big, flag }) {
  return (
    <div>
      <div className="pg-metric__label">{label}</div>
      <div className={"pg-metric__value" + (big ? " pg-metric__value--big" : "")} style={tone ? { color: tone } : undefined}>{value}</div>
      {sub && <div className="pg-metric__sub">{sub}</div>}
      {flag && (
        <div className="pg-metric__flag" title={flag.title}>
          <AlertTriangle size={11} />
          {flag.text}
        </div>
      )}
    </div>
  );
}

// A 15-point cushion between "% of package used" and "% of month elapsed" before
// calling it ahead/behind pace — small day-to-day swings shouldn't flip the label.
const PACE_MARGIN = 15;
function paceStatus(usagePct, elapsedPct) {
  if (usagePct == null || elapsedPct == null) return null;
  const diff = usagePct - elapsedPct;
  if (diff > PACE_MARGIN) return { label: "trending over pace", tone: "var(--status-over)" };
  if (diff < -PACE_MARGIN) return { label: "trending under pace", tone: "var(--status-warn)" };
  return { label: "on pace", tone: "var(--status-ok)" };
}

function PackageBar({ pkg, worked, prior, status, monthProgress }) {
  const effective = pkg - prior;
  const max = Math.max(worked, effective, pkg) * 1.15;
  const workedPct = Math.max(0, Math.min(100, (worked / max) * 100));
  const pkgPct = (pkg / max) * 100;
  const effPct = (effective / max) * 100;
  const barColor = status === "over" ? "var(--status-over)" : status === "under" ? "var(--status-warn)" : "var(--status-ok)";
  const usagePct = effective > 0 ? (worked / effective) * 100 : null;
  const pace = monthProgress ? paceStatus(usagePct, monthProgress.pct) : null;
  return (
    <div>
      <div className="pg-bar-track">
        <div className="pg-bar-fill" style={{ width: `${workedPct}%`, background: barColor }} />
        <div className="pg-bar-mark" style={{ left: `${pkgPct}%` }} />
        {Math.abs(effective - pkg) > 0.01 && (
          <div className="pg-bar-mark pg-bar-mark--accent" style={{ left: `${effPct}%` }} />
        )}
      </div>
      <div className="pg-bar-caption">
        <span>worked {fmt(worked)} h</span>
        <span>package {fmt(pkg)} h{Math.abs(effective - pkg) > 0.01 && <> · adjusted {fmt(effective)} h</>}</span>
      </div>
      {pace && (
        <div className="pg-bar-caption" style={{ marginTop: 2 }}>
          <span>{fmt(usagePct, 0)}% of package used · {fmt(monthProgress.pct, 0)}% of month elapsed</span>
          <span style={{ color: pace.tone }}>{pace.label}</span>
        </div>
      )}
    </div>
  );
}
