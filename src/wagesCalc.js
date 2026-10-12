// Pure maths for the admin-only Wages review module: a digitised version of Kelly's
// Monthly Wages Review workbook (one row per employee, columns A-Y). No React or Supabase
// imports -- everything here is directly testable (see wagesCalc.test.js).
//
// Units: ClickUp buckets are kept in MINUTES until computeLine converts them to hours;
// workbook outputs are HOURS rounded to 2dp (ratios to 4dp). Dates are "YYYY-MM-DD"
// string keys built with Date.UTC/getUTCDay -- never toISOString on a local date.
// null always means "not entered / not applicable" and is kept distinct from 0.
import { CLIENT_SPACE_IDS, isInternalFolder } from "./nameMatch.js";
import { holidaysFor, PUBLIC_HOLIDAYS } from "./publicHolidays.js";

export const STANDARD_DAY_HOURS = 7.6;

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pad2 = (n) => String(n).padStart(2, "0");
// Hours for human-readable workings: at least 1dp ("114.0"), up to 2dp ("78.26").
const fmtH = (n) => { const r = round2(n); return Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2); };
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PATTERN_KEYS = ["sun_h", "mon_h", "tue_h", "wed_h", "thu_h", "fri_h", "sat_h"]; // indexed by getUTCDay()

// ---------------------------------------------------------------- calendar --------------
export function monthDays(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= count; d++) {
    out.push({ date: `${y}-${pad2(m)}-${pad2(d)}`, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() });
  }
  return out;
}
const isWeekday = (dow) => dow >= 1 && dow <= 5;

export function weekdaysInMonth(monthKey) {
  return monthDays(monthKey).filter((d) => isWeekday(d.dow)).length;
}

// The workbook's "standard hours" note: weekdays × 7.6 (Jul 2026: 23 × 7.6 = 174.8).
export function standardMonthHours(monthKey, perDay = STANDARD_DAY_HOURS) {
  return round2(weekdaysInMonth(monthKey) * perDay);
}

// ---------------------------------------------------------------- ClickUp ---------------
const normFolder = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const normUser = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function emptyBuckets() {
  return { pgBillable: 0, pgNonBillable: 0, clientBillable: 0, clientNonBillable: 0, taskless: 0, unknownSpace: 0, total: 0, byFolder: [] };
}

// Adds one folder slice into a bucket, merging with an existing slice for the same
// folder/pg/billable so byFolder stays one line per folder × billable.
function addSlice(b, { folder, pg, billable, minutes }) {
  if (pg) b[billable ? "pgBillable" : "pgNonBillable"] += minutes;
  else b[billable ? "clientBillable" : "clientNonBillable"] += minutes;
  b.total += minutes;
  const hit = b.byFolder.find((f) => normFolder(f.folder) === normFolder(folder) && f.pg === pg && f.billable === billable);
  if (hit) hit.minutes += minutes;
  else b.byFolder.push({ folder, pg, billable, minutes });
}

// Classifies pginvoice_clickup_month_summary rows into per-user PG/client buckets.
//   CLIENT = space_id in CLIENT_SPACE_IDS, folder not one of settings.pg_folders, not an
//            internal-keyword folder (onboarding/induction/offboarding/handover/wip), and
//            the entry has a task.
//   PG     = everything else (Purple Giraffe folder, internal folders, PG HQ / BDM / any
//            other space, task-less "Private" entries).
// Rows with no space_id that DO have a task were synced before the space column existed:
// they're classified as if in a client space (legacy behaviour) but their minutes are also
// counted in `unknownSpace` / `unknownSpaceMinutes` so the UI can warn.
// `taskless` and `unknownSpace` are informational subsets of `total`, not extra time.
// Returns { perUser: { [userName]: buckets }, ignored: { [userName]: buckets }, unknownSpaceMinutes }.
export function classifyClickup(summaryRows, settings = {}) {
  const pgFolders = new Set((settings.pg_folders || []).map(normFolder));
  const ignoredUsers = new Set((settings.ignored_clickup_users || []).map(normUser));
  const perUser = {};
  const ignored = {};
  let unknownSpaceMinutes = 0;
  for (const r of summaryRows || []) {
    const user = String(r.user_name ?? "").trim();
    const minutes = num(r.minutes);
    const spaceId = r.space_id == null ? "" : String(r.space_id).trim();
    const taskless = !!r.taskless;
    const unknownSpace = !spaceId && !taskless;
    const folder = r.folder ?? "";
    const clientSpace = unknownSpace || CLIENT_SPACE_IDS.has(spaceId);
    const isClient = clientSpace && !taskless && !pgFolders.has(normFolder(folder)) && !isInternalFolder(folder);
    const target = ignoredUsers.has(normUser(user)) ? ignored : perUser;
    const b = target[user] || (target[user] = emptyBuckets());
    addSlice(b, { folder, pg: !isClient, billable: !!r.billable, minutes });
    if (taskless) b.taskless += minutes;
    if (unknownSpace) {
      b.unknownSpace += minutes;
      if (target === perUser) unknownSpaceMinutes += minutes;
    }
  }
  return { perUser, ignored, unknownSpaceMinutes };
}

