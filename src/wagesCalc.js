// Pure maths for the admin-only Wages review module: a digitised version of Kelly's
// Monthly Wages Review workbook (one row per employee, columns A-Y). No React or Supabase
// imports -- everything here is directly testable (see wagesCalc.test.js).
//
// Units: ClickUp buckets are kept in MINUTES until computeLine converts them to hours;
// workbook outputs are HOURS rounded to 2dp (ratios to 4dp). Dates are "YYYY-MM-DD"
// string keys built with Date.UTC/getUTCDay -- never toISOString on a local date.
// null always means "not entered / not applicable" and is kept distinct from 0.
import { CLIENT_SPACE_IDS, isInternalFolder, isNonClientSpace } from "./nameMatch.js";
import { holidaysFor, PUBLIC_HOLIDAYS } from "./publicHolidays.js";

// Default global settings (pginvoice_wage_settings). The single source for these numbers:
// wagesView's DEFAULT_WAGE_SETTINGS, computeLine's fallbacks and the Settings form all
// import them from here.
export const STANDARD_DAY_HOURS = 7.6;
export const DEFAULT_XERO_TOLERANCE_H = 0.25;
export const DEFAULT_VARIANCE_THRESHOLD_H = 3.8;

export const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
// Coerces to a finite number; anything else (null, "", "abc") is 0. Use only where a
// missing value genuinely means zero -- null-vs-0 matters for Xero hours.
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pad2 = (n) => String(n).padStart(2, "0");
// Trimmed, single-spaced, lower-case: the one key used to compare ClickUp user names,
// folder names and pasted Xero names.
export const normName = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
// Hours for human-readable workings: at least 1dp ("114.0"), up to 2dp ("78.26").
const fmtWorkingHours = (n) => { const r = round2(n); return Number.isInteger(r * 10) ? r.toFixed(1) : r.toFixed(2); };
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Weekly-pattern columns on pginvoice_wage_rules, in display order (Mon first).
// `dow` is the getUTCDay() index the column applies to.
export const PATTERN_DAYS = [
  { key: "mon_h", label: "Mon", dow: 1 }, { key: "tue_h", label: "Tue", dow: 2 }, { key: "wed_h", label: "Wed", dow: 3 },
  { key: "thu_h", label: "Thu", dow: 4 }, { key: "fri_h", label: "Fri", dow: 5 }, { key: "sat_h", label: "Sat", dow: 6 },
  { key: "sun_h", label: "Sun", dow: 0 },
];

// Employment bases (pginvoice_wage_rules.basis). short = workbook column C label,
// long = settings/working label, help = one-line explanation in the rule editor.
export const BASES = {
  ft: { short: "F/T", long: "Full-time", help: "Standard days × hours per day" },
  pt_pattern: { short: "P/T", long: "Part-time pattern", help: "Hours per weekday" },
  casual_xero: { short: "Casual", long: "Casual (expected = Xero)", help: "Expected = Xero (no over/under)" },
  casual_pattern: { short: "Casual", long: "Casual pattern", help: "Agreed weekly pattern" },
  casual_target: { short: "Casual", long: "Casual monthly target", help: "Monthly target" },
};

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

// Named apart from capacityData's weekdaysInMonth (same answer, different module) so an
// auto-import can't silently pick the wrong one.
export function wageWeekdaysInMonth(monthKey) {
  return monthDays(monthKey).filter((d) => isWeekday(d.dow)).length;
}

// The workbook's "standard hours" note: weekdays × 7.6 (Jul 2026: 23 × 7.6 = 174.8).
export function standardMonthHours(monthKey, perDay = STANDARD_DAY_HOURS) {
  return round2(wageWeekdaysInMonth(monthKey) * perDay);
}

// ---------------------------------------------------------------- ClickUp ---------------
function emptyBuckets() {
  return { pgBillable: 0, pgNonBillable: 0, clientBillable: 0, clientNonBillable: 0, taskless: 0, unknownSpace: 0, total: 0, byFolder: [] };
}

