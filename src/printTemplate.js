import { LETTERHEAD_FOOTER_B64 } from "./letterheadFooter.js";
import { NORDIQUE_FONT_FACE_CSS } from "./nordiqueFont.js";
import { fmt, esc, filenameSafe, isPackageLikeType } from "./format.js";
import { unfilteredForExport, isLifetimeBudgetType } from "./reconcile.js";
import { WITHHELD_NOTE } from "./clientListFilter.js";
import { notInvoicedLines } from "./clientSummary.js";
import { typeLabelShort } from "./clientTypeLabels.js";
import { costCentreInvoicesFor, costCentreInvoice, invoiceCapRuleFor, invoiceLineLabel, fmtMoney } from "./invoiceSplit.js";

// "Invoices by cost centre" rows for a client with a per-cost-centre invoice cap
// (invoiceSplit.js): each cost centre's billable hours/amount, then one row per invoice
// when it has to be split to stay under the cap. "" for any other client.
function invoiceRowsHtml(invoices) {
  if (!invoices || !invoices.length) return "";
  const { rate, cap } = invoices[0].rule;
  const rows = invoices.map((inv) => `
    <tr class="datarow"><td>${esc(inv.name)} <span class="label">(${fmt(inv.hours)} h)</span></td><td class="right">${esc(fmtMoney(inv.amount))}</td></tr>${inv.lines.length > 1 ? inv.lines.map((line, i) => `
    <tr class="datarow"><td class="label" style="padding-left:24px">${esc(invoiceLineLabel(line, i, inv.lines.length))}</td><td class="right">${esc(fmtMoney(line.amount))}</td></tr>`).join("") : ""}`).join("");
  return `
    <tr class="noborder"><td colspan="2" class="section-heading">Invoices by cost centre</td></tr>${rows}
    <tr class="noborder"><td colspan="2" class="note-cell">Billable hours at ${esc(fmtMoney(rate))}/h. No invoice may exceed ${esc(fmtMoney(cap))} per cost centre, so a cost centre over that is split across several invoices.</td></tr>`;
}

// ------------------------------- PDF (print) --------------------------------
// Pixel size of the letterhead footer image (LETTERHEAD_FOOTER_B64), for its height at
// full page width.
const FOOTER_IMG_W = 2843;
const FOOTER_IMG_H = 202;
const PRINT = { ink: "#000000", inkSoft: "#000000", brand: "#3F008E", line: "#E7E1F0", brandSoft: "#F1EAFB" };

