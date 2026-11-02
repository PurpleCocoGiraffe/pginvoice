// Bulk "Generate PDF": one real PDF file per client, bundled into a single ZIP.
//
// The single-client PDF opens buildPrintHtml in a window and uses the browser's print
// dialog, which can't be scripted for many clients at once. Here the same HTML is laid
// out in a hidden iframe, rasterised with html2canvas, cut into A4 pages at table-row
// boundaries (so a row is never split across pages), and written with jsPDF -- the
// letterhead footer is drawn on every page, as the print version's repeating <tfoot> does.
// The heavy libraries are loaded on demand so they never weigh down the main bundle.
import { buildPrintHtml, lineItemClient } from "./printTemplate.js";
import { LETTERHEAD_FOOTER_B64 } from "./letterheadFooter.js";
import { NORDIQUE_FONT_FACE_CSS } from "./nordiqueFont.js";
import { filenameSafe } from "./format.js";
import { unfilteredForExport } from "./reconcile.js";
import { costCentreInvoice, invoiceCapRuleFor } from "./invoiceSplit.js";

// A4 with the print template's 15mm margins.
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const MARGIN_MM = 15;
const CONTENT_W_MM = PAGE_W_MM - 2 * MARGIN_MM;
// Letterhead footer strip: full page width (edge to edge, no side margins), at the same
// height on every page, its bottom FOOTER_BOTTOM_MM (1 cm) above the bottom edge of the page.
// Content stops FOOTER_GAP_MM above the strip; anything longer flows to the next page.
const FOOTER_BOTTOM_MM = 10;
const FOOTER_GAP_MM = 5;
const CONTENT_W_PX = Math.round((CONTENT_W_MM / 25.4) * 96);
const SCALE = 2;

// Pure: where to cut a tall render into pages. `rowBottoms` are each row's bottom edge
// (px, ascending order not required); each page holds at most `pageH` px. Cuts land on a
// row boundary whenever one fits; a single row taller than a page is cut mid-row.
export function pageBreaks(totalH, pageH, rowBottoms) {
  const bottoms = [...new Set(rowBottoms.map((b) => Math.round(b)))].sort((a, b) => a - b);
  const slices = [];
  let start = 0;
  while (start < totalH - 1) {
    const limit = start + pageH;
    if (limit >= totalH) { slices.push([start, totalH]); break; }
    let cut = -1;
    for (const b of bottoms) { if (b > start && b <= limit) cut = b; else if (b > limit) break; }
    if (cut <= start) cut = limit;
    slices.push([start, cut]);
    start = cut;
  }
  return slices;
}

// Pure: shares a task -> minutes map out across invoices of `hoursList` hours each,
// largest task first. Task time is scaled so the parts add up to the invoice hours even
// when some tracked time wasn't billable (the invoice hours are billable hours); a task
// that straddles two invoices is split and marked "(part)". -> [{ tasks, minutes, split }]
export function allocateTasks(tasks, hoursList) {
  const entries = [...tasks.entries()].filter(([, m]) => m > 0).sort((a, b) => b[1] - a[1]);
  const trackedMin = entries.reduce((a, [, m]) => a + m, 0);
  const invoiceMin = hoursList.reduce((a, h) => a + h * 60, 0);
  const scale = trackedMin > 0 && invoiceMin > 0 ? trackedMin / invoiceMin : 1;
  const parts = hoursList.map(() => ({ tasks: new Map(), minutes: 0, split: false }));
  let p = 0;
  let room = hoursList.length ? hoursList[0] * 60 * scale : 0;
  for (const [task, min] of entries) {
    let left = min;
    let pieces = 0;
    while (left > 1e-6) {
      if (room <= 1e-6 && p < parts.length - 1) { p++; room = hoursList[p] * 60 * scale; }
      const take = p === parts.length - 1 ? left : Math.min(left, room);
      if (take <= 1e-6) break;
      pieces++;
      parts[p].tasks.set(task, (parts[p].tasks.get(task) || 0) + take);
      parts[p].minutes += take;
      left -= take;
      room -= take;
    }
    if (pieces > 1) {
      // label the split task "(part)" on every invoice it appears on
      for (const part of parts) {
        if (part.tasks.has(task)) { const m = part.tasks.get(task); part.tasks.delete(task); part.tasks.set(`${task} (part)`, m); part.split = true; }
      }
    }
  }
  return parts;
}

// One invoice of a capped cost centre that had to be split, as a printable client.
function invoicePartClient(base, centre, part, index) {
  return {
    ...base, isLineItemExport: true, invoices: null,
    tasksFiltered: part.tasks, workedFiltered: part.minutes / 60,
    invoicePart: {
      index: index + 1, count: centre.lines.length, line: centre.lines[index], rule: centre.rule,
      centreName: centre.name, totalHours: centre.hours, totalAmount: centre.amount, splitTasks: part.split,
    },
  };
}