// Adds one folder slice into a bucket, merging with an existing slice for the same
// folder/pg/billable so byFolder stays one line per folder × billable.
function addSlice(b, { folder, pg, billable, minutes }) {
  if (pg) b[billable ? "pgBillable" : "pgNonBillable"] += minutes;
  else b[billable ? "clientBillable" : "clientNonBillable"] += minutes;
  b.total += minutes;
  const hit = b.byFolder.find((f) => normName(f.folder) === normName(folder) && f.pg === pg && f.billable === billable);
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
// they fall back to nameMatch's folder-name rule (isNonClientSpace(null, null, folder):
// BDM-space folders such as "CRM" are non-client, anything else is assumed client), and
// their minutes are also counted in `unknownSpace` / `unknownSpaceMinutes` so the UI can warn.
// `taskless` and `unknownSpace` are informational subsets of `total`, not extra time.
// Returns { perUser: { [userName]: buckets }, ignored: { [userName]: buckets }, unknownSpaceMinutes }.
export function classifyClickup(summaryRows, settings = {}) {
  const pgFolders = new Set((settings.pg_folders || []).map(normName));
  const ignoredUsers = new Set((settings.ignored_clickup_users || []).map(normName));
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
    const clientSpace = spaceId ? CLIENT_SPACE_IDS.has(spaceId) : !isNonClientSpace(null, null, folder);
    const isClient = clientSpace && !taskless && !pgFolders.has(normName(folder)) && !isInternalFolder(folder);
    const target = ignoredUsers.has(normName(user)) ? ignored : perUser;
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
      const k = normName(n);
      if (!k) continue;
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k).add(p.person_id);
    }
  }
  const byPerson = {};
  const unmapped = [];
  const conflicts = [];
  for (const [userName, b] of Object.entries(perUser || {})) {
    const ids = owners.get(normName(userName));
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
// Indexed by getUTCDay(): pattern[dow] = hours that weekday.
function patternOf(rule) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const d of PATTERN_DAYS) out[d.dow] = num(rule[d.key]);
  return out;
}

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
      working: `${weekdays.length} weekdays × ${fmtWorkingHours(dh)} = ${fmtWorkingHours(S)}`,
      qWorking: `${phWeekdays.length} public holiday${phWeekdays.length === 1 ? "" : "s"} × ${fmtWorkingHours(dh)} = ${fmtWorkingHours(Q)}`,
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
      parts.push(`${counts[dow]} ${DOW_SHORT[dow]} × ${fmtWorkingHours(pattern[dow])}`);
    }
    const phWorked = phDays.filter((d) => pattern[d.dow] > 0);
    let working = `${parts.length ? parts.join(" + ") : "no pattern days"} = ${fmtWorkingHours(S)}`;
    if (excludePh && phWorked.length) working += ` (excl. ${phWorked.length} public holiday${phWorked.length === 1 ? "" : "s"})`;
    if (excludePh) return { S, Q: 0, counted: [], working, qWorking: "Casual: no public holiday pay" };
    const Q = phWorked.reduce((s, d) => s + pattern[d.dow], 0);
    return {
      S, Q, counted: phWorked, working,
      qWorking: phWorked.length ? `${phWorked.map((d) => `${DOW_SHORT[d.dow]} ${d.date.slice(8)} × ${fmtWorkingHours(pattern[d.dow])}`).join(" + ")} = ${fmtWorkingHours(Q)}` : "no public holidays on working days",
    };
  }
  if (basis === "casual_target") {
    const target = num(rule.monthly_target_h);
    const S = monthWeekdays ? target * (weekdays.length / monthWeekdays) : 0;
    return {
      S, Q: 0, counted: [],
      working: weekdays.length === monthWeekdays
        ? `monthly target ${fmtWorkingHours(target)}`
        : `${fmtWorkingHours(target)} × ${weekdays.length}/${monthWeekdays} weekdays = ${fmtWorkingHours(S)}`,
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
// varianceApplicable is false and S is the sum of the other segments. S is null (never a
// fabricated 0) when no segment produces an expected figure: every segment casual_xero,
// or no rule covers any employed day. A missing rule for any employed day also sets
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
  let sSum = 0, Q = 0, anyXero = false, anyExpected = false, allXero = runs.length > 0;
  for (const run of runs) {
    const rule = sorted[run.idx];
    const calc = segmentCalc({ rule, days: run.days, phDates, monthWeekdays, perDay });
    if (!calc) { missingRule = true; allXero = false; continue; }
    if (rule.basis === "casual_xero") anyXero = true; else { allXero = false; anyExpected = true; sSum += calc.S; }
    Q += calc.Q;
    counted.push(...calc.counted);
    segments.push({
      from: run.days[0].date, to: run.days[run.days.length - 1].date, basis: rule.basis,
      S: calc.S == null ? null : round2(calc.S), Q: round2(calc.Q), working: calc.working, qWorking: calc.qWorking,
    });
  }

  return {
    S: anyExpected ? round2(sSum) : null,
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
    const l = BASES[s.basis]?.short;
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
// T (and Tpct) is null whenever the variance isn't assessable (mixed casual_xero month,
// missing rule) -- a partial S would make R - S look like a real over/under. The one
// exception is an all-casual_xero month, where T = 0 once Xero is in (as the workbook has it).
export function computeLine({ clickup, leave, xeroHours, expected, overrides = {}, settings = {} }) {
  const c = clickup || emptyBuckets();
  const exp = expected || { S: null, Q: 0, varianceApplicable: false, missingRule: true, allCasualXero: false, segments: [] };
  const tol = num(settings.xero_tolerance_h ?? DEFAULT_XERO_TOLERANCE_H);
  const thr = num(settings.variance_threshold_h ?? DEFAULT_VARIANCE_THRESHOLD_H);

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
  const allXero = !!exp.allCasualXero;
  let S;
  if (overridden) S = round2(num(overrides.expected_override_h));
  else if (exp.S == null && allXero) S = R;
  else S = exp.S == null ? null : round2(exp.S);
  const varianceApplicable = overridden || !!exp.varianceApplicable;

  const T = R == null || S == null || (!varianceApplicable && !allXero) ? null : round2(R - S);
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
    varianceApplicable, allCasualXero: allXero, flags, status, type: typeLabelFor(exp.segments),
  };
}

// ---------------------------------------------------------------- hours input -----------
// Parses a typed hours field (Xero hours L, PH / expected overrides): "" -> null (cleared,
// never 0), otherwise a number 0..9999 rounded to 2dp. A comma is accepted ONLY as a real
// thousands separator ("1,234.5"); "152,5" is a decimal comma and is refused with a hint
// instead of silently becoming 1525. A monthly value over MONTHLY_HOURS_WARN is allowed
// but comes back with a warning. Returns { ok, value, error?, warning? }.
export const MONTHLY_HOURS_WARN = 400;
const THOUSANDS_RE = /^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/;
const PLAIN_NUMBER_RE = /^(\d+(\.\d*)?|\.\d+)$/;
export function parseHoursInput(text) {
  const t = String(text ?? "").trim();
  if (t === "") return { ok: true, value: null };
  let clean = t;
  if (t.includes(",")) {
    if (!THOUSANDS_RE.test(t)) {
      const dc = t.match(/^(\d+),(\d+)$/);
      return { ok: false, value: null, error: dc ? `Use a dot for decimals: ${t} → ${dc[1]}.${dc[2]}` : "Enter hours as a number, e.g. 152.5" };
    }
    clean = t.replace(/,/g, "");
  }
  if (!PLAIN_NUMBER_RE.test(clean)) return { ok: false, value: null, error: "Enter hours as a number, e.g. 152.5" };
  const n = Number(clean);
  if (!Number.isFinite(n) || n > 9999) return { ok: false, value: null, error: "Enter hours between 0 and 9999" };
  const value = round2(n);
  return value > MONTHLY_HOURS_WARN
    ? { ok: true, value, warning: `Over ${MONTHLY_HOURS_WARN} h in a month: check this is right` }
    : { ok: true, value };
}

// ---------------------------------------------------------------- Xero paste ------------
// Kelly pastes "name, hours" pairs for the whole team from Xero. Accepted shapes:
//   "Jane Smith\t142.5" -- a line containing a tab is split on tabs ONLY, and each cell is
//                          either a time or, whole, a name: "Jane Smith 2\t40" is name
//                          "Jane Smith 2" with 40 h, never "Jane Smith" with 2 h.
//   "Jane Smith, 142.5" / "Jane Smith   142.5" / "Jane Smith 142.5" (no tab)
//   alternating lines (name, then hours), or one line "Jane, 142.5, Bob, 166.2".
// Times: 142.5, 142:30, 142h 30m, 142 hrs. A comma is never a decimal point: a line with
// a decimal comma ("152,5") is reported ("Use a dot for decimals") instead of being split
// into 152 and 5. A tab-less line that reads as name, name, hours ("Smith, Jane 152.5") is
// reported too -- "Surname, First" can't be told apart from two names.
// Header-ish lines ("Employee  Hours") are skipped. A full Xero report table (header row
// with Employee + Units columns) is read by column instead -- see parseXeroTable.
// Returns { rows: [{name, hours, raw}], errors: [{raw, message}], notes: [string] }.
const T_HM = String.raw`\d+\s*h(?:rs?|ours?)?\s*\d{1,2}\s*m(?:ins?|inutes?)?`;
const T_COLON = String.raw`\d+:\d{1,2}`;
const T_DEC = String.raw`\d+(?:\.\d+)?(?:\s*(?:h|hrs?|hours?))?`;
const TIME_ALT = `(?:${T_HM}|${T_COLON}|${T_DEC})`;
const TIME_ONLY_RE = new RegExp(`^${TIME_ALT}$`, "i");
const NAME_THEN_TIME_RE = new RegExp(`^(.*?[A-Za-z].*?)\\s+(${TIME_ALT})$`, "i");
const DECIMAL_COMMA_RE = /(\d+),(\d{1,2})(?![\d:])/;
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

// One line -> tokens {kind: "name"|"time"|"junk"|"error", value?, raw, message?}.
function lineTokens(line) {
  const trimmed = line.trim();
  const dc = line.match(DECIMAL_COMMA_RE);
  if (dc) return [{ kind: "error", raw: trimmed, message: `Use a dot for decimals: ${dc[1]},${dc[2]} → ${dc[1]}.${dc[2]}` }];
  // "1,234.5" would otherwise be split on the comma into "1" and "234.5" -- and if the
  // admin ticked "ignore unreadable lines", that person would be saved at 1 h.
  if (/\d,\d{3}\b/.test(line)) return [{ kind: "error", raw: trimmed, message: "Remove thousands separators from hours (1,234.5 → 1234.5)" }];
  const tabbed = line.includes("\t");
  const chunks = (tabbed ? line.split("\t") : line.split(/,|\s{2,}/)).map((c) => c.trim()).filter(Boolean);
  if (!chunks.length || chunks.every(isHeaderChunk)) return [];
  const out = [];
  for (const chunk of chunks) {
    const hours = parseXeroTime(chunk);
    if (hours != null) { out.push({ kind: "time", value: hours, raw: chunk }); continue; }
    if (!tabbed) {
      const m = chunk.match(NAME_THEN_TIME_RE);
      const trailing = m ? parseXeroTime(m[2]) : null;
      if (m && trailing != null) {
        out.push({ kind: "name", value: m[1].trim().replace(/\s+/g, " "), raw: m[1].trim() });
        out.push({ kind: "time", value: trailing, raw: m[2] });
        continue;
      }
    }
    // In a tab cell the whole text is the name (digits included); otherwise a name has no digits.
    if (/[A-Za-z]/.test(chunk) && (tabbed || !/\d/.test(chunk))) out.push({ kind: "name", value: chunk.replace(/\s+/g, " "), raw: chunk });
    else out.push({ kind: "junk", raw: chunk });
  }
  if (!tabbed && out.length === 3 && out[0].kind === "name" && out[1].kind === "name" && out[2].kind === "time") {
    return [{ kind: "error", raw: trimmed, message: `Can't tell where the name ends in "${trimmed}": put a tab between the name and the hours` }];
  }
  return out;
}

// Xero's timesheet/pay report pasted whole: a tab-separated table whose header row has an
// "Employee" column and a "Units" (or "Hours") column, e.g.
//   Employee | Employee group | Earnings Rate | Calendar | Timesheet Category | Units
// Only the employee name and units are used. When an "Earnings Rate" column exists, only
// Ordinary Hours rows count -- other rates (overtime, public holiday, leave...) are listed
// as notes, not added, because public holidays and leave are accounted for separately
// (Q / N / O / P) and adding them here would double count. Several rows for one person
// are kept as separate rows -- resolveXeroBatch makes the admin choose. "Total" rows are
// skipped.
const XERO_NAME_HEADERS = new Set(["employee", "employee name", "name"]);
const XERO_HOURS_HEADERS = new Set(["units", "hours", "total hours", "hours worked", "ordinary hours"]);
function parseXeroTable(lines) {
  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx < 0 || !lines[headerIdx].includes("\t")) return null;
  const header = lines[headerIdx].split("\t").map((c) => normName(c));
  const nameCol = header.findIndex((h) => XERO_NAME_HEADERS.has(h));
  const hoursCol = header.findIndex((h) => XERO_HOURS_HEADERS.has(h));
  if (nameCol < 0 || hoursCol < 0) return null;
  const rateCol = header.findIndex((h) => h === "earnings rate");
  const rows = [];
  const errors = [];
  const notes = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cells = line.split("\t").map((c) => c.trim());
    const name = (cells[nameCol] || "").replace(/\s+/g, " ");
    const rawHours = cells[hoursCol] ?? "";
    if (!name) { errors.push({ raw: line.trim(), message: `No employee name in "${line.trim()}"` }); continue; }
    if (/^(grand\s+)?totals?$/i.test(name)) continue;
    if (rateCol >= 0 && cells[rateCol] && !/ordinary/i.test(cells[rateCol])) {
      notes.push(`Skipped ${name}: ${cells[rateCol]} ${rawHours} (only Ordinary Hours are imported)`);
      continue;
    }
    if (/\d,\d/.test(rawHours)) { errors.push({ raw: line.trim(), message: `${name}: remove commas from the hours ("${rawHours}")` }); continue; }
    const hours = parseXeroTime(rawHours);
    if (hours == null) { errors.push({ raw: line.trim(), message: `${name}: couldn't read the hours "${rawHours}"` }); continue; }
    rows.push({ name, hours, raw: line.trim() });
  }
  return { rows, errors, notes };
}

