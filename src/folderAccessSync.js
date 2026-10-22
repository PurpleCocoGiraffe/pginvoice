// pginvoice_folder_clients (20261022_entries_own_clients.sql): admin-written folder -> client
// map that decides which time entries a non-admin may read. See folderAccess.js for how the
// pairs are derived.
import { supabase } from "./supabaseClient.js";
import { isMissingTableError } from "./nameMatchesSync.js";

// Adds the pairs the table doesn't have yet; never deletes. A stale pair only keeps a folder
// readable to that client's people a little longer, whereas deleting from a partial or
// mid-edit computation would hide real time from them. Returns { added } or { unavailable }
// while the migration isn't deployed. Admin tier only (RLS); real errors throw.
export async function syncFolderClients(pairs) {
  const { data, error } = await supabase.from("pginvoice_folder_clients").select("folder_key, client");
  if (error) {
    if (isMissingTableError(error)) return { unavailable: true };
    throw error;
  }
  const have = new Set((data || []).map((r) => `${r.folder_key}\u0000${r.client}`));
  const missing = (pairs || []).filter((p) => !have.has(`${p.folderKey}\u0000${p.client}`))
    .map((p) => ({ folder_key: p.folderKey, folder: p.folder, client: p.client }));
  for (let i = 0; i < missing.length; i += 200) {
    const { error: insErr } = await supabase.from("pginvoice_folder_clients")
      .upsert(missing.slice(i, i + 200), { onConflict: "folder_key,client", ignoreDuplicates: true });
    if (insErr) throw insErr;
  }
  return { added: missing.length };
}

// Month keys the ClickUp sync holds data for (pginvoice_clickup_months), or null when the RPC
// isn't deployed yet or fails -- the pipeline then falls back to "a month with rows".
export async function fetchClickupMonths() {
  const { data, error } = await supabase.rpc("pginvoice_clickup_months");
  if (error) {
    console.error("Couldn't load ClickUp months:", error);
    return null;
  }
  return Array.isArray(data) ? data : null;
}
