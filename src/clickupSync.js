// Bridges the pginvoice_clickup_entries table (kept fresh by the clickup-sync
// Edge Function on a cron schedule) into the exact shape App.jsx has always
// produced from a manual CSV upload — so every downstream module (Capacity
// Planning, Performance, Timesheet Summary) needs zero changes; they already
// just read `clickup.rows` regardless of where it came from.
import { supabase } from "./supabaseClient.js";
import { splitTaskPrefixFolders } from "./nameMatch.js";

const PAGE_SIZE = 1000; // PostgREST's default row cap per request — paginate past it

// Stamped onto every live-sync payload's `fileName` -- a manual CSV upload's
// fileName is always a real filename, which never matches this literal, so
// callers can tell the two apart after a value has round-tripped through
// IndexedDB (which caches both kinds of clickup data identically).
export const LIVE_SYNC_LABEL = "Live sync from ClickUp";

// `sinceMonthKey` (optional, "YYYY-MM") restricts the fetch to that month onward --
// callers that only need a trailing window (e.g. Overview's 6-month rollup) should
// always pass this, since the full table is 47k+ rows spanning 15+ months and
// paginating through all of it (at 1000 rows/request, sequentially) is the single
// biggest cost in loading anything that reads this. Callers that genuinely need
// full history (Client Invoicing's month picker, recomputeAccruals) omit it.
export async function fetchClickupFromSupabase(sinceMonthKey) {
  let all = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from("pginvoice_clickup_entries")
      .select("folder, task, task_id, minutes, billable, has_billable_col, user_name, is_internal, month_key, month_label, date_key")
      .order("entry_start", { ascending: true });
    if (sinceMonthKey) q = q.gte("month_key", sinceMonthKey);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  if (!all.length) return null;

  const rawRows = all.map((r) => ({
    folder: r.folder,
    task: r.task,
    // Real ClickUp task id, when this entry was linked to an actual task -- lets the UI
    // deep-link straight to https://app.clickup.com/t/{taskId}. Absent for entries tracked
    // with no task selected in ClickUp (see clickup-sync's resolveTaskId for details).
    taskId: r.task_id || null,
    minutes: Number(r.minutes) || 0,
    billable: !!r.billable,
    hasBillableCol: !!r.has_billable_col,
    user: r.user_name || "",
    isInternal: !!r.is_internal,
    monthKey: r.month_key || null,
    monthLabel: r.month_label || null,
    dateKey: r.date_key || null,
  }));
  // Rewrites a task-prefix-split client's rows (see nameMatch.js) from their real,
  // shared ClickUp folder to the synthetic per-cost-centre identity a task's name
  // prefix maps to -- everything downstream keys off `row.folder`, so this is the one
  // place that needs to know the difference between the two tracking conventions.
  const rows = splitTaskPrefixFolders(rawRows);
  return {
    rows,
    hasBillable: rows.some((r) => r.hasBillableCol),
    hasUser: rows.some((r) => r.user),
    hasStartDate: rows.some((r) => r.dateKey),
    warnings: [],
    fileName: LIVE_SYNC_LABEL,
  };
}

export async function fetchSyncMeta() {
  const { data, error } = await supabase.from("pginvoice_sync_meta").select("*").eq("id", 1).maybeSingle();
  if (error) return null;
  return data;
}

// Calls the Edge Function directly rather than waiting for the next cron
// tick — used by the "Sync now" button for an on-demand refresh.
//
// Also reconciles last month (monthOffset: 1), not just the current one.
// The Edge Function's stale-row cleanup only deletes rows whose entry_start
// falls inside the month it just fetched, so a month that's never re-synced
// never gets its deletions/edits reconciled again — an entry logged (and
// later removed in ClickUp) right before a month boundary would linger in
// Supabase forever once the calendar rolled over, even after clicking
// "Sync now" repeatedly. Two months is cheap (well under the Edge
// Function's per-invocation budget — see clickup-sync/index.ts) and covers
// the realistic case of edits made just after month-end.
export async function triggerManualSync() {
  const { data, error } = await supabase.functions.invoke("clickup-sync", { body: {} });
  if (error) throw error;
  const { data: lastMonthData, error: lastMonthError } = await supabase.functions.invoke("clickup-sync", { body: { monthOffset: 1 } });
  if (lastMonthError) throw lastMonthError;
  return { current: data, lastMonth: lastMonthData };
}

// Settings' ClickUp connection card — status check never sees the raw token
// (it's stored service-role-only in pginvoice_secrets), just whether one is
// saved and what workspace it validated against.
export async function fetchClickupKeyStatus() {
  const { data, error } = await supabase.functions.invoke("clickup-key", { body: { action: "status" } });
  if (error) throw error;
  return data;
}

// Validates the key against ClickUp's own API before saving it — a bad key
// never gets persisted, so clickup-sync can't silently start failing on it.
export async function saveClickupApiKey(token) {
  const { data, error } = await supabase.functions.invoke("clickup-key", { body: { action: "set", token } });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "Couldn't validate that ClickUp API key.");
  return data;
}