export function parseXeroPaste(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const table = parseXeroTable(lines);
  if (table) return table;
  const tokens = [];
  for (const line of lines) tokens.push(...lineTokens(line));
  const rows = [];
  const errors = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const next = tokens[i + 1];
    if (tk.kind === "name" && next?.kind === "time") {
      rows.push({ name: tk.value, hours: next.value, raw: `${tk.raw} ${next.raw}` });
      i++;
    } else if (tk.kind === "name" && next?.kind === "error") {
      // Alternating layout with an unreadable hours line: one error for the pair.
      errors.push({ raw: `${tk.raw} ${next.raw}`, message: `${tk.raw}: ${next.message}` });
      i++;
    } else if (tk.kind === "name") errors.push({ raw: tk.raw, message: `No hours found for "${tk.raw}"` });
    else if (tk.kind === "time") errors.push({ raw: tk.raw, message: `Hours "${tk.raw}" have no name before them` });
    else if (tk.kind === "error") errors.push({ raw: tk.raw, message: tk.message });
    else errors.push({ raw: tk.raw, message: `Couldn't read "${tk.raw}"` });
  }
  return { rows, errors, notes: [] };
}

// ---------------------------------------------------------------- Xero name matching ----
// settings.xero_name_map is keyed by normName(pastedName) -> person_id.
const firstName = (s) => normName(s).split(" ")[0] || "";