// Rolls ClickUp users up to payroll people via each person's clickup_user_names (exact,
// case-insensitive, trimmed -- no fuzzy matching: a wrong guess here moves someone's hours).
// A ClickUp name claimed by more than one person is a conflict and attributed to nobody.
// Returns { byPerson: { [person_id]: buckets }, unmapped: [{user_name, minutes}],
//           conflicts: [{user_name, person_ids, minutes}] }.
export function attributeToPeople(perUser, people) {
  const owners = new Map(); // normalised clickup name -> Set(person_id)
  for (const p of people || []) {
    for (const n of p.clickup_user_names || []) {
      const k = normUser(n);
      if (!k) continue;
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k).add(p.person_id);
    }
  }
  const byPerson = {};
  const unmapped = [];
  const conflicts = [];
  for (const [userName, b] of Object.entries(perUser || {})) {
    const ids = owners.get(normUser(userName));
    if (!ids || ids.size === 0) { unmapped.push({ user_name: userName, minutes: b.total }); continue; }
    if (ids.size > 1) { conflicts.push({ user_name: userName, person_ids: [...ids], minutes: b.total }); continue; }
    const [pid] = ids;
    const t = byPerson[pid] || (byPerson[pid] = emptyBuckets());
    for (const k of ["taskless", "unknownSpace"]) t[k] += b[k];
    for (const f of b.byFolder) addSlice(t, { ...f });
  }
  return { byPerson, unmapped, conflicts };
}

// ---------------------------------------------------------------- expected hours (S, Q) --
const BASIS_LABEL = { ft: "F/T", pt_pattern: "P/T", casual_pattern: "Casual", casual_target: "Casual", casual_xero: "Casual" };

function patternOf(rule) { return PATTERN_KEYS.map((k) => num(rule[k])); }

