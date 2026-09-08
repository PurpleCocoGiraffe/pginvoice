import { LETTERHEAD_FOOTER_B64 } from "./letterheadFooter.js";
import { NORDIQUE_FONT_FACE_CSS } from "./nordiqueFont.js";
import { fmt, esc, filenameSafe, isPackageLikeType } from "./format.js";

// ------------------------------- PDF (print) --------------------------------
const PRINT = { ink: "#000000", inkSoft: "#000000", brand: "#3F008E", line: "#E7E1F0", brandSoft: "#F1EAFB" };

export function buildPrintHtml(c, monthText, priorMonthText) {
  const type = c.type;
  const isPkg = isPackageLikeType(type) && !c.isLineItemExport;
  const isQuoted = type === "quoted" && !c.isLineItemExport;
  const taskRows = [...c.tasksFiltered.entries()].sort((a, b) => b[1] - a[1])
    .map(([task, min]) => `<tr class="datarow"><td>${esc(task)}</td><td class="right">${fmt(min / 60)}</td></tr>`).join("");
  const workedRounded = Math.round(c.workedFiltered * 100) / 100;
  const priorSigned = c.priorBalance ?? 0;
  const priorLabel = priorSigned < 0 ? "Carried in from previous month"
                    : priorSigned > 0 ? "Over-used in previous month"
                    : "Prior month balance";
  const priorAbs = Math.abs(priorSigned);
  const totalAccrued = workedRounded + priorSigned; // as spec'd: current spent + prior signed

  const reconciliation = isPkg ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Reconciliation</td></tr>
    <tr class="datarow"><td class="label">Package</td><td class="right">${fmt(c.pkg)} h / month</td></tr>
    <tr class="datarow"><td class="label">${priorLabel}${priorMonthText ? ` (${esc(priorMonthText)})` : ""}</td><td class="right">${fmt(priorAbs)} h</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="total"><td>Total accrued time</td><td class="right">${fmt(totalAccrued)} h</td></tr>
    <tr class="datarow"><td class="label">New balance going forward</td><td class="right">${fmt(c.newBalance)} h ${c.newBalance > 0 ? "over" : c.newBalance < 0 ? "credit" : ""}</td></tr>
    <tr class="datarow"><td class="label">Remaining this month</td><td class="right">${c.remaining >= 0 ? fmt(c.remaining) + " h left" : fmt(Math.abs(c.remaining)) + " h over"}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">Total accrued time = time tracked this month + prior balance (signed). Negative prior = client credit carried in; positive prior = over-served last month.</td></tr>` : isQuoted ? `
    <tr class="noborder"><td colspan="2" class="section-heading">Quoted project summary</td></tr>
    <tr class="datarow"><td class="label">Quoted amount</td><td class="right">${c.quotedAmount != null ? fmt(c.quotedAmount) + " h" : "—"}</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="datarow"><td class="label">Total time tracked (all time)</td><td class="right">${fmt(c.lifetimeWorked ?? 0)} h</td></tr>
    <tr class="total"><td>${c.quotedRemaining != null && c.quotedRemaining < 0 ? "Over the quoted amount by" : "Remaining of quoted amount"}</td><td class="right">${c.quotedRemaining != null ? fmt(Math.abs(c.quotedRemaining)) + " h" : "—"}</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">Quoted is a single fixed budget for the whole project, not a monthly one -- the total/remaining figures are cumulative across every month worked, not just this one.</td></tr>` : `
    <tr class="noborder"><td colspan="2" class="section-heading">Summary</td></tr>
    <tr class="datarow"><td class="label">Time tracked this month</td><td class="right">${fmt(workedRounded)} h</td></tr>
    <tr class="noborder"><td colspan="2" class="note-cell">${c.isLineItemExport ? `This folder's own hours only -- part of ${esc(c.rolledUpParentName)}'s rolled-up package; see that client's own report for the combined package/reconciliation figures.` : type === "hourly" ? "Hourly-rate client: invoice at the agreed hourly rate for these hours." : type === "queensland" ? "Queensland (previously) client: no accrued balance on record." : "No accrued balance tracked for this client type."}</td></tr>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${esc(filenameSafe(c.displayName))} ${esc(filenameSafe(monthText))}</title>
<style>
  ${NORDIQUE_FONT_FACE_CSS}
  @page { margin: 15mm; size: A4; }
  * { box-sizing: border-box; }
  body { font-family: 'Nordique Pro', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; font-weight: 600; color: ${PRINT.ink}; margin: 0; }
  /* The letterhead footer repeats on every printed page via a <tfoot> with
     display:table-footer-group — the one CSS mechanism Chromium actually
     reserves per-page space for correctly. A position:fixed footer (the
     previous approach) hits a longstanding Chromium print bug: the last
     row before a page break bleeds a few mm into a fixed element regardless
     of how much @page margin is reserved for it — reproduces even in a
     bare table with zero custom CSS, so it isn't a tuning problem. Hence
     the whole page being one table: everything that needs to flow across
     pages safely (header, tasks, reconciliation) lives in its tbody. */
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
  .note-cell { font-size: 11px; color: ${PRINT.inkSoft}; font-style: italic; padding-top: 4px; }
  .generated-note-cell { font-size: 9px; color: ${PRINT.inkSoft}; text-align: right; font-style: italic; padding-top: 24px; }
  .letterhead-footer-cell {
    height: 15mm; /* the footer image is cropped to fit exactly within a 15mm margin at full page width */
    padding: 0;
    border: none;
    background-image: url('data:image/png;base64,${LETTERHEAD_FOOTER_B64}');
    background-repeat: no-repeat;
    background-position: bottom center;
    background-size: 100% auto;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @media print { .noprint { display: none; } }
</style>
</head><body>
  <table class="doc">
    <tfoot>
      <tr><td colspan="2" class="letterhead-footer-cell"></td></tr>
    </tfoot>
    <tbody>
      <tr class="noborder"><td colspan="2" class="header-cell">
        <div class="brand">Purple Giraffe · client hours report</div>
        <h1>${esc(c.displayName)}</h1>
        <div class="subtitle">${esc(monthText)}</div>
      </td></tr>

      <tr class="noborder"><td colspan="2" class="section-heading">Tasks worked this month</td></tr>
      ${taskRows || `<tr class="datarow"><td colspan="2" class="label">No tasks in this filter.</td></tr>`}
      <tr class="total"><td>Total</td><td class="right">${fmt(workedRounded)} h</td></tr>

      ${reconciliation}

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

// A single folder's own slice of a rolled-up (cost-centre) client, e.g. exporting just
// BAMSS Childcare's hours out of Brisbane Alarm Monitoring's combined report -- built
// from the line item's own (pre-merge) tasksByUser snapshot (see App.jsx's cost-centre
// merge) rather than the parent's already-merged totals, so this genuinely reports only
// that one folder's work, not the whole rolled-up package.
export function printLineItemPdf(parent, lineItem, monthText, consultantFilter) {
  let tasks;
  if (consultantFilter) {
    tasks = lineItem.tasksByUser.get(consultantFilter) || new Map();
  } else {
    tasks = new Map();
    for (const [, tm] of lineItem.tasksByUser) for (const [task, min] of tm) tasks.set(task, (tasks.get(task) || 0) + min);
  }
  const workedFiltered = [...tasks.values()].reduce((a, min) => a + min, 0) / 60;
  const synthetic = {
    displayName: `${parent.displayName} — ${lineItem.name}`,
    type: "project", tasksFiltered: tasks, workedFiltered,
    isLineItemExport: true, rolledUpParentName: parent.displayName,
  };
  printClientPdf(synthetic, monthText, null);
}

export function printClientPdf(c, monthText, priorMonthText) {
  const html = buildPrintHtml(c, monthText, priorMonthText);
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
