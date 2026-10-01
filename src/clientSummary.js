// Plain-text "Copy summary" for one Client Invoicing client. Pure (moved out of App.jsx's
// component closure) so its figures are testable alongside reconcile.js.
import { fmt, isPackageLikeType } from "./format.js";
import { typeLabelShort } from "./clientTypeLabels.js";
import { unfilteredForExport, isLifetimeBudgetType } from "./reconcile.js";
import { costCentreInvoicesFor, invoiceLineLabel, fmtMoney } from "./invoiceSplit.js";

export function buildSummaryText(client, { invoiceMonth, priorMonthPretty } = {}) {
  // Always the whole client's tasks/hours, never one consultant's slice (see unfilteredForExport).
  const c = unfilteredForExport(client);
  const billable = c.billableWorked ?? c.worked;
  const lines = [];
  const monthText = invoiceMonth || "this month";
  lines.push(`${c.displayName}: hours for ${monthText}`);
  if (c.accruedClient && c.accruedClient.name !== c.name) lines.push(`(ClickUp folder: ${c.name})`);
  lines.push(`Client type: ${typeLabelShort(c.type)}`);
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
  if (c.status === "wrap_up") {
    // Offboarded, still owed unutilised hours: this month's work is deducted from them.
    lines.push(`Offboarded: unutilised hours owed carried in: ${fmt(Math.abs(c.priorBalance))} h`);
    if (Math.abs(billable - c.worked) > 0.005) lines.push(`Billable wrap-up time deducted: ${fmt(billable)} h`);
    lines.push(c.remainingShown > 0 ? `Still owed after this month: ${fmt(c.remainingShown)} h` : `Owed hours used up (over by ${fmt(Math.abs(c.remainingShown))} h)`);
  } else if (isPackageLikeType(c.type) && c.pkg != null && c.pkg > 0) {
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
  } else if (c.type === "digital") {
    lines.push("Digital Package: fixed monthly price, hours shown for reference only.");
  } else if (isLifetimeBudgetType(c.type)) {
    // Quoted and MAP: one fixed hour budget for the whole engagement, MAP wording for a MAP.
    const isMap = c.type === "map";
    const word = isMap ? "MAP" : "quoted";
    if (c.quotedAmount != null) {
      lines.push(`${isMap ? "MAP hours" : "Quoted amount"}: ${fmt(c.quotedAmount)} h`);
      lines.push(`Total time tracked on this ${isMap ? "MAP" : "quote"}: ${fmt(c.lifetimeWorked ?? 0)} h`);
      lines.push(c.quotedRemaining >= 0 ? `Remaining of ${word} amount: ${fmt(c.quotedRemaining)} h` : `Over the ${word} amount by: ${fmt(Math.abs(c.quotedRemaining))} h`);
    } else if (c.fixedFee) {
      // Priced as a one-off dollar fee, no hours: the fee and its effective hourly rate.
      lines.push(`Fixed fee: ${fmtMoney(c.fixedFee.fee)}`);
      lines.push(`Total time tracked on this ${isMap ? "MAP" : "quote"}: ${fmt(c.lifetimeWorked ?? 0)} h`);
      if (c.fixedFee.effectiveRate != null) lines.push(`Effective rate so far: ${fmtMoney(c.fixedFee.effectiveRate)}/h`);
    } else {
      lines.push(`No ${word} amount on file for this client.`);
    }
    if (c.quotedAmount != null && c.fixedFee) lines.push(`Fixed fee: ${fmtMoney(c.fixedFee.fee)}`);
  }
  const invoices = costCentreInvoicesFor(c);
  if (invoices) {
    const { rate, cap } = invoices[0].rule;
    lines.push("");
    lines.push(`Invoices by cost centre (billable hours at ${fmtMoney(rate)}/h, max ${fmtMoney(cap)} per invoice):`);
    for (const inv of invoices) {
      lines.push(`  ${inv.name}: ${fmt(inv.hours)} h · ${fmtMoney(inv.amount)}`);
      if (inv.lines.length > 1) inv.lines.forEach((line, i) => lines.push(`    ${invoiceLineLabel(line, i, inv.lines.length)}`));
    }
  }
  return lines.join("\n");
}