// The figures block for one client (Reconciliation / Quoted summary / Summary / invoice
// part), shared by the full per-client PDF and the summary-only group PDF. `c` is already
// unfiltered.
function reconciliationHtml(c, priorMonthText) {
  const type = c.type;
  const isPkg = isPackageLikeType(type) && !c.isLineItemExport;
  const hasPkg = c.pkg != null && c.pkg > 0;
  // Quoted and MAP share one lifetime-budget summary (a MAP is quoted at a fixed total too).
  const isQuoted = isLifetimeBudgetType(type) && !c.isLineItemExport;
  const isMap = type === "map";
  const budgetWord = isMap ? "MAP" : "quoted";
  const workedRounded = Math.round(c.workedFiltered * 100) / 100;
  // The package math always runs on billable hours (the Billable-only toggle is display-only).
  const billableRounded = Math.round((c.billableWorked ?? c.workedFiltered) * 100) / 100;
  const priorSigned = c.priorBalance ?? 0;
  const priorLabel = priorSigned < 0 ? "Carried in from previous month"
                    : priorSigned > 0 ? "Over-used in previous month"
                    : "Prior month balance";
  const priorAbs = Math.abs(priorSigned);
  // Prior month re-baselined from the legacy macro sheet (see carryOutOf in format.js).
  const priorRebased = c.priorRebaseline ? " (re-baselined)" : "";
  // A month carrying its own macro-sheet reset reports that as the balance going forward
  // and as Remaining (Remaining convention = negated signed balance).
  const balanceForward = c.balanceForward;
  const remainingShown = c.remainingShown;
  const totalAccrued = billableRounded + priorSigned; // as spec'd: current spent + prior signed
  const onHold = c.status === "on_hold";
  const billableRow = Math.abs(billableRounded - workedRounded) > 0.005
    ? `<tr class="datarow"><td class="label">Billable time counted toward the package</td><td class="right">${fmt(billableRounded)} h</td></tr>` : "";

  // The prior month wasn't invoiced: show how its carry-out was worked out (worked hours
  // against the balance carried into it, no package billed) above the carry row.
  const notInv = !c.isLineItemExport ? notInvoicedLines(c.priorNotInvoiced) : null;
  const notInvoicedRows = notInv ? notInv.rows.map(([label, h]) => `
    <tr class="datarow"><td class="label">${esc(label)}</td><td class="right">${fmt(h)} h</td></tr>`).join("") : "";
  const notInvoicedNote = notInv ? ` ${esc(notInv.note)}` : "";

  const isWrapUp = c.status === "wrap_up" && !c.isLineItemExport;
  const feeOnly = isQuoted && c.quotedAmount == null && !!c.fixedFee;
  // One invoice of a capped cost centre split across several (pdfZip.js invoicePartClient).
  const part = c.invoicePart;
  // Scoped view, not one of the user's clients (withholdRedactedFigures): hours only.
  const reconciliation = part ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Invoice ${part.index} of ${part.count}</td></tr>
    <tr class="datarow"><td class="label">Billable hours on this invoice</td><td class="right">${fmt(part.line.hours)} h</td></tr>
    <tr class="datarow"><td class="label">Rate</td><td class="right">${esc(fmtMoney(part.rule.rate))}/h</td></tr>
    <tr class="total"><td>Invoice amount</td><td class="right">${esc(fmtMoney(part.line.amount))}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">${esc(part.centreName)} logged ${fmt(part.totalHours)} billable hours this month (${esc(fmtMoney(part.totalAmount))}). No invoice may exceed ${esc(fmtMoney(part.rule.cap))}, so the month is split across ${part.count} invoices; the tasks above are this invoice's share${part.splitTasks ? " (a task marked \"part\" continues on the neighbouring invoice)" : ""}.</td></tr>` : c.withheld && !c.isLineItemExport ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Reconciliation</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">${esc(WITHHELD_NOTE)}</td></tr>` : isWrapUp ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Reconciliation</td></tr>
    <tr class="datarow"><td class="label">Unutilised hours owed${priorMonthText ? ` (carried in from ${esc(priorMonthText)})` : ""}</td><td class="right">${fmt(priorAbs)} h</td></tr>
    <tr class="datarow"><td class="label">Wrap-up time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    ${billableRow.replace("toward the package", "against the owed hours")}
    <tr class="total"><td>${remainingShown > 0 ? "Still owed" : "Owed hours used up, over by"}</td><td class="right">${fmt(Math.abs(remainingShown))} h</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">The engagement has ended. We owe the client its unutilised package hours, so any work after the end date is deducted from them; no new package hours are added.</td></tr>` : feeOnly ? `
    <tr class="noborder"><td colspan="2" class="section-heading">${isMap ? "MAP summary" : "Quoted project summary"}</td></tr>
    <tr class="datarow"><td class="label">Fixed fee</td><td class="right">${esc(fmtMoney(c.fixedFee.fee))}</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="datarow"><td class="label">Total time tracked on this ${isMap ? "MAP" : "quote"}</td><td class="right">${fmt(c.lifetimeWorked ?? 0)} h</td></tr>
    <tr class="total"><td>Effective rate so far</td><td class="right">${c.fixedFee.effectiveRate != null ? esc(fmtMoney(c.fixedFee.effectiveRate)) + "/h" : "n/a"}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">A one-off fixed fee rather than an hour budget: the effective rate is the fee divided by every billable hour logged against it so far.</td></tr>` : isPkg && !hasPkg ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Reconciliation</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">No package on file for this client this month, so no balance is calculated.</td></tr>` : isPkg && onHold ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Reconciliation</td></tr>
    <tr class="datarow"><td class="label">Package</td><td class="right">${fmt(c.pkg)} h / month</td></tr>
    ${notInvoicedRows}
    <tr class="datarow"><td class="label">${priorLabel}${priorMonthText ? ` (${esc(priorMonthText)})` : ""}${priorRebased}</td><td class="right">${fmt(priorAbs)} h</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="datarow"><td class="label">Balance carried forward</td><td class="right">${fmt(balanceForward)} h ${balanceForward > 0 ? "over" : balanceForward < 0 ? "credit" : ""}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">On hold this month: the package is paused, so no package hours are consumed and the balance carries forward unchanged.${notInvoicedNote}</td></tr>` : isPkg ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Reconciliation</td></tr>
    <tr class="datarow"><td class="label">Package</td><td class="right">${fmt(c.pkg)} h / month</td></tr>
    ${notInvoicedRows}
    <tr class="datarow"><td class="label">${priorLabel}${priorMonthText ? ` (${esc(priorMonthText)})` : ""}${priorRebased}</td><td class="right">${fmt(priorAbs)} h</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    ${billableRow}
    <tr class="total"><td>Total accrued time</td><td class="right">${fmt(totalAccrued)} h</td></tr>
    <tr class="datarow"><td class="label">New balance going forward</td><td class="right">${fmt(balanceForward)} h ${balanceForward > 0 ? "over" : balanceForward < 0 ? "credit" : ""}</td></tr>
    <tr class="datarow"><td class="label">Remaining this month</td><td class="right">${remainingShown >= 0 ? fmt(remainingShown) + " h left" : fmt(Math.abs(remainingShown)) + " h over"}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">Total accrued time = billable time tracked this month + prior balance (signed). Negative prior = client credit carried in; positive prior = over-served last month.${c.resetValue != null ? " This month's closing balance and remaining figure are reset to the agreed closing balance." : ""}${notInvoicedNote}</td></tr>` : isQuoted ? `
    <tr class="noborder"><td colspan="2" class="section-heading">${isMap ? "MAP summary" : "Quoted project summary"}</td></tr>
    <tr class="datarow"><td class="label">${isMap ? "MAP hours" : "Quoted amount"}</td><td class="right">${c.quotedAmount != null ? fmt(c.quotedAmount) + " h" : "n/a"}</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="datarow"><td class="label">Total time tracked on this ${isMap ? "MAP" : "quote"}</td><td class="right">${fmt(c.lifetimeWorked ?? 0)} h</td></tr>
    <tr class="total"><td>${c.quotedRemaining != null && c.quotedRemaining < 0 ? `Over the ${budgetWord} amount by` : `Remaining of ${budgetWord} amount`}</td><td class="right">${c.quotedRemaining != null ? fmt(Math.abs(c.quotedRemaining)) + " h" : "n/a"}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">${isMap ? "A MAP" : "Quoted"} is a single fixed budget for the whole ${isMap ? "plan" : "project"}, not a monthly one. The total and remaining figures are cumulative across every month of it, not just this one.</td></tr>` : `
    <tr class="noborder"><td colspan="2" class="section-heading">Summary</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">${c.isLineItemExport ? `This folder's own hours only. It is part of ${esc(c.rolledUpParentName)}'s rolled-up package; see that client's own report for the combined package and reconciliation figures.` : type === "hourly" ? "Hourly-rate client: invoice at the agreed hourly rate for these hours." : type === "digital" ? "Digital Package: fixed monthly price. Hours are shown for reference only." : type === "queensland" ? "Queensland (previously) client: no accrued balance on record." : "No accrued balance tracked for this client type."}</td></tr>`;
  return reconciliation;
}

