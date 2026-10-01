// Cross-state hours: which state's team (SA/WA/QLD) logged time against which state's
// clients. Pure functions only (no React, no Supabase) so the attribution rules are
// directly testable -- see crossState.test.js. The storage side (loading/saving each
// client's state) lives in clientStatesSync.js.
import { normalizeName, findMatch, findPersonMatch, multiFolderMatchesFor, folderVariants, isInternalFolder } from "./nameMatch.js";

export const STATES = ["SA", "WA", "QLD"];
export const UNKNOWN = "Unknown";
// The "Purple Giraffe" ClickUp login is the shared account DMA (an external contractor)
// logs time under -- not any state's own team, so it gets its own row rather than being
// folded into SA or dropped (same attribution TimesheetSummary uses).
export const EXTERNAL = "External (DMA)";
export const DMA_USERNAME = "purple giraffe";

// The "Purple Giraffe" ClickUp FOLDER is PG's own work (admin, intern management, PG's own
// marketing) -- not a client, so it's left out of the cross-state grid and reported as its own
// total instead. Deliberately NOT added to nameMatch.js's isInternalFolder: other modules
// treat that folder differently, and the "Purple Giraffe" *login* (DMA) is a separate thing.
export function isOwnPgFolder(folder) {
  return normalizeName(folder) === "purple giraffe";
}

// Kelly's confirmed client-state list (Oct 2026). Each entry is a normalized phrase matched
// as whole words inside the client's normalized name, so "Filter Supplies (WA)", "Rent
// Busters WA" and "Mary Di Marco - Ray White (Qld)" all hit regardless of punctuation or
// suffixes. Every client not listed here is SA ("rest are all SA") -- including every
// Clarke Energy sub-project, Clarke Energy WA included, as Kelly confirmed. A saved state
// (set in the Clients module) always wins over this list.
const DEFAULT_STATE_PHRASES = {
  WA: [
    "filter supplies", "filter suppliers", "green shoots", "greenshoots", "rent busters", "blueforce", "blue force",
    "majestic plumbing", "commercial leak", "clt", "committee for perth", "astill", "zest",
  ],
  QLD: [
    "sgme", "di marco", "sunfresh", "brisbane alarm", "bamss", "cowie", "prison transport",
    "baintech", "barclay", "bridge to best", "by the rules", "connection central", "cra construction", "plumbaround",
  ],
};

function hasPhrase(normName, phrase) {
  return (` ${normName} `).includes(` ${phrase} `);
}

// The state a client gets when nobody has set one explicitly: Kelly's list, else SA.
export function defaultClientState(name) {
  const n = normalizeName(name);
  if (n.startsWith("clarke energy") || n.startsWith("cea ")) return "SA";
  for (const state of ["WA", "QLD"]) {
    if (DEFAULT_STATE_PHRASES[state].some((p) => hasPhrase(n, p))) return state;
  }
  return "SA";
}

// `saved`: { [clientName]: "SA" | "WA" | "QLD" } as loaded from storage. Returns where the
// answer came from too, so the UI can show which states are confirmed vs. defaulted.
export function resolveClientState(name, saved) {
  const s = saved && saved[name];
  if (s && STATES.includes(s)) return { state: s, source: "set" };
  return { state: defaultClientState(name), source: "default" };
}

// Assigns every ClickUp folder to at most ONE client, so no hour is ever counted twice.
// Order of precedence, strongest evidence first:
//   1. the client's registered ClickUp folder (any case/whitespace variant of it)
//   2. a cost-centre/sub-project/multi-folder rule (multiFolderMatchesFor)
//   3. fuzzy name match against client names (findMatch) -- marked "estimated"
// `clients`: [{ client, clickupFolder }] (pginvoice_clients via fetchClients).
// Returns Map(folder -> { client, method: "folder" | "rule" | "estimated" }).
export function assignFoldersToClients(folders, clients) {
  const out = new Map();
  const list = clients || [];
  for (const c of list) {
    if (!c.clickupFolder) continue;
    for (const f of folderVariants(c.clickupFolder, folders)) {
      if (!out.has(f)) out.set(f, { client: c.client, method: "folder" });
    }
  }
  for (const c of list) {
    const matched = multiFolderMatchesFor(c.client, folders, c.clickupFolder || undefined) || [];
    for (const f of matched) {
      if (!out.has(f)) out.set(f, { client: c.client, method: "rule" });
    }
  }
  const names = list.map((c) => c.client);
  for (const f of folders) {
    if (out.has(f)) continue;
    const m = findMatch(f, names);
    if (m) out.set(f, { client: m.name, method: "estimated" });
  }
  return out;
}

