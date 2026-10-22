// Shared capacity-planning data layer: seed roster/client/support data, the
// pure date/availability math, and the Supabase-backed storage helpers.
//
// This used to live inside CapacityDashboard.jsx, which made a page component
// into a de facto shared library -- App.jsx, PerformanceScorecard.jsx,
// TeamDashboard.jsx, and TimesheetSummary.jsx all imported straight from a
// page they don't render, so the "Capacity Planning" page could never be
// refactored or reasoned about without checking four other files first.
// Extracted here so the page and its consumers are peers, both importing
// from a real shared module, instead of one secretly depending on the other.
import { loadState, saveState } from "./capacityStore.js";
import { findMatch, multiFolderMatchesFor, folderVariants, isInternalFolder } from "./nameMatch.js";
import { PUBLIC_HOLIDAYS } from "./publicHolidays.js";

/* ============================================================
   MONTHS / CONSTANTS
============================================================ */
const _now = new Date();
export const CURRENT_MONTH = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}`;

function monthKeyAt(year, monthIndex) { return `${year}-${String(monthIndex + 1).padStart(2, "0")}`; }
function monthLabelAt(year, monthIndex) { return new Date(year, monthIndex, 1).toLocaleString(undefined, { month: "short", year: "2-digit" }); }

// Seed data starts Dec 2025 -- generated out to 3 months past whatever "now" actually is
// (not a fixed literal ending at 2026-12) so CURRENT_MONTH is always a member of MONTHS and
// the month picker/"today" highlighting don't silently stop finding the current month once
// the real date rolls past whatever end-date used to be hardcoded here.
const MONTHS_START = { year: 2025, month: 11 }; // December 2025, 0-indexed month
export const MONTHS = (() => {
  const months = [];
  let y = MONTHS_START.year, m = MONTHS_START.month;
  const endYear = _now.getFullYear(), endMonth = _now.getMonth() + 3;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push(monthKeyAt(y, m));
    m++; if (m > 11) { m = 0; y++; }
  }
  return months;
})();
export const MONTH_LABELS = Object.fromEntries(MONTHS.map((mk) => {
  const [y, m] = mk.split("-").map(Number);
  return [mk, monthLabelAt(y, m - 1)];
}));

// Public holidays now live in publicHolidays.js (shared with Wages review); re-exported
// here so existing `import { PUBLIC_HOLIDAYS } from "./capacityData.js"` consumers keep working.
export { PUBLIC_HOLIDAYS } from "./publicHolidays.js";

// Exact count of Mon-Fri weekdays in a given "YYYY-MM" month — computed directly
// from the calendar rather than a flat assumption, so short/long months are accurate.
export function weekdaysInMonth(monthStr) {
  const [y, mo] = monthStr.split("-").map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, mo - 1, d).getDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}
export function publicHolidayDays(state, monthStr) {
  const list = PUBLIC_HOLIDAYS[state] || PUBLIC_HOLIDAYS.SA;
  return list.filter((h) => h.date.startsWith(monthStr)).length;
}
// Same two counts, but capped to day `throughDay` of the month — used to prorate
// a person's capacity down to their last working day in their resignation month.
export function weekdaysInMonthUpToDay(monthStr, throughDay) {
  const [y, mo] = monthStr.split("-").map(Number);
  let count = 0;
  for (let d = 1; d <= throughDay; d++) {
    const dow = new Date(y, mo - 1, d).getDay();
    if (dow >= 1 && dow <= 5) count++;
  }
  return count;
}
export function publicHolidayDaysUpToDay(state, monthStr, throughDay) {
  const list = PUBLIC_HOLIDAYS[state] || PUBLIC_HOLIDAYS.SA;
  return list.filter((h) => h.date.startsWith(monthStr) && Number(h.date.slice(8, 10)) <= throughDay).length;
}
// Whether a person counts as staff for a given month, given their (optional)
// resignationDate ("YYYY-MM-DD"): fully active if unset or the resignation falls
// in a later month; excluded entirely if it's an earlier month; active but capped
// to their last working day if the resignation falls within this exact month.
export function resignationStatus(person, monthStr) {
  if (!person.resignationDate) return { active: true, throughDay: null };
  const resignMonthKey = person.resignationDate.slice(0, 7);
  if (resignMonthKey > monthStr) return { active: true, throughDay: null };
  if (resignMonthKey < monthStr) return { active: false, throughDay: null };
  return { active: true, throughDay: Number(person.resignationDate.slice(8, 10)) };
}

// The single source of truth for a person's monthly capacity — used by both Capacity
// Planning's peopleMap and the Team module's Availability list, so the two can never
// silently drift onto different formulas for the same person/month.
export function computeMonthlyAvailability(person, monthStr, leaveHrs) {
  const status = resignationStatus(person, monthStr);
  if (!status.active) return null; // resigned in an earlier month — not staff this month at all
  const dailyHrs = person.contracted / 5;
  const wd = weekdaysInMonth(monthStr);
  const effectiveWeekdays = status.throughDay !== null ? weekdaysInMonthUpToDay(monthStr, status.throughDay) : wd;
  const resourceHours = dailyHrs * effectiveWeekdays;         // Total Resource Hours (monthly, weekday-exact, prorated if resigning this month)
  const holidayDays = status.throughDay !== null ? publicHolidayDaysUpToDay(person.state, monthStr, status.throughDay) : publicHolidayDays(person.state, monthStr);
  const publicHolidayHrs = dailyHrs * holidayDays;            // Public Holidays (hrs lost, state-specific)
  const totalMonthlyHours = Math.max(0, resourceHours - publicHolidayHrs - (leaveHrs || 0));
  const billableHours = totalMonthlyHours * person.rate;      // Total Monthly Billable Capacity
  const nonBillableHours = Math.max(0, totalMonthlyHours - billableHours);
  return {
    resourceHours, publicHolidayHrs, holidayDays, leaveHrs: leaveHrs || 0, totalMonthlyHours,
    billableHours, nonBillableHours, resigningThisMonth: status.throughDay !== null,
  };
}
// The 6 real calendar months ending with the current one, regardless of which month is
// selected in the ledger — "average of the last 6 months" is a fixed, always-moving window,
// not something that changes as you flip through Jan/Feb/... in the capacity view.
export function last6MonthKeys() {
  const now = new Date();
  const keys = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}
// Groups this month's holidays by date, and by date lists which states observe what —
// this is what powers the plain-English "X is a holiday in..." summary.
export function holidaysInMonthGrouped(monthStr) {
  const byDate = {};
  ["SA", "WA", "QLD"].forEach((state) => {
    PUBLIC_HOLIDAYS[state].filter((h) => h.date.startsWith(monthStr)).forEach((h) => {
      if (!byDate[h.date]) byDate[h.date] = {};
      byDate[h.date][state] = h.name;
    });
  });
  return Object.keys(byDate).sort().map((date) => {
    const day = Number(date.split("-")[2]);
    const ordinal = (n) => { const s = ["th", "st", "nd", "rd"]; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
    return { date, dayLabel: ordinal(day), states: byDate[date] };
  });
}

export const uid = (p) => p + Math.random().toString(36).slice(2, 9);
export const FIXED_BASES = ["Package", "Project", "Quoted", "MAP", "Strategy"];
export const VARIABLE_BASES = ["Hourly", "Ad hoc"];

// A client's agreed hours as of a given month, from its `history` (ascending list of
// { from: "YYYY-MM", agreed }) — the value from the latest entry whose `from` is <= the
// given month, or the client's base `agreed` if no history entry applies yet. Lets a
// package-hours change (e.g. Baintech 38 -> 32 hrs/month from June 2026) show correctly
// for past months in the ledger instead of always showing today's number.
export function agreedAt(client, monthKey) {
  if (client.offboardedFrom && monthKey >= client.offboardedFrom) return 0;
  if (!client.history || !client.history.length) return client.agreed;
  let value = client.agreed;
  // Skips any malformed entry instead of throwing -- a bad write (manual SQL edit,
  // a bug elsewhere) putting a null/non-object into this array previously crashed
  // this on `h.from`, taking down the whole dashboard via the ErrorBoundary rather
  // than just the one bad client. Better to render this client's own hours slightly
  // wrong than to blank the entire page for everyone.
  for (const h of client.history) { if (h && typeof h.from === "string" && h.from <= monthKey) value = h.agreed; }
  return value;
}

/* ============================================================
   SEED DATA -- intentionally empty.
   These used to hold the real roster (billable-rate targets, HR notes), client list
   (offboarding reasons) and support allocations, and they shipped inside the public JS
   bundle that every visitor downloads before signing in. The live data has long lived
   in pginvoice_app_state (admin tier only since 20261022_capacity_admin_only.sql), so
   they're now just empty starting values: every module renders nothing until its load
   succeeds, and every save-effect is gated on that successful load (capacityStore.js).
   The names stay exported so the existing imports and `v || SEED_*` fallbacks still work.
============================================================ */
export const SEED_PEOPLE = [];

export function C(id, client, group, lead, basis, agreed, actuals, extra) {
  const e = extra || {};
  return {
    id, client, group, lead, basis, agreed, actuals: actuals || null, note: e.note || "",
    status: e.status || "active", offboardedFrom: e.offboardedFrom || null, offboardNote: e.offboardNote || "",
    history: e.history || null,
  };
}
export const SEED_CLIENTS = [];

export const SEED_SUPPORT = [];

// Fallback owner order only (seed data / before the roster loads). Capacity Planning's real
// owner list is the Consultants roster -- see ownersFor.
export const OWNERS = ["Holly", "Shreya", "Chloe", "Alice", "Amanda", "Vinavie"];

/* ============================================================
   CONNECTION TO THE CLIENTS + CONSULTANTS MODULES
   The Clients module (pginvoice_clients + its dated events) is the source of truth for a
   client's status, consultant, type and agreed hours, and the Consultants roster for who
   the people are. Capacity Planning's own cap_clients rows used to be a separately
   maintained copy that drifted (Kasey's Queensland clients still led by Lucy after she
   resigned, HTSA at 80 h instead of 100, Comunet at 32 instead of 16, active clients like
   Committee for Perth missing entirely). reconcileCapClients rewrites those fields from
   the Clients module and adds any active client it doesn't have yet.
============================================================ */
export const CLIENT_TYPE_TO_BASIS = {
  package: "Package", strategy: "Strategy", map: "MAP", quoted: "Quoted", project: "Project",
  hourly: "Hourly", ad_hoc: "Ad hoc", digital: "Digital", queensland: "Hourly",
};
// Types whose agreed hours are a MONTHLY commitment -- the only ones copied into Capacity
// Planning's monthly demand. A quote's hours are a lifetime budget (Prison Transport Group's
// 80 h is not 80 h every month), and hourly/digital/ad hoc carry none, so those rows keep
// their own monthly estimate (or fall back to the real ClickUp average).
const MONTHLY_HOURS_TYPES = new Set(["package", "strategy", "map"]);
const STATUS_TO_CAP = { active: "active", archived: "archived" }; // on_hold/offboarded -> inactive

const firstWord = (s) => String(s || "").trim().split(/\s+/)[0].toLowerCase();
// The roster person a Clients-module consultant ("Kasey Doren", "Purple Giraffe") refers to:
// an exact full-name match first, then the first name. null when nobody on the roster fits.
export function rosterNameFor(consultant, people) {
  const full = String(consultant || "").trim().toLowerCase();
  if (!full) return null;
  const list = people || [];
  const exact = list.find((p) => String(p.name || "").trim().toLowerCase() === full);
  if (exact) return exact.name;
  const byFirst = list.find((p) => firstWord(p.name) === firstWord(full));
  return byFirst ? byFirst.name : null;
}

// `timelineFor(profile)` -> typeTimelineFor's segments ({ from, type, agreedHours }), passed
// in so this stays pure. `parentByFolder` maps a cost-centre/sub-project ClickUp folder to
// its parent client, so a sub-project added here joins its parent's group.
// Rows linked 1:1 to a profile take its type and monthly hours too; when several rows share
// one profile (Clarke Energy's sub-brands, Villani's website project beside its package)
// only status and lead are shared -- each row keeps its own basis and hours.
export function reconcileCapClients(capClients, pgClients, { people = [], timelineFor = null, parentByFolder = new Map(), newId = () => uid("c") } = {}) {
  const byName = new Map((pgClients || []).map((p) => [p.client, p]));
  const linkCount = new Map();
  for (const c of capClients || []) if (c.pgLink && byName.has(c.pgLink)) linkCount.set(c.pgLink, (linkCount.get(c.pgLink) || 0) + 1);
  let changed = false;
  const next = (capClients || []).map((c) => {
    const p = c.pgLink ? byName.get(c.pgLink) : null;
    if (!p) return c;
    const patch = {};
    const status = STATUS_TO_CAP[p.status] || "inactive";
    if (c.status !== status) patch.status = status;
    const lead = rosterNameFor(p.consultant, people);
    if (lead && c.lead !== lead) patch.lead = lead;
    if (linkCount.get(p.client) === 1) {
      const basis = CLIENT_TYPE_TO_BASIS[p.type];
      if (basis && c.basis !== basis) patch.basis = basis;
      if (MONTHLY_HOURS_TYPES.has(p.type)) {
        const hours = monthlyHoursFrom(p, timelineFor);
        if (c.agreed !== hours.agreed) patch.agreed = hours.agreed;
        if (JSON.stringify(c.history ?? null) !== JSON.stringify(hours.history)) patch.history = hours.history;
      }
    }
    if (!Object.keys(patch).length) return c;
    changed = true;
    return { ...c, ...patch };
  });
  const linked = new Set(next.map((c) => c.pgLink).filter(Boolean));
  for (const p of pgClients || []) {
    if (linked.has(p.client) || (p.status !== "active" && p.status !== "on_hold")) continue;
    const monthly = MONTHLY_HOURS_TYPES.has(p.type);
    const hours = monthly ? monthlyHoursFrom(p, timelineFor) : { agreed: null, history: null };
    next.push({
      id: newId(), client: p.client, group: (p.clickupFolder && parentByFolder.get(p.clickupFolder)) || p.client,
      lead: rosterNameFor(p.consultant, people) || "Unassigned", basis: CLIENT_TYPE_TO_BASIS[p.type] || "Hourly",
      agreed: hours.agreed, history: hours.history, actuals: null, note: "",
      status: STATUS_TO_CAP[p.status] || "inactive", offboardedFrom: null, offboardNote: "", pgLink: p.client,
    });
    changed = true;
  }
  return { clients: next, changed };
}

// A profile's monthly hours as cap_clients' { agreed, history }: `agreed` is the base
// (earliest) figure and `history` each later dated change, so agreedAt replays the same
// timeline the Clients module does. Without a timeline, just the current figure.
function monthlyHoursFrom(p, timelineFor) {
  const segs = timelineFor ? (timelineFor(p) || []) : [];
  if (segs.length < 2) return { agreed: p.agreedHours ?? null, history: null };
  const toMonth = (d) => (d.slice(8, 10) === "01" ? d.slice(0, 7) : shiftMonth(d.slice(0, 7), 1));
  const history = segs.slice(1).filter((sg) => sg.from).map((sg) => ({ from: toMonth(sg.from), agreed: MONTHLY_HOURS_TYPES.has(sg.type) ? (sg.agreedHours ?? null) : 0 }));
  const base = segs[0];
  return { agreed: MONTHLY_HOURS_TYPES.has(base.type) ? (base.agreedHours ?? null) : 0, history: history.length ? history : null };
}
function shiftMonth(mk, d) {
  const [y, m] = mk.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Capacity Planning's owner cards: everyone on the Consultants roster who is staff in
// `month` (resignation applied) and either a Consultant or the lead on a client -- the
// roster, not a hardcoded list, so a new consultant (Kasey) gets a card and a resigned one
// (Lucy) drops off.
export function ownersFor(people, month, leads = new Set()) {
  return (people || [])
    .filter((p) => resignationStatus(p, month).active && (p.role === "Consultant" || leads.has(p.name)))
    .map((p) => p.name);
}

/* ============================================================
   STORAGE — backed by Supabase (pginvoice_app_state), not localStorage, so
   roster/client edits are visible from any browser, not just the one that
   made them. Exported under its old name so every consumer's existing
   `loadKey(...)`/`saveKey(...)` calls keep working unchanged.
============================================================ */
export const loadKey = loadState;
export const saveKey = saveState;

/* ============================================================
   DEMAND — real billable-hours averages per client group (from ClickUp) and the
   per-client/per-group monthly demand derived from them, an override, or the
   seed actuals. Extracted out of CapacityDashboard.jsx (which used to be the
   only place these lived, closing over its own component state) so they're
   plain, testable functions instead.
============================================================ */

// Real billable-hours average per client GROUP, from whatever ClickUp export Client
// Invoicing currently has loaded — trailing 6 real calendar months, billable only,
// internal folders excluded, averaged only over the months that actually have data
// (not padded to 6 with zeros). Matched to a group by fuzzy folder-name match, same
// logic Client Invoicing uses to match ClickUp folders to the accrued sheet. Per-group
// only (not split across a combined client's sub-projects) — see demandForGroup below.
export function computeDynamicAverages(clickupData, clients) {
  const result = new Map();
  if (!clickupData || !clickupData.rows || !clickupData.rows.length) return result;
  const monthSet = new Set(last6MonthKeys());
  const perFolderMonth = new Map();
  const folders = new Set();
  for (const r of clickupData.rows) {
    if (isInternalFolder(r.folder) || r.nonClientSpace) continue;
    if (clickupData.hasBillable && !r.billable) continue;
    folders.add(r.folder);
    if (!r.monthKey || !monthSet.has(r.monthKey)) continue;
    if (!perFolderMonth.has(r.folder)) perFolderMonth.set(r.folder, new Map());
    const byMonth = perFolderMonth.get(r.folder);
    byMonth.set(r.monthKey, (byMonth.get(r.monthKey) || 0) + r.minutes);
  }
  const folderList = [...folders];
  const groups = [...new Set(clients.map((c) => c.group))];
  for (const group of groups) {
    // Some clients run their real work across several sibling ClickUp folders (Aus3C's
    // training programs, Magain's ~20 individual-agent folders, etc.) rather than one
    // umbrella folder -- sum minutes across all of them per month instead of picking a
    // single best-match folder, which was silently undercounting these clients' actuals.
    const multi = multiFolderMatchesFor(group, folderList);
    if (multi && multi.length) {
      const byMonth = new Map();
      for (const f of multi) {
        const fm = perFolderMonth.get(f);
        if (!fm) continue;
        for (const [mk, min] of fm) byMonth.set(mk, (byMonth.get(mk) || 0) + min);
      }
      if (byMonth.size === 0) continue;
      const totalMin = [...byMonth.values()].reduce((a, b) => a + b, 0);
      result.set(group, { avgHours: (totalMin / 60) / byMonth.size, matchedFolder: `${multi.length} folders`, monthsCounted: byMonth.size, confidence: 1 });
      continue;
    }
    const match = findMatch(group, folderList);
    if (!match) continue;
    // findMatch picks ONE folder, but a renamed folder's rows can sit under several
    // case/whitespace spellings ("GPEX" and "gpex") -- sum every variant of it.
    const byMonth = new Map();
    for (const f of folderVariants(match.name, folderList)) {
      for (const [mk, min] of perFolderMonth.get(f) || []) byMonth.set(mk, (byMonth.get(mk) || 0) + min);
    }
    if (byMonth.size === 0) continue;
    const totalMin = [...byMonth.values()].reduce((a, b) => a + b, 0);
    result.set(group, { avgHours: (totalMin / 60) / byMonth.size, matchedFolder: match.name, monthsCounted: byMonth.size, confidence: match.confidence });
  }
  return result;
}

export function trailingAverage(actuals, m) {
  if (!actuals) return null;
  const vals = Object.keys(actuals).filter((k) => k < m).sort().map((k) => actuals[k]);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function demandFor(c, m, overrides, avgOverride) {
  const avg = avgOverride !== undefined ? avgOverride : trailingAverage(c.actuals, m);
  const isFixed = FIXED_BASES.includes(c.basis);
  const agreed = agreedAt(c, m);
  let demand;
  if (c.offboardedFrom && m >= c.offboardedFrom) { demand = 0; }
  else if (isFixed) { demand = (agreed !== null && agreed !== undefined) ? agreed : (avg !== null ? avg : 0); }
  else { demand = avg !== null ? avg : (agreed !== null ? agreed : 0); }
  const overrideKey = `${c.id}_${m}`;
  const overridden = overrides[overrideKey];
  if (overridden !== undefined && overridden !== null && overridden !== "") { demand = Number(overridden); }
  return { demand, avg, isOverridden: overridden !== undefined && overridden !== null && overridden !== "" };
}

// One client (single-row group): the real average, if matched, replaces the seed
// actuals average entirely (still subject to a manual override, same as before).
// Combined client (several sub-projects): as long as none of the sub-projects has
// been manually overridden, the GROUP TOTAL becomes the real average directly rather
// than a sum of the sub-projects' own (still seed-sourced) figures — per the client's
// call, ClickUp hours aren't split across sub-projects. But once any sub-project IS
// manually edited, the total has to track that edit like a normal total row, so it
// falls back to summing the (possibly-overridden) sub-project figures.
export function demandForGroup(group, rows, m, overrides, dynamicAverages) {
  const dyn = dynamicAverages.get(group);
  if (rows.length === 1) {
    const { demand, avg, isOverridden } = demandFor(rows[0], m, overrides, dyn?.avgHours);
    return { demand, avg, isOverridden, isDynamic: !!dyn && !isOverridden, dyn };
  }
  const rowResults = rows.map((r) => demandFor(r, m, overrides));
  const anyOverridden = rowResults.some((x) => x.isOverridden);
  if (dyn && !anyOverridden) return { demand: dyn.avgHours, avg: dyn.avgHours, isOverridden: false, isDynamic: true, dyn };
  const demand = rowResults.reduce((s, x) => s + x.demand, 0);
  return { demand, avg: null, isOverridden: anyOverridden, isDynamic: false, dyn: null };
}
