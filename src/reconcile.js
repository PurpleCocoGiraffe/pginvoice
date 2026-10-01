// Pure per-client reconciliation math for Client Invoicing (App.jsx's buildClientsForMonth).
// Split out of the component closure so every package/prior/estimate/mismatch rule is
// directly testable -- most of them exist because a silent wrong-number bug shipped once
// (see reconcile.test.js). No React or Supabase imports.
import { isPackageLikeType } from "./format.js";
import { prevMonthKeyStr } from "./parsers.js";

// Below this many hours of disagreement between the ledger's recorded prior-month balance
// and what it recalculates to from current ClickUp data, treat it as rounding noise rather
// than a real edit-after-the-fact discrepancy worth flagging.
export const MISMATCH_TOLERANCE_H = 0.2;

// ---------------------------- folder-name identity ----------------------------
// ClickUp folder names drift in case and whitespace ("GPEX" vs "gpex", a trailing space) --
// keyed by the raw string, each variant became its own duplicate client row splitting the
// month's hours. Every folder lookup in Client Invoicing goes through this key instead.
export const folderKey = (s) => String(s ?? "").trim().toLowerCase();

// Picks one display name per folderKey: a `preferred` spelling when one matches (e.g. the
// Clients module's registered clickup_folder), otherwise the variant with the most minutes,
// ties going to whichever was seen first. Built over ALL rows (not one month's) so every
// month resolves a folder to the same name. `variantsOf(name)` returns every raw spelling
// seen for it, for exact-match lookups (dynamic cost-centre rows) that need the original.
export function buildFolderCanonicalizer(rows, preferred = []) {
  const byKey = new Map(); // key -> Map(rawVariant -> minutes)
  for (const r of rows || []) {
    const raw = r.folder ?? "";
    const k = folderKey(raw);
    if (!byKey.has(k)) byKey.set(k, new Map());
    const v = byKey.get(k);
    v.set(raw, (v.get(raw) || 0) + (r.minutes || 0));
  }
  const preferredByKey = new Map();
  for (const p of preferred) if (p && !preferredByKey.has(folderKey(p))) preferredByKey.set(folderKey(p), String(p).trim());
  const canonByKey = new Map();
  for (const [k, variants] of byKey) {
    let best = null, bestMin = -1;
    for (const [raw, min] of variants) if (min > bestMin) { best = raw; bestMin = min; }
    canonByKey.set(k, preferredByKey.get(k) ?? String(best).trim());
  }
  const canon = (folder) => {
    const k = folderKey(folder);
    return canonByKey.get(k) ?? preferredByKey.get(k) ?? String(folder ?? "").trim();
  };
  const variantsOf = (folder) => {
    const k = folderKey(folder);
    const out = new Set([canon(folder)]);
    for (const raw of byKey.get(k)?.keys() || []) out.add(raw);
    return [...out];
  };
  return { canon, variantsOf };
}

// ------------------------------ row aggregation ------------------------------
export const newFolderEntry = (name) => ({
  name, totalMin: 0, billableMin: 0,
  tasksAll: new Map(), userMinutes: new Map(), tasksByUser: new Map(), taskUsers: new Map(), taskIds: new Map(),
});

// One month's ClickUp rows -> Map(canonical folder name -> entry). `totalMin` and the task/
// consultant maps follow the "Billable only" toggle (what's displayed); `billableMin` never
// does -- it's what every balance/remaining/mismatch/export figure is computed from, so
// unticking the toggle can't change the accrual math. Internal folders are skipped.
export function aggregateMonthRows(rows, { monthKey, billableOnly, hasBillable, canon = (f) => f }) {
  const map = new Map();
  for (const r of rows || []) {
    const isBillable = !hasBillable || !!r.billable;
    if (billableOnly && !isBillable) continue;
    if (r.isInternal) continue;
    if (monthKey && r.monthKey && r.monthKey !== monthKey) continue;
    const folder = canon(r.folder);
    if (!map.has(folder)) map.set(folder, newFolderEntry(folder));
    const c = map.get(folder);
    c.totalMin += r.minutes;
    if (isBillable) c.billableMin += r.minutes;
    c.tasksAll.set(r.task, (c.tasksAll.get(r.task) || 0) + r.minutes);
    const u = r.user || "";
    c.userMinutes.set(u, (c.userMinutes.get(u) || 0) + r.minutes);
    if (!c.tasksByUser.has(u)) c.tasksByUser.set(u, new Map());
    const t = c.tasksByUser.get(u);
    t.set(r.task, (t.get(r.task) || 0) + r.minutes);
    // who logged time against each task, regardless of the consultant filter
    if (!c.taskUsers.has(r.task)) c.taskUsers.set(r.task, new Map());
    const tu = c.taskUsers.get(r.task);
    tu.set(u, (tu.get(u) || 0) + r.minutes);
    // Task names aren't unique -- track every distinct id seen per name; a link is only
    // shown when there's exactly one, so an ambiguous name never links to the wrong task.
    if (r.taskId) {
      if (!c.taskIds.has(r.task)) c.taskIds.set(r.task, new Set());
      c.taskIds.get(r.task).add(r.taskId);
    }
  }
  return map;
}