// "<dir>/<label> - <month> - Invoice i of N.pdf" for each invoice of a split cost centre.
function invoicePartPdfs(base, centre, tasks, dir, label, month) {
  const parts = allocateTasks(tasks, centre.lines.map((l) => l.hours));
  return parts.map((part, i) => ({
    path: `${dir}/${label} - ${month} - Invoice ${i + 1} of ${parts.length}.pdf`,
    client: invoicePartClient(base, centre, part, i),
  }));
}

const tasksOfLineItem = (item) => {
  const tasks = new Map();
  for (const [, tm] of item?.tasksByUser || []) for (const [t, m] of tm) tasks.set(t, (tasks.get(t) || 0) + m);
  return tasks;
};

// The PDFs for one client row, under `dir`:
// - the client's own report;
// - a rolled-up client's other cost centres each in their own sub-folder (that cost
//   centre's own hours, as the drawer's per-cost-centre PDF);
// - for a client with a per-invoice cap (Clarke Energy (CEA)), a cost centre over the cap
//   gets one PDF per invoice (the client's own centre next to its report, any other
//   centre's in its sub-folder).
function pdfsForClient(c, dir, monthText, uniqueDir) {
  const name = filenameSafe(c.displayName || c.name) || "Client";
  const month = filenameSafe(monthText);
  const out = [{ path: `${dir}/${name} - ${month}.pdf`, client: c }];
  const rule = invoiceCapRuleFor(c);
  const items = c.costCentre?.lineItems || [];
  if (items.length > 1) {
    const key = (x) => String(x ?? "").trim().toLowerCase();
    items.forEach((item) => {
      // The client's own folder (labelled with the client's name) is already the report
      // above; every other cost centre -- including a busiest sibling standing in as the
      // roll-up's primary when the client has no umbrella folder -- is its own folder.
      const own = key(item.name) === key(c.displayName) || key(item.name) === key(c.name);
      const centreDir = own ? dir : uniqueDir(`${dir}/${filenameSafe(item.name) || "Cost centre"}`);
      const label = own ? name : filenameSafe(item.name) || "Cost centre";
      const li = lineItemClient(c, item, null);
      const centre = rule ? costCentreInvoice(item.name, item.billableHours ?? item.hours, rule) : null;
      if (centre && centre.lines.length > 1) {
        out.push(...invoicePartPdfs(own ? { ...li, displayName: c.displayName } : li, centre, tasksOfLineItem(item), centreDir, label, month));
      } else if (!own) {
        out.push({ path: `${centreDir}/${label} - ${month}.pdf`, client: li });
      }
    });
  } else if (rule) {
    const centre = costCentreInvoice(c.displayName ?? c.name, c.billableWorked ?? c.worked ?? 0, rule);
    if (centre.lines.length > 1) out.push(...invoicePartPdfs(c, centre, unfilteredForExport(c).tasksFiltered, dir, name, month));
  }
  return out;
}

