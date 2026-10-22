// Which client each real ClickUp folder's time belongs to, as Client Invoicing itself
// attributes it -- the source of pginvoice_folder_clients, which decides what time entries a
// non-admin may read (20261022_entries_own_clients.sql: their own rows, plus rows in folders
// mapped to a client they have access to).
//
// Built from the pipeline's own cards rather than a second matcher, so the mapping can't
// drift from how hours are attributed: every folder behind a card (searchFolders: its
// folder, its client's registered folder, cost-centre / roll-up line items) maps to the
// card's Clients-module client (profileClient). Cards are per month, so every month with
// data is walked -- a folder last used in March still maps. Task-prefix synthetic folders
// ("Aus3C IRAP") also map their real source folder, the only name the table stores.
import { buildClientsForMonth } from "./invoicingPipeline.js";
import { folderKey } from "./reconcile.js";
import { taskPrefixSourceFolder } from "./nameMatch.js";

// [{ folderKey, folder, client }], one per distinct (folderKey, client) pair.
export function folderClientPairs(cards, sourceFolderOf = taskPrefixSourceFolder) {
  const out = new Map();
  for (const c of cards || []) {
    const client = c?.profileClient;
    if (!client) continue;
    for (const f of c.searchFolders || []) {
      for (const folder of [f, sourceFolderOf(f)]) {
        const key = folderKey(folder);
        if (!key) continue;
        out.set(`${key}\u0000${client}`, { folderKey: key, folder: String(folder).trim(), client });
      }
    }
  }
  return [...out.values()];
}

const priorMonth = (mk) => {
  const [y, m] = mk.split("-").map(Number);
  const t = y * 12 + (m - 1) - 1;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

// Union of folderClientPairs over every month that has ClickUp rows.
export function folderClientPairsAllMonths(ctx, opts) {
  const months = [...new Set((ctx?.clickup?.rows || []).map((r) => r.monthKey).filter(Boolean))].sort();
  const out = new Map();
  for (const mk of months) {
    for (const p of folderClientPairs(buildClientsForMonth(ctx, mk, priorMonth(mk), opts))) {
      out.set(`${p.folderKey}\u0000${p.client}`, p);
    }
  }
  return [...out.values()];
}