// Billable, non-internal minutes per folderKey for one month -- the prior-month figure the
// estimate and mismatch cross-check recompute from. Billable regardless of the toggle.
// null when the rows don't cover that month at all (nothing to check).
export function billableMinutesByFolder(rows, monthKey, hasBillable) {
  if (!monthKey) return null;
  const byFolder = new Map();
  let covered = false;
  for (const r of rows || []) {
    if (r.monthKey === monthKey) covered = true; else continue;
    if (hasBillable && !r.billable) continue;
    if (r.isInternal) continue;
    const k = folderKey(r.folder);
    byFolder.set(k, (byFolder.get(k) || 0) + r.minutes);
  }
  return covered ? byFolder : null;
}

// ------------------------------ month reconciliation ------------------------------
// One client's package/prior/estimate/mismatch figures for one month.
//
// worked        -- BILLABLE hours this month. The "Billable only" toggle is display-only;
//                  balances, exports and the mismatch check must never move with it.
// priorWorkedH  -- billable hours in priorKey, or null when the ClickUp data doesn't cover it.
// monthType/priorType, monthStatus/priorStatus -- typeForMonth/statusForMonth for a client
//                  registered in the Clients module; null = unknown (unregistered), which
//                  keeps the ledger-only behaviour.
// monthSegmentAgreed -- typeForMonth's agreedHours for the viewed month (registered clients
//                  only): used when the ledger has no row for the month yet.
// priorEnded    -- the prior month sits inside one of the client's end periods (offboarded/
//                  archived, see endPeriodsFor + monthInEndPeriods): it accrued nothing.
// allowScalarPackage -- only a manually uploaded workbook (no per-month agreed hours at all)
//                  may fall back to the client-level `package` scalar; on live data that
//                  scalar is a stale last-write-wins value (see accrualsSync.js).
export function reconcileClientMonth({
  worked, accruedClient: a, monthKey, priorKey, priorWorkedH = null,
  monthType = null, priorType = null, monthStatus = null, priorStatus = null,
  monthSegmentAgreed = null, allowScalarPackage = false, priorEnded = false,
}) {
  const monthOffPackage = monthType != null && !isPackageLikeType(monthType);
  // An ended prior month is treated like an off-package one: recomputeAccruals restarts
  // prior at (reset ?? 0) after an end period, so estimating a carry from the old package
  // invented one (Equippers: offboarded 2026-06, re-signed from 2026-08 -> "Carried in 24h").
  const priorOffPackage = priorEnded || (priorType != null && !isPackageLikeType(priorType));
  const onHold = monthStatus === "on_hold";
  const priorOnHold = priorStatus === "on_hold";

  let pkg = null;
  if (a && !monthOffPackage) {
    const monthAgreed = a.agreedByMonth?.[monthKey];
    if (monthAgreed !== undefined) pkg = monthAgreed;
    else if (allowScalarPackage && a.package != null) pkg = a.package;
    else if (monthType != null && monthSegmentAgreed != null) pkg = monthSegmentAgreed;
  }
  const hasPkg = pkg !== null && pkg > 0;

  // `balances` holds each month's carry-out (a macro-sheet reset when the month has one).
  let priorBalance = a && priorKey ? (a.balances?.[priorKey] ?? null) : null;
  const priorReset = a && priorKey ? (a.resets?.[priorKey] ?? null) : null;
  let priorRebaseline = priorReset !== null
    ? { resetValue: priorReset, computed: a.computedBalances?.[priorKey] ?? null }
    : null;
  const monthReset = a && monthKey ? (a.resets?.[monthKey] ?? null) : null;
  // undefined = no ledger row for the prior month at all; null = a row saying no package.
  const priorAgreed = a && priorKey ? a.agreedByMonth?.[priorKey] : undefined;
  const priorPkg = priorAgreed ?? pkg;
  const priorPriorBalance = a && priorKey ? (a.balances?.[prevMonthKeyStr(priorKey)] ?? 0) : 0;

  let priorBalanceEstimated = false;
  if (a && priorKey && priorOffPackage) {
    // A month off package carries nothing into the next one (same as recomputeAccruals'
    // off-package branch), except an explicit macro-sheet figure for that month.
    priorBalance = priorReset ?? 0;
  } else if (priorBalance === null && a && priorAgreed === null && hasPkg) {
    priorBalance = 0;
  } else if (priorBalance === null && a && hasPkg && priorOnHold) {
    // On hold pauses the clock: the prior month handed its own carry-in straight through.
    priorBalance = priorPriorBalance;
    priorBalanceEstimated = true;
  } else if (priorBalance === null && a && hasPkg && priorWorkedH != null) {
    priorBalance = priorWorkedH - priorPkg + priorPriorBalance;
    priorBalanceEstimated = true;
  }

  let newBalance = null, remaining = null, kpiPct = null, status = "no-pkg";
  if (hasPkg && onHold) {
    // Paused: no package consumed, the balance carries forward unchanged.
    const prior = priorBalance ?? 0;
    newBalance = prior;
    remaining = 0 - prior;
    status = "on_hold";
  } else if (hasPkg) {
    const prior = priorBalance ?? 0;
    newBalance = worked - pkg + prior;
    remaining = pkg - prior - worked;
    kpiPct = (newBalance / pkg) * 100;
    status = kpiPct > 10 ? "over" : kpiPct < -10 ? "under" : "ok";
  }

  // Cross-check the ledger's recorded prior-month balance against a recompute from current
  // ClickUp data. Not meaningful for an estimated/re-baselined prior, a prior month off
  // package, or a prior month on hold (its balance deliberately ignores its hours).
  let priorMismatch = null;
  if (!priorBalanceEstimated && !priorRebaseline && !priorOffPackage && !priorOnHold
      && priorAgreed !== null && hasPkg && priorBalance !== null && priorWorkedH != null) {
    const recomputed = priorWorkedH - priorPkg + priorPriorBalance;
    if (Math.abs(recomputed - priorBalance) > MISMATCH_TOLERANCE_H) {
      priorMismatch = { sheetValue: priorBalance, recomputed };
    }
  }

  // A month not on a package has no carry at all -- showing the old package's balance on
  // an hourly row (and summing it into the Carry KPI) was a real bug.
  if (monthOffPackage) {
    priorBalance = null;
    priorBalanceEstimated = false;
    priorMismatch = null;
    priorRebaseline = null;
  }

  return {
    pkg, priorBalance, priorBalanceEstimated, newBalance, remaining, kpiPct, status, priorMismatch,
    priorRebaseline,
    resetValue: monthReset,
    // Remaining convention (positive = hours left): the negated signed reset.
    remainingReset: monthReset !== null ? 0 - monthReset : null, // 0 - x, not -x: a reset of 0 must not become -0
    // The official closing figures every export/copy/PDF path must use.
    balanceForward: monthReset ?? newBalance,
    remainingShown: monthReset !== null ? 0 - monthReset : remaining,
  };
}