// Pure: the ZIP's layout. One folder per top-level client holding its PDF(s); each nested
// row (sub-project / grouped sibling) and each extra cost centre gets its own folder
// inside its parent's. tops: top-level client rows; nestedOf(name) -> its nested rows.
export function planClientPdfs(tops, nestedOf, monthText) {
  const used = new Set();
  const uniqueDir = (dir) => {
    let d = dir; let n = 1;
    while (used.has(d.toLowerCase())) d = `${dir} (${++n})`;
    used.add(d.toLowerCase());
    return d;
  };
  const out = [];
  for (const c of tops) {
    const dir = uniqueDir(filenameSafe(c.displayName || c.name) || "Client");
    out.push(...pdfsForClient(c, dir, monthText, uniqueDir));
    for (const s of nestedOf(c.name) || []) {
      const sub = uniqueDir(`${dir}/${filenameSafe(s.displayName || s.name) || "Sub-project"}`);
      out.push(...pdfsForClient(s, sub, monthText, uniqueDir));
    }
  }
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Load every Nordique Pro weight the template uses before capturing. A freshly written
// document only starts loading a face when layout first needs it, so fonts.ready could
// resolve with just Light (300) loaded -- the title, headings, labels and totals (600/700)
// then rendered in the fallback sans-serif instead of matching the single-client PDF.
// Runs on our iframe and again on html2canvas's own clone of it.
const FONT_WEIGHTS = ["300", "600", "700"];
async function loadTemplateFonts(doc) {
  if (!doc?.fonts?.load) return;
  const loads = Promise.all(FONT_WEIGHTS.map((w) => doc.fonts.load(`${w} 16px 'Nordique Pro'`)))
    .then(() => doc.fonts.ready);
  await Promise.race([loads.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
}

// html2canvas draws the text onto a canvas owned by THIS (the app's) document, and canvas
// text can only use fonts registered here -- the iframe's own @font-face rules don't
// count. So register the template's faces on the app document too (once).
const FONT_STYLE_ID = "pg-pdfzip-nordique";
async function ensureHostFonts() {
  if (!document.getElementById(FONT_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = FONT_STYLE_ID;
    style.textContent = NORDIQUE_FONT_FACE_CSS;
    document.head.appendChild(style);
  }
  await loadTemplateFonts(document);
}

async function renderClientPdf(c, monthText, priorMonthText, libs, footer, footerBottomMm = FOOTER_BOTTOM_MM) {
  const { jsPDF, html2canvas } = libs;
  const html = buildPrintHtml(c, monthText, priorMonthText)
    .replace(/<script>[\s\S]*?<\/script>/g, "") // no auto window.print()
    // Our own footer and side margins replace the print version's: hide its fixed strip and
    // spacer row, and lay the content out at the iframe's full (content) width.
    .replace("</style>", "  tfoot, .letterhead-footer { display: none !important; }\n  body { background: #fff; margin: 0 !important; }\n</style>");

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${CONTENT_W_PX}px;height:1200px;border:0;visibility:hidden;`;
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument;
    doc.open(); doc.write(html); doc.close();
    await loadTemplateFonts(doc);

    const body = doc.body;
    const totalH = Math.ceil(body.scrollHeight);
    const rowBottoms = [...doc.querySelectorAll("table.doc > tbody > tr")].map((tr) => tr.offsetTop + tr.offsetHeight);
    const canvas = await html2canvas(body, {
      scale: SCALE, backgroundColor: "#ffffff", width: CONTENT_W_PX, height: totalH,
      windowWidth: CONTENT_W_PX, windowHeight: totalH, logging: false,
      onclone: (cloned) => loadTemplateFonts(cloned),
    });

    const pxPerMm = CONTENT_W_PX / CONTENT_W_MM;
    const footerH = PAGE_W_MM * (footer.height / footer.width);
    const footerTop = PAGE_H_MM - footerBottomMm - footerH;
    const pageHpx = Math.floor((footerTop - FOOTER_GAP_MM - MARGIN_MM) * pxPerMm);
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    pdf.setProperties({ title: `${c.displayName || c.name} ${monthText}`, creator: "Purple Giraffe" });

    const slices = pageBreaks(totalH, pageHpx, rowBottoms);
    slices.forEach(([from, to], i) => {
      if (i > 0) pdf.addPage();
      const page = document.createElement("canvas");
      page.width = canvas.width;
      page.height = Math.max(1, Math.round((to - from) * SCALE));
      const ctx = page.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, page.width, page.height);
      ctx.drawImage(canvas, 0, Math.round(from * SCALE), canvas.width, page.height, 0, 0, page.width, page.height);
      pdf.addImage(page.toDataURL("image/jpeg", 0.95), "JPEG", MARGIN_MM, MARGIN_MM, CONTENT_W_MM, (to - from) / pxPerMm);
      pdf.addImage(footer.dataUrl, "PNG", 0, footerTop, PAGE_W_MM, footerH);
    });
    return pdf.output("blob");
  } finally {
    iframe.remove();
  }
}

// Builds every planned PDF (planClientPdfs) and returns the ZIP blob plus any that failed.
// onProgress(done, total) after each PDF.
export async function buildClientPdfZip(entries, { monthText, priorMonthText, onProgress, footerBottomMm } = {}) {
  const [{ jsPDF }, { default: html2canvas }, { default: JSZip }] = await Promise.all([
    import("jspdf"), import("html2canvas"), import("jszip"),
  ]);
  await ensureHostFonts();
  const dataUrl = `data:image/png;base64,${LETTERHEAD_FOOTER_B64}`;
  const img = await loadImage(dataUrl);
  const footer = { dataUrl, width: img.naturalWidth, height: img.naturalHeight };

  const zip = new JSZip();
  const failed = [];
  for (let i = 0; i < entries.length; i++) {
    const { path, client } = entries[i];
    try {
      zip.file(path, await renderClientPdf(client, monthText, priorMonthText, { jsPDF, html2canvas }, footer, footerBottomMm));
    } catch (e) {
      console.error("PDF failed for", path, e);
      failed.push(path);
    }
    onProgress?.(i + 1, entries.length);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, count: entries.length - failed.length, failed };
}