export function buildPrintHtml(client, monthText, priorMonthText) {
  // The whole client's tasks/hours, never one consultant's slice -- the reconciliation below
  // is the whole client's balance, so a consultant-filtered task total next to it produced a
  // document whose figures didn't add up. A line-item export is already its own slice.
  const c = client.isLineItemExport ? client : unfilteredForExport(client);
  // A line-item export carries its own one-cost-centre invoices (see printLineItemPdf).
  const invoices = c.invoicePart ? null : c.isLineItemExport ? (c.invoices || null) : costCentreInvoicesFor(c);
  const taskRows = [...c.tasksFiltered.entries()].sort((a, b) => b[1] - a[1])
    .map(([task, min]) => `<tr class="datarow"><td>${esc(task)}</td><td class="right">${fmt(min / 60)}</td></tr>`).join("");
  const workedRounded = Math.round(c.workedFiltered * 100) / 100;
  return docHtml({
    title: `${filenameSafe(c.displayName)} ${filenameSafe(monthText)}`,
    brandLine: "Purple Giraffe · client hours report",
    heading: c.displayName,
    subtitle: `${monthText}${c.invoicePart ? ` · Invoice ${c.invoicePart.index} of ${c.invoicePart.count}` : ""}`,
    body: `
      <tr class="noborder"><td colspan="2" class="section-heading">Tasks worked this month</td></tr>
      ${taskRows || `<tr class="datarow"><td colspan="2" class="label">No tasks in this filter.</td></tr>`}
      <tr class="total"><td>Total</td><td class="right">${fmt(workedRounded)} h</td></tr>

      ${reconciliationHtml(c, priorMonthText)}
      ${invoiceRowsHtml(invoices)}`,
  });
}