// Match order: remembered map -> exact xero_name -> exact full/display/ClickUp name ->
// first name shared by exactly one person -> unmatched. A tier where the name hits
// several people is skipped rather than guessed. method: "remembered" | "xero_name" |
// "name" | "first_name" | "ambiguous" | "unmatched". A first-name hit is only a
// suggestion (needsConfirm: true): the dialog preselects it but treats the row as
// unresolved until someone confirms it -- "Jane" could be a different Jane.
export function matchXeroNames(parsed, people, nameMap = {}) {
  const list = people || [];
  const known = new Set(list.map((p) => p.person_id));
  const uniqueBy = (pred) => {
    const hits = list.filter(pred);
    return hits.length === 1 ? hits[0].person_id : hits.length > 1 ? "__ambiguous" : null;
  };
  return (parsed || []).map(({ name, hours }) => {
    const n = normName(name);
    const remembered = nameMap?.[n];
    if (remembered != null && known.has(remembered)) return { name, hours, person_id: remembered, method: "remembered", needsConfirm: false };
    let ambiguous = false;
    const tiers = [
      ["xero_name", (p) => p.xero_name && normName(p.xero_name) === n],
      ["name", (p) => [p.full_name, p.display_name, ...(p.clickup_user_names || [])].some((x) => x && normName(x) === n)],
      ["first_name", (p) => [p.full_name, p.display_name].some((x) => x && firstName(x) === firstName(n))],
    ];
    for (const [method, pred] of tiers) {
      const hit = uniqueBy(pred);
      if (hit === "__ambiguous") { ambiguous = true; continue; }
      if (hit) return { name, hours, person_id: hit, method, needsConfirm: method === "first_name" };
    }
    return { name, hours, person_id: null, method: ambiguous ? "ambiguous" : "unmatched", needsConfirm: false };
  });
}

