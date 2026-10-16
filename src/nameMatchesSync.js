// Client Invoicing's manual "Match to accrued client…" overrides, shared by everyone in
// pginvoice_name_matches (supabase-migrations/20261017_scoped_modules.sql): ClickUp folder
// name -> accrued (ledger) client name. Readable by anyone with Invoicing access (a scoped
// user's pipeline needs every row to match the admin's), writable by the admin tier only.
// They used to live in each admin's browser localStorage (NAMEMAP_KEY); legacyMatchesToMigrate
// moves a leftover local map up once without ever overriding a row already in the table.
import { supabase } from "./supabaseClient.js";
import { folderKey } from "./reconcile.js";

// The value the drawer's select sends for "clear" -- never stored.
export const CLEAR_MATCH = "__none__";

// { [clickupFolder]: accruedName }. Throws the raw error (see isMissingTableError for the
// "migration not applied yet" case).
export async function fetchNameMatches() {
  const { data, error } = await supabase.from("pginvoice_name_matches").select("clickup_folder, accrued_name");
  if (error) throw error;
  return rowsToNameMap(data);
}

export async function upsertNameMatch(clickupFolder, accruedName) {
  const { error } = await supabase.from("pginvoice_name_matches")
    .upsert({ clickup_folder: clickupFolder, accrued_name: accruedName }, { onConflict: "clickup_folder" });
  if (error) throw error;
}

export async function deleteNameMatch(clickupFolder) {
  const { error } = await supabase.from("pginvoice_name_matches").delete().eq("clickup_folder", clickupFolder);
  if (error) throw error;
}

// Inserts only rows whose folder isn't in the table yet (ON CONFLICT DO NOTHING): a stale
// local copy must never override a shared row.
export async function insertMissingNameMatches(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("pginvoice_name_matches")
    .upsert(rows, { onConflict: "clickup_folder", ignoreDuplicates: true });
  if (error) throw error;
}

// ---------------------------------------------------------------- pure helpers ----------
// True when the table isn't deployed yet (frontend ahead of the migration): PostgREST's
// schema-cache miss (PGRST205) or Postgres undefined_table (42P01).
export function isMissingTableError(error) {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  return /could not find the table|relation .* does not exist/i.test(error.message || "");
}

// The loaded table map with any not-yet-written local edits laid over it (an edit made
// while the first load was in flight must not be visually undone by that load).
export function withPendingMatches(dbMap, pending) {
  let map = dbMap;
  for (const [folder, value] of pending || []) map = applyNameMatch(map, folder, value);
  return map;
}

const isRealName = (v) => typeof v === "string" && v.trim() !== "" && v !== CLEAR_MATCH;

export function rowsToNameMap(rows) {
  const map = {};
  for (const r of rows || []) if (r?.clickup_folder && isRealName(r.accrued_name)) map[r.clickup_folder] = r.accrued_name;
  return map;
}

// The legacy localStorage value -> a plain { folder: accruedName } map; anything unreadable
// or not an object is treated as empty (it's only ever a one-off migration source).
export function parseLegacyNameMap(raw) {
  if (!raw) return {};
  let v;
  try { v = JSON.parse(raw); } catch (e) { return {}; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [k, name] of Object.entries(v)) if (String(k).trim() && isRealName(name)) out[k] = name;
  return out;
}

// Rows to insert from a legacy local map: only folders the table has no row for. The
// pipeline looks overrides up by exact name OR folderKey (trimmed, case-insensitive), so a
// legacy "foo " is skipped when the table already has "Foo" -- otherwise the two would
// compete for the same folder and the local copy could win.
export function legacyMatchesToMigrate(legacyMap, dbMap) {
  const taken = new Set(Object.keys(dbMap || {}).map(folderKey));
  const rows = [];
  for (const [folder, accruedName] of Object.entries(legacyMap || {})) {
    if (!String(folder).trim() || !isRealName(accruedName)) continue;
    const k = folderKey(folder);
    if (taken.has(k)) continue;
    taken.add(k);
    rows.push({ clickup_folder: folder, accrued_name: accruedName });
  }
  return rows;
}

// The map after one edit: a real name sets the override, CLEAR_MATCH removes it.
export function applyNameMatch(map, clickupFolder, accruedName) {
  const next = { ...map };
  if (isRealName(accruedName)) next[clickupFolder] = accruedName;
  else delete next[clickupFolder];
  return next;
}