function segmentCalc({ rule, days, phDates, monthWeekdays, perDay }) {
  const weekdays = days.filter((d) => isWeekday(d.dow));
  const phDays = days.filter((d) => phDates.has(d.date));
  const basis = rule.basis;
  if (basis === "ft") {
    const dh = rule.daily_hours == null ? perDay : num(rule.daily_hours);
    const phWeekdays = phDays.filter((d) => isWeekday(d.dow));
    const S = weekdays.length * dh;
    const Q = phWeekdays.length * dh;
    return {
      S, Q, counted: phWeekdays,
      working: `${weekdays.length} weekdays × ${fmtH(dh)} = ${fmtH(S)}`,
      qWorking: `${phWeekdays.length} public holiday${phWeekdays.length === 1 ? "" : "s"} × ${fmtH(dh)} = ${fmtH(Q)}`,
    };
  }
  if (basis === "pt_pattern" || basis === "casual_pattern") {
    const pattern = patternOf(rule);
    const excludePh = basis === "casual_pattern";
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const d of days) if (!(excludePh && phDates.has(d.date))) counts[d.dow]++;
    let S = 0;
    const parts = [];
    for (const dow of [1, 2, 3, 4, 5, 6, 0]) {
      if (!pattern[dow] || !counts[dow]) continue;
      S += counts[dow] * pattern[dow];
      parts.push(`${counts[dow]} ${DOW_SHORT[dow]} × ${fmtH(pattern[dow])}`);
    }
    const phWorked = phDays.filter((d) => pattern[d.dow] > 0);
    let working = `${parts.length ? parts.join(" + ") : "no pattern days"} = ${fmtH(S)}`;
    if (excludePh && phWorked.length) working += ` (excl. ${phWorked.length} public holiday${phWorked.length === 1 ? "" : "s"})`;
    if (excludePh) return { S, Q: 0, counted: [], working, qWorking: "Casual: no public holiday pay" };
    const Q = phWorked.reduce((s, d) => s + pattern[d.dow], 0);
    return {
      S, Q, counted: phWorked, working,
      qWorking: phWorked.length ? `${phWorked.map((d) => `${DOW_SHORT[d.dow]} ${d.date.slice(8)} × ${fmtH(pattern[d.dow])}`).join(" + ")} = ${fmtH(Q)}` : "no public holidays on working days",
    };
  }
  if (basis === "casual_target") {
    const target = num(rule.monthly_target_h);
    const S = monthWeekdays ? target * (weekdays.length / monthWeekdays) : 0;
    return {
      S, Q: 0, counted: [],
      working: weekdays.length === monthWeekdays
        ? `monthly target ${fmtH(target)}`
        : `${fmtH(target)} × ${weekdays.length}/${monthWeekdays} weekdays = ${fmtH(S)}`,
      qWorking: "Casual: no public holiday pay",
    };
  }
  if (basis === "casual_xero") {
    return { S: null, Q: 0, counted: [], working: "Casual: expected equals Xero hours", qWorking: "Casual: no public holiday pay" };
  }
  return null; // unknown basis -- treated like a missing rule by the caller
}

// Expected hours (column S) and public-holiday hours (column Q) for one person/month.
// The month is split into segments by employment window ∩ rule windows (a rule applies
// from effective_from until the day before the next rule's effective_from).
// casual_xero segments have S = null ("equals Xero"). If ANY segment is casual_xero,
// varianceApplicable is false and S is the sum of the other segments (null only when every
// segment is casual_xero). A missing rule for any employed day also sets
// varianceApplicable false (S would be understated, so over/under would be misleading).
// unknownState: the person's state isn't SA/WA/QLD, so no public holidays were applied.
export function expectedFor({ monthKey, person = {}, rules = [], holidays, perDay = STANDARD_DAY_HOURS }) {
  const stateKey = String(person.state ?? "").trim().toUpperCase();
  const phList = holidays ?? holidaysFor(stateKey, monthKey);
  const phByDate = new Map(phList.map((h) => [h.date, h]));
  const phDates = new Set(phByDate.keys());
  const sorted = [...(rules || [])].filter((r) => r && r.effective_from).sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  const start = person.start_date ? String(person.start_date).slice(0, 10) : null;
  const end = person.end_date ? String(person.end_date).slice(0, 10) : null;
  const ruleIndexFor = (date) => {
    let idx = -1;
    for (let i = 0; i < sorted.length; i++) if (String(sorted[i].effective_from).slice(0, 10) <= date) idx = i;
    return idx;
  };

  const days = monthDays(monthKey);
  const monthWeekdays = days.filter((d) => isWeekday(d.dow)).length;
  const employed = days.filter((d) => (!start || d.date >= start) && (!end || d.date <= end));
  const employedWeekdays = employed.filter((d) => isWeekday(d.dow)).length;

  // Contiguous runs of employed days sharing the same rule.
  const runs = [];
  let missingRule = false;
  for (const d of employed) {
    const idx = ruleIndexFor(d.date);
    if (idx < 0) { missingRule = true; continue; }
    const last = runs[runs.length - 1];
    if (last && last.idx === idx) last.days.push(d);
    else runs.push({ idx, days: [d] });
  }

  const segments = [];
  const counted = [];
  let sSum = 0, Q = 0, anyXero = false, allXero = runs.length > 0;
  for (const run of runs) {
    const rule = sorted[run.idx];
    const calc = segmentCalc({ rule, days: run.days, phDates, monthWeekdays, perDay });
    if (!calc) { missingRule = true; allXero = false; continue; }
    if (rule.basis === "casual_xero") anyXero = true; else { allXero = false; sSum += calc.S; }
    Q += calc.Q;
    counted.push(...calc.counted);
    segments.push({
      from: run.days[0].date, to: run.days[run.days.length - 1].date, basis: rule.basis,
      S: calc.S == null ? null : round2(calc.S), Q: round2(calc.Q), working: calc.working, qWorking: calc.qWorking,
    });
  }

  return {
    S: allXero ? null : round2(sSum),
    Q: round2(Q),
    varianceApplicable: !anyXero && !missingRule,
    allCasualXero: allXero,
    missingRule,
    unknownState: !PUBLIC_HOLIDAYS[stateKey],
    employedWeekdays,
    segments,
    holidays: counted.map((d) => ({ date: d.date, name: phByDate.get(d.date).name })),
  };
}

