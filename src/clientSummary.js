// Plain-text "Copy summary" for one Client Invoicing client. Pure (moved out of App.jsx's
// component closure) so its figures are testable alongside reconcile.js.
import { fmt, isPackageLikeType } from "./format.js";
import { TYPE_LABELS_SHORT } from "./nameMatch.js";
import { unfilteredForExport } from "./reconcile.js";

export function buildSummaryText(client, { invoiceMonth, priorMonthPretty } = {}) {
  // Always the whole client's tasks/hours, never one consultant's slice (see unfilteredForExport).
  const c = unfilteredForExport(client);
  const billable = c.billableWorked ?? c.worked;
  const lines = [];
  const monthText = invoiceMonth || "this month";
  lines.push(`${c.displayName}: hours for ${monthText}`);
  if (c.accruedClient && c.accruedClient.name !== c.name) lines.push(`(ClickUp folder: ${c.name})`);
  lines.push(`Client type: ${TYPE_LABELS_SHORT[c.type]}`);
  lines.push("");
  lines.push("Tasks:");
  for (const [task, min] of [...c.tasksFiltered.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`  ${fmt(min / 60)} h  ${task}`);
  lines.push("");
  if (c.userMinutes.size > 0) {
    lines.push("Consultants involved:");
    for (const [u, min] of [...c.userMinutes.entries()].sort((a, b) => b[1] - a[1]))
      lines.push(`  ${fmt(min / 60)} h  ${u || "—"}`);
    lines.push("");
  }
  lines.push(`Time tracked this month: ${fmt(c.workedFiltered)} h`);
  if (isPackageLikeType(c.type) && c.pkg != null && c.pkg > 0) {
    if (Math.abs(billable - c.worked) > 0.005) lines.push(`Billable time counted toward the package: ${fmt(billable)} h`);
    lines.push(`Package: ${fmt(c.pkg)} h`);
    const p = c.priorBalance ?? 0;
    const rebased = c.priorRebaseline ? " (re-baselined)" : "";
    if (p < 0) lines.push(`Carried in from ${priorMonthPretty}${rebased}: ${fmt(Math.abs(p))} h`);
    else if (p > 0) lines.push(`Over-used in ${priorMonthPretty}${rebased}: ${fmt(p)} h`);
    else lines.push(`Prior balance${rebased}: 0 h`);
    if (c.status === "on_hold") {
      lines.push("On hold this month: package paused, balance carried forward unchanged.");
      lines.push(`Balance carried forward: ${fmt(c.balanceForward)} h`);
    } else {
      lines.push(`Total accrued time: ${fmt(billable + p)} h`);
      // A month re-baselined from the macro sheet reports the reset as its Remaining figure.
      const rem = c.remainingShown;
      lines.push(rem >= 0 ? `Remaining this month: ${fmt(rem)} h` : `Over by ${fmt(Math.abs(rem))} h`);
      if (c.resetValue != null) lines.push("(Remaining re-baselined to the accrual sheet's closing figure for this month.)");
      if (c.status === "over") lines.push(`⚠ Over the +10% KPI (${fmt(c.kpiPct, 1)}% of package)`);
      if (c.status === "under") lines.push(`⚠ Under the −10% KPI (${fmt(c.kpiPct, 1)}% of package), accruing`);
    }
  } else if (isPackageLikeType(c.type)) {
    lines.push("No package on file for this client this month.");
  } else if (c.type === "quoted") {
    if (c.quotedAmount != null) {
      lines.push(`Quoted amount: ${fmt(c.quotedAmount)} h`);
      lines.push(`Total time tracked on this quote: ${fmt(c.lifetimeWorked ?? 0)} h`);
      lines.push(c.quotedRemaining >= 0 ? `Remaining of quoted amount: ${fmt(c.quotedRemaining)} h` : `Over the quoted amount by: ${fmt(Math.abs(c.quotedRemaining))} h`);
    } else {
      lines.push("No quoted amount on file for this client.");
    }
  }
  return lines.join("\n");
}