// Whether an accrued client with NO ClickUp row this month (0 hours, or only non-billable
// time) still needs a row: a package-like month always does -- the package is consumed
// (or banked) whether or not anyone logged time, so dropping it hid the client from the
// list, KPIs and both accrual exports.
// `monthSegmentAgreed` (typeForMonth's agreedHours, registered clients only) covers a month
// the ledger has no row for yet -- e.g. the current month before a recompute has run.
export function shouldSeedPackageMonth(accruedClient, monthKey, monthType = null, monthSegmentAgreed = null) {
  if (!accruedClient || !monthKey) return false;
  if (monthType != null && !isPackageLikeType(monthType)) return false;
  const agreed = accruedClient.agreedByMonth?.[monthKey];
  if (agreed === undefined && monthType != null) return monthSegmentAgreed != null && monthSegmentAgreed > 0;
  return agreed != null && agreed > 0;
}

// Whether a seeded zero-hour row would duplicate or shadow real data. Never seed when the
// ledger name is already matched by a real row, or when the client's own registered folder
// (any case/whitespace variant) or any of its cost-centre/multi-folder folders has rows this
// month -- those hours are on screen already, just matched elsewhere (an unmatched hourly
// row awaiting a manual match, or a folder claimed by another client's roll-up), and a
// phantom 0h row beside them would consume the whole package in the exports and KPIs.
// `monthFolderKeys`: folderKey of every folder with rows this month (pre-merge).
export function seedBlockedBy({ ledgerName, matchedLedgerNames, ownFolder = null, clientFolders = [], monthFolderKeys }) {
  if (matchedLedgerNames.has(ledgerName)) return true;
  if (ownFolder && monthFolderKeys.has(folderKey(ownFolder))) return true;
  return (clientFolders || []).some((f) => monthFolderKeys.has(folderKey(f)));
}