// "F/T", "P/T", "Casual", or e.g. "F/T → P/T" for a mid-month change -- column C.
export function typeLabelFor(segments) {
  const labels = [];
  for (const s of segments || []) {
    const l = BASIS_LABEL[s.basis];
    if (l && labels[labels.length - 1] !== l) labels.push(l);
  }
  return labels.join(" → ");
}

// ---------------------------------------------------------------- workbook row ----------
// One workbook row (columns D-T) in hours. `clickup` null = no tracked time (zeros, flagged
// noClickup). `xeroHours` null = not entered yet: L, M, R and T all stay null.
// S: expected_override_h wins; otherwise expected.S, except when every segment is
// casual_xero (expected.S null) where S = R so the variance is 0 once Xero is in.
// An expected_override_h makes the variance assessable even for casual / missing-rule
// rows -- the admin has stated what the person should have worked.
export function computeLine({ clickup, leave, xeroHours, expected, overrides = {}, settings = {} }) {
  const c = clickup || emptyBuckets();
  const exp = expected || { S: null, Q: 0, varianceApplicable: false, missingRule: true, allCasualXero: false, segments: [] };
  const tol = num(settings.xero_tolerance_h ?? 0.25);
  const thr = num(settings.variance_threshold_h ?? 3.8);

  const D = round2((num(c.pgBillable) + num(c.clientBillable)) / 60);
  const E = round2(num(c.pgBillable) / 60);
  const F = round2(D - E);
  const G = round2((num(c.pgNonBillable) + num(c.clientNonBillable)) / 60);
  const H = round2(D + G);
  const J = H > 0 ? round4(F / H) : null;
  const K = H > 0 ? round4(D / H) : null;

  const L = xeroHours == null || xeroHours === "" ? null : round2(num(xeroHours));
  const M = L == null ? null : round2(L - H);

  const N = round2(num(leave?.annual ?? 0));
  const O = round2(num(leave?.personal ?? 0));
  const P = round2(num(leave?.lwop ?? 0));
  const unspecified = round2(num(leave?.unspecified ?? 0));
  const Q = round2(overrides?.ph_override_h != null ? num(overrides.ph_override_h) : num(exp.Q));
  const R = L == null ? null : round2(L + N + O + P + unspecified + Q);

  const overridden = overrides?.expected_override_h != null;
  const allXero = exp.allCasualXero ?? (exp.S == null);
  let S;
  if (overridden) S = round2(num(overrides.expected_override_h));
  else if (exp.S == null && allXero) S = R;
  else S = exp.S == null ? null : round2(exp.S);
  const varianceApplicable = overridden || !!exp.varianceApplicable;

  const T = R == null || S == null ? null : round2(R - S);
  const Tpct = T != null && S ? round4(T / S) : null;

  const flags = {
    missingXero: L == null,
    xeroMismatch: M != null && Math.abs(M) > tol,
    over: varianceApplicable && T != null && T > thr,
    under: varianceApplicable && T != null && T < -thr,
    missingRule: !!exp.missingRule,
    unspecifiedLeave: unspecified > 0,
    overridden,
    noClickup: !clickup,
  };
  let status;
  if (flags.missingXero) status = "awaiting_xero";
  else if (flags.xeroMismatch) status = "check_sync";
  else if (flags.over) status = "over";
  else if (flags.under) status = "under";
  else if (!varianceApplicable) status = "not_assessed";
  else status = "ok";

  return {
    D, E, F, G, H, J, K, L, M, N, O, P, unspecified, Q, R, S, T, Tpct,
    varianceApplicable, flags, status, type: typeLabelFor(exp.segments),
  };
}

