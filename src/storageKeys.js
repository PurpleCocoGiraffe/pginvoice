// Centralized storage-key strings — used both as IndexedDB keys and as the `key` value
// carried on PG_DATA_EVENT/cross-module change notifications. Keeping every reader and
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
