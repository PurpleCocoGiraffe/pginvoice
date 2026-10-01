import React, { useState } from "react";
import { Link2, MoreVertical, ChevronDown, Copy, Printer, Users } from "lucide-react";
import { fmt, isPackageLikeType } from "./format.js";
import { isLifetimeBudgetType } from "./reconcile.js";
import { typeLabelShort, typeTone } from "./clientTypeLabels.js";
import { costCentreInvoicesFor, invoiceLineLabel, fmtMoney } from "./invoiceSplit.js";
import { ClientAvatar } from "./avatar.jsx";
import { useDismissable } from "./useDismissable.js";
import { ExportItem } from "./ExportItem.jsx";

// The cost-centre breakdown for a client whose real work is logged across several
// sibling ClickUp folders instead of a single umbrella one (Aus3C's training programs,
// Majestic Plumbing's cost centres, ...) — multiFolderAccrualMatchesFor (nameMatch.js)
// already merges these into the parent row's package/worked/remaining figures; this is
// just a minimal, inline reveal of exactly which folders (including hours logged
// directly under the parent itself) added up to that total, styled as a plain
// timeline list rather than a second boxed table -- it's a footnote to the row above
// it, not a peer card of its own. A sibling folder that's deliberately EXCLUDED from
// the accrual (billed separately, e.g. a quoted one-off project) never appears here —
// it stays its own ordinary row, nested underneath via the existing sub-project
// mechanism (see the `nested` prop below), tagged "Sub project" rather than folded in.
//
// A client with a per-cost-centre invoice cap (invoiceSplit.js, e.g. Clarke Energy) also
// gets each cost centre's billable $ amount, and one extra line per invoice when it has to
// be split to stay under the cap.
function CostCentreBreakdown({ client: c, divider, showReset }) {
  const { lineItems } = c.costCentre;
  const invoicesByName = new Map((costCentreInvoicesFor(c) || []).map((inv) => [inv.name, inv]));
  const rowClass = "pg-costcentre-mini__row pg-row-grid-cols" + (showReset ? " pg-row-grid-cols--reset" : "");
  return (
    <div className={"pg-costcentre-mini" + (divider ? " pg-costcentre-mini--divider" : "")}>
      {lineItems.map((item) => {
        const inv = invoicesByName.get(item.name);
        return (
          <React.Fragment key={item.name}>
            {/* Reuses the row's own grid-column track list (pg-row-grid-cols) rather than an
                independent layout, so each line item's hours land in exactly the same column
                as the "Worked" figure on the row above -- a fixed left-padding/flex layout
                can't guarantee that once folder names vary in length. */}
            <div className={rowClass}>
              <span />
              <span className="pg-costcentre-mini__dotcell"><span className="pg-costcentre-mini__dot" /></span>
              <span className="pg-costcentre-mini__name">
                {item.name}
                {inv && <span style={{ color: "var(--fg-tertiary)" }} title={`Billable ${fmt(inv.hours)} h at ${fmtMoney(inv.rule.rate)}/h${inv.lines.length > 1 ? `, over the ${fmtMoney(inv.rule.cap)} per-invoice cap` : ""}`}> · {fmtMoney(inv.amount)}{inv.lines.length > 1 ? ` · ${inv.lines.length} invoices` : ""}</span>}
              </span>
              <span />
              <span />
              <span />
              <span className="pg-costcentre-mini__hours">{fmt(item.hours)} h</span>
            </div>
            {inv && inv.lines.length > 1 && inv.lines.map((line, i) => (
              <div className={rowClass} key={`${item.name}-inv${i}`} style={{ paddingTop: 0 }}>
                <span />
                <span className="pg-costcentre-mini__dotcell" />
                <span className="pg-costcentre-mini__name" style={{ paddingLeft: 12, fontSize: 12, color: "var(--fg-tertiary)" }}>{invoiceLineLabel(line, i, inv.lines.length)}</span>
              </div>
            ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// Compact numbered row — the list's default state. Clicking anywhere on it opens
// the full client detail in the right-side drawer (see ClientDrawer.jsx).
//
// `tileRow` + `hasMoreBelow`: when a client has sub-projects (siblings billed
// separately, e.g. a quoted one-off) and/or a cost-centre breakdown, every one of
// those rows renders inside a single shared `.pg-tile` card (see App.jsx) instead of
// each getting its own floating card -- `tileRow` tells this row to drop its own
// border/shadow/radius (the tile already provides those) and `hasMoreBelow` tells it
// whether to draw the divider line under itself, since dividers only belong between
// rows, never trailing the last one in the group.
//
// `subIndex` + `avatarOf`: a sub-project doesn't get its own number in the list --
// it's not a separate client, just a different billing arrangement for the same one --
// so it's labelled against its parent's number instead (parent "26" -> sub-project
// "26s", a second one "26s2", ...). `avatarOf` carries the parent's {name, logo} so the
// sub-project's avatar reads as the same client's picture, not a distinct one of its own.
//
// `showReset`: the viewed month has at least one macro-sheet reset somewhere in the list,
// so every row (and the header) gets the extra "Remaining Reset" track -- blank for a
// client without one -- keeping all columns aligned.
export function ClientRow({ index, client: c, active, onOpen, nested, parentName, onCopy, onPdf, tileRow, hasMoreBelow, subIndex, avatarOf, showReset }) {
  const [inlineOpen, setInlineOpen] = useState(false);
  // Cost-centre breakdown starts collapsed, same as every other row's expand affordance
  // (the reconciliation breakdown below, the drawer) -- the list should read as a plain
  // set of tiles by default, not open every roll-up's internals at once.
  const [costCentreOpen, setCostCentreOpen] = useState(false);
  const [tasksAllShown, setTasksAllShown] = useState(false);
  const [consultantsAllShown, setConsultantsAllShown] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismissable(() => setMenuOpen(false));
  const isPackage = isPackageLikeType(c.type);
  // Quoted has no monthly carry/pacing concept -- it's a single fixed hour budget spent
  // down across however many months the project runs. Reuses the Package/Worked/Remaining
  // columns, but "Worked" always stays this month's hours (same meaning as every other
  // type -- that's what the row is scanned for) with the lifetime total shown in the
  // otherwise-unused Carry slot instead, rather than replacing the month figure with it
  // (see quotedAmount/lifetimeWorked/quotedRemaining computed in App.jsx's
  // buildClientsForMonth). A MAP is the same shape -- a fixed total (e.g. 80 h) for the
  // whole plan -- so it reuses every Quoted figure here, with MAP wording.
  const isQuoted = isLifetimeBudgetType(c.type);
  const isMap = c.type === "map";
  const budgetWord = isMap ? "MAP" : "quoted";
  // Digital Package: fixed price, hours shown for reference only (no package/remaining).
  const isDigital = c.type === "digital";
  // A quote priced as a one-off dollar fee with no hour budget (AWIWA): shows the fee and
  // its effective hourly rate instead of any hours-left/over figure.
  const feeOnly = isQuoted && c.quotedAmount == null && !!c.fixedFee;
  // An offboarded client still owed unutilised hours: wrap-up work this month is drawn
  // down from them (reconcileClientMonth's wrap-up branch). Carry = the owed balance,
  // Remaining = hours still owed.
  const isWrapUp = c.status === "wrap_up";
  const statusTone = isWrapUp ? "var(--status-ok)"
    : isPackage
    ? (c.status === "over" ? "var(--status-over)" : c.status === "under" ? "var(--status-warn)" : "var(--status-ok)")
    : isQuoted && c.quotedRemaining != null
      ? (c.quotedRemaining < 0 ? "var(--status-over)" : "var(--status-ok)")
      : undefined;
  const statusText = isWrapUp
    ? (c.remaining > 0 ? `Offboarded: ${fmt(c.remaining)} h of unutilised hours still owed after this month's wrap-up work` : "Offboarded: owed hours fully used by wrap-up work")
    : feeOnly ? `Fixed fee ${fmtMoney(c.fixedFee.fee)}${c.fixedFee.effectiveRate != null ? `, ${fmtMoney(c.fixedFee.effectiveRate)}/h so far over ${fmt(c.lifetimeWorked ?? 0)} h` : ""}`
    : isPackage && c.status === "on_hold"
    ? "On hold: accrual paused, balance carried forward unchanged"
    : isPackage && c.status !== "no-pkg"
    ? (c.status === "over" ? `${fmt(Math.abs(c.newBalance))} h over-served` : c.status === "under" ? `${fmt(Math.abs(c.newBalance))} h under-served` : "on track")
    : isQuoted && c.quotedRemaining != null
      ? (c.quotedRemaining < 0 ? `${fmt(Math.abs(c.quotedRemaining))} h over the ${budgetWord} amount` : `${fmt(c.quotedRemaining)} h left of the ${budgetWord} amount`)
    : isDigital ? "Digital Package: fixed monthly price, hours shown for reference only"
      : null;

  // worked is always THIS MONTH's hours, same meaning for every type -- quoted's lifetime
  // total is a separate figure (lifetimeWorked) shown alongside it, never instead of it.
  // Losing the this-month figure for quoted rows was a real regression: "did we do any
  // work on this quoted project this month" is exactly what the row is scanned for.
  const worked = c.workedFiltered ?? c.worked;
  const pkg = isQuoted ? (c.quotedAmount ?? 0) : (c.pkg ?? 0);
  const lifetimeWorked = c.lifetimeWorked ?? 0;
  // Carry is a package balance -- a row that isn't package-like this month (e.g. just moved
  // package -> hourly) has none, even if the ledger still holds the old package's figure.
  const priorBalance = isPackage || isWrapUp ? c.priorBalance : null;
  const carry = Math.abs(priorBalance ?? 0);
  const barBase = isQuoted ? lifetimeWorked : worked;
  const effective = pkg - (priorBalance ?? 0);
  const barMax = Math.max(barBase, effective, pkg, 1) * 1.15;
  const workedPct = Math.max(0, Math.min(100, (barBase / barMax) * 100));
  const pkgPct = (pkg / barMax) * 100;

  // priorBalance < 0: unused hours banked last month, brought into this one — a
  // benefit, shown green. priorBalance > 0: the client over-used their package
  // last month, so this month's hours are effectively paying that down — shown
  // red, same "carried in (green) vs. carried over/used (red)" convention the
  // drawer already uses for this exact field, just applied to this row too.
  const carryLabel = priorBalance == null || priorBalance === 0 ? "Carry-over"
    : priorBalance < 0 ? "Carried in" : "Over-used prior";
  const carryTone = priorBalance == null || priorBalance === 0 ? undefined
    : priorBalance < 0 ? "var(--status-ok)" : "var(--status-over)";
  const carryTitle = priorBalance == null ? undefined
    : isWrapUp ? `${fmt(carry)} h of unutilised package hours owed to the client since offboarding.`
    : priorBalance < 0 ? `${fmt(carry)} h of unused package time carried in from last month.`
    : priorBalance > 0 ? `${fmt(carry)} h of last month's over-use being carried over into this month.`
    : undefined;
  // remaining < 0: over-served (used more than the package this month) — red.
  // remaining > 0: hours still left in the package this month — green.
  const remainingTone = isQuoted
    ? (c.quotedRemaining == null || c.quotedRemaining === 0 ? undefined : c.quotedRemaining < 0 ? "var(--status-over)" : "var(--status-ok)")
    : c.remaining == null || c.remaining === 0 ? undefined
    : c.remaining < 0 ? "var(--status-over)" : "var(--status-ok)";

  const remainingResetTone = c.remainingReset == null || c.remainingReset === 0 ? undefined
    : c.remainingReset < 0 ? "var(--status-over)" : "var(--status-ok)";

  // A friendlier status pill (On pace / At risk / Overserviced / No package) for
  // package-style clients, reusing the same over/under/ok tone already computed
  // above; non-package clients just get their type as a neutral pill.
  // Status column reflects package pacing (the only type with an over/under/on-pace
  // concept) -- non-package types (hourly, ad hoc, …) have no such notion, and
  // showing their type here again would just repeat the Type column two cells over,
  // so they get a plain "not tracked" placeholder instead. Quoted gets its own lifetime-
  // budget pacing (spent-down against the one fixed quoted figure, not a monthly one).
  const statusPill = isWrapUp
    // Kept as short as the other pills (the fixed-width box clipped "Wrap-up · owes 13.2 h");
    // the hours still owed are the Remaining figure, spelled out in the tooltip.
    ? { label: c.remaining > 0 ? "Wrap-up" : "Wrap-up done", tone: "var(--fg-secondary)", bg: "var(--bg-elevated)" }
    : feeOnly
      ? { label: `Fixed fee ${fmtMoney(c.fixedFee.fee).replace(/\.00$/, "")}`, tone: "var(--fg-secondary)", bg: "var(--bg-elevated)" }
    : isPackage
    ? (c.pkg == null || c.pkg <= 0
      ? { label: "No package", tone: "var(--fg-tertiary)", bg: "var(--bg-elevated)" }
      : c.status === "on_hold"
        ? { label: "On hold", tone: "var(--fg-secondary)", bg: "var(--bg-elevated)" }
      : c.status === "over"
        ? { label: "Overserviced", tone: "var(--status-over)", bg: "var(--status-over-soft)" }
        : c.status === "under"
          ? { label: "At risk", tone: "var(--status-warn)", bg: "var(--status-warn-soft)" }
          : { label: "On pace", tone: "var(--status-ok)", bg: "var(--status-ok-soft)" })
    : isQuoted
      // Kept as short as the package-side labels ("Overserviced", "At risk", "On pace")
      // -- "Over quoted amount" was long enough to wrap and spill out of the pill's
      // fixed-width box instead of staying on one line.
      ? (c.quotedAmount == null
        ? { label: isMap ? "No MAP hours" : "No quote set", tone: "var(--fg-tertiary)", bg: "var(--bg-elevated)" }
        : c.quotedRemaining < 0
          ? { label: isMap ? "Over MAP" : "Over quote", tone: "var(--status-over)", bg: "var(--status-over-soft)" }
          : { label: "Within budget", tone: "var(--status-ok)", bg: "var(--status-ok-soft)" })
    : isDigital
      ? { label: "Fixed price", tone: "var(--fg-secondary)", bg: "var(--bg-elevated)" }
      : null;

  const consultantEntries = [...c.userMinutes.entries()].sort((a, b) => b[1] - a[1]);
  const consultantTotal = consultantEntries.reduce((a, [, min]) => a + min, 0);
  const shownConsultants = consultantsAllShown ? consultantEntries : consultantEntries.slice(0, 3);
  const taskEntries = [...c.tasksFiltered.entries()].sort((a, b) => b[1] - a[1]);
  const shownTasks = tasksAllShown ? taskEntries : taskEntries.slice(0, 3);

  // A divider belongs under whichever piece of this row is visually last -- the row
  // itself, unless its cost-centre breakdown is open, in which case the breakdown
  // (rendered right after it) takes the divider instead so the row and its own
  // breakdown never get a line drawn between them.
  const rowDivider = tileRow && hasMoreBelow && !(c.costCentre && costCentreOpen);
  const miniDivider = tileRow && hasMoreBelow && !!c.costCentre && costCentreOpen;

  return (
    <div className={tileRow ? "pg-tile__row-wrap" : "pg-row-wrap" + (nested ? " pg-row--nested" : "")}>
      <div
        role="button" tabIndex={0}
        className={
          "pg-row pg-row-grid-cols"
          + (showReset ? " pg-row-grid-cols--reset" : "")
          + (tileRow ? " pg-row--in-tile" : "")
          + (active ? " pg-row--active" : "")
          + (inlineOpen ? " pg-row--expanded" : "")
          + (rowDivider ? " pg-row--divider" : "")
        }
        onClick={onOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      >
        <span className="pg-row__index">{nested ? subIndex : index}</span>
        <ClientAvatar name={avatarOf?.name ?? c.displayName} logo={avatarOf?.logo ?? c.logoUrl} size={32} style={{ marginRight: -6 }} />
        <span className="pg-row__name">
          <span className="pg-row__name-main">
            {c.displayName}
            {c.isOffboarded && <span className="pg-tag pg-tag--muted pg-tag--pill" style={{ marginLeft: 6 }} title={c.offboardNote}>Offboarded</span>}
          </span>
          {c.costCentre ? (
            <button
              type="button"
              aria-label={costCentreOpen ? "Collapse cost centre breakdown" : "Expand cost centre breakdown"}
              className="pg-row__name-sub pg-row__name-sub--toggle"
              onClick={(e) => { e.stopPropagation(); setCostCentreOpen((o) => !o); }}
            >
              Rolled Up <ChevronDown size={12} style={{ transform: costCentreOpen ? "rotate(180deg)" : undefined }} />
            </button>
          ) : (
            <span className="pg-row__name-sub">
              {nested ? <><Link2 size={10} /> Sub project</>
                : (c.capGroup && c.capGroup !== c.displayName ? c.capGroup : null)}
            </span>
          )}
        </span>
        <span className="pg-tag pg-tag--pill" style={{ color: typeTone(c.type) }}>{typeLabelShort(c.type)}</span>
        <span className="pg-row__num" style={carryTone ? { color: carryTone } : undefined} title={isQuoted ? `Total billed against this ${isMap ? "MAP" : "quote"} so far, from its start month through this one.` : carryTitle}>
          <span className="pg-row__num-label">{isQuoted ? "Total worked" : carryLabel}</span>
          {isQuoted ? `${fmt(lifetimeWorked)} h` : priorBalance != null ? `${fmt(carry)} h` : isPackage ? "—" : ""}
        </span>
        <span className="pg-row__num">
          <span className="pg-row__num-label">{isQuoted ? (isMap ? "MAP" : "Quoted") : "Package"}</span>
          {isQuoted ? (c.quotedAmount != null ? `${fmt(c.quotedAmount)} h` : feeOnly ? fmtMoney(c.fixedFee.fee).replace(/\.00$/, "") : "—") : c.pkg != null ? `${fmt(c.pkg)} h` : isPackage || isWrapUp ? "—" : ""}
        </span>
        <span className="pg-row__num">
          <span className="pg-row__num-label">Worked</span>{fmt(worked)} h
        </span>
        <span className="pg-row__num" style={remainingTone ? { color: remainingTone } : undefined}
          title={feeOnly ? "Effective rate: the fixed fee divided by every billable hour logged against it so far." : isWrapUp ? "Unutilised hours still owed to the client after this month's wrap-up work." : undefined}>
          <span className="pg-row__num-label">{feeOnly ? "Effective rate" : isWrapUp ? "Owed" : "Remaining"}</span>
          {feeOnly
            ? (c.fixedFee.effectiveRate != null ? `${fmtMoney(c.fixedFee.effectiveRate).replace(/\.\d\d$/, "")}/h` : "—")
            : isQuoted
            ? (c.quotedRemaining != null ? `${c.quotedRemaining < 0 ? "−" : ""}${fmt(Math.abs(c.quotedRemaining))} h` : "—")
            : c.remaining != null ? `${c.remaining < 0 ? "−" : ""}${fmt(Math.abs(c.remaining))} h` : isPackage ? "—" : ""}
        </span>
        {showReset && (
          // Same Remaining convention/colouring as the cell above; the tooltip shows the raw
          // signed ledger figure (negative = hours owed to the client).
          <span
            className="pg-row__num"
            style={remainingResetTone ? { color: remainingResetTone } : undefined}
            title={c.resetValue != null ? `Macro sheet: ${fmt(c.resetValue)} h` : undefined}
          >
            {c.remainingReset != null && <span className="pg-row__num-label">Remaining Reset</span>}
            {c.remainingReset != null ? `${c.remainingReset < 0 ? "−" : ""}${fmt(Math.abs(c.remainingReset))} h` : ""}
          </span>
        )}
        <span className="pg-row__status">
          {statusPill && (
            <span className="pg-status-pill" style={{ color: statusPill.tone, background: statusPill.bg }} title={statusText || undefined}>
              {statusPill.label}
            </span>
          )}
        </span>
        <span className="pg-row__menu" style={{ position: "relative" }} ref={menuRef}>
          <button
            type="button" aria-label="More actions"
            className="pg-row__chevron pg-icon-btn-sm"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div className="pg-menu" onClick={(e) => e.stopPropagation()}>
              <ExportItem icon={<Users size={14} />} label="Open full details" onClick={() => { setMenuOpen(false); onOpen(); }} />
              <ExportItem
                icon={<ChevronDown size={14} style={{ transform: inlineOpen ? "rotate(180deg)" : undefined }} />}
                label={inlineOpen ? "Hide reconciliation breakdown" : "Show reconciliation breakdown"}
                onClick={() => { setMenuOpen(false); setInlineOpen((o) => !o); }}
              />
              <div className="pg-menu-sep" />
              <ExportItem icon={<Copy size={14} />} label="Copy summary" onClick={() => { setMenuOpen(false); onCopy?.(c); }} />
              <ExportItem icon={<Printer size={14} />} label="Generate PDF" onClick={() => { setMenuOpen(false); onPdf?.(c); }} />
            </div>
          )}
        </span>
      </div>

      {c.costCentre && costCentreOpen && <CostCentreBreakdown client={c} divider={miniDivider} showReset={showReset} />}

      {inlineOpen && (
        <div className="pg-row-inline">
          <div className="pg-row-inline__col">
            <div className="pg-row-inline__title">Reconciliation overview</div>
            {isPackage && c.pkg != null && c.pkg > 0 ? (
              <>
                <div className="pg-row-inline__barhead">
                  <span>worked {fmt(worked)} h</span>
                  {c.status === "on_hold" ? (
                    <span>on hold, accrual paused</span>
                  ) : c.remaining != null && (
                    <span style={{ color: statusTone }}>{c.remaining < 0 ? "over" : "under"} {fmt(Math.abs(c.remaining))} h</span>
                  )}
                </div>
                <div className="pg-bar-track" style={{ marginTop: 6 }}>
                  <div className="pg-bar-fill" style={{ width: `${workedPct}%`, background: statusTone || "var(--status-ok)" }} />
                  <div className="pg-bar-mark" style={{ left: `${pkgPct}%` }} />
                </div>
                <div className="pg-bar-caption" style={{ marginTop: 6 }}>
                  <span>package {fmt(pkg)} h</span>
                  <span>carry-over {fmt(carry)} h</span>
                </div>
              </>
            ) : isQuoted && c.quotedAmount != null ? (
              <>
                <div className="pg-row-inline__barhead">
                  <span>worked {fmt(lifetimeWorked)} h all time ({fmt(worked)} h this month)</span>
                  {c.quotedRemaining != null && (
                    <span style={{ color: statusTone }}>{c.quotedRemaining < 0 ? "over" : "left"} {fmt(Math.abs(c.quotedRemaining))} h</span>
                  )}
                </div>
                <div className="pg-bar-track" style={{ marginTop: 6 }}>
                  <div className="pg-bar-fill" style={{ width: `${workedPct}%`, background: statusTone || "var(--status-ok)" }} />
                  <div className="pg-bar-mark" style={{ left: `${pkgPct}%` }} />
                </div>
                <div className="pg-bar-caption" style={{ marginTop: 6 }}>
                  <span>{budgetWord} {fmt(pkg)} h</span>
                  <span>bar is cumulative across every month, not just this one</span>
                </div>
              </>
            ) : isWrapUp ? (
              <div className="pg-row-inline__empty">{statusText}</div>
            ) : feeOnly ? (
              <div className="pg-row-inline__empty">{statusText}</div>
            ) : (
              <div className="pg-row-inline__empty">{isQuoted ? `No ${budgetWord} amount on file for this client.` : isDigital ? "Digital Package: fixed monthly price, no package hours tracked." : "No package on file for this client."}</div>
            )}
          </div>

          <div className="pg-row-inline__col">
            <div className="pg-row-inline__title">Consultants involved</div>
            {consultantEntries.length === 0 && <div className="pg-row-inline__empty">No consultants logged.</div>}
            {shownConsultants.map(([u, min]) => (
              <div key={u || "unknown"} className="pg-row-inline__line">
                <span>{u || "—"}</span>
                <span className="pg-row-inline__line-num">{fmt(min / 60)} h · {consultantTotal > 0 ? Math.round((min / consultantTotal) * 100) : 0}%</span>
              </div>
            ))}
            {consultantEntries.length > 3 && (
              <button className="pg-row-inline__more" onClick={() => setConsultantsAllShown((o) => !o)}>
                {consultantsAllShown ? "Show fewer" : `View all ${consultantEntries.length} consultants`}
              </button>
            )}
          </div>

          <div className="pg-row-inline__col">
            <div className="pg-row-inline__title">Tasks worked {tasksAllShown ? "" : "(top 3)"}</div>
            {taskEntries.length === 0 && <div className="pg-row-inline__empty">No tasks in this filter.</div>}
            {shownTasks.map(([task, min]) => (
              <div key={task} className="pg-row-inline__line">
                <span className="pg-row-inline__task">{task}</span>
                <span className="pg-row-inline__line-num">{fmt(min / 60)} h</span>
              </div>
            ))}
            {taskEntries.length > 3 && (
              <button className="pg-row-inline__more" onClick={() => setTasksAllShown((o) => !o)}>
                {tasksAllShown ? "Show fewer" : `View all ${taskEntries.length} tasks`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
