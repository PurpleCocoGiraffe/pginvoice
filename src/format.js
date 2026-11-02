// Pure formatting/display helpers shared across App.jsx and its print template —
// extracted out of App.jsx so App.jsx isn't the sole home for logic that doesn't
// touch component state.

export const fmt = (hrs, dec = 2) =>
  Number.isFinite(hrs)
    ? (Math.round(hrs * Math.pow(10, dec)) / Math.pow(10, dec)).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : "—";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The browser's "Save as PDF" dialog suggests <title> as the default filename —
// strip characters that are illegal in filenames on Windows/macOS (some client
// names contain "/", e.g. "BAMSS / Childcare Sec Services") so that suggestion
// doesn't get silently mangled or rejected.
export const filenameSafe = (s) => String(s ?? "").replace(/[\\/:*?"<>|]/g, "-").trim();

export function timeAgo(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// "Priya" for a single contributor; "Priya (18.00h), Suba (4.00h)" when more than one logged
// time against the same task — hours already shown in the Hours column, so only spelled out
// per-person when there's more than one name to disambiguate.
export function formatTaskUsers(userMinutesMap) {
  if (!userMinutesMap || userMinutesMap.size === 0) return "—";
  const entries = [...userMinutesMap.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 1) return entries[0][0] || "—";
  return entries.map(([u, min]) => `${u || "—"} (${fmt(min / 60)}h)`).join(", ");
}

// Only ever a real link when every row logged under this task name shares the exact same
// ClickUp task id -- an ambiguous name (two different real tasks, or two task-less rows,
// that happen to share text) deliberately gets no link rather than a guess.
export function clickupTaskUrl(taskIdSet) {
  if (!taskIdSet || taskIdSet.size !== 1) return null;
  return `https://app.clickup.com/t/${[...taskIdSet][0]}`;
}

// Strategy is an ongoing engagement with agreed recurring hours -- the same fixed-hours
// accrual shape as Package (see accrualsSync.js/ClientAccruals.jsx) -- so anywhere the
// package/reconciliation UI decides "does the accrued-balance math apply", Strategy is
// treated identically to Package.
export const isPackageLikeType = (t) => t === "package" || t === "strategy";

// The balance a month actually hands forward to the next one. A month can carry a one-off
// "reset" (pginvoice_accruals.reset_value -- e.g. the legacy macro sheet's authoritative
// August 2026 closing figure) that replaces our own computed balance as the carry-in for
// the following month, while the computed accrual_value itself stays untouched for display.
// Same sign convention as accrual_value (negative = hours owed to the client). A reset of 0
// is a real figure, hence `??` and never `||`. Lives here (not accrualsSync.js) because
// overviewData.js is deliberately free of any Supabase import.
export const carryOutOf = (cell) => (cell ? (cell.resetValue ?? cell.accrualValue ?? null) : null);

// ------------------------- package -> hourly settlement -------------------------
// A client moving off a package onto hourly settles its package balance on its hourly
// invoices instead of losing it (the old behaviour dropped it to 0):
//   - balance > 0 (over-used, they owe us): added in full to the first hourly invoice;
//   - balance < 0 (unused hours, we owe them): deducted from the hourly hours, and any part
//     the month's hours can't cover carries to the next hourly month until used up.
// Only from HOURLY_SETTLEMENT_FROM onwards (agreed Nov 2026: earlier transitions stay as
// they were). First use: Treasure Boxes, -1.70 h from Sep 2026 into its Oct 2026 invoice.
// The ledger records each settled month as a row with HOURLY_SETTLEMENT_NOTE (agreed null,
// accrual_value = what's still owed), written by replayClientAccruals; Client Accruals reads
// the same carry-ins back (hourlySettlementCarryIn in reconcile.js).
export const HOURLY_SETTLEMENT_FROM = "2026-10";
export const HOURLY_SETTLEMENT_NOTE = "Hourly: package balance settled on invoice";

// prior: the signed balance carried in (same sign as accrual_value); worked: this month's
// billable hours. hoursToInvoice = worked + applied; remaining carries to the next month.
export function settleHourly(prior, worked) {
  const p = Number(prior) || 0;
  const w = Math.max(0, Number(worked) || 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  if (p > 0) return { prior: r2(p), applied: r2(p), hoursToInvoice: r2(w + p), remaining: 0 };
  if (p < 0) {
    const used = Math.min(w, -p);
    return { prior: r2(p), applied: r2(-used), hoursToInvoice: r2(w - used), remaining: r2(p + used) };
  }
  return { prior: 0, applied: 0, hoursToInvoice: r2(w), remaining: 0 };
}
