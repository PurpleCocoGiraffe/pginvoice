// Shared roster/client/support/notes/leaves/overrides storage, backed by
// pginvoice_app_state in Supabase instead of browser localStorage — so
// Capacity Planning edits are visible to every browser/device, not just the
// one that made them. One row per key, value stored as jsonb, same shape
// each caller already worked with under localStorage.
import { supabase } from "./supabaseClient.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { isMissingRpcError } from "./permissions.js";
import { CAP_PEOPLE_KEY, CAP_LEAVES_KEY } from "./storageKeys.js";

// Callers must NOT treat a thrown error the same as "no row yet" -- a real
// query failure (network blip, RLS denial, expired session) used to be
// silently swallowed here and resolved with `fallback`, which for the seed
// keys (SEED_PEOPLE/SEED_CLIENTS/SEED_SUPPORT) meant a transient error could
// look identical to "first run, nothing saved yet". Callers then marked
// themselves loaded and their save-effects wrote that fallback straight back
// to Supabase, silently overwriting real data with the hardcoded seed. A
// missing row (`data === null`, no error) is the only case that should fall
// back quietly; a real error must propagate so the caller can refuse to
// proceed as if it had loaded successfully.
export async function loadState(key, fallback) {
  const { data, error } = await supabase
    .from("pginvoice_app_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data ? (data.value ?? fallback) : fallback;
}

// Same reasoning as loadState: a failed save must not look identical to a
// successful one. Callers should catch this and surface it -- an edit that
// silently didn't persist is worse than one that visibly failed.
export async function saveState(key, value) {
  const { error } = await supabase.from("pginvoice_app_state").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
  // Same signal idbSet/saveKey already fire for other shared datasets, so any
  // mounted module (Performance, Timesheet Summary) reacts live. Only fired
  // on a confirmed successful write -- firing it after a failed save would
  // tell other modules something changed when it didn't.
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key } }));
}

// A non-admin's own roster record and leave totals. pginvoice_app_state is admin tier only
// (20261022_capacity_admin_only.sql), so Overview "assigned", Timesheets / Wages "own" and
// scoped Client Invoicing read pginvoice_my_roster() instead: just the linked person's
// cap_people record (no rate, no note) and their own cap_leaves keys. Until that migration
// is deployed the RPC is missing -- then this falls back to the old table reads, so the
// frontend can ship first without breaking anything. Real errors throw, like loadState.
export async function loadMyRoster() {
  const { data, error } = await supabase.rpc("pginvoice_my_roster");
  if (error) {
    if (!isMissingRpcError(error)) throw error;
    const [people, leaves] = await Promise.all([loadState(CAP_PEOPLE_KEY, []), loadState(CAP_LEAVES_KEY, {})]);
    return { personId: null, people: Array.isArray(people) ? people : [], leaves: leaves && typeof leaves === "object" ? leaves : {} };
  }
  return {
    personId: data?.personId ?? null,
    people: Array.isArray(data?.people) ? data.people : [],
    leaves: data?.leaves && typeof data.leaves === "object" && !Array.isArray(data.leaves) ? data.leaves : {},
  };
}