// Whether monthKey falls inside one of endPeriodsFor()'s periods ({ from, until, after }:
// ended from `from` inclusive to `until` exclusive). An undated period (from null) is
// resolved by replayClientAccruals from the client's last evidence month; here a month
// within its window counts as ended unless it has evidence of its own (`hasEvidence`: a
// ledger balance or worked hours), the same signal the replay uses.
export function monthInEndPeriods(periods, monthKey, { hasEvidence = false } = {}) {
  if (!monthKey) return false;
  return (periods || []).some((p) => {
    if (p.until != null && monthKey >= p.until) return false;
    if (p.from != null) return monthKey >= p.from;
    if (p.after != null && monthKey < p.after) return false;
    return !hasEvidence;
  });
}

// folderKeys whose hours count toward a client's package in the PRIOR month (estimate and
// mismatch cross-check). A row's own name isn't always a folder: a seeded row and a row
// renamed to its client/ledger name (ARAS, whose folder is "Aged Rights Advocacy
// Services") are keyed by the client name, so looking up c.name found 0 hours and flagged a
// false mismatch. Resolved like accrualFolderMinutesFor: the client's accrual multi-folder
// match (with its registered folder folded in, across every folder in the data, not just
// this month's), else this month's roll-up folders, else its registered folder, else c.name.
// `accrualMatchesFor` is nameMatch's multiFolderAccrualMatchesFor (injected for testing);
// `allFolders` is every raw folder name in the data.
export function priorFolderKeysFor({ name, costCentreFolders = null, clientName = null, ownFolder = null, isSubProject = false, allFolders = [], accrualMatchesFor }) {
  const keys = (list) => [...new Set(list.map(folderKey))];
  if (isSubProject) return [folderKey(name)];
  const multi = clientName && accrualMatchesFor ? accrualMatchesFor(clientName, allFolders, ownFolder || undefined) : null;
  if (multi && multi.length) return keys(multi);
  if (costCentreFolders && costCentreFolders.length) return keys(costCentreFolders);
  return [folderKey(ownFolder || name)];
}

// Carry-over KPI: absolute prior balance, only for rows that are actually package-like.
export function sumCarry(list) {
  return list.reduce((a, c) => a + (isPackageLikeType(c.type) && c.priorBalance != null ? Math.abs(c.priorBalance) : 0), 0);
}

// Rows for the "last month accrued" ready-to-merge export: package-like type AND a real package.
export function lastMonthAccruedClients(list) {
  return list.filter((c) => isPackageLikeType(c.type) && c.pkg != null && c.pkg > 0);
}

// ---------------------------------- Quoted ----------------------------------
const nextMonthKey = (key) => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
// First month typeForMonth reports a segment starting on `date` (it applies from the first
// month whose 1st is on/after the date).
const firstMonthFrom = (date) => (date.slice(8, 10) === "01" ? date.slice(0, 7) : nextMonthKey(date.slice(0, 7)));

// The quote in effect for monthKey, from typeTimelineFor's segments: { fromMonth, amount },
// or null when the client isn't Quoted that month. The quote starts where the contiguous run
// of quoted segments containing monthKey starts (fromMonth null = no known start). The amount
// is that segment's agreed hours -- except for the client's current (last) segment, where the
// live profile figure wins, since updateQuotedAmount edits it directly without an event.
export function quotedBudgetFor(timeline, monthKey, { currentAgreedHours = null } = {}) {
  if (!timeline?.length || !monthKey) return null;
  const monthStart = `${monthKey}-01`;
  let idx = 0;
  timeline.forEach((seg, i) => { if (seg.from === null || seg.from <= monthStart) idx = i; });
  if (timeline[idx].type !== "quoted") return null;
  let start = idx;
  while (start > 0 && timeline[start - 1].type === "quoted") start--;
  const from = timeline[start].from;
  const fromMonth = from ? firstMonthFrom(from) : null;
  const isCurrent = idx === timeline.length - 1;
  const amount = isCurrent ? (currentAgreedHours ?? timeline[idx].agreedHours ?? null) : (timeline[idx].agreedHours ?? null);
  return { fromMonth, amount };
}

// Sums a Map(monthKey -> minutes) over [fromMonth, toMonth] (either bound null = open).
// Minutes with no month (key "") only count when there's no lower bound.
export function sumMinutesInRange(byMonth, fromMonth, toMonth) {
  let total = 0;
  for (const [mk, min] of byMonth || []) {
    if (!mk) { if (!fromMonth) total += min; continue; }
    if (fromMonth && mk < fromMonth) continue;
    if (toMonth && mk > toMonth) continue;
    total += min;
  }
  return total;
}

// ------------------------------ copy / PDF view ------------------------------
// The client-facing copy summary and PDF always use the client's full (unfiltered by
// consultant) tasks and hours -- mixing one consultant's hours with the whole client's
// balance produced a document whose figures didn't add up.
export function unfilteredForExport(c) {
  return { ...c, tasksFiltered: c.tasksAll, workedFiltered: c.worked, taskUsersFiltered: c.taskUsers };
}
