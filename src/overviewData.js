// Pure, testable aggregation math for the Overview landing page — no React,
// no Supabase calls in here, mirroring capacityData.js's pattern. Every
// function takes already-fetched plain data (from clientsSync.js's
// fetchClients(), accrualsSync.js's fetchAccrualsFromSupabase(), the
// cap_people roster, and ClickUp rows) and returns plain aggregates.
import { findPersonMatch } from "./nameMatch.js";
import { computeMonthlyAvailability, last6MonthKeys } from "./capacityData.js";
import { carryOutOf } from "./format.js";

/* ============================================================
   TEAM — per-consultant, per-month billable/non-billable/PG-time totals
============================================================ */

// key -> Map(monthKey -> { total, clientBillable, pgBillable, unbillable }), all in
// hours. `clickupData` is the shape fetchClickupFromSupabase()/the local IndexedDB
// blob already uses: { rows: [{ folder, monthKey, minutes, billable, user, isInternal }], hasBillable }.
// Extracted verbatim from PerformanceScorecard's old userMatch + teamMonthly memos
// (see PerformanceScorecard.jsx's teamChart, which now calls this instead of
// duplicating the same per-field summing-across-months logic inline) — an unmatched
// real ClickUp username gets its own key (raw name) rather than being silently
// folded into nothing, same "never hide real logged hours" rule the rest of the
// app follows.
export function teamMonthlyTotals(people, clickupData, monthKeys) {
  const map = new Map();
  if (!clickupData?.rows?.length) return map;
  const monthSet = new Set(monthKeys);
  const userMatch = new Map();
  const usernames = new Set();
  for (const r of clickupData.rows) if (r.user) usernames.add(r.user);
  usernames.forEach((u) => {
    // The "Purple Giraffe" ClickUp login is a shared account DMA (an external
    // contractor) logs time under — attribute it to DMA rather than dropping it.
    if (u.trim().toLowerCase() === "purple giraffe") { userMatch.set(u, "DMA (external)"); return; }
    const p = findPersonMatch(u, people);
    userMatch.set(u, p ? p.name : null);
  });
  for (const r of clickupData.rows) {
    if (!r.monthKey || !r.user || !monthSet.has(r.monthKey)) continue;
    const key = userMatch.get(r.user) || r.user;
    if (!map.has(key)) map.set(key, new Map());
    const byMonth = map.get(key);
    if (!byMonth.has(r.monthKey)) byMonth.set(r.monthKey, { total: 0, clientBillable: 0, pgBillable: 0, unbillable: 0 });
    const bucket = byMonth.get(r.monthKey);
    const hrs = r.minutes / 60;
    bucket.total += hrs;
    if (clickupData.hasBillable) {
      if (r.billable && !r.isInternal) bucket.clientBillable += hrs;
      else if (r.billable && r.isInternal) bucket.pgBillable += hrs;
      else bucket.unbillable += hrs;
    } else if (r.isInternal) bucket.pgBillable += hrs;
    else bucket.clientBillable += hrs;
  }
  return map;
}

/* ============================================================
   CLIENTS
============================================================ */

// `clients` is fetchClients()'s shape: { client, type, agreedHours, status, ... }.
// "Active" = status === "active" exactly — pginvoice_clients has THREE real status
// values (active/offboarded/archived, see the CHECK constraint), not two. This used
// to be `status !== "offboarded"`, which silently counted every archived client as
// active too (confirmed: 42 active + 26 archived = 68, the exact wrong number this
// page was showing against the Clients module's correctly-scoped 42).
// active === 0 -> overServicedPct: null (not 0) — "no active clients" is a
// different fact than "0% of clients are over-serviced", and collapsing them
// would make an empty book look like a healthy one.
export function activeClientStats(clients) {
  const list = clients || [];
  const active = list.filter((c) => c.status === "active").length;
  // Real per-month over-serviced flagging lives in accrualHealth/the accrual data
  // (this function only has the client roster, no monthly actuals) — callers that
  // want the over-serviced count should combine this with accrualHealth's output.
  return { active, overServiced: 0, overServicedPct: active === 0 ? null : 0 };
}

