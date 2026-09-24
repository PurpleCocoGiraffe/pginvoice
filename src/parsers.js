import Papa from "papaparse";
import * as XLSX from "xlsx";
import { isInternalFolder, splitTaskPrefixFolders } from "./nameMatch.js";

// ---------------------------- time text → minutes ----------------------------
export function parseTimeTextToMinutes(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === "-" || s === "--") return 0;
  const colon = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) return parseInt(colon[1], 10) * 60 + parseInt(colon[2], 10) + (colon[3] ? parseInt(colon[3], 10) / 60 : 0);
  if (/[hms]/.test(s)) {
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
    const m = s.match(/(\d+(?:\.\d+)?)\s*m/);
    const sec = s.match(/(\d+(?:\.\d+)?)\s*s(?!\w)/);
    if (h || m || sec) return (h ? parseFloat(h[1]) * 60 : 0) + (m ? parseFloat(m[1]) : 0) + (sec ? parseFloat(sec[1]) / 60 : 0);
  }
  const n = parseFloat(s.replace(/,/g, ""));
  if (isNaN(n)) return 0;
  if (n > 0 && n < 1) return n * 24 * 60;
  return n;
}
export function msToMinutes(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  if (isNaN(n) || n <= 0) return 0;
  return n / 60000;
}

// ------------------------------ name matching --------------------------------
// normalizeName / tokenSim / findMatch / isInternalFolder now live in ./nameMatch.js,
// shared with Capacity Planning so the two never quietly drift apart.

// ------------------- header parsing for the accrued sheet --------------------
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"];
const MONTH_INDEX = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };

export function parseHeaderToMonth(cell, contextYear) {
  if (cell === null || cell === undefined || cell === "") return null;
  if (cell instanceof Date && !isNaN(cell.getTime()))
    return { year: cell.getFullYear(), month: cell.getMonth(), label: monthLabel(cell.getFullYear(), cell.getMonth()) };
  const s = String(cell).trim();
  const lower = s.toLowerCase();
  if (lower.includes("%") || lower.includes("comment")) return null;
  const dmy = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    let year = parseInt(dmy[3], 10);
    if (year < 100) year += 2000;
    const month = parseInt(dmy[2], 10) - 1;
    if (month >= 0 && month <= 11) return { year, month, label: monthLabel(year, month) };
  }
  for (const m of MONTH_NAMES) {
    const re = new RegExp(`\\b${m}\\w*\\b`, "i");
    if (re.test(lower)) {
      const yearMatch = s.match(/\b(20\d{2}|\d{2})\b/);
      let year = null;
      if (yearMatch) { year = parseInt(yearMatch[1], 10); if (year < 100) year += 2000; }
      else if (contextYear) year = contextYear;
      else return null;
      return { year, month: MONTH_INDEX[m], label: monthLabel(year, MONTH_INDEX[m]) };
    }
  }
  return null;
}
export function monthLabel(year, month) { return new Date(year, month, 1).toLocaleString(undefined, { month: "long", year: "numeric" }); }
export function monthKey(year, month) { return `${year}-${String(month + 1).padStart(2, "0")}`; }
export function prevMonthKeyStr(key) {
  const [y, m] = key.split("-").map(Number); // m is 1-12
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// ------------------------------ accrued parser -------------------------------
export function parseAccruedWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames.find((n) => /accrued/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  let headerIdx = rows.findIndex((r) => r && ((r[0] && /client/i.test(String(r[0]))) || (r[1] && /agreed/i.test(String(r[1])))));
  if (headerIdx < 0) headerIdx = 2;
  const header = rows[headerIdx] || [];

  const warnings = [];
  const maxSaneYear = new Date().getFullYear() + 1;
  const rawCols = [];
  let contextYear = null;
  for (let c = 2; c < header.length; c++) {
    const m = parseHeaderToMonth(header[c], contextYear);
    if (!m) continue;
    if (m.year > maxSaneYear) {
      warnings.push(`Column "${String(header[c])}" parsed as ${m.label}, which looks like a typo in the source sheet (year is well in the future). It's still included, but check it.`);
    } else {
      contextYear = m.year; // don't let a bad year poison inference for later month-only headers
    }
    rawCols.push({ col: c, ...m });
  }
  // real spreadsheets accumulate repeated/duplicate month columns over time (copy-paste,
  // corrections); keep one per month — the rightmost (latest-entered) column wins — and
  // present them in chronological order rather than raw column order.
  const byMonth = new Map();
  for (const bc of rawCols) byMonth.set(monthKey(bc.year, bc.month), bc);
  if (byMonth.size < rawCols.length) {
    warnings.push(`Found ${rawCols.length - byMonth.size} duplicate month column(s) in the accrued sheet, using the rightmost (latest) one for each month.`);
  }
  const balanceCols = [...byMonth.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month));

  const clients = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = row[0];
    const pkgRaw = row[1];
    if (!name || typeof name !== "string") continue;
    const nameTrim = name.trim();
    if (!nameTrim) continue;
    if (typeof pkgRaw === "string" && /agreed\s*h\.?p\.?m/i.test(pkgRaw)) continue;

    let pkg = null;
    if (typeof pkgRaw === "number") pkg = pkgRaw;
    else if (typeof pkgRaw === "string") {
      const m = pkgRaw.match(/(-?\d+(?:\.\d+)?)/);
      if (m) pkg = parseFloat(m[1]);
    }

    const balances = {};
    for (const bc of balanceCols) {
      const v = row[bc.col];
      if (typeof v === "number") balances[monthKey(bc.year, bc.month)] = v;
    }
    if (pkg === null && Object.keys(balances).length === 0) continue;
    clients.push({ name: nameTrim, package: pkg, balances });
  }

  // real client lists accumulate exact-name duplicates (re-added rows, copy-paste) — not
  // a parsing error, but worth surfacing since only the first match is ever used for lookups
  const nameCounts = new Map();
  for (const c of clients) nameCounts.set(c.name, (nameCounts.get(c.name) || 0) + 1);
  const dupNames = [...nameCounts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  if (dupNames.length) warnings.push(`${dupNames.length} client name${dupNames.length === 1 ? "" : "s"} appear more than once in the accrued sheet (${dupNames.slice(0, 5).join(", ")}${dupNames.length > 5 ? ", …" : ""}); only the first row for each is used.`);

  return { clients, balanceCols, sheetName, warnings };
}