// ---------------------------------------------------------------- Xero paste ------------
// Kelly pastes "name, hours" pairs for the whole team from Xero. Accepted shapes:
//   "Jane Smith\t142.5" / "Jane Smith, 142.5" / "Jane Smith   142.5" / "Jane Smith 142.5"
//   alternating lines (name, then hours), or one line "Jane, 142.5, Bob, 166.2".
// Times: 142.5, 142:30, 142h 30m, 142 hrs. A comma is always a separator, never a decimal.
// Header-ish lines ("Employee  Hours") are skipped. Returns { rows: [{name, hours, raw}], errors: [{raw, message}] }.
const T_HM = String.raw`\d+\s*h(?:rs?|ours?)?\s*\d{1,2}\s*m(?:ins?|inutes?)?`;
const T_COLON = String.raw`\d+:\d{1,2}`;
const T_DEC = String.raw`\d+(?:\.\d+)?(?:\s*(?:h|hrs?|hours?))?`;
const TIME_ALT = `(?:${T_HM}|${T_COLON}|${T_DEC})`;
const TIME_ONLY_RE = new RegExp(`^${TIME_ALT}$`, "i");
const NAME_THEN_TIME_RE = new RegExp(`^(.*?[A-Za-z].*?)\\s+(${TIME_ALT})$`, "i");
const HEADER_WORDS = new Set(["employee", "employees", "name", "names", "staff", "hours", "hrs", "time", "total", "totals", "worked", "ordinary"]);

export function parseXeroTime(s) {
  const t = String(s ?? "").trim();
  if (!TIME_ONLY_RE.test(t)) return null;
  let m = t.match(/^(\d+)\s*h(?:rs?|ours?)?\s*(\d{1,2})\s*m/i);
  if (m) return Number(m[2]) < 60 ? round2(Number(m[1]) + Number(m[2]) / 60) : null;
  m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[2]) < 60 ? round2(Number(m[1]) + Number(m[2]) / 60) : null;
  m = t.match(/^(\d+(?:\.\d+)?)/);
  return m ? round2(Number(m[1])) : null;
}

const isHeaderChunk = (s) => {
  const words = s.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => HEADER_WORDS.has(w));
};

export function parseXeroPaste(text) {
  const tokens = []; // {kind: "name"|"time", value, raw}
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const chunks = line.split(/\t|,|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (!chunks.length || chunks.every(isHeaderChunk)) continue;
    for (const chunk of chunks) {
      const hours = parseXeroTime(chunk);
      if (hours != null) { tokens.push({ kind: "time", value: hours, raw: chunk }); continue; }
      const m = chunk.match(NAME_THEN_TIME_RE);
      const trailing = m ? parseXeroTime(m[2]) : null;
      if (m && trailing != null) {
        tokens.push({ kind: "name", value: m[1].trim(), raw: m[1].trim() });
        tokens.push({ kind: "time", value: trailing, raw: m[2] });
        continue;
      }
      if (/[A-Za-z]/.test(chunk) && !/\d/.test(chunk)) tokens.push({ kind: "name", value: chunk.replace(/\s+/g, " "), raw: chunk });
      else tokens.push({ kind: "junk", raw: chunk });
    }
  }
  const rows = [];
  const errors = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.kind === "name" && tokens[i + 1]?.kind === "time") {
      rows.push({ name: tk.value, hours: tokens[i + 1].value, raw: `${tk.raw} ${tokens[i + 1].raw}` });
      i++;
    } else if (tk.kind === "name") errors.push({ raw: tk.raw, message: `No hours found for "${tk.raw}"` });
    else if (tk.kind === "time") errors.push({ raw: tk.raw, message: `Hours "${tk.raw}" have no name before them` });
    else errors.push({ raw: tk.raw, message: `Couldn't read "${tk.raw}"` });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------- Xero name matching ----
