// Bulk "Generate PDF": one real PDF file per client, bundled into a single ZIP.
//
// The single-client PDF opens buildPrintHtml in a window and uses the browser's print
// dialog, which can't be scripted for many clients at once. Here the same HTML is laid
// out in a hidden iframe, rasterised with html2canvas, cut into A4 pages at table-row
// boundaries (so a row is never split across pages), and written with jsPDF -- the
// letterhead footer is drawn on every page, as the print version's repeating <tfoot> does.
// The heavy libraries are loaded on demand so they never weigh down the main bundle.
import { buildPrintHtml } from "./printTemplate.js";
import { LETTERHEAD_FOOTER_B64 } from "./letterheadFooter.js";
import { filenameSafe } from "./format.js";

// A4 with the print template's 15mm margins.
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const MARGIN_MM = 15;
const CONTENT_W_MM = PAGE_W_MM - 2 * MARGIN_MM;
const FOOTER_H_MM = 15; // the .letterhead-footer-cell height
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

// Pure: unique "<client> - <month>.pdf" names (a repeated display name gets " (2)", ...).
export function pdfFileNames(clients, monthText) {
  const seen = new Map();
  return clients.map((c) => {
    const base = `${filenameSafe(c.displayName || c.name) || "Client"} - ${filenameSafe(monthText)}`;
    const n = (seen.get(base.toLowerCase()) || 0) + 1;
    seen.set(base.toLowerCase(), n);
    return `${base}${n > 1 ? ` (${n})` : ""}.pdf`;
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function renderClientPdf(c, monthText, priorMonthText, libs, footer) {
  const { jsPDF, html2canvas } = libs;
  const html = buildPrintHtml(c, monthText, priorMonthText)
    .replace(/<script>[\s\S]*?<\/script>/g, "") // no auto window.print()
    .replace("</style>", "  tfoot { display: none; }\n  body { background: #fff; }\n  * { font-variant-ligatures: none; font-kerning: none; letter-spacing: 0.01px; }\n</style>");

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${CONTENT_W_PX}px;height:1200px;border:0;visibility:hidden;`;
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument;
    doc.open(); doc.write(html); doc.close();
    await Promise.race([doc.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2000))]);

    const body = doc.body;
    const totalH = Math.ceil(body.scrollHeight);
    const rowBottoms = [...doc.querySelectorAll("table.doc > tbody > tr")].map((tr) => tr.offsetTop + tr.offsetHeight);
    const canvas = await html2canvas(body, {
      scale: SCALE, backgroundColor: "#ffffff", width: CONTENT_W_PX, height: totalH,
      windowWidth: CONTENT_W_PX, windowHeight: totalH, logging: false,
    });

    const pxPerMm = CONTENT_W_PX / CONTENT_W_MM;
    const pageHpx = Math.floor((PAGE_H_MM - 2 * MARGIN_MM - FOOTER_H_MM) * pxPerMm);
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
      // Letterhead footer: full content width, sitting on the bottom of the 15mm footer band.
      const fh = CONTENT_W_MM * (footer.height / footer.width);
      pdf.addImage(footer.dataUrl, "PNG", MARGIN_MM, PAGE_H_MM - MARGIN_MM - fh, CONTENT_W_MM, fh);
    });
    return pdf.output("blob");
  } finally {
    iframe.remove();
  }
}

// Builds every client's PDF and returns the ZIP blob plus any clients that failed.
// onProgress(done, total) after each client.
export async function buildClientPdfZip(clients, { monthText, priorMonthText, onProgress } = {}) {
  const [{ jsPDF }, { default: html2canvas }, { default: JSZip }] = await Promise.all([
    import("jspdf"), import("html2canvas"), import("jszip"),
  ]);
  const dataUrl = `data:image/png;base64,${LETTERHEAD_FOOTER_B64}`;
  const img = await loadImage(dataUrl);
  const footer = { dataUrl, width: img.naturalWidth, height: img.naturalHeight };

  const zip = new JSZip();
  const names = pdfFileNames(clients, monthText);
  const failed = [];
  for (let i = 0; i < clients.length; i++) {
    try {
      const blob = await renderClientPdf(clients[i], monthText, priorMonthText, { jsPDF, html2canvas }, footer);
      zip.file(names[i], blob);
    } catch (e) {
      console.error("PDF failed for", clients[i]?.name, e);
      failed.push(clients[i]?.displayName || clients[i]?.name);
    }
    onProgress?.(i + 1, clients.length);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, count: clients.length - failed.length, failed };
}
