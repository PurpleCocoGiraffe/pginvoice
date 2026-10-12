// Pure month-view builder for the Wages review module: turns the raw sources loaded by
// wagesSync.loadWagesMonth (roster, wage people/rules/settings, the month row, saved
// lines, typed leave, ClickUp summary) into one display line per payroll person plus
// team totals and the warnings the page shows. No React or Supabase imports -- tested
// directly in wagesView.test.js.
//
// A CLOSED month renders from wage_months.snapshot (frozen at close), never from a
// recompute: ClickUp edits, rule changes or a roster edit after closing must not move
// numbers Kelly already signed off. Comments stay live (they're editable after close),
// so they're merged from the current wage_lines rows over the snapshot's copy.
//
// LEAVE_TYPES comes from leaveSync.js, which creates (but here never calls) the Supabase
// client -- tests mock supabaseClient.js.
import {
  classifyClickup, attributeToPeople, expectedFor, computeLine, standardMonthHours,
  wageWeekdaysInMonth, round2, num, normName,
  STANDARD_DAY_HOURS, DEFAULT_XERO_TOLERANCE_H, DEFAULT_VARIANCE_THRESHOLD_H,
} from "./wagesCalc.js";
import { holidaysFor, HOLIDAY_COVERAGE_END } from "./publicHolidays.js";
import { LEAVE_TYPES } from "./leaveSync.js";

export const SNAPSHOT_VERSION = 1;
export const WAGE_STATES = ["SA", "WA", "QLD"];

// Workbook review/comment columns U-Y, in workbook order. key = wage_lines column,
// short = card/table dot label, label = drawer field label, heading = workbook heading.
export const REVIEW_FIELDS = [
  { key: "pg_comment", short: "PG", label: "PG note", heading: "PG" },
  { key: "kw_comment", short: "KW", label: "Kelly (KW)", heading: "KW" },
  { key: "ls_comment", short: "LS", label: "Lynda (LS)", heading: "LS" },
  { key: "phil_comment", short: "Phil", label: "Phil", heading: "Phil" },
  { key: "kw2_comment", short: "KW2", label: "Kelly round 2 (KW2)", heading: "KW comment round 2" },
];
export const COMMENT_FIELDS = REVIEW_FIELDS.map((f) => f.key);
// The reviewer sign-off dots (everything but the PG note).
export const REVIEWER_FIELDS = REVIEW_FIELDS.filter((f) => f.key !== "pg_comment");

// Typed leave keys (annual / personal / lwop / unspecified) -- the leave columns N/O/P + untyped.
const LEAVE_KEYS = LEAVE_TYPES.map((t) => t.key);
const TYPED_LEAVE_KEYS = LEAVE_KEYS.filter((k) => k !== "unspecified");

// Statuses that put a person in "Needs attention" (and the "attention" filter).
export const ATTENTION_STATUSES = ["check_sync", "over", "under"];

export const DEFAULT_WAGE_SETTINGS = {
  hours_per_day: STANDARD_DAY_HOURS,
  xero_tolerance_h: DEFAULT_XERO_TOLERANCE_H,
  variance_threshold_h: DEFAULT_VARIANCE_THRESHOLD_H,
  pg_folders: ["Purple Giraffe"],
  ignored_clickup_users: ["Purple Giraffe"],
  xero_name_map: {},
};

