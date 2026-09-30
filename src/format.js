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
