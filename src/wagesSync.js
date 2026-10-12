// Supabase data layer for the admin-only Wages review module. Every wage table's RLS is
// admin tier only (pg_is_admin_tier()); a non-admin simply gets no rows / a denied write.
//
// loadWagesMonth runs every source through Promise.allSettled and returns each one's
// data OR error separately -- one flaky source must not blank the page, and a failed
// source must never be passed on as empty data (that would show fabricated zeros, or
// worse, let a later save write defaults over real data). Writers always throw.
import { supabase } from "./supabaseClient.js";
import { loadKey, SEED_PEOPLE } from "./capacityData.js";
import { fetchLeaveEntries } from "./leaveSync.js";
import { functionErrorMessage } from "./clickupSync.js";
import { CAP_PEOPLE_KEY, CAP_LEAVES_KEY } from "./storageKeys.js";

const PAGE_SIZE = 1000; // PostgREST's per-request row cap

export const WAGE_SOURCES = [
  { key: "roster", label: "Consultants roster" },
  { key: "capLeaves", label: "Leave totals" },
  { key: "wagePeople", label: "Wage setup" },
  { key: "rules", label: "Hours rules" },
  { key: "settings", label: "Wage settings" },
  { key: "monthRow", label: "Month status" },
  { key: "lines", label: "Xero hours and comments" },
  { key: "leaveEntries", label: "Typed leave" },
  { key: "clickupSummary", label: "ClickUp time" },
  { key: "syncMeta", label: "ClickUp sync status" },
];
// Sources a live (draft) month can't be computed without. syncMeta is informational.
export const ESSENTIAL_LIVE_SOURCES = ["roster", "capLeaves", "wagePeople", "rules", "settings", "monthRow", "lines", "leaveEntries", "clickupSummary"];

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// The RPC is a set-returning function, so the 1000-row cap applies to it too. Ordered
// by every group-by column (unique per row) so pages never skip/duplicate.
export async function fetchClickupMonthSummary(monthKey) {
  let all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .rpc("pginvoice_clickup_month_summary", { p_month: monthKey })
      .order("user_name").order("folder").order("space_id").order("billable").order("taskless")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return all.map((r) => ({ ...r, minutes: Number(r.minutes) || 0 }));
}

const LOADERS = {
  roster: () => loadKey(CAP_PEOPLE_KEY, SEED_PEOPLE),
  capLeaves: () => loadKey(CAP_LEAVES_KEY, {}),
  wagePeople: () => rows(supabase.from("pginvoice_wage_people").select("*").order("person_id")),
  rules: () => rows(supabase.from("pginvoice_wage_rules").select("*").order("person_id").order("effective_from")),
  // A missing settings row (data null, no error) falls back to defaults in wagesView.
  settings: async () => {
    const { data, error } = await supabase.from("pginvoice_wage_settings").select("*").eq("id", 1).maybeSingle();
    if (error) throw error;
    return data;
  },
  monthRow: async (monthKey) => {
    const { data, error } = await supabase.from("pginvoice_wage_months").select("*").eq("month_key", monthKey).maybeSingle();
    if (error) throw error;
    return data; // null = never opened/closed -> draft
  },
  lines: (monthKey) => rows(supabase.from("pginvoice_wage_lines").select("*").eq("month_key", monthKey)),
  leaveEntries: (monthKey) => fetchLeaveEntries(monthKey),
  clickupSummary: (monthKey) => fetchClickupMonthSummary(monthKey),
  syncMeta: async () => {
    const { data, error } = await supabase.from("pginvoice_sync_meta").select("*").eq("id", 1).maybeSingle();
    if (error) throw error;
    return data;
  },
};

// Returns { [sourceKey]: { data, error } }. `only` (optional array of keys) reloads a
// subset, e.g. a single source's Retry or a live-refresh of leave.
export async function loadWagesMonth(monthKey, only = null) {
  const keys = only || Object.keys(LOADERS);
  const settled = await Promise.allSettled(keys.map((k) => LOADERS[k](monthKey)));
  const out = {};
  keys.forEach((k, i) => {
    const s = settled[i];
    out[k] = s.status === "fulfilled"
      ? { data: s.value, error: null }
      : { data: null, error: s.reason?.message || String(s.reason) };
  });
  return out;
}

// ---------------------------------------------------------------- writers ---------------
async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id ?? null;
}

