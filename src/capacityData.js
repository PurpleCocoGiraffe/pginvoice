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

// Real, named public holidays for SA/WA/QLD, weekdays only (weekend-falling holidays
// with no substitute don't affect working-day capacity, so they're excluded here — e.g.
// ANZAC Day 2026 falls on a Saturday and SA/QLD give no substitute day).
// Sourced from each state's official 2026 public holiday calendar (Dec 2025 included for
// months prior to Jan 2026). Verify before relying on this for payroll purposes.
export const PUBLIC_HOLIDAYS = {
  SA: [
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Proclamation Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-03-09", name: "Adelaide Cup Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-06-08", name: "King's Birthday" },
    { date: "2026-10-05", name: "Labour Day" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Proclamation Day (in lieu)" },
  ],
  WA: [
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Boxing Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-03-02", name: "Labour Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-04-27", name: "ANZAC Day (in lieu)" },
    { date: "2026-06-01", name: "Western Australia Day" },
    { date: "2026-09-28", name: "King's Birthday" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Boxing Day (in lieu)" },
  ],
  QLD: [
    { date: "2025-12-25", name: "Christmas Day" },
    { date: "2025-12-26", name: "Boxing Day" },
    { date: "2026-01-01", name: "New Year's Day" },
    { date: "2026-01-26", name: "Australia Day" },
    { date: "2026-04-03", name: "Good Friday" },
    { date: "2026-04-06", name: "Easter Monday" },
    { date: "2026-05-04", name: "Labour Day" },
    { date: "2026-08-12", name: "Royal Queensland Show (Ekka, Brisbane)" },
    { date: "2026-10-05", name: "King's Birthday" },
    { date: "2026-12-25", name: "Christmas Day" },
    { date: "2026-12-28", name: "Boxing Day (in lieu)" },
  ],
};

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
   SEED DATA (unchanged from the real Resourcing sheet + ClickUp actuals)
   Exported — Performance, Team, and Timesheet Summary reuse this exact
   roster/client master instead of keeping their own copy, so the modules
   can never quietly drift apart.
============================================================ */
export const SEED_PEOPLE = [
  { id: "p1", name: "Holly", role: "Consultant", state: "SA", contracted: 38, rate: 0.70, note: "Standard" },
  { id: "p2", name: "Shreya", role: "Consultant", state: "SA", contracted: 38, rate: 0.60, note: "Probation" },
  { id: "p3", name: "Chloe", role: "Consultant", state: "SA", contracted: 30, rate: 0.70, note: "Standard" },
  { id: "p4", name: "Alice", role: "Consultant", state: "SA", contracted: 22.5, rate: 0.70, note: "Standard" },
  { id: "p5", name: "Amanda", role: "Consultant", state: "WA", contracted: 38, rate: 0.20, note: "Support-heavy role, worth reviewing" },
  { id: "p6", name: "Lucy", role: "Consultant", state: "QLD", contracted: 38, rate: 0.50, note: "Probation + BDM discount" },
  { id: "p7", name: "Vinavie", role: "Consultant", state: "SA", contracted: 38, rate: 0.70, note: "Standard" },
  { id: "p8", name: "Alex", role: "Coordinator", state: "SA", contracted: 38, rate: 0.70, note: "Supports others + Purple Giraffe internal work" },
  { id: "p9", name: "Ariani", role: "Coordinator", state: "SA", contracted: 38, rate: 0.70, note: "Standard" },
  { id: "p10", name: "Chelsea", role: "Coordinator", state: "SA", contracted: 38, rate: 0.60, note: "Probation" },
  { id: "p11", name: "Vino", role: "Coordinator", state: "SA", contracted: 38, rate: 0.60, note: "Probation" },
  { id: "p12", name: "Julia", role: "Coordinator", state: "QLD", contracted: 38, rate: 0.60, note: "Probation" },
  { id: "p13", name: "Tanya", role: "Coordinator", state: "SA", contracted: 15, rate: 0.70, note: "Part-time, currently unallocated" },
  { id: "p17", name: "Sarah", role: "Consultant", state: "SA", contracted: 38, rate: 0.70, note: "Owns several active package clients in the Clients module (Amorim Cork, Magain Real Estate, etc.) -- added as an owner here to keep the two systems in sync; please confirm role/state/rate." },
];

export function C(id, client, group, lead, basis, agreed, actuals, extra) {
  const e = extra || {};
  return {
    id, client, group, lead, basis, agreed, actuals: actuals || null, note: e.note || "",
    status: e.status || "active", offboardedFrom: e.offboardedFrom || null, offboardNote: e.offboardNote || "",
    history: e.history || null,
  };
}
export const SEED_CLIENTS = [
  C("c1", "Amorim Cork", "Amorim Cork", "Chloe", "Package", 16, { "2026-01": 4.5, "2026-02": 5.3, "2026-03": 5.0, "2026-04": 9.5, "2026-05": 0.5, "2026-06": 0.8 }, { status: "active", history: [{ from: "2024-11", agreed: 0.0 }, { from: "2025-07", agreed: 16.0 }] }),
  C("c2", "Apex Energy", "Apex Energy", "Chloe", "Package", 16, { "2026-01": 11.7, "2026-02": 7.8, "2026-03": 22.8, "2026-04": 15.8, "2026-05": 18.3, "2026-06": 36.7 }, { status: "active", history: [{ from: "2025-06", agreed: 24.0 }, { from: "2026-01", agreed: 16.0 }] }),
  C("c3", "Apex Communications", "Apex Communications", "Chloe", "Package", 30.5, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 0, "2026-05": 28.6, "2026-06": 19.5 }, { status: "active" }),
  C("c4", "ARAS (Aged Rights Advocacy Services)", "Aged Rights Advocacy Services", "Chloe", "Hourly", null, { "2026-01": 0, "2026-02": 0, "2026-03": 3.1, "2026-04": 5.6, "2026-05": 3.7, "2026-06": 2.7 }, { status: "inactive", offboardedFrom: "2026-07", offboardNote: "ClickUp activity stopped after 1 Jul 2026, lining up with an earlier Lost Client Register note about funding expiring (source: PG Four Lists workbook, \"recommend treating as offboarded pending confirmation\"); confirmed same client as the Supabase Clients module's ARAS record, also offboarded there 1 Jul 2026." }),
  C("c5", "Equippers", "Equippers", "Chloe", "Quoted", null, { "2026-01": 0, "2026-02": 11.2, "2026-03": 5.0, "2026-04": 3.3, "2026-05": 10.0, "2026-06": 0.4 }, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Not recorded — recurring invoicing and ClickUp activity simply stop (source: Inactive Clients list, ~1 Jun 2026)" }),
  C("c6", "Spectrum Consultants", "Spectrum Consultants", "Chloe", "Package", 24, { "2026-01": 21.8, "2026-02": 36.9, "2026-03": 35.9, "2026-04": 22.7, "2026-05": 22.8, "2026-06": 21.1 }, { status: "active", history: [{ from: "2026-01", agreed: 24.0 }] }),
  C("c7", "Treasure Boxes", "Treasure Boxes", "Chloe", "Package", 10, { "2026-01": 21.8, "2026-02": 20.2, "2026-03": 3.4, "2026-04": 0, "2026-05": 0, "2026-06": 11.5 }, { status: "active", history: [{ from: "2025-07", agreed: 10.0 }] }),
  C("c8", "Warrina Homes: Package", "Warrina Homes", "Chloe", "Package", 24, { "2026-01": 28.5, "2026-02": 27.8, "2026-03": 7.2, "2026-04": 46.8, "2026-05": 50.0, "2026-06": 44.1 }, { status: "active" }),
  C("c9", "Warrina Homes: Employee Handbook", "Warrina Homes", "Chloe", "Project", null, null, { status: "active" }),

  C("c11", "Clare Valley Wine & Grape", "Clare Valley Wine & Grape", "Vinavie", "Package", 8, { "2026-01": 17.9, "2026-02": 5.2, "2026-03": 9.0, "2026-04": 7.8, "2026-05": 2.3, "2026-06": 0.8 }, { status: "active", history: [{ from: "2026-01", agreed: 8.0 }] }),
  C("c12", "Coonawarra", "Coonawarra", "Vinavie", "Package", 16, { "2026-01": 0, "2026-02": 0, "2026-03": 25.5, "2026-04": 17.7, "2026-05": 21.8, "2026-06": 13.6 }, { status: "active" }),
  C("c13", "Riverland Wine: Package", "Riverland Wine", "Vinavie", "Package", 8, { "2026-01": 9.8, "2026-02": 14.8, "2026-03": 14.2, "2026-04": 11.9, "2026-05": 23.1, "2026-06": 3.2 }, { status: "active", history: [{ from: "2026-04", agreed: 8.0 }] }),
  C("c14", "Riverland Wine: Melbourne Showcase", "Riverland Wine", "Vinavie", "Quoted", 25, null, { status: "inactive", offboardedFrom: "2026-08", offboardNote: "One-time project, completed. Also added to the Clients module as an archived project." }),
  C("c15", "Sevenhill", "Sevenhill", "Vinavie", "Project", 6, null, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Reduced to 'Media Release only' then dropped (source: Inactive Clients list, ~Feb-Jun 2026)" }),
  C("c16", "Vegetation Solutions: MVS", "Vegetation Solutions: MVS", "Vinavie", "Hourly", null, { "2026-01": 3.8, "2026-02": 3.6, "2026-03": 3.5, "2026-04": 1.3, "2026-05": 1.2, "2026-06": 0.4 }, { status: "active" }),
  C("c17", "Vegetation Solutions: Firewood", "Vegetation Solutions: Firewood", "Vinavie", "Hourly", null, { "2026-01": 1.3, "2026-02": 2.5, "2026-03": 22.4, "2026-04": 21.1, "2026-05": 19.3, "2026-06": 13.0 }, { status: "active" }),

  C("c18", "Aus3C", "Aus3C", "Shreya", "Package", 40, { "2026-01": 35.0, "2026-02": 58.9, "2026-03": 56.0, "2026-04": 27.4, "2026-05": 67.6, "2026-06": 18.6 }, { status: "active" }),
  C("c19", "GPEX", "GPEX", "Shreya", "Package", 70, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 38.6, "2026-05": 105.3, "2026-06": 140.4 }, { status: "active" }),
  C("c20", "BusSA", "BusSA", "Shreya", "Project", 25, { "2026-01": 0, "2026-02": 1.5, "2026-03": 9.0, "2026-04": 18.8, "2026-05": 46.5, "2026-06": 19.0 }, { status: "active", note: "A separate 'BusSA / BusSafe' one-off project ended ~May 2026 per the Inactive Clients list, but this account is the ongoing BusSAFE retainer and remains active." }),
  C("c21", "Magain Real Estate", "Magain Real Estate", "Shreya", "Hourly", null, { "2026-01": 13.1, "2026-02": 8.8, "2026-03": 42.9, "2026-04": 24.0, "2026-05": 10.3, "2026-06": 7.6 }, { status: "active" }),

  C("c23", "Baintech", "Baintech", "Lucy", "Package", 38, null, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Zero ClickUp folder activity found across the entire 13-month synced window (Jul 2025-Jul 2026), corroborating the PG Four Lists workbook note \"Offboarding planned for end Jun 2026 -- recommend confirming this went ahead as scheduled\"; mirrors the same status set on this client in the Supabase Clients module.", history: [{ from: "2026-06", agreed: 32.0 }] }),
  C("c24", "BAMSS / Childcare Sec Services", "BAMSS Childcare Security Services (Qld)", "Lucy", "Package", 22, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 4.7, "2026-05": 5.8, "2026-06": 13.9 }, { status: "active" }),
  C("c25", "Barclay Recruitment (Verity Cons)", "Barclay Recruitment", "Lucy", "Package", 27, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 0, "2026-05": 14.9, "2026-06": 48.5 }, { status: "active" }),
  C("c26", "Bridge to Best", "Bridge to Best", "Lucy", "Package", 10, null, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Zero ClickUp folder activity found across the entire 13-month synced window (Jul 2025-Jul 2026), corroborating the PG Four Lists workbook note \"Offboarding planned for end Jun 2026 -- recommend confirming this went ahead as scheduled\"; mirrors the same status set on this client in the Supabase Clients module." }),
  C("c27", "By the Rules", "By the Rules", "Lucy", "Package", 5, null, { status: "active" }),
  C("c28", "Connection Central", "Connection Central", "Lucy", "Project", 25, null, { status: "inactive", offboardedFrom: "2026-05", offboardNote: "Project ended (source: Inactive Clients list, ~1 May 2026)" }),
  C("c29", "Cowie Environmental", "Cowie Environmental", "Lucy", "Package", 16, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 31.7, "2026-05": 16.2, "2026-06": 33.5 }, { status: "active" }),
  C("c30", "CRA Construction", "CRA Construction", "Lucy", "Package", 24, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 7.8, "2026-05": 25.7, "2026-06": 23.5 }, { status: "active" }),
  C("c31", "Mary Di Marco – Ray White", "Mary Di Marco - Ray White (Qld)", "Lucy", "Package", 11, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 4.7, "2026-05": 6.4, "2026-06": 11.5 }, { status: "active", history: [{ from: "2026-06", agreed: 6 }] }),
  C("c32", "Plumbaround", "Plumbaround", "Lucy", "Package", 16, null, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Zero ClickUp folder activity found across the entire 13-month synced window (Jul 2025-Jul 2026), corroborating the PG Four Lists workbook note \"Offboarding planned for end Jun 2026 -- recommend confirming this went ahead as scheduled\"; mirrors the same status set on this client in the Supabase Clients module." }),
  C("c33", "Sunfresh Linen", "Sunfresh Linen", "Lucy", "Package", 22, { "2026-01": 0, "2026-02": 0, "2026-03": 0.3, "2026-04": 22.6, "2026-05": 21.7, "2026-06": 32.9 }, { status: "active" }),

  C("c34", "Bee Squared Consulting", "Bee Squared", "Holly", "Package", 24, { "2026-01": 29.1, "2026-02": 25.7, "2026-03": 24.4, "2026-04": 13.4, "2026-05": 30.1, "2026-06": 29.4 }, { status: "active", history: [{ from: "2025-07", agreed: 24.0 }] }),
  C("c35", "Comunet", "Comunet", "Holly", "Hourly", 32, { "2026-01": 22.8, "2026-02": 21.8, "2026-03": 20.8, "2026-04": 6.8, "2026-05": 47.4, "2026-06": 32.8 }, { status: "active" }),
  C("c36", "Clarke Energy (base)", "Clarke Energy", "Holly", "Hourly", null, { "2026-01": 26.9, "2026-02": 37.2, "2026-03": 48.1, "2026-04": 26.0, "2026-05": 67.2, "2026-06": 112.3 }, { status: "active" }),
  C("c37", "Clarke Energy: AEP", "Clarke Energy", "Holly", "Hourly", null, null, { status: "active" }),
  C("c38", "Clarke Energy: ACES", "Clarke Energy", "Holly", "Hourly", null, null, { status: "active" }),
  C("c39", "Clarke Energy: AIMEX", "Clarke Energy", "Holly", "Hourly", null, null, { status: "active" }),
  C("c40", "Clarke Energy: WA", "Clarke Energy", "Holly", "Hourly", null, null, { status: "active" }),
  C("c41", "History Trust of SA (HTSA)", "HTSA", "Holly", "MAP", 80, { "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 0, "2026-05": 28.1, "2026-06": 82.6 }, { status: "active" }),
  C("c42", "PRG Consulting", "PRG Financial Services Outsourced Marketing", "Holly", "Package", 8, { "2026-01": 13.5, "2026-02": 15.4, "2026-03": 13.1, "2026-04": 1.0, "2026-05": 5.0, "2026-06": 5.4 }, { status: "active", history: [{ from: "2026-01", agreed: 8.0 }] }),
  C("c43", "Utter Gutters", "Utter Gutters", "Holly", "Package", 32, { "2026-01": 8.2, "2026-02": 6.5, "2026-03": 6.2, "2026-04": 6.0, "2026-05": 7.1, "2026-06": 9.0 }, { status: "active" }),
  C("c44", "Villani Jewellers", "Villani Jewellers", "Holly", "Package", 16, { "2026-01": 12.8, "2026-02": 16.8, "2026-03": 16.5, "2026-04": 20.9, "2026-05": 16.8, "2026-06": 12.9 }, { status: "active", history: [{ from: "2025-09", agreed: 24.0 }, { from: "2026-05", agreed: 16.0 }] }),
  C("c45", "Villani: Website Project", "Villani Jewellers", "Holly", "Project", 8, null, { status: "active" }),

  C("c46", "Hills Medical (Better Medical)", "Hills Medical", "Alice", "Package", 32, { "2026-01": 48.0, "2026-02": 43.6, "2026-03": 47.6, "2026-04": 32.9, "2026-05": 18.1, "2026-06": 47.7 }, { status: "active" }),
  C("c47", "Duco", "Duco", "Alice", "Package", 24, { "2026-01": 16.2, "2026-02": 34.8, "2026-03": 25.6, "2026-04": 27.2, "2026-05": 3.3, "2026-06": 0.0 }, { status: "active", history: [{ from: "2026-01", agreed: 24.0 }] }),
  C("c48", "Osteria Polpo", "Osteria Polpo", "Alice", "Package", 16, null, { status: "archived", note: "Archived to match the main Clients module (not found in PG Four Lists / no ClickUp folder)." }),
  C("c49", "Sidewood", "Sidewood", "Alice", "Hourly", null, { "2026-01": 26.6, "2026-02": 32.4, "2026-03": 37.8, "2026-04": 30.0, "2026-05": 31.8, "2026-06": 30.3 }, { status: "active" }),
  C("c50", "Your Success Lab", "Your Success Lab", "Alice", "Package", 40, { "2026-01": 0, "2026-02": 0, "2026-03": 33.8, "2026-04": 61.6, "2026-05": 33.2, "2026-06": 35.1 }, { status: "active" }),

  C("c51", "Blueforce", "Blueforce", "Amanda", "Package", 40, { "2026-01": 0, "2026-02": 0, "2026-03": 6.4, "2026-04": 27.2, "2026-05": 47.2, "2026-06": 51.4 }, { status: "active" }),
  C("c53", "Filter Supplies (WA)", "Filter Supplies", "Amanda", "Package", 16, { "2026-01": 6.4, "2026-02": 9.8, "2026-03": 14.0, "2026-04": 17.8, "2026-05": 8.1, "2026-06": 15.0 }, { status: "active" }),
  C("c54", "Green Shoots", "Green Shoots", "Amanda", "Package", 16, { "2026-01": 19.2, "2026-02": 6.6, "2026-03": 13.9, "2026-04": 7.5, "2026-05": 19.3, "2026-06": 24.8 }, { status: "active" }),
  C("c55", "Majestic Plumbing", "Majestic Plumbing", "Amanda", "Package", 16, { "2026-01": 0, "2026-02": 0, "2026-03": 4.6, "2026-04": 11.7, "2026-05": 15.9, "2026-06": 32.2 }, { status: "active" }),
  C("c56", "Rent Busters WA", "Rent Busters WA", "Amanda", "Package", 8, { "2026-01": 6.1, "2026-02": 6.6, "2026-03": 6.2, "2026-04": 8.3, "2026-05": 7.0, "2026-06": 7.0 }, { status: "active" }),
  C("c57", "Zest", "Zest", "Amanda", "Package", 24, { "2026-01": 1.3, "2026-02": 36.6, "2026-03": 18.8, "2026-04": 42.7, "2026-05": 22.9, "2026-06": 1.3 }, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Appointed an in-house manager (source: Inactive Clients list, End Jun 2026)" }),

  // Long-churned clients from the PG Four Lists workbook with no lead/basis/agreed-hours
  // recorded in the source sheet -- kept as unassigned placeholders for history/lookup
  // only. They carry no lead so they are excluded from every consultant's capacity math.
  C("c58", "YSL", "YSL", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2026-06", offboardNote: "Appointed an in-house manager (source: Inactive Clients list, offboarded 26 Jun 2026). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c59", "Port Adelaide Enfield Council", "Port Adelaide Enfield Council", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2026-05", offboardNote: "Single invoice — one-off engagement (source: Inactive Clients list, offboarded 31 May 2026). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c60", "Leaker Partners", "Leaker Partners", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2026-03", offboardNote: "Single invoice — one-off engagement (source: Inactive Clients list, offboarded 23 Mar 2026). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c61", "Tyre Evolution", "Tyre Evolution", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2026-03", offboardNote: "Single invoice — one-off engagement (source: Inactive Clients list, offboarded 5 Mar 2026). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c62", "Dulux Flextool", "Dulux Flextool", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-12", offboardNote: "Single invoice — one-off engagement (source: Inactive Clients list, offboarded 31 Dec 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c63", "ONeills", "ONeills", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-12", offboardNote: "Taking work in-house (source: Inactive Clients list, offboarded 25 Dec 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c64", "Barkuma", "Barkuma", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-12", offboardNote: "'Taking work in-house?' — reason marked uncertain in source (source: Inactive Clients list, offboarded Dec 2025 (uncertain)). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c65", "ATR Guitars", "ATR Guitars", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-09", offboardNote: "Single invoice — one-off engagement (source: Inactive Clients list, offboarded 30 Sep 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c66", "Alix Doherty (Advisory/Consulting)", "Alix Doherty (Advisory/Consulting)", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-10", offboardNote: "Change in direction (source: Inactive Clients list, offboarded 25 Sep 2025-Oct 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c67", "Adelaide Direct Stationers", "Adelaide Direct Stationers", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-08", offboardNote: "Employed an in-house marketer (source: Inactive Clients list, offboarded 31 Aug 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c68", "Capital Prudential", "Capital Prudential", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-09", offboardNote: "Business model realignment to geography/direction (source: Inactive Clients list, offboarded 19 Aug 2025-Sep 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c69", "Killikanoon (Kilikanoon Wines)", "Killikanoon (Kilikanoon Wines)", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-08", offboardNote: "In-house resource returned from leave (source: Inactive Clients list, offboarded 15 Aug 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c70", "Orbis Wines", "Orbis Wines", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-08", offboardNote: "Unhappy with WordPress/ecommerce rebuild (source: Inactive Clients list, offboarded 1 Aug 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c71", "Prexus", "Prexus", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-06", offboardNote: "Client-initiated, unhappy with website management (source: Inactive Clients list, offboarded 23 Jun 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c72", "Franz Knoll / Franz Knoll Councillor", "Franz Knoll / Franz Knoll Councillor", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-08", offboardNote: "4-week project — fixed-term, not an ongoing retainer (source: Inactive Clients list, offboarded Jul-Aug 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c73", "Pursuit Allied Health", "Pursuit Allied Health", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-12", offboardNote: "No specific reason given at notice (source: Inactive Clients list, offboarded End Dec 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c74", "TradeiNet / TradieNet", "TradeiNet / TradieNet", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-12", offboardNote: "Strategy realignment for app (source: Inactive Clients list, offboarded From 25 Dec 2025 (paused)). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c75", "HSE Fit Tick", "HSE Fit Tick", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-12", offboardNote: "Moving work to the UK (source: Inactive Clients list, offboarded Sept-Dec 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
  C("c76", "Gatt Wines", "Gatt Wines", "Unassigned", "Hourly", null, null, { status: "inactive", offboardedFrom: "2025-09", offboardNote: "Reduced to ad hoc, then dropped (source: Inactive Clients list, offboarded ~Sep 2025). Added as an unassigned placeholder — the source sheet has no lead/basis/agreed-hours data for this client." }),
];

export const SEED_SUPPORT = [
  { id: "s1", from: "Vinavie", to: "Holly", type: "pct", value: 0.30 },
  { id: "s2", from: "Ariani", to: "Holly", type: "pct", value: 0.20 },
  { id: "s3", from: "Chelsea", to: "Holly", type: "pct", value: 0.35 },
  { id: "s4", from: "Ariani", to: "Shreya", type: "pct", value: 0.20 },
  { id: "s5", from: "Alex", to: "Shreya", type: "pct", value: 0.75 },
  { id: "s6", from: "Vinavie", to: "Shreya", type: "pct", value: 0.30 },
  { id: "s7", from: "Ariani", to: "Chloe", type: "pct", value: 0.10 },
  { id: "s8", from: "Alex", to: "Chloe", type: "pct", value: 0.05 },
  { id: "s9", from: "DMA (external)", to: "Alice", type: "hours", value: 23 },
  { id: "s10", from: "Chelsea", to: "Alice", type: "pct", value: 0.35 },
  { id: "s11", from: "Ariani", to: "Alice", type: "pct", value: 0.20 },
  { id: "s12", from: "Ariani", to: "Amanda", type: "pct", value: 0.20 },
  { id: "s13", from: "Chelsea", to: "Amanda", type: "pct", value: 0.30 },
  { id: "s14", from: "DMA (external)", to: "Amanda", type: "hours", value: 9 },
  { id: "s15", from: "DMA (external)", to: "Vinavie", type: "hours", value: 5 },
  { id: "s16", from: "Ariani", to: "Vinavie", type: "pct", value: 0.10 },
  { id: "s17", from: "Vino", to: "Lucy", type: "hours", value: 99 },
  { id: "s18", from: "Julia", to: "Lucy", type: "hours", value: 99 },
  { id: "s19", from: "Ariani", to: "Lucy", type: "pct", value: 0.10 },
  { id: "s20", from: "Alex", to: "Purple Giraffe (internal)", type: "pct", value: 0.20 },
];

export const OWNERS = ["Holly", "Shreya", "Chloe", "Alice", "Amanda", "Lucy", "Vinavie", "Sarah"];

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
    if (isInternalFolder(r.folder)) continue;
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