// Key used for the remembered settings.xero_name_map ({ normalisedPastedName: person_id }).
export const normaliseXeroName = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const firstName = (s) => normaliseXeroName(s).split(" ")[0] || "";

// Match order: remembered map -> exact xero_name -> exact full/display/ClickUp name ->
// first name shared by exactly one person -> unmatched. A tier where the name hits
// several people is skipped rather than guessed. method: "remembered" | "xero_name" |
// "name" | "first_name" | "ambiguous" | "unmatched".
export function matchXeroNames(parsed, people, nameMap = {}) {
  const list = people || [];
  const known = new Set(list.map((p) => p.person_id));
  const uniqueBy = (pred) => {
    const hits = list.filter(pred);
    return hits.length === 1 ? hits[0].person_id : hits.length > 1 ? "__ambiguous" : null;
  };
  return (parsed || []).map(({ name, hours }) => {
    const n = normaliseXeroName(name);
    const remembered = nameMap?.[n];
    if (remembered != null && known.has(remembered)) return { name, hours, person_id: remembered, method: "remembered" };
    let ambiguous = false;
    const tiers = [
      ["xero_name", (p) => p.xero_name && normaliseXeroName(p.xero_name) === n],
      ["name", (p) => [p.full_name, p.display_name, ...(p.clickup_user_names || [])].some((x) => x && normaliseXeroName(x) === n)],
      ["first_name", (p) => [p.full_name, p.display_name].some((x) => x && firstName(x) === firstName(n))],
    ];
    for (const [method, pred] of tiers) {
      const hit = uniqueBy(pred);
      if (hit === "__ambiguous") { ambiguous = true; continue; }
      if (hit) return { name, hours, person_id: hit, method };
    }
    return { name, hours, person_id: null, method: ambiguous ? "ambiguous" : "unmatched" };
  });
}

// ---------------------------------------------------------------- export ----------------
export const WORKBOOK_HEADINGS = [
  "Employee", "State", "Type", "ClickUp total billed (with PG)", "PG billed", "Client billed",
  "ClickUp unbilled", "ClickUp total", "% billed total", "% billed client", "% billed (with PG)",
  "Xero", "ClickUp Total Xero Total Variance", "AL", "Sick / Personal", "LWOP", "Public Holiday",
  "Total", "Should be", "Variance", "PG", "KW", "LS", "Phil", "KW comment round 2",
];

// lines: [{ person_id, ...computeLine(...) result, pg_comment, kw_comment, ls_comment,
// phil_comment, kw2_comment }]. people: [{ person_id, display_name, state, type? }]
// (type overrides the basis-derived label). Nulls become "" so the cell stays blank;
// percentages stay as fractions (format the column as % in the sheet).
export function toWorkbookRows(lines, people) {
  const byId = new Map((people || []).map((p) => [p.person_id, p]));
  const blank = (v) => (v == null ? "" : v);
  return (lines || []).map((l) => {
    const p = byId.get(l.person_id) || {};
    const vals = [
      p.display_name ?? p.full_name ?? l.person_id, p.state ?? "", p.type ?? l.type ?? "",
      l.D, l.E, l.F, l.G, l.H, "", l.J, l.K, l.L, l.M, l.N, l.O, l.P, l.Q, l.R, l.S, l.T,
      l.pg_comment, l.kw_comment, l.ls_comment, l.phil_comment, l.kw2_comment,
    ];
    return Object.fromEntries(WORKBOOK_HEADINGS.map((h, i) => [h, blank(vals[i])]));
  });
}
