// pginvoice_client_directory() (supabase-migrations/20261017_scoped_modules.sql): every
// client, applied event, cost centre and ledger row Client Invoicing's pipeline reads, for a
// user whose own RLS reads cover only their own clients. Reshaped here into exactly the
// inputs the admin path builds from fetchClients / fetchClientEvents / fetchCostCentres /
// fetchAccruedForReconciliation, so invoicingPipeline.js runs over the same inputs.
//
// For a client the caller isn't assigned (`assigned: false`) the server withholds fees, event
// notes, agreed hours (sent as sign(hours): 1 / 0 / null, which keeps seeding, type guesses
// and grouping identical) and ledger balances (null). `redactedClients` lists those, so the UI
// can withhold the package figures of any card built from one (see withholdRedactedFigures).
import { supabase } from "./supabaseClient.js";
import { rowToClient } from "./clientsSync.js";
import { rowsToClients, buildReconciliationClients, ACCRUALS_LIVE_SYNC_LABEL } from "./accrualsSync.js";

// Throws the raw PostgREST error -- callers check permissions.js isMissingRpcError to tell
// "migration not applied yet" apart from a real failure.
export async function fetchClientDirectory() {
  const { data, error } = await supabase.rpc("pginvoice_client_directory");
  if (error) throw error;
  return data;
}

// Ledger columns the directory doesn't send (comments, flags, ...) -- unused by the
// reconciliation, filled so rowsToClients sees the same shape as a table read.
const LEDGER_DEFAULTS = {
  account_manager: null, accrual_note: null, pct_over_under: null, comment: null, worked_hours: null,
  is_override: false, hours_flagged: false, flagged_from_hours: null, reset_note: null,
};

// Pure: the RPC's JSON -> { pgClients, pgClientEvents, costCentres, accrued, assignedClients, redactedClients }.
// `accrued` is null when the ledger is empty (same as fetchAccruedForReconciliation).
export function directoryToInputs(dir) {
  const clients = dir?.clients || [];
  const accrualRows = (dir?.accruals || []).map((r) => ({ ...LEDGER_DEFAULTS, ...r }));
  return {
    pgClients: clients.map(rowToClient),
    pgClientEvents: dir?.events || [],
    costCentres: dir?.costCentres || [],
    accrued: accrualRows.length
      ? { ...buildReconciliationClients(rowsToClients(accrualRows)), warnings: [], fileName: ACCRUALS_LIVE_SYNC_LABEL }
      : null,
    assignedClients: new Set(clients.filter((c) => c.assigned).map((c) => c.client)),
    redactedClients: new Set(clients.filter((c) => !c.assigned).map((c) => c.client)),
  };
}