// Which team a ClickUp username belongs to. `people`: the shared roster (cap_people), each
// with a `state`. Returns { person, state } where person is the roster name (or the raw
// username when it doesn't match anyone, so their hours still show, flagged Unknown).
export function staffFor(user, people) {
  const u = String(user || "").trim();
  if (!u) return { person: "(No user)", state: UNKNOWN, matched: false };
  if (u.toLowerCase() === DMA_USERNAME) return { person: EXTERNAL, state: EXTERNAL, matched: true };
  const p = findPersonMatch(u, people || []);
  if (!p) return { person: u, state: UNKNOWN, matched: false };
  return { person: p.name, state: STATES.includes(p.state) ? p.state : UNKNOWN, matched: true };
}

// The main aggregation. `rows`: the shared ClickUp row shape (folder, task, minutes,
// billable, user, isInternal, monthKey). Options:
//   clients        pginvoice_clients list ({ client, clickupFolder })
//   people         roster with `state`
//   savedStates    { [clientName]: state }
//   billableOnly   true = only billable rows (when the data carries a billable column)
//   hasBillable    whether the dataset has a billable column at all
//   months         Set of monthKeys to include (null = all)
// Internal folders (onboarding, WIP, ...) are excluded, the same "client work" definition
// every other report uses. Returns cell totals plus the detail needed for drill-down and
// the "missing clients"/"unmatched staff" panels.
export function buildCrossStateReport(rows, opts = {}) {
  const { clients = [], people = [], savedStates = {}, billableOnly = true, hasBillable = true, months = null } = opts;
  const included = [];
  let ownPgMin = 0;
  for (const r of rows || []) {
    if (isInternalFolder(r.folder)) continue;
    if (billableOnly && hasBillable && !r.billable) continue;
    if (months && (!r.monthKey || !months.has(r.monthKey))) continue;
    if (!(r.minutes > 0)) continue;
    if (isOwnPgFolder(r.folder)) { ownPgMin += r.minutes; continue; }
    included.push(r);
  }
  const folders = [...new Set(included.map((r) => r.folder))];
  const folderClient = assignFoldersToClients(folders, clients);

  const staffCache = new Map();
  const staffOf = (u) => {
    if (!staffCache.has(u)) staffCache.set(u, staffFor(u, people));
    return staffCache.get(u);
  };

  const cells = new Map(); // `${staffState}|${clientState}` -> minutes
  const detail = new Map(); // key -> { staffState, clientState, person, client, minutes }
  const unassigned = new Map(); // folder -> minutes
  const unmatchedUsers = new Map(); // raw username -> minutes
  const estimated = new Map(); // folder -> { client, minutes }
  let totalMin = 0;

  for (const r of included) {
    const staff = staffOf(r.user);
    const fc = folderClient.get(r.folder);
    const clientName = fc ? fc.client : r.folder;
    const clientState = fc ? resolveClientState(fc.client, savedStates).state : UNKNOWN;
    const ck = `${staff.state}|${clientState}`;
    cells.set(ck, (cells.get(ck) || 0) + r.minutes);
    const dk = `${ck}|${staff.person}|${clientName}`;
    if (!detail.has(dk)) detail.set(dk, { staffState: staff.state, clientState, person: staff.person, client: clientName, minutes: 0 });
    detail.get(dk).minutes += r.minutes;
    if (!fc) unassigned.set(r.folder, (unassigned.get(r.folder) || 0) + r.minutes);
    else if (fc.method === "estimated") {
      if (!estimated.has(r.folder)) estimated.set(r.folder, { client: fc.client, minutes: 0 });
      estimated.get(r.folder).minutes += r.minutes;
    }
    if (!staff.matched) unmatchedUsers.set(staff.person, (unmatchedUsers.get(staff.person) || 0) + r.minutes);
    totalMin += r.minutes;
  }

  const hours = (min) => min / 60;
  const cellHours = (staffState, clientState) => hours(cells.get(`${staffState}|${clientState}`) || 0);
  const rowStates = [...STATES, EXTERNAL, UNKNOWN].filter((s) => STATES.includes(s) || [...cells.keys()].some((k) => k.startsWith(`${s}|`)));
  const colStates = [...STATES, UNKNOWN].filter((s) => STATES.includes(s) || [...cells.keys()].some((k) => k.endsWith(`|${s}`)));
  const sortDesc = (a, b) => b.hours - a.hours;
  return {
    rowStates,
    colStates,
    cellHours,
    totalHours: hours(totalMin),
    ownPgHours: hours(ownPgMin),
    detail: [...detail.values()].map((d) => ({ ...d, hours: hours(d.minutes) })).sort(sortDesc),
    unassignedFolders: [...unassigned.entries()].map(([folder, min]) => ({ folder, hours: hours(min) })).sort(sortDesc),
    estimatedFolders: [...estimated.entries()].map(([folder, v]) => ({ folder, client: v.client, hours: hours(v.minutes) })).sort(sortDesc),
    unmatchedUsers: [...unmatchedUsers.entries()].map(([user, min]) => ({ user, hours: hours(min) })).sort(sortDesc),
  };
}