// ------------------------------- clickup parser -------------------------------
export function findHeader(headers, wanted) {
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const w = norm(wanted);
  let hit = headers.find((h) => norm(h) === w);
  if (!hit) hit = headers.find((h) => norm(h).startsWith(w));
  return hit || null;
}
export const SKIP_FOLDERS = new Set(["", "grand total", "(blank)", "blank"]);

// "Start Text" is already localised to the business timezone (ACST), e.g.
// "05/19/2026, 6:49:33 AM ACST" — parse the date directly from it rather
// than converting the raw epoch "Start" value, which can misfile
// near-midnight sessions into the wrong month across a UTC boundary.
export function parseStartTextMonth(raw) {
  if (!raw) return null;
  const datePart = String(raw).split(",")[0].trim();
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = parseInt(m[1], 10) - 1;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 0 || month > 11) return null;
  return { year, month, day };
}
export function dateKeyStr(year, month, day) { return `${monthKey(year, month)}-${String(day).padStart(2, "0")}`; }

export function parseClickupCsv(file, onDone, onErr) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: "greedy",
    complete: (result) => {
      const headers = result.meta.fields || [];
      const warnings = [];
      const hFolder = findHeader(headers, "Folder Name");
      const hTask = findHeader(headers, "Task Name");
      const hTimeText = findHeader(headers, "Time Tracked Text");
      // Exact match only — "Time Tracked" must not fall back to matching
      // "Time Tracked Text" via findHeader's startsWith rule when there's no
      // separate numeric column.
      const hTimeMs = headers.find((h) => h.toLowerCase().replace(/[^a-z0-9]/g, "") === "timetracked") || null;
      const hBillable = findHeader(headers, "Billable");
      const hUser = findHeader(headers, "Username");
      const hStart = findHeader(headers, "Start Text");
      // Optional — only some ClickUp export presets include it. When present, lets task
      // rows link straight to the task in ClickUp, same as the live Supabase sync does.
      const hTaskId = findHeader(headers, "Task ID");
      if (!hFolder) { onErr("Couldn't find a \"Folder Name\" column. This should be a ClickUp time-tracking export."); return; }
      let zeroCount = 0;
      const rows = [];
      for (const r of result.data) {
        const folder = String(r[hFolder] || "").trim();
        if (SKIP_FOLDERS.has(folder.toLowerCase())) continue;
        let minutes = 0;
        // "Time Tracked" (ms) is the authoritative numeric duration; "Time Tracked
        // Text" is a display string and only used as a fallback for older,
        // pre-aggregated exports that don't carry the numeric column at all.
        if (hTimeMs && r[hTimeMs] !== undefined && String(r[hTimeMs]).trim() !== "") minutes = msToMinutes(r[hTimeMs]);
        else if (hTimeText) minutes = parseTimeTextToMinutes(r[hTimeText]);
        if (minutes === 0) zeroCount++;
        const billableRaw = hBillable ? String(r[hBillable] || "").trim().toLowerCase() : "";
        const billable = ["true", "yes", "1", "billable"].includes(billableRaw);
        const startMonth = hStart ? parseStartTextMonth(r[hStart]) : null;
        rows.push({
          folder,
          task: hTask ? String(r[hTask] || "").trim() || "Untitled" : "Untitled",
          taskId: hTaskId ? (String(r[hTaskId] || "").trim() || null) : null,
          minutes, billable, hasBillableCol: !!hBillable,
          user: hUser ? String(r[hUser] || "").trim() : "",
          isInternal: isInternalFolder(folder),
          monthKey: startMonth ? monthKey(startMonth.year, startMonth.month) : null,
          monthLabel: startMonth ? monthLabel(startMonth.year, startMonth.month) : null,
          dateKey: startMonth ? dateKeyStr(startMonth.year, startMonth.month, startMonth.day) : null,
        });
      }
      if (rows.length && zeroCount === rows.length) warnings.push("Every row parsed to zero hours; the ClickUp export format may have changed.");
      // Same task-name-prefix rewrite the live Supabase sync applies (see nameMatch.js) --
      // a manually uploaded export needs the exact same treatment for a client tracked
      // that way, or it would show differently depending on which data source is loaded.
      onDone({ rows: splitTaskPrefixFolders(rows), hasBillable: !!hBillable, hasUser: !!hUser, hasStartDate: !!hStart, warnings });
    },
    error: (e) => onErr("Couldn't read the CSV: " + e.message),
  });
}
