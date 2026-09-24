// Shared client-name matching, used by both Client Invoicing (matching ClickUp folder
// names to the accrued sheet) and Capacity Planning (matching ClickUp folder names to
// its own client list) — kept in one place so the two never quietly drift apart.
export function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/&/g, "and").replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}
// Generic connector/corporate-suffix words carry no identifying signal on their own —
// without filtering them, two unrelated clients that both happen to be "X and Co" (e.g.
// "Wills and Co" vs "Toto and Co") share enough tokens to clear the fuzzy-match
// threshold below and get folded into each other's hours. Only strip them when doing so
// leaves at least one real token, so a name that's ALL stopwords still matches on itself.
const STOPWORDS = new Set(["and", "the", "co", "pty", "ltd", "inc", "group", "of"]);
export function tokens(s) {
  const all = normalizeName(s).split(" ").filter((t) => t.length > 1);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}
export function tokenSim(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
export function findMatch(name, candidates) {
  const norm = normalizeName(name);
  // A name that normalizes to nothing (e.g. ClickUp's literal "(No folder)" placeholder
  // for tasks not filed under any folder -- normalizeName strips parenthesized text
  // entirely, so this collapses to "") must never match anything: the substring rule
  // below treats "" as a substring of every candidate, which without this guard picks
  // whichever candidate happens to be first in the list and calls it an 85%-confidence
  // match -- silently misattributing real hours to a random, unrelated client.
  if (!norm) return null;
  for (const a of candidates) if (normalizeName(a) === norm) return { name: a, confidence: 1, method: "exact" };
  for (const a of candidates) {
    const na = normalizeName(a);
    if (na && (norm.includes(na) || na.includes(norm))) return { name: a, confidence: 0.85, method: "substring" };
  }
  let best = null;
  for (const a of candidates) {
    const sim = tokenSim(name, a);
    if (sim > (best?.confidence ?? 0)) best = { name: a, confidence: sim, method: "tokens" };
  }
  if (best && best.confidence >= 0.5) return best;
  return null;
}

// Matches a raw ClickUp username against a roster of {name, alias} people, trying
// each person's alias (a manually-set override for when ClickUp's display name
// doesn't fuzzy-match their roster name at all) alongside their name. Returns the
// owning person object, keyed back by canonical `name` regardless of which of the
// two candidates actually matched.
export function findPersonMatch(name, people) {
  const owner = new Map();
  const candidates = [];
  for (const p of people) {
    const keys = [p.name];
    if (p.alias && p.alias.trim()) keys.push(p.alias.trim());
    for (const k of keys) {
      if (!owner.has(k)) { owner.set(k, p); candidates.push(k); }
    }
  }
  const m = findMatch(name, candidates);
  return m ? (owner.get(m.name) || null) : null;
}

// Canonical client-type vocabulary — Client Invoicing's own persisted `pginvoice_clients.type`
// column. Capacity Planning and Performance track the same 7-way "basis" per client agreement
// (Package/Project/Quoted/MAP/Strategy/Hourly/Ad hoc, see FIXED_BASES/VARIABLE_BASES in
// capacityData.js); basisToClientType maps each of those 1:1 onto this vocabulary (lower-
// snake-cased) so a chip, filter, or export reads consistently everywhere, without lossily
// folding distinct business types (Strategy, Project, MAP, Ad hoc) into one another before
// they ever reach the client record.
export const CLIENT_TYPE_LABELS = {
  package: "Package",
  hourly: "Hourly",
  quoted: "Quoted",
  map: "MAP",
  project: "Project",
  strategy: "Strategy",
  ad_hoc: "Ad hoc",
  queensland: "Queensland (prv)",
};
// Short canonical name for each client type, plus "all" -- shared by Client
// Invoicing's row/drawer/export code and anywhere else that needs the same
// short phrasing (as opposed to CLIENT_TYPE_LABELS' longer filter-menu wording).
export const TYPE_LABELS_SHORT = { all: "All", ...CLIENT_TYPE_LABELS };
export const CLIENT_TYPE_TONES = {
  package: "var(--accent)",
  hourly: "var(--accent-orchid)",
  quoted: "var(--fg-tertiary)",
  map: "var(--status-warn)",
  project: "var(--fg-tertiary)",
  strategy: "var(--accent)",
  ad_hoc: "var(--accent-orchid)",
  queensland: "var(--status-info)",
};
// CLIENT_TYPE_TONES above reuses the same accent for several types (package/strategy
// both --accent, hourly/ad_hoc both --accent-orchid, etc.) -- fine for a single badge,
// unreadable once up to 8 of them are simultaneous lines on one chart (Reporting's
// per-client-type trend). This is a chart-only jewel-tone palette (see app.css's
// --chart-* tokens) with one distinct hue per type, plus its own tone for the
// aggregate "Total Agreed" line.
export const CHART_TYPE_TONES = {
  hourly: "var(--chart-hourly)", package: "var(--chart-package)", quoted: "var(--chart-quoted)",
  map: "var(--chart-map)", strategy: "var(--chart-strategy)", project: "var(--chart-project)", ad_hoc: "var(--chart-ad-hoc)",
};
export function basisToClientType(basis) {
  const b = String(basis || "").trim();
  if (b === "MAP") return "map";
  if (b === "Package") return "package";
  if (b === "Strategy") return "strategy";
  if (b === "Quoted") return "quoted";
  if (b === "Project") return "project";
  if (b === "Ad hoc") return "ad_hoc";
  if (b !== "" && b !== "Hourly") {
    console.warn(`basisToClientType: unrecognized basis "${basis}", defaulting to "hourly"`);
  }
  return "hourly"; // Hourly or unrecognised
}

// A client group's canonical type from its Capacity Planning row(s). Almost every
// group is a single row, so this is just basisToClientType(that row's basis); a
// "Combined" group (multiple sub-project rows with different bases — e.g. a
// Package plus a one-off Project) is bucketed under whichever fixed-hours type
// carries the most agreed hours, since actual hours can't be split back out
// between the sub-rows once matched to a single ClickUp folder. "Fixed" here
// mirrors capacityData.js's FIXED_BASES (Package/Project/Quoted/MAP/Strategy) vs
// VARIABLE_BASES (Hourly/Ad hoc) grouping, not just "not Hourly".
const VARIABLE_BASIS_NAMES = new Set(["Hourly", "Ad hoc"]);
export function dominantClientType(rows) {
  const types = rows.map((r) => basisToClientType(r.basis));
  const uniq = [...new Set(types)];
  if (uniq.length === 1) return uniq[0];
  const fixedRows = rows.filter((r) => !VARIABLE_BASIS_NAMES.has(String(r.basis || "").trim()));
  if (!fixedRows.length) return "hourly";
  const dominant = fixedRows.reduce((best, r) => (r.agreed || 0) > (best.agreed || 0) ? r : best, fixedRows[0]);
  return basisToClientType(dominant.basis);
}

// A handful of clients run their ClickUp work across several sibling project folders
// instead of one umbrella folder per client (e.g. Aus3C's cyber-training programs each
// get their own folder: "Aus3C Cyber Battle", "Aus3C IRAP", ...). The single-best-match
// findMatch() above only ever picks ONE folder for a client, so these clients' real hours
// were being silently undercounted everywhere actuals are computed from ClickUp data —
// Capacity Planning, Performance, and Client Accruals alike. Prefix rules (rather than a
// fixed, manually-maintained folder list) so a brand-new sub-project folder is picked up
// automatically the next time it's synced, without another code change.
// Keyed by a normalized substring that identifies the client regardless of which system's
// exact display name is passed in (SEED_CLIENTS vs pginvoice_clients spell some of these
// differently).
// `excludeFromAccrual` (optional): sub-project folders that genuinely belong to this
// client and should stay rolled up under it everywhere hours are totalled (Capacity
// Planning, Client Invoicing reconciliation), but are billed/quoted separately from the
// retainer package and must NOT count toward the package's accrual math — e.g. Majestic
// Plumbing's "Quoted Web Project" folder is client work, not retainer work; per the
// existing accrual comment on file ("web project is separate"), only accrualMatchesFor
// (used by recomputeAccruals) excludes these prefixes — multiFolderMatchesFor keeps
// including them, since that function backs the "how much did we actually work for this
// client in total" views, not the "are they over/under their package hours" one.
const MULTI_FOLDER_CLIENTS = [
  // Both "Apex Comms Website (QP)" and "Apex Comms Sales Presenter (QP)" are quoted
  // one-off projects, not part of the Apex Energy retainer -- excluded from the accrual
  // the same way Majestic Plumbing's web project is, so both show as sub-projects
  // rather than cost centres.
  { key: "apex energy", prefixes: ["apex energy", "apex comms "], exact: ["apex energy"], excludeFromAccrual: ["apex comms website", "apex comms sales presenter"] },
  { key: "aus3c", prefixes: ["aus3c "], exact: ["australian cyber collaboration centre"] },
  { key: "aus 3c", prefixes: ["aus3c "], exact: ["australian cyber collaboration centre"] },
  // BAMSS Childcare Security Services is its own registered client (with its own type
  // history and a scheduled reactivation), but its hours count toward the SAME 22 hr/month
  // package as Brisbane Alarm Monitoring (one combined retainer, confirmed by the user) --
  // included in the accrual, not excluded like a billed-separately sub-project.
  { key: "brisbane alarm monitoring", prefixes: ["brisbane alarm monitoring", "bamss"] },
  { key: "clarke energy", prefixes: ["cea "], exact: ["clarke energy"] },
  { key: "magain", prefixes: ["magain "] },
  { key: "majestic plumbing", prefixes: ["majestic plumbing", "mp "], excludeFromAccrual: ["majestic plumbing quoted web project"] },
  // "Warrina Homes - Employee Guide (Quoted Project)" used to fuzzy-match "Warrina Homes"
  // on its own (via findMatch's token-similarity fallback), showing as a second,
  // independent "Warrina Homes" row instead of nesting under the real one -- an explicit
  // rule here takes it out of that fuzzy path entirely.
  { key: "warrina homes", prefixes: ["warrina homes"], excludeFromAccrual: ["warrina homes employee guide"] },
  { key: "vegetation solutions", prefixes: ["vegetation solutions"] },
];

// User-editable cost-centre/sub-project links (Clients module -> pginvoice_cost_centres),
// keyed by EXACT client name rather than a fuzzy substring like MULTI_FOLDER_CLIENTS below --
// these are explicit, individually-added rows, so there's no ambiguity to resolve. Populated
// once via setDynamicCostCentres (called from App.jsx/Clients.jsx after fetching the table);
// every other module that imports multiFolderMatchesFor/multiFolderAccrualMatchesFor picks up
// the same data automatically since this module is a singleton, without needing its own fetch
// or becoming async. Starts empty, which is indistinguishable from "no dynamic rows for any
// client yet" -- exactly what you want before the first fetch resolves.
let DYNAMIC_COST_CENTRES = new Map(); // client name -> { folders: string[], excludeFromAccrual: string[] (real folder names, not prefixes) }

// Some clients (Aus3C first) have moved from tracking each cost centre as its own
// separate ClickUp folder to logging everything in ONE shared folder, with the cost
// centre identified by a prefix on the TASK name instead ("IRAP - ...", "Cyber Meets -
// ...", with "Corporate - ..." for the parent's own general work). None of the rest of
// this app's matching/roll-up/accrual logic knows anything about task names -- it's all
// keyed on `row.folder` -- so left alone, every one of these tasks would just collapse
// into one lump under the shared folder's own name, silently losing the exact
// cost-centre split the old separate-folder convention used to provide for free.
// Rather than teach every downstream consumer (App.jsx, capacityData.js,
// accrualsSync.js, TimesheetSummary, PerformanceScorecard, ...) a second way to think
// about client identity, splitTaskPrefixFolders below rewrites a matching row's
// `folder` to a SYNTHETIC name that reuses the exact same string the old separate-folder
// convention already used (e.g. "Aus3C IRAP") -- every existing MULTI_FOLDER_CLIENTS
// rule, cost-centre roll-up, and accrual computation then treats it exactly like a real
// folder always did, with zero changes, and a month straddling the old-to-new transition
// unifies under one identity instead of splitting into two look-alike rows.
// Map<sourceFolder, Array<{ prefix, syntheticFolder }>> -- keyed by the real, shared
// ClickUp folder the prefixed tasks actually live in, since that's the only thing a raw
// row carries to look this up by. Built from pginvoice_cost_centres rows with
// kind = 'task_prefix' (source_folder, task_prefix, folder = the synthetic name).
let TASK_PREFIX_RULES = new Map();

// `rows`: [{ client, folder, kind, source_folder, task_prefix }], kind is "cost_centre",
// "sub_project", or "task_prefix" (see pginvoice_cost_centres). Call with the full current
// table contents each time (not deltas) -- this replaces both maps, same pattern as the
// rest of the app's Supabase-backed state.
export function setDynamicCostCentres(rows) {
  const next = new Map();
  const nextTaskPrefixRules = new Map();
  for (const r of rows || []) {
    if (r.kind === "task_prefix") {
      if (!nextTaskPrefixRules.has(r.source_folder)) nextTaskPrefixRules.set(r.source_folder, []);
      nextTaskPrefixRules.get(r.source_folder).push({ prefix: r.task_prefix, syntheticFolder: r.folder, client: r.client });
      continue;
    }
    if (!next.has(r.client)) next.set(r.client, { folders: [], excludeFromAccrual: [] });
    const entry = next.get(r.client);
    entry.folders.push(r.folder);
    if (r.kind === "sub_project") entry.excludeFromAccrual.push(r.folder);
  }
  // Longest prefix first within each source folder, so a prefix that's itself a substring
  // of another registered prefix (e.g. "IR" vs "IR Masterclass") can never shadow the more
  // specific one just because it happens to be checked first.
  for (const rules of nextTaskPrefixRules.values()) rules.sort((a, b) => b.prefix.length - a.prefix.length);
  DYNAMIC_COST_CENTRES = next;
  TASK_PREFIX_RULES = nextTaskPrefixRules;
}

// A task name "belongs" to a prefix when it starts with the prefix followed by a
// separator ("-" or ":", any surrounding whitespace) -- not just any substring match,
// so a prefix like "IR" can't accidentally claim an unrelated task that merely mentions
// "IR" partway through its name.
function taskPrefixMatch(taskName, prefix) {
  const t = String(taskName || "").trimStart();
  const p = String(prefix || "");
  if (!p || t.length <= p.length) return false;
  if (t.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return false;
  const rest = t.slice(p.length);
  return /^\s*[-:]\s*\S/.test(rest);
}

// Rewrites `row.folder` to its synthetic cost-centre identity wherever a task_prefix rule
// matches, for every row whose real folder has at least one such rule registered; every
// other row (an unconfigured client, or a task with no recognized prefix -- "Corporate -
// ..." included) passes through completely untouched, keeping the real folder as that
// row's identity exactly as it always was. Returns a new array; individual row objects
// are only shallow-copied when actually rewritten, not for every row, since this runs
// over the full synced dataset (18k+ rows) on every load.
export function splitTaskPrefixFolders(rows) {
  if (!TASK_PREFIX_RULES.size) return rows;
  return rows.map((r) => {
    const rules = TASK_PREFIX_RULES.get(r.folder);
    if (!rules) return r;
    const hit = rules.find((rule) => taskPrefixMatch(r.task, rule.prefix));
    return hit ? { ...r, folder: hit.syntheticFolder } : r;
  });
}

// For the Clients module's cost-centre editor -- every task_prefix rule currently
// registered for one client, in the shape the UI wants to list/remove them by.
export function taskPrefixRulesFor(client) {
  const out = [];
  for (const [sourceFolder, rules] of TASK_PREFIX_RULES) {
    for (const rule of rules) if (rule.client === client) out.push({ sourceFolder, prefix: rule.prefix, syntheticFolder: rule.syntheticFolder });
  }
  return out;
}

// Whether `name` currently has explicit rows in the user-editable table -- a client with
// dynamic rows is fully managed through the Clients module UI (the hardcoded rule below, if
// any, is ignored for it entirely); a client still running on a hardcoded MULTI_FOLDER_CLIENTS
// rule has no dynamic rows to edit yet. The Clients module uses this to decide whether to
// offer add/remove controls or just a read-only view with a note to have it converted --
// adding even one folder for an still-hardcoded client would otherwise silently switch it to
// dynamic-only and drop every other folder the hardcoded rule was matching.
export function isDynamicCostCentreClient(name) {
  return DYNAMIC_COST_CENTRES.has(name);
}

// Returns every real ClickUp folder belonging to a multi-folder client, or null if `name`
// isn't one of them (meaning the caller should fall back to plain findMatch instead). Checks
// the user-editable dynamic table first (exact name match) -- a client with explicit rows
// there is fully managed through the Clients module UI, and the hardcoded MULTI_FOLDER_CLIENTS
// prefix rule below (if any) is ignored for it entirely, rather than the two silently
// combining into a confusing double-match.
export function multiFolderMatchesFor(name, allFolders) {
  const dynamic = DYNAMIC_COST_CENTRES.get(name);
  if (dynamic) return allFolders.filter((f) => dynamic.folders.includes(f));
  const norm = normalizeName(name);
  const rule = MULTI_FOLDER_CLIENTS.find((r) => norm.includes(r.key));
  if (!rule) return null;
  return allFolders.filter((f) => {
    const nf = normalizeName(f);
    if (rule.exact && rule.exact.includes(nf)) return true;
    return rule.prefixes.some((p) => nf.startsWith(p));
  });
}

// Same as multiFolderMatchesFor, but drops any folder marked "sub_project" in the dynamic
// table (or listed under a hardcoded rule's excludeFromAccrual prefixes) — use this
// specifically for accrual/package-hours math (recomputeAccruals), not for total-worked-hours
// views, which should keep using multiFolderMatchesFor so those sub-project folders don't
// just vanish from reporting.
export function multiFolderAccrualMatchesFor(name, allFolders) {
  const dynamic = DYNAMIC_COST_CENTRES.get(name);
  if (dynamic) return allFolders.filter((f) => dynamic.folders.includes(f) && !dynamic.excludeFromAccrual.includes(f));
  const norm = normalizeName(name);
  const rule = MULTI_FOLDER_CLIENTS.find((r) => norm.includes(r.key));
  if (!rule) return null;
  return allFolders.filter((f) => {
    const nf = normalizeName(f);
    const matched = (rule.exact && rule.exact.includes(nf)) || rule.prefixes.some((p) => nf.startsWith(p));
    if (!matched) return false;
    if (rule.excludeFromAccrual && rule.excludeFromAccrual.some((p) => nf.startsWith(p))) return false;
    return true;
  });
}

// Internal / non-revenue folders (per the billable-hours guide, §3.1): onboarding/
// offboarding/handover/WIP trackers. "Purple Giraffe" is NOT internal — it's the
// ClickUp account DMA (Digital Marketing Adelaide) logs time under, and its hours
// count like any other consultant's across all reports.
// Case-insensitive substring match — deliberately broader than the guide's literal-case
// example so folders like "Julia Onboarding & Induction" still match regardless of case.
export const INTERNAL_KEYWORDS = ["onboarding", "induction", "offboarding", "handover", "wip"];
export function isInternalFolder(folder) {
  const f = String(folder || "").toLowerCase();
  if (!f) return false;
  return INTERNAL_KEYWORDS.some((k) => f.includes(k));
}