// fetchAccrualsFromSupabase() returns a row for every client that ever had an
// accrual entry — including offboarded/archived ones, since pginvoice_accruals
// carries no status of its own (ClientAccruals.jsx cross-references it against
// fetchClients()' status for exactly this reason, and defaults its own filter to
// "active"). Every accrual-derived Overview metric needs the same scoping, or an
// offboarded client's stale balance silently skews the whole business's numbers.
export function filterToActiveClients(accrualClients, clients) {
  if (!accrualClients) return accrualClients;
  const activeNames = new Set((clients || []).filter((c) => c.status === "active").map((c) => c.client));
  return accrualClients.filter((c) => activeNames.has(c.client));
}

// Client Invoicing's own `status === "over"` definition (App.jsx ~line 497) is
// kpiPct > 10, i.e. this month's accrual balance is more than 10% of the agreed
// monthly package hours in the client's favour of PG (over-serviced). The
// pginvoice_accruals cell already carries the equivalent figure precomputed as
// `pct` (accrualValue / agreedHours) by recomputeAccruals in accrualsSync.js, so
// `pct > 0.10` here is the same threshold, just expressed as a fraction instead
// of a percentage — generalized across the whole client base (every client with
// a current-month figure) rather than scoped to one month's Client Invoicing view.
export function overServicedFromAccruals(accrualClients, monthKey) {
  const list = accrualClients || [];
  let overServiced = 0;
  let withData = 0;
  for (const c of list) {
    const cell = c.months?.[monthKey];
    if (!cell || cell.pct === null || cell.pct === undefined) continue;
    withData++;
    if (cell.pct > 0.10) overServiced++;
  }
  return { overServiced, withData };
}

/* ============================================================
   ACCRUAL HEALTH
============================================================ */

// A client showing an accrual balance below -20 hours (they're owed more than
// 20 hours of work) counts as "meaningfully negative" — founder-confirmed value.
export const NEGATIVE_BALANCE_THRESHOLD_HRS = 20;

// `accrualClients` is fetchAccrualsFromSupabase()'s shape: [{ client, months: {
// [monthKey]: { accrualValue, ... } } }]. Uses each client's most recent month
// present in its own `months` map (clients can have different latest months if
// one's ClickUp folder stopped logging earlier than another's) rather than a
// single shared "current" month, so a client that went quiet doesn't just drop
// out of the health check.
// netHours is the literal signed sum (can be positive, negative, or near-zero)
// — deliberately NOT used to infer whether anyone is meaningfully negative,
// since a +40h client and a -40h client cancel out to ~0 net while one of them
// is very much in a bad spot. negativeCount/negativeList are computed
// independently of netHours for exactly that reason.
export function accrualHealth(accrualClients, negativeThresholdHrs = NEGATIVE_BALANCE_THRESHOLD_HRS) {
  const list = accrualClients || [];
  let netHours = 0;
  const negativeList = [];
  for (const c of list) {
    const months = Object.keys(c.months || {}).sort();
    if (!months.length) continue;
    const latestKey = months[months.length - 1];
    // Carry-out, not the raw computed figure: a month re-baselined by a macro-sheet reset
    // (see carryOutOf) hands the reset forward, so that's the client's real balance.
    const value = carryOutOf(c.months[latestKey]);
    if (value === null || value === undefined) continue;
    netHours += value;
    if (value < -negativeThresholdHrs) negativeList.push({ client: c.client, balance: value, monthKey: latestKey });
  }
  negativeList.sort((a, b) => a.balance - b.balance); // most negative first
  return { netHours, negativeCount: negativeList.length, negativeList };
}

/* ============================================================
   TEAM UTILIZATION
============================================================ */

// A consultant is at/over 100% utilization once billable hours reach their
// full available capacity for the month — founder-confirmed threshold.
export const OVER_UTILIZATION_PCT = 100;

