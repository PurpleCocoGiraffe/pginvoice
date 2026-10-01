// Each client's office state (SA/WA/QLD), stored in the shared pginvoice_app_state table
// (same table capacityStore.js uses) as ONE row per client -- key "client_state:<name>" --
// rather than a single map under one key, so two people setting different clients' states
// at the same time can't overwrite each other's edit with a stale copy of the whole map.
// A client with no row falls back to defaultClientState() in crossState.js.
import { supabase } from "./supabaseClient.js";
import { PG_DATA_EVENT } from "./idbStore.js";
import { CLIENT_STATES_KEY } from "./storageKeys.js";
import { STATES } from "./crossState.js";

const PREFIX = "client_state:";

// Same error rule as capacityStore.loadState: a real query error must throw, never quietly
// look like "nothing saved yet".
export async function fetchClientStates() {
  const out = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("pginvoice_app_state")
      .select("key, value")
      .like("key", `${PREFIX}%`)
      .order("key", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data || []) {
      const state = r.value && r.value.state;
      if (STATES.includes(state)) out[r.key.slice(PREFIX.length)] = state;
    }
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export async function saveClientState(client, state) {
  if (!STATES.includes(state)) throw new Error(`Unknown state "${state}".`);
  const { data: userData } = await supabase.auth.getUser();
  const { error } = await supabase.from("pginvoice_app_state").upsert(
    { key: `${PREFIX}${client}`, value: { state, by: userData?.user?.email || null }, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) throw error;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key: CLIENT_STATES_KEY } }));
}