// Update first, insert only when no row exists yet. A plain upsert would be refused on a
// closed month even for a comment: the lock trigger fires BEFORE INSERT on the proposed
// row before ON CONFLICT turns it into an update.
export async function upsertLine(monthKey, personId, patch) {
  const { data, error } = await supabase.from("pginvoice_wage_lines")
    .update(patch).eq("month_key", monthKey).eq("person_id", personId).select("*");
  if (error) throw error;
  if (data && data.length) return data[0];
  const ins = await supabase.from("pginvoice_wage_lines")
    .insert({ month_key: monthKey, person_id: personId, ...patch }).select("*").single();
  if (ins.error) throw ins.error;
  return ins.data;
}

export async function upsertPerson(row) {
  const { data, error } = await supabase.from("pginvoice_wage_people").upsert(row, { onConflict: "person_id" }).select("*").single();
  if (error) throw error;
  return data;
}

export async function upsertRule(rule) {
  const { id, ...fields } = rule;
  const q = id
    ? supabase.from("pginvoice_wage_rules").update(fields).eq("id", id)
    : supabase.from("pginvoice_wage_rules").insert(fields);
  const { data, error } = await q.select("*").single();
  if (error) throw error;
  return data;
}

export async function deleteRule(id) {
  const { error } = await supabase.from("pginvoice_wage_rules").delete().eq("id", id);
  if (error) throw error;
}

export async function saveSettings(patch) {
  const { data, error } = await supabase.from("pginvoice_wage_settings").upsert({ id: 1, ...patch }, { onConflict: "id" }).select("*").single();
  if (error) throw error;
  return data;
}

// Merges `additions` ({ normalisedName: person_id }) into the map as currently stored --
// re-read first so two admins pasting at once don't drop each other's remembered names.
export async function saveXeroNameMap(additions) {
  const { data, error } = await supabase.from("pginvoice_wage_settings").select("xero_name_map").eq("id", 1).maybeSingle();
  if (error) throw error;
  return saveSettings({ xero_name_map: { ...(data?.xero_name_map || {}), ...additions } });
}

// Freezes the month. Every person in the snapshot first gets a wage_lines row (comments
// are still editable after close, but the lock trigger refuses INSERTs on a closed
// month, so a person with no row yet couldn't be commented on otherwise).
export async function closeMonth(monthKey, snapshot) {
  const ids = (snapshot?.lines || []).map((l) => l.person_id);
  if (ids.length) {
    const { error: e1 } = await supabase.from("pginvoice_wage_lines")
      .upsert(ids.map((person_id) => ({ month_key: monthKey, person_id })), { onConflict: "month_key,person_id", ignoreDuplicates: true });
    if (e1) throw e1;
  }
  const { data, error } = await supabase.from("pginvoice_wage_months").upsert({
    month_key: monthKey, status: "closed", snapshot, closed_at: new Date().toISOString(), closed_by: await currentUserId(),
  }, { onConflict: "month_key" }).select("*").single();
  if (error) throw error;
  return data;
}

// Reopening drops the snapshot: the month goes back to live numbers, and closing again
// takes a fresh snapshot. The reason is kept on the row.
export async function reopenMonth(monthKey, reason) {
  const { data, error } = await supabase.from("pginvoice_wage_months").upsert({
    month_key: monthKey, status: "draft", snapshot: null, closed_at: null, closed_by: null, reopened_reason: reason,
  }, { onConflict: "month_key" }).select("*").single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------- ClickUp re-sync -------
// The current calendar month in Adelaide (the sync's month boundary), as "YYYY-MM".
export function adelaideMonthKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Adelaide", year: "numeric", month: "2-digit" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}`;
}
export function adelaideDayOfMonth(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Adelaide", day: "numeric" }).format(now));
}

// Months back from the current Adelaide month (0 = this month, 1 = last month).
export function monthOffsetFor(monthKey, now = new Date()) {
  const [cy, cm] = adelaideMonthKey(now).split("-").map(Number);
  const [y, m] = String(monthKey).split("-").map(Number);
  return (cy * 12 + cm) - (y * 12 + m);
}

// cron only refreshes the current and previous month; anything older must be re-synced
// on demand before its numbers reflect later ClickUp edits.
export async function resyncClickupMonth(monthKey) {
  const monthOffset = monthOffsetFor(monthKey);
  if (monthOffset < 0) throw new Error("Can't sync a future month");
  const { data, error } = await supabase.functions.invoke("clickup-sync", { body: { monthOffset } });
  if (error) throw new Error(await functionErrorMessage(error));
  return data;
}