// Derives utilization % (billable hours / available hours) per consultant from
// teamMonthlyTotals' output, using computeMonthlyAvailability (capacityData.js)
// as the availability source, for whichever single month is passed in
// (typically the latest month with data). People with no availability that
// month (e.g. resigned) or no logged hours are simply omitted — a fabricated
// 0% would misreport someone who isn't staff that month as badly under-utilized.
export function teamUtilization(people, teamMonthly, monthKey, leaveHrsByPerson = {}) {
  const perConsultant = [];
  for (const p of people || []) {
    const avail = computeMonthlyAvailability(p, monthKey, leaveHrsByPerson[p.name] || 0);
    if (!avail || !avail.totalMonthlyHours) continue;
    const byMonth = teamMonthly.get(p.name);
    const billable = (byMonth?.get(monthKey)?.clientBillable || 0) + (byMonth?.get(monthKey)?.pgBillable || 0);
    const pct = (billable / avail.totalMonthlyHours) * 100;
    perConsultant.push({ name: p.name, pct, billable, available: avail.totalMonthlyHours });
  }
  if (!perConsultant.length) return { avgPct: null, minPct: null, maxPct: null, perConsultant: [] };
  const pcts = perConsultant.map((c) => c.pct);
  const avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  return { avgPct, minPct: Math.min(...pcts), maxPct: Math.max(...pcts), perConsultant };
}

// Sorted highest utilization first — the people to look at when capacity is
// stretched thin.
export function overUtilizedConsultants(perConsultant) {
  return (perConsultant || [])
    .filter((c) => c.pct >= OVER_UTILIZATION_PCT)
    .sort((a, b) => b.pct - a.pct);
}

/* ============================================================
   SIX-MONTH TREND
============================================================ */

// last6MonthKeys() (capacityData.js) is the canonical window every module
// already uses for "trailing 6 months" — reused here rather than reinventing
// a second definition of "recent". A month with no matching data for either
// series is OMITTED from the returned arrays entirely (not zero-filled) —
// the same "don't pad to N with fabricated zeros" convention
// computeDynamicAverages/last6MonthKeys' own callers already use in
// capacityData.js, so a short data history reads as "not enough data yet"
// rather than a fake dip to zero.
export function sixMonthTrend(accrualClients, clickupRows, monthKeysOverride) {
  const monthKeys = monthKeysOverride || last6MonthKeys().slice().reverse(); // oldest -> newest
  const accruals = accrualClients || [];
  const rows = clickupRows || [];

  const months = [];
  const overServicedCounts = [];
  const totalAccruedHours = [];

  for (const mk of monthKeys) {
    let hasAny = false;
    let overServiced = 0;
    let totalAccrued = 0;
    for (const c of accruals) {
      const cell = c.months?.[mk];
      if (!cell) continue;
      if (cell.pct !== null && cell.pct !== undefined) {
        hasAny = true;
        if (cell.pct > 0.10) overServiced++;
      }
      const carry = carryOutOf(cell); // reset ?? computed balance -- see accrualHealth
      if (carry !== null) {
        hasAny = true;
        totalAccrued += carry;
      }
    }
    if (!hasAny) continue; // no data at all for this month — omit, don't zero-fill
    months.push(mk);
    overServicedCounts.push(overServiced);
    totalAccruedHours.push(Math.round(totalAccrued * 100) / 100);
  }
  return { months, overServicedCounts, totalAccruedHours };
}

/* ============================================================
   CLIENT TYPE MIX
============================================================ */

// Counts grouped by client.type (fetchClients()'s lower_snake_case vocabulary,
// see nameMatch.js's CLIENT_TYPE_LABELS). An unrecognized/unexpected type
// string is still counted (under its own raw key) rather than thrown away or
// throwing — a bad/legacy value in the data shouldn't make this card blow up
// or silently under-count the client base.
export function clientTypeMix(clients) {
  const counts = {};
  for (const c of clients || []) {
    const key = c.type || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
