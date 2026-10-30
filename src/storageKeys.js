// Centralized storage-key strings — IndexedDB keys, the `key` value carried on
// PG_DATA_EVENT/cross-module change notifications, and localStorage keys (bottom section). Keeping every reader and
// writer importing from here (instead of each redeclaring its own literal) means a
// mismatched string between a writer and a reader can't silently break sync.
export const CLICKUP_DB_KEY = "clickup";
export const ACCRUED_DB_KEY = "accrued";
export const CAP_CLIENTS_KEY = "cap_clients";
export const CAP_PEOPLE_KEY = "cap_people";
export const CAP_SUPPORT_KEY = "cap_support";
export const CAP_NOTES_KEY = "cap_notes";
export const CAP_LEAVES_KEY = "cap_leaves";
export const CAP_OVERRIDES_KEY = "cap_overrides";
export const PG_CLIENTS_KEY = "pg_clients";
export const PG_COST_CENTRES_KEY = "pg_cost_centres";
export const PG_ACCRUALS_KEY = "pg_accruals";
// pginvoice_leave_entries (typed leave per person per month, see leaveSync.js). The
// per-person monthly total is still mirrored into CAP_LEAVES_KEY for Capacity Planning.
export const LEAVE_ENTRIES_KEY = "leave_entries";
// Window event a "Sync now" outside Client Invoicing fires with { live, meta } (Timesheets),
// so App.jsx -- the one writer of CLICKUP_DB_KEY -- adopts the fresh data and re-caches it
// for every other module.
export const CLICKUP_SYNCED_EVENT = "pg-clickup-synced";

// ----- localStorage keys -----
// Device prefs, kept across users (Shell.jsx).
export const THEME_KEY = "pg-theme";
export const COLLAPSE_KEY = "pg-sidebar-collapsed";
// Wages review module: filters + cards/table view, persisted per browser (localStorage).
export const WAGES_PREFS_KEY = "pg-wages-prefs";
// Client Invoicing: LEGACY per-browser manual name matches -- now shared in
// pginvoice_name_matches; App.jsx only reads this once to move it into the table (or uses it
// while the table isn't deployed), then clears it. Still in USER_DATA_LOCAL_KEYS until then.
export const NAMEMAP_KEY = "pg-name-map-v1";
// Client Invoicing's filters/search/months.
export const VIEWSTATE_KEY = "pg-view-state-v1";
// Reporting (Performance Scorecard): free-text notes about people, kept only in this browser.
export const PERF_NOTES_KEY = "perf_notes_v1";
// Supabase user id the cached data above belongs to (see cacheOwner.js). Not itself cleared.
export const CACHE_OWNER_KEY = "pg-cache-owner";
// localStorage keys holding a signed-in user's data (or filters over it), cleared when a
// different user signs in or on sign-out. Deliberately NOT listed (kept per device):
// THEME_KEY, COLLAPSE_KEY, and supabase-js's own "sb-*" auth session keys. Any new data-bearing key must be added here.
export const USER_DATA_LOCAL_KEYS = [NAMEMAP_KEY, VIEWSTATE_KEY, PERF_NOTES_KEY, WAGES_PREFS_KEY];