const numOrNull = (v) => (v == null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const dateKey = (v) => (v ? String(v).slice(0, 10) : null);

export function monthBounds(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${monthKey}-01`, last: `${monthKey}-${String(last).padStart(2, "0")}` };
}

// numeric columns can arrive as strings; null/undefined stay null (never coerced to 0).
export function normaliseSettings(row) {
  const s = { ...DEFAULT_WAGE_SETTINGS, ...(row || {}) };
  return {
    ...s,
    hours_per_day: numOrNull(s.hours_per_day) ?? DEFAULT_WAGE_SETTINGS.hours_per_day,
    xero_tolerance_h: numOrNull(s.xero_tolerance_h) ?? DEFAULT_WAGE_SETTINGS.xero_tolerance_h,
    variance_threshold_h: numOrNull(s.variance_threshold_h) ?? DEFAULT_WAGE_SETTINGS.variance_threshold_h,
    pg_folders: Array.isArray(s.pg_folders) ? s.pg_folders : [],
    ignored_clickup_users: Array.isArray(s.ignored_clickup_users) ? s.ignored_clickup_users : [],
    xero_name_map: s.xero_name_map && typeof s.xero_name_map === "object" ? s.xero_name_map : {},
  };
}

// "F/T" -> "FT", "P/T" -> "PT", "F/T → P/T" -> "FT → PT". Empty when no rule applied.
export const typeShort = (label) => String(label || "").replace(/F\/T/g, "FT").replace(/P\/T/g, "PT");

// Typed leave per person: hours and (entered) days per type. A person with no typed
// entries but a legacy cap_leaves total (entered before leave types existed) gets that
// total as "unspecified" -- dropping it would silently understate column R.
function leaveByPerson(entries, capLeaves, monthKey, personIds) {
  const out = {};
  const zeros = () => Object.fromEntries(LEAVE_KEYS.map((k) => [k, 0]));
  const blank = () => ({ ...zeros(), days: zeros(), legacy: false });
  for (const e of entries || []) {
    if (e.month_key && e.month_key !== monthKey) continue;
    const t = TYPED_LEAVE_KEYS.includes(e.leave_type) ? e.leave_type : "unspecified";
    const b = out[e.person_id] || (out[e.person_id] = blank());
    b[t] = round2(b[t] + num(e.hours));
    if (e.days != null) b.days[t] = round2(b.days[t] + num(e.days));
  }
  for (const pid of personIds) {
    if (out[pid]) continue;
    const legacy = num(capLeaves?.[`${pid}_${monthKey}`]);
    const b = blank();
    if (legacy > 0) { b.unspecified = round2(legacy); b.legacy = true; }
    out[pid] = b;
  }
  return out;
}

function hoursByFolder(buckets) {
  const map = new Map();
  for (const f of buckets?.byFolder || []) {
    const k = `${f.pg ? "pg" : "client"}|${normName(f.folder)}`;
    const row = map.get(k) || { folder: f.folder || "(No folder)", pg: f.pg, billableH: 0, nonBillableH: 0 };
    if (f.billable) row.billableH += f.minutes / 60; else row.nonBillableH += f.minutes / 60;
    map.set(k, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, billableH: round2(r.billableH), nonBillableH: round2(r.nonBillableH) }))
    .sort((a, b) => (b.billableH + b.nonBillableH) - (a.billableH + a.nonBillableH));
}

function lifecycleFor({ start, end, rules, monthKey }) {
  const { first, last } = monthBounds(monthKey);
  const inMonth = (d) => d && d >= first && d <= last;
  const change = (rules || []).map((r) => dateKey(r.effective_from)).filter((d) => inMonth(d) && d > first && (!start || d > start)).sort()[0] || null;
  return { started: inMonth(start) ? start : null, left: inMonth(end) ? end : null, hoursChanged: change };
}

// Builds the live (recomputed) lines and warnings. Exported for the closed-month
// "live differs" comparison and for building the snapshot at close.
export function computeLiveView(sources, monthKey) {
  const settings = normaliseSettings(sources.settings);
  const roster = sources.roster || [];
  const wagePeople = sources.wagePeople || [];
  const { first, last } = monthBounds(monthKey);
  const rosterById = new Map(roster.map((p) => [p.id, p]));
  const wpById = new Map(wagePeople.map((w) => [w.person_id, w]));
  const lineById = new Map((sources.lines || []).filter((l) => !l.month_key || l.month_key === monthKey).map((l) => [l.person_id, l]));
  const rulesByPerson = {};
  for (const r of sources.rules || []) (rulesByPerson[r.person_id] || (rulesByPerson[r.person_id] = [])).push(r);
  const nameOf = (pid) => rosterById.get(pid)?.name || pid;

  // Every wage_people row claims its ClickUp names (included or not), so a login that
  // belongs to an excluded person never shows up as "unmapped".
  const { perUser, unknownSpaceMinutes } = classifyClickup(sources.clickupSummary || [], settings);
  const { byPerson, unmapped, conflicts } = attributeToPeople(perUser, wagePeople);

  const included = [];
  const outsideWindow = [];
  const orphanWagePeople = [];
  for (const w of wagePeople) {
    if (!w.include) continue;
    const r = rosterById.get(w.person_id);
    if (!r) { orphanWagePeople.push({ person_id: w.person_id }); continue; }
    const start = dateKey(w.start_date);
    const end = dateKey(w.end_date) ?? dateKey(r.resignationDate);
    const tracked = byPerson[w.person_id]?.total || 0;
    if ((start && start > last) || (end && end < first)) {
      if (tracked > 0) outsideWindow.push({ person_id: w.person_id, name: nameOf(w.person_id), hours: round2(tracked / 60) });
      continue;
    }
    included.push({ w, r, start, end });
  }
  const needsSetup = roster
    .filter((p) => !wpById.has(p.id) && !(p.resignationDate && dateKey(p.resignationDate) < first))
    .map((p) => ({ person_id: p.id, name: p.name }));

  const leave = leaveByPerson(sources.leaveEntries, sources.capLeaves, monthKey, included.map((x) => x.w.person_id));

  const lines = included.map(({ w, r, start, end }) => {
    const pid = w.person_id;
    const state = String(r.state ?? "").trim().toUpperCase();
    const rules = rulesByPerson[pid] || [];
    const row = lineById.get(pid) || null;
    const exp = expectedFor({ monthKey, person: { state, start_date: start, end_date: end }, rules, perDay: settings.hours_per_day });
    const lv = leave[pid];
    const buckets = byPerson[pid] || null;
    const res = computeLine({
      clickup: buckets,
      leave: lv,
      xeroHours: row?.xero_hours ?? null,
      expected: exp,
      overrides: { ph_override_h: numOrNull(row?.ph_override_h), expected_override_h: numOrNull(row?.expected_override_h) },
      settings,
    });
    return {
      person_id: pid,
      name: r.name || pid,
      role: r.role || "",
      photo: r.photo || "",
      state,
      typeLabel: res.type,
      typeShort: typeShort(res.type),
      ...res,
      split: {
        clientBillable: round2(num(buckets?.clientBillable) / 60),
        pgBillable: round2(num(buckets?.pgBillable) / 60),
        clientNonBillable: round2(num(buckets?.clientNonBillable) / 60),
        pgNonBillable: round2(num(buckets?.pgNonBillable) / 60),
        taskless: round2(num(buckets?.taskless) / 60),
        unknownSpace: round2(num(buckets?.unknownSpace) / 60),
      },
      byFolder: hoursByFolder(buckets),
      leave: lv,
      expected: {
        S: exp.S, Q: exp.Q, segments: exp.segments, holidays: exp.holidays, missingRule: exp.missingRule,
        allCasualXero: exp.allCasualXero, unknownState: exp.unknownState, employedWeekdays: exp.employedWeekdays,
      },
      stateHolidays: holidaysFor(state, monthKey),
      lifecycle: lifecycleFor({ start, end, rules, monthKey }),
      start_date: start,
      end_date: end,
      hasLineRow: !!row,
      xero_source: row?.xero_source ?? null,
      ph_override_h: numOrNull(row?.ph_override_h),
      expected_override_h: numOrNull(row?.expected_override_h),
      expected_override_reason: row?.expected_override_reason ?? null,
      ...commentsOf(row),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const noRule = lines.filter((l) => l.expected.missingRule && l.expected_override_h == null).map((l) => ({ person_id: l.person_id, name: l.name }));
  const untypedLeave = lines.filter((l) => l.leave.unspecified > 0).map((l) => ({ person_id: l.person_id, name: l.name, hours: l.leave.unspecified, legacy: l.leave.legacy }));

  return {
    settings,
    lines,
    warnings: {
      unmapped: unmapped.map((u) => ({ user_name: u.user_name, hours: round2(u.minutes / 60) })).sort((a, b) => b.hours - a.hours),
      conflicts: conflicts.map((c) => ({ user_name: c.user_name, hours: round2(c.minutes / 60), people: c.person_ids.map((id) => ({ person_id: id, name: nameOf(id) })) })),
      needsSetup,
      noRule,
      untypedLeave,
      outsideWindow,
      orphanWagePeople,
      unknownSpaceHours: round2(unknownSpaceMinutes / 60),
      // publicHolidays.js only lists dates up to HOLIDAY_COVERAGE_END; past that, Q would
      // silently be 0 for everyone.
      holidaysNotLoaded: first > HOLIDAY_COVERAGE_END,
    },
  };
}

function commentsOf(row) {
  const out = {};
  for (const f of COMMENT_FIELDS) out[f] = row?.[f] ?? null;
  out.phil_leave_applied = !!row?.phil_leave_applied;
  return out;
}

export function holidaysByState(monthKey) {
  return Object.fromEntries(WAGE_STATES.map((s) => [s, holidaysFor(s, monthKey)]));
}

// Team totals over the given lines. Sums only what's known: L/T only over lines where
// they're non-null, ratios null when there's no tracked time at all.
export function computeTotals(lines) {
  const ls = lines || [];
  const sum = (k) => round2(ls.reduce((s, l) => s + num(l[k]), 0));
  const withXero = ls.filter((l) => l.L != null);
  const assessed = ls.filter((l) => l.varianceApplicable && l.T != null);
  const H = sum("H"), D = sum("D"), F = sum("F");
  const count = (st) => ls.filter((l) => l.status === st).length;
  return {
    people: ls.length,
    D, E: sum("E"), F, G: sum("G"), H,
    L: withXero.length ? round2(withXero.reduce((s, l) => s + num(l.L), 0)) : null,
    xeroEntered: withXero.length,
    reconciled: withXero.filter((l) => !l.flags?.xeroMismatch).length,
    outOfTolerance: ls.filter((l) => l.flags?.xeroMismatch).length,
    awaiting: count("awaiting_xero"),
    over: count("over"),
    under: count("under"),
    ok: count("ok"),
    notAssessed: count("not_assessed"),
    netT: assessed.length ? round2(assessed.reduce((s, l) => s + num(l.T), 0)) : null,
    assessed: assessed.length,
    J: H > 0 ? Math.round((F / H) * 10000) / 10000 : null,
    K: H > 0 ? Math.round((D / H) * 10000) / 10000 : null,
  };
}

// Line fields that are display-only and not needed to render a closed month: photo is a
// base64 data URL (tens of KB per person -- re-read from the live roster instead),
// stateHolidays isn't rendered at all.
const SNAPSHOT_DROP_FIELDS = ["photo", "stateHolidays"];

// Frozen at close: lines + the config that produced them. Plain JSON.
export function buildSnapshot(view, computedAt = new Date().toISOString()) {
  return {
    version: SNAPSHOT_VERSION,
    computed_at: computedAt,
    lines: view.lines.map((l) => {
      const out = { ...l };
      for (const k of SNAPSHOT_DROP_FIELDS) delete out[k];
      return out;
    }),
    settings: view.settings,
    standardHours: view.standardHours,
    weekdays: view.weekdays,
    holidaysByState: view.holidaysByState,
  };
}

// sources: { roster, capLeaves, wagePeople, rules, settings, monthRow, lines, leaveEntries,
// clickupSummary } -- plain data (callers must not pass a failed source as empty data).
// For a closed month only monthRow (+ lines for live comments) is required; the live
// sources are optional and only used for the "live differs" comparison.
export function buildMonthView(sources, monthKey) {
  const monthRow = sources.monthRow || null;
  const closed = monthRow?.status === "closed";
  const snap = closed && monthRow.snapshot && Array.isArray(monthRow.snapshot.lines) ? monthRow.snapshot : null;
  const liveAvailable = ["roster", "wagePeople", "rules", "lines", "leaveEntries", "clickupSummary"].every((k) => Array.isArray(sources[k]));

  if (snap) {
    const liveRows = new Map((sources.lines || []).map((l) => [l.person_id, l]));
    // Photos aren't frozen (see buildSnapshot); take the current one when the roster loaded.
    const photoById = new Map((sources.roster || []).map((p) => [p.id, p.photo || ""]));
    const lines = snap.lines.map((l) => {
      const row = liveRows.get(l.person_id);
      const merged = row ? { ...l, ...commentsOf(row) } : { ...l };
      if (merged.photo == null) merged.photo = photoById.get(l.person_id) || "";
      return merged;
    });
    let liveDiffers = [];
    if (liveAvailable) {
      const live = computeLiveView(sources, monthKey);
      const liveById = new Map(live.lines.map((l) => [l.person_id, l]));
      liveDiffers = lines.map((l) => {
        const lv = liveById.get(l.person_id);
        const fields = lv
          ? LIVE_DIFF_FIELDS.filter((f) => Math.abs(num(lv[f.key]) - num(l[f.key])) > 0.1)
            .map((f) => ({ key: f.key, label: f.label, snapshot: l[f.key] ?? null, live: lv[f.key] ?? null }))
          : [];
        return { person_id: l.person_id, name: l.name, missing: !lv, fields };
      }).filter((d) => d.missing || d.fields.length);
    }
    const settings = normaliseSettings(snap.settings);
    return {
      monthKey, closed: true, fromSnapshot: true, monthRow, settings,
      computedAt: snap.computed_at || null,
      perDay: settings.hours_per_day,
      weekdays: snap.weekdays ?? wageWeekdaysInMonth(monthKey),
      standardHours: snap.standardHours ?? standardMonthHours(monthKey, settings.hours_per_day),
      holidaysByState: snap.holidaysByState || holidaysByState(monthKey),
      lines,
      totals: computeTotals(lines),
      warnings: emptyWarnings(),
      liveDiffers,
    };
  }

  const live = computeLiveView(sources, monthKey);
  return {
    monthKey, closed, fromSnapshot: false, snapshotMissing: closed, monthRow,
    settings: live.settings,
    computedAt: null,
    perDay: live.settings.hours_per_day,
    weekdays: wageWeekdaysInMonth(monthKey),
    standardHours: standardMonthHours(monthKey, live.settings.hours_per_day),
    holidaysByState: holidaysByState(monthKey),
    lines: live.lines,
    totals: computeTotals(live.lines),
    warnings: live.warnings,
    liveDiffers: [],
  };
}

function emptyWarnings() {
  return { unmapped: [], conflicts: [], needsSetup: [], noRule: [], untypedLeave: [], outsideWindow: [], orphanWagePeople: [], unknownSpaceHours: 0, holidaysNotLoaded: false };
}

// Inputs that can move after close and that the closed-month banner compares (> 0.1 h):
// ClickUp total, the three typed leave columns, untyped leave, public holidays.
const LIVE_DIFF_FIELDS = [
  { key: "H", label: "ClickUp" },
  { key: "N", label: "Annual leave" },
  { key: "O", label: "Sick / Personal" },
  { key: "P", label: "LWOP" },
  { key: "unspecified", label: "Untyped leave" },
  { key: "Q", label: "Public holiday" },
];

// Whether the line has an expected figure S to show/sum: false for a person with no hours
// rule covering the month (S null, never a fabricated 0) and for an all-casual month
// before Xero is entered (S = Xero, not known yet).
export const hasExpected = (line) => line?.S != null;

// ---------------------------------------------------------------- grouping / filters ----
export const STATUS_GROUPS = [
  { key: "attention", title: "Needs attention", statuses: ATTENTION_STATUSES },
  { key: "awaiting", title: "Awaiting Xero", statuses: ["awaiting_xero"] },
  { key: "ok", title: "Within tolerance", statuses: ["ok"] },
  { key: "not_assessed", title: "Not assessed (casual / no rule)", statuses: ["not_assessed"] },
];

export function groupLines(lines) {
  return STATUS_GROUPS.map((g) => {
    let ls = (lines || []).filter((l) => g.statuses.includes(l.status));
    if (g.key === "attention") {
      ls = [...ls].sort((a, b) => (Math.abs(num(b.T)) - Math.abs(num(a.T))) || (Math.abs(num(b.M)) - Math.abs(num(a.M))) || a.name.localeCompare(b.name));
    }
    return { ...g, lines: ls };
  }).filter((g) => g.lines.length);
}

// filters: { q, state: "all"|SA|WA|QLD, type: "all"|"FT"|"PT"|"Casual", status: "all"|"attention"|<status> }
export function filterLines(lines, filters = {}) {
  const q = String(filters.q || "").trim().toLowerCase();
  return (lines || []).filter((l) => {
    if (q && !String(l.name || "").toLowerCase().includes(q)) return false;
    if (filters.state && filters.state !== "all" && l.state !== filters.state) return false;
    if (filters.type && filters.type !== "all" && !String(l.typeShort || typeShort(l.type)).includes(filters.type)) return false;
    if (filters.status && filters.status !== "all") {
      if (filters.status === "attention") return ATTENTION_STATUSES.includes(l.status);
      if (l.status !== filters.status) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------- workbook export -------
// Columns A-Y of Kelly's workbook, in order. U-Y come from REVIEW_FIELDS.
export const WORKBOOK_HEADINGS = [
  "Employee", "State", "Type", "ClickUp total billed (with PG)", "PG billed", "Client billed",
  "ClickUp unbilled", "ClickUp total", "% billed total", "% billed client", "% billed (with PG)",
  "Xero", "ClickUp Total Xero Total Variance", "AL", "Sick / Personal", "LWOP", "Public Holiday",
  "Total", "Should be", "Variance",
  ...REVIEW_FIELDS.map((f) => f.heading),
];

// lines: [{ person_id, ...computeLine(...) result, <REVIEW_FIELDS keys> }]. people:
// [{ person_id, display_name, state, type? }] (type overrides the basis-derived label).
// Nulls become "" so the cell stays blank; percentages stay as fractions (format the
// column as % in the sheet). Variance (T) is blank unless it's assessable or the month is
// all casual-equals-Xero (T = 0 there, as in the workbook) -- a mixed or no-rule month's
// R - S isn't a real over/under. Column I ("% billed total") is in the workbook's layout
// but not used in the workbook, so it's always blank here.
export function toWorkbookRows(lines, people) {
  const byId = new Map((people || []).map((p) => [p.person_id, p]));
  const blank = (v) => (v == null ? "" : v);
  return (lines || []).map((l) => {
    const p = byId.get(l.person_id) || {};
    const T = l.varianceApplicable || l.allCasualXero ? l.T : null;
    const vals = [
      p.display_name ?? p.full_name ?? l.person_id, p.state ?? "", p.type ?? l.type ?? "",
      l.D, l.E, l.F, l.G, l.H, "", l.J, l.K, l.L, l.M, l.N, l.O, l.P, l.Q, l.R, hasExpected(l) ? l.S : null, T,
      ...REVIEW_FIELDS.map((f) => l[f.key]),
    ];
    return Object.fromEntries(WORKBOOK_HEADINGS.map((h, i) => [h, blank(vals[i])]));
  });
}