// Summary-only export for a client with sub-projects and/or a cost-centre roll-up: every
// nested row's own totals and figures (hours, package/carry/remaining, invoices,
// cost-centre hours) on one document, without the task line items. `parent` and
// `subProjects` are App.jsx's cards (parent first, then each nested sub-project row);
// App.jsx leaves quoted sub-projects out of `subProjects` (billed separately).
export function buildGroupSummaryHtml(parent, subProjects, monthText, priorMonthText) {
  const cards = [parent, ...(subProjects || [])].map((x) => unfilteredForExport(x));
  const totalWorked = cards.reduce((sum, x) => sum + (x.worked || 0), 0);
  const sections = cards.map((x, i) => {
    const cc = x.costCentre?.lineItems?.length ? `
      <tr class="noborder"><td colspan="2" class="section-heading">Hours by cost centre</td></tr>
      ${x.costCentre.lineItems.map((item) => `<tr class="datarow"><td>${esc(item.name)}</td><td class="right">${fmt(item.hours)} h</td></tr>`).join("")}` : "";
    return `
      <tr class="noborder"><td colspan="2" class="client-heading">${esc(x.displayName)} <span class="client-tag">${esc(i === 0 ? typeLabelShort(x.type) : `Sub project · ${typeLabelShort(x.type)}`)}</span></td></tr>
      ${cc}
      ${reconciliationHtml(x, priorMonthText)}
      ${invoiceRowsHtml(costCentreInvoicesFor(x))}`;
  }).join("");
  return docHtml({
    title: `${filenameSafe(parent.displayName)} summary ${filenameSafe(monthText)}`,
    brandLine: "Purple Giraffe · client summary",
    heading: parent.displayName, subtitle: monthText,
    body: `${sections}
      <tr class="noborder"><td colspan="2" class="client-heading">All projects</td></tr>
      ${cards.map((x) => `<tr class="datarow"><td>${esc(x.displayName)}</td><td class="right">${fmt(Math.round((x.worked || 0) * 100) / 100)} h</td></tr>`).join("")}
      <tr class="total"><td>Total time tracked this month</td><td class="right">${fmt(Math.round(totalWorked * 100) / 100)} h</td></tr>
      <tr class="noborder"><td colspan="2" class="note-cell">Summary only: task-level line items and separately quoted projects are left out. Each project's own figures are shown above; use Generate PDF on a project for its task breakdown.</td></tr>`,
  });
}