// ---------------------------------------------------------------- Xero batches ----------
// Xero hours can arrive in several pastes (batches). Applying a batch only touches the
// people in it. A person is a CONFLICT -- and nothing is saved for them until the admin
// chooses -- when this paste has more than one row for them, or they already have saved
// Xero hours (from an earlier batch) that differ from the pasted value.
//   rows:     [{ target: person_id, hours, name }]  (matched, non-ignored rows of this paste)
//   currentL: { [person_id]: saved hours | null }
//   choices:  { [person_id]: "row:<index into that person's rows>" | "saved" | "sum" }
//     "sum" adds this paste's rows together, plus the saved value when there is one.
// Returns { apply: [{person_id, hours, names}], unchanged: [person_id], keep: [person_id],
//           conflicts: [{ person_id, saved, rows: [{hours, name}], options: [{key, label, hours}], choice }] }
export function resolveXeroBatch(rows, currentL = {}, choices = {}) {
  const byPerson = new Map();
  for (const r of rows || []) {
    if (!r.target) continue;
    if (!byPerson.has(r.target)) byPerson.set(r.target, []);
    byPerson.get(r.target).push({ hours: r.hours, name: r.name });
  }
  const apply = [];
  const unchanged = [];
  const keep = [];
  const conflicts = [];
  for (const [person_id, prs] of byPerson) {
    const saved = currentL[person_id] ?? null;
    const names = [...new Set(prs.map((r) => r.name))];
    if (prs.length === 1 && (saved == null || Math.abs(saved - prs[0].hours) < 0.005)) {
      if (saved == null) apply.push({ person_id, hours: prs[0].hours, names });
      else unchanged.push(person_id);
      continue;
    }
    const pastedSum = round2(prs.reduce((a, r) => a + r.hours, 0));
    const options = prs.map((r, i) => ({ key: `row:${i}`, label: prs.length === 1 ? `Use new ${r.hours} h` : `Use ${r.hours} h (row ${i + 1})`, hours: r.hours }));
    if (saved != null) options.push({ key: "saved", label: `Keep saved ${saved} h`, hours: saved });
    options.push(saved != null
      ? { key: "sum", label: `Add together: ${round2(saved + pastedSum)} h`, hours: round2(saved + pastedSum) }
      : { key: "sum", label: `Add together: ${pastedSum} h`, hours: pastedSum });
    const choice = options.some((o) => o.key === choices[person_id]) ? choices[person_id] : null;
    conflicts.push({ person_id, saved, rows: prs, options, choice });
    if (choice === "saved") keep.push(person_id);
    else if (choice) apply.push({ person_id, hours: options.find((o) => o.key === choice).hours, names });
  }
  return { apply, unchanged, keep, conflicts };
}
