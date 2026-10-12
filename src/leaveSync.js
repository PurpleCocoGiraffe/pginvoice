// Typed leave entries (pginvoice_leave_entries): several rows per person per month,
// each with a leave type and hours (days kept as entered, display only). RLS limits the
// table to the admin tier -- a non-admin's select simply returns no rows.
//
// The per-person monthly TOTAL still lives in pginvoice_app_state's cap_leaves (the
// number Capacity Planning reads). TeamDashboard recomputes that total from the typed
// entries after every add/update/delete; nothing here writes cap_leaves itself.
//
// Errors always throw -- a failed fetch must never look like "no typed entries",
// or a caller could treat a real cap_leaves total as untyped/zero and write over it.
import { supabase } from "./supabaseClient.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { LEAVE_ENTRIES_KEY } from "./storageKeys.js";
import { round2, STANDARD_DAY_HOURS } from "./wagesCalc.js";

export const LEAVE_TYPES = [
  { key: "annual", label: "Annual leave" },
  { key: "personal", label: "Sick / Personal" },
  { key: "lwop", label: "Leave without pay" },
  { key: "unspecified", label: "Untyped (legacy)" },
];
// 'unspecified' is display-only: never offered when creating a new entry.
export const SELECTABLE_LEAVE_TYPES = LEAVE_TYPES.filter((t) => t.key !== "unspecified");
export const leaveTypeLabel = (key) => (LEAVE_TYPES.find((t) => t.key === key) || { label: key }).label;

const TABLE = "pginvoice_leave_entries";
const COLUMNS = "id, person_id, month_key, leave_type, hours, days, note, created_at, updated_at";

// numeric columns come back from PostgREST as numbers or strings depending on precision;
// normalise so callers can add them safely. days stays null when not entered.
function normalize(row) {
  return {
    ...row,
    hours: Number(row.hours ?? 0),
    days: row.days == null ? null : Number(row.days),
  };
}

// hours/days are numeric(6,2): writes round with round2 (wagesCalc.js) before sending so
// the stored value matches what we total locally.

export function notifyLeaveEntriesChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key: LEAVE_ENTRIES_KEY } }));
}

export async function fetchLeaveEntries(monthKey) {
  const { data, error } = await supabase.from(TABLE).select(COLUMNS).eq("month_key", monthKey).order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(normalize);
}

export async function addLeaveEntry({ person_id, month_key, leave_type, hours, days = null, note = null }) {
  const { data, error } = await supabase.from(TABLE).insert({
    person_id, month_key, leave_type,
    hours: round2(hours ?? 0),
    days: days == null ? null : round2(days),
    note,
  }).select(COLUMNS).single();
  if (error) throw error;
  return normalize(data);
}

export async function updateLeaveEntry(id, patch) {
  const clean = { ...patch, updated_at: new Date().toISOString() };
  if ("hours" in clean) clean.hours = round2(clean.hours ?? 0);
  if ("days" in clean) clean.days = clean.days == null ? null : round2(clean.days);
  const { data, error } = await supabase.from(TABLE).update(clean).eq("id", id).select(COLUMNS).single();
  if (error) throw error;
  return normalize(data);
}

export async function deleteLeaveEntry(id) {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

/* ---------- pure helpers (tested in leaveSync.test.js) ---------- */

export function entriesForPerson(entries, personId, monthKey) {
  return (entries || []).filter((e) => e.person_id === personId && e.month_key === monthKey);
}

export function totalLeaveHours(entries) {
  return round2((entries || []).reduce((sum, e) => sum + Number(e.hours ?? 0), 0));
}

// The rows the leave popover shows for one person+month. Typed entries win whenever any
// exist. With none, a non-zero cap_leaves total (entered before leave types existed) is
// shown as a single synthetic "legacy" row -- it is never converted into a type
// automatically; the user must pick one, which inserts a real entry for those hours.
export function deriveLeaveRows(personEntries, legacyTotalHours) {
  if (personEntries && personEntries.length) return personEntries.map((e) => ({ ...e, legacy: false }));
  const legacy = Number(legacyTotalHours ?? 0);
  if (legacy > 0) return [{ id: null, legacy: true, leave_type: "unspecified", hours: legacy, days: null }];
  return [];
}

const FULL_TIME_WEEKLY_HOURS = 38;
// Length of one day off in hours for the leave editor's Days field, or 0 when days can't
// be converted (the field is disabled and hours must be entered). Only full-time (38 h a
// week) staff have a fixed day (7.6 h); a part-timer's or casual's working days vary in
// length, so contracted/5 would misstate their leave.
export function leaveDayHours(person) {
  return Number(person?.contracted) === FULL_TIME_WEEKLY_HOURS ? STANDARD_DAY_HOURS : 0;
}