export function printGroupSummaryPdf(parent, subProjects, monthText, priorMonthText) {
  openPrintWindow(buildGroupSummaryHtml(parent, subProjects, monthText, priorMonthText));
}

function docHtml({ title, brandLine, heading, subtitle, body }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  ${NORDIQUE_FONT_FACE_CSS}
  /* Page layout (matches the bulk ZIP export, pdfZip.js): 15mm top and side margins for the
     content, and the letterhead footer strip at full page width, edge to edge, its bottom
     1cm above the bottom of every page. The @page side/bottom margins are 0 so a fixed
     footer can reach the page edges; the side margins live on body instead. */
  @page { margin: 15mm 0 0 0; size: A4; }
  * { box-sizing: border-box; }
  body { font-family: 'Nordique Pro', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 600; color: ${PRINT.ink}; margin: 0 15mm; }
  /* The footer strip: position:fixed repeats it on every printed page. Content is kept clear
     of it by the empty repeating <tfoot> row below (display:table-footer-group is the one
     mechanism Chromium reserves per-page space for correctly), which is taller than the
     strip plus its 1cm offset and a 5mm gap -- a fixed element alone doesn't reserve space,
     and the last row before a page break used to bleed into it. Hence the whole page being
     one table: everything that flows across pages (header, tasks, reconciliation) lives in
     its tbody. */
  .letterhead-footer {
    position: fixed; left: 0; right: 0; bottom: 10mm; margin: 0; line-height: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .letterhead-footer img { display: block; width: 100%; height: auto; }
  .letterhead-footer-cell { height: calc(10mm + ${(210 * FOOTER_IMG_H / FOOTER_IMG_W).toFixed(2)}mm + 5mm); padding: 0; border: none; }
  table.doc { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 8px 10px; text-align: left; }
  .header-cell { border-bottom: 2px solid ${PRINT.ink}; padding-bottom: 14px; }
  .brand { font-family: 'Nordique Pro', sans-serif; color: ${PRINT.brand}; font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; }
  h1 { font-family: 'Nordique Pro', sans-serif; font-weight: 700; font-size: 26px; margin: 6px 0 0; letter-spacing: -0.01em; }
  .subtitle { color: ${PRINT.inkSoft}; font-size: 14px; margin-top: 4px; }
  .section-heading { font-family: 'Nordique Pro', sans-serif; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${PRINT.brand}; font-weight: 600; padding-top: 22px; }
  .noborder td, tr.noborder { border: none; }
  .datarow { border-bottom: 1px solid ${PRINT.line}; page-break-inside: avoid; break-inside: avoid; font-weight: 300; }
  .right { text-align: right; font-variant-numeric: tabular-nums; font-family: Arial, "Segoe UI", sans-serif; }
  .total td { font-weight: 700; border-top: 2px solid ${PRINT.ink}; border-bottom: none; padding-top: 12px; }
  .label { color: ${PRINT.inkSoft}; }
  .client-heading { font-family: 'Nordique Pro', sans-serif; font-weight: 700; font-size: 17px; padding-top: 28px; border-bottom: 1px solid ${PRINT.ink}; }
  .client-tag { font-size: 10px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: ${PRINT.brand}; margin-left: 6px; }
  .note-cell { font-size: 11px; color: ${PRINT.inkSoft}; font-style: italic; padding-top: 4px; }
  .generated-note-cell { font-size: 9px; color: ${PRINT.inkSoft}; text-align: right; font-style: italic; padding-top: 24px; }
  @media print { .noprint { display: none; } }
</style>
</head><body>
  <div class="letterhead-footer"><img alt="" src="data:image/png;base64,${LETTERHEAD_FOOTER_B64}"></div>
  <table class="doc">
    <tfoot>
      <tr><td colspan="2" class="letterhead-footer-cell"></td></tr>
    </tfoot>
    <tbody>
      <tr class="noborder"><td colspan="2" class="header-cell">
        <div class="brand">${esc(brandLine)}</div>
        <h1>${esc(heading)}</h1>
        <div class="subtitle">${esc(subtitle)}</div>
      </td></tr>
${body}

      <tr class="noborder"><td colspan="2" class="generated-note-cell">Generated ${esc(new Date().toLocaleString())}</td></tr>
    </tbody>
  </table>

  <script>
    window.addEventListener('load', function() {
      // Print as soon as fonts are ready, but never wait more than 1.5s for
      // them — a hung font-loading promise should never be able to silently
      // stop the print dialog (and the "download") from happening at all.
      var printed = false;
      function go() { if (!printed) { printed = true; window.print(); } }
      document.fonts.ready.then(go, go);
      setTimeout(go, 1500);
    });
  </script>
</body></html>`;
}

// Heading for one cost centre's own PDF. A ClickUp folder often already starts with the
// client's name ("Vegetation Solutions - Firewood Solutions"), which used to give
// "Vegetation Solutions — Vegetation Solutions - Firewood Solutions". Such a folder name is
// used as-is; a folder prefixed with the client's initials ("MP - Commercial Leak Tech
// (WA)" under Majestic Plumbing) has them swapped for the name; anything else is
// "Client - Folder". Plain hyphens only, never an em dash.
export function lineItemTitle(parentName, itemName) {
  const parent = String(parentName ?? "").trim();
  const item = String(itemName ?? "").trim();
  if (!parent) return item;
  if (!item) return parent;
  const lp = parent.toLowerCase(), li = item.toLowerCase();
  // Starts with the client's name at a word boundary ("Zest WA ...", "Vegetation Solutions - MVS").
  if (li === lp || (li.startsWith(lp) && !/[a-z0-9]/i.test(item[parent.length]))) return item;
  const initials = parent.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");
  if (initials.length >= 2) {
    const m = item.match(/^([A-Za-z0-9]+)\s*[-–—:]\s*(.+)$/);
    if (m && m[1].toLowerCase() === initials.toLowerCase()) return `${parent} - ${m[2]}`;
  }
  return `${parent} - ${item}`;
}

// A single folder's own slice of a rolled-up (cost-centre) client, e.g. exporting just
// BAMSS Childcare's hours out of Brisbane Alarm Monitoring's combined report -- built
// from the line item's own (pre-merge) tasksByUser snapshot (see App.jsx's cost-centre
// merge) rather than the parent's already-merged totals, so this genuinely reports only
// that one folder's work, not the whole rolled-up package.
export function lineItemClient(parent, lineItem, consultantFilter) {
  let tasks;
  if (consultantFilter) {
    tasks = lineItem.tasksByUser.get(consultantFilter) || new Map();
  } else {
    tasks = new Map();
    for (const [, tm] of lineItem.tasksByUser) for (const [task, min] of tm) tasks.set(task, (tasks.get(task) || 0) + min);
  }
  const workedFiltered = [...tasks.values()].reduce((a, min) => a + min, 0) / 60;
  // A capped client's cost centre is invoiced on its own, so its slice carries its own split
  // (always from the whole cost centre's billable hours, whatever the consultant filter).
  const rule = invoiceCapRuleFor(parent);
  const invoices = rule ? [costCentreInvoice(lineItem.name, lineItem.billableHours ?? lineItem.hours, rule)] : null;
  return {
    displayName: lineItemTitle(parent.displayName, lineItem.name),
    type: "project", tasksFiltered: tasks, workedFiltered,
    isLineItemExport: true, rolledUpParentName: parent.displayName, invoices,
  };
}

export function printLineItemPdf(parent, lineItem, monthText, consultantFilter) {
  printClientPdf(lineItemClient(parent, lineItem, consultantFilter), monthText, null);
}

export function printClientPdf(c, monthText, priorMonthText) {
  openPrintWindow(buildPrintHtml(c, monthText, priorMonthText));
}

function openPrintWindow(html) {
  const w = window.open("", "_blank", "width=900,height=1100");
  if (!w) {
    // popup blocked — fall back to blob URL in the current tab
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
