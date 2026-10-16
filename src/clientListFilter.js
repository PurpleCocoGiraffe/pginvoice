import { isPackageLikeType } from "./format.js";
import { ownNameSet, isOwnName } from "./ownTime.js";

// Groups a client list by capGroup and, for any group with 2+ members, picks one "primary"
// so the others can nest under it instead of showing as separate top-level cards. Pure so
// the current month's list and the prior month's run through the same rule.
//
// A row tagged as another client's sub-project (costCentreParentAccName) is never eligible:
// filterClientList hides it as a top-level row regardless, so making it the group's primary
// also hid every other member as a "non-primary" -- both rows vanished (Sep 2026: ARAS's
// 11 h Website Optimisation Project out-worked ARAS's own 0.08 h; Majestic Plumbing's
// Quoted Web Project, mistyped package, was found first by the package-like check).
// Among the rest: a package-like row (the ongoing relationship), then the registered client
// / ledger owner, then whoever logged the most hours.
export function computePrimaryNameByGroup(clientList) {
  const byGroup = new Map();
  clientList.forEach((c) => { if (!c.capGroup) return; if (!byGroup.has(c.capGroup)) byGroup.set(c.capGroup, []); byGroup.get(c.capGroup).push(c); });
  const result = new Map();
  byGroup.forEach((members, group) => {
    if (members.length < 2) return;
    const eligible = members.filter((m) => !m.costCentreParentAccName);
    // Every member is someone's sub-project: each renders under its own parent instead.
    if (!eligible.length) return;
    const isOwner = (m) => !!(m.costCentreAccruedName || m.accruedClient || m.registered);
    const primary = eligible.find((m) => isPackageLikeType(m.type))
      || eligible.find(isOwner)
      || [...eligible].sort((a, b) => b.worked - a.worked)[0];
    result.set(group, primary.name);
  });
  return result;
}

// Shared type/consultant/search filter + primary-group suppression for Client Invoicing's
// client list (everything App.jsx's `visible` list needs except the final sort). Used for
// both the current month's `visible` list and the prior month's `prevStats` comparison list,
// so "what's currently in view" can't silently diverge between the two. Pure (no React/
// Supabase imports) so it's directly testable.
// `workedOnly` (the "Worked only" toggle) drops rows with no hours this month -- the selected
// consultant's hours when one is picked, otherwise everyone's. Like the consultant filter, a
// parent stays in view when anything nested under it has hours, since nested rows only ever
// render inside their parent's tile (App.jsx hides the zero-hour nested rows themselves).
export function hasWorkedHours(c, consultantFilter) {
  return consultantFilter ? (c.userMinutes?.get(consultantFilter) || 0) > 0 : (c.worked || 0) > 0;
}

export function filterClientList(list, { clientTypeFilter, consultantFilter, search, primaryNameByGroup, workedOnly = false }) {
  // A nested row is only hidden when the row it nests under actually exists in the full
  // list -- otherwise it was hidden as a child of nothing (e.g. a sub-project whose hourly
  // parent logged no time this month and so has no row at all).
  const presentNames = new Set(list.map((c) => c.name));
  const nestedUnderPresent = (c) => {
    if (c.costCentreParentAccName && presentNames.has(c.costCentreParentAccName)) return true;
    if (!c.capGroup) return false;
    const primaryName = primaryNameByGroup.get(c.capGroup);
    return !!primaryName && primaryName !== c.name && presentNames.has(primaryName);
  };
  let out = clientTypeFilter === "all" ? list.slice()
    // The MAP bucket: a month typed "map" in the Clients module, or a client Capacity
    // Planning flags as on a MAP while it keeps its own type (the isMap overlay).
    : clientTypeFilter === "map" ? list.filter((c) => c.isMap || c.type === "map")
    : list.filter((c) => c.type === clientTypeFilter);
  if (consultantFilter) {
    // A sub-project/sibling row is only ever shown nested under its parent (the
    // filter below), so a parent must stay in view when the consultant worked on
    // anything nested under it -- not just on the parent's own folder. Checking the
    // parent alone hid e.g. someone's billable Apex Comms Website (QP) hours whenever
    // they had no billable time on Apex Energy itself that month. Nested rows are found
    // in the FULL list (not the type-filtered one), same as App.jsx's sibling lookup.
    const worked = (c) => c.userMinutes.has(consultantFilter);
    const parentsWithNestedWork = parentsWithNested(list, worked, primaryNameByGroup);
    out = out.filter((c) => worked(c) || parentsWithNestedWork.has(c.name));
  }
  if (workedOnly) {
    const worked = (c) => hasWorkedHours(c, consultantFilter);
    const parentsWithNestedWork = parentsWithNested(list, worked, primaryNameByGroup);
    out = out.filter((c) => worked(c) || parentsWithNestedWork.has(c.name));
  }
  // A non-primary capGroup member, or a folder explicitly tagged as another cost-centre
  // client's sub-project (see costCentreParentAccName in buildClientsForMonth), is shown
  // nested under that parent's tile, never again as its own top-level card -- the first
  // driven by Capacity Planning's grouping, the second by nameMatch.js's rules.
  out = out.filter((c) => !nestedUnderPresent(c));
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    // A row nested under each parent (same two rules as nestedUnderPresent), so searching for
    // a sub-project's name finds the tile it's rendered in.
    const nestedByParent = new Map();
    for (const c of list) {
      if (!nestedUnderPresent(c)) continue;
      const parent = c.costCentreParentAccName && presentNames.has(c.costCentreParentAccName)
        ? c.costCentreParentAccName : primaryNameByGroup.get(c.capGroup);
      if (!nestedByParent.has(parent)) nestedByParent.set(parent, []);
      nestedByParent.get(parent).push(c);
    }
    out = out.filter((c) => matchesSearch(c, q) || (nestedByParent.get(c.name) || []).some((s) => matchesSearch(s, q)));
  }
  return out;
}

// Names of every parent row that has at least one row nested under it passing `test`
// (searched in the FULL list, not the type-filtered one, same as App.jsx's sibling lookup).
function parentsWithNested(list, test, primaryNameByGroup) {
  const parents = new Set();
  for (const c of list) {
    if (!test(c)) continue;
    if (c.costCentreParentAccName) parents.add(c.costCentreParentAccName);
    if (c.capGroup) {
      const primaryName = primaryNameByGroup.get(c.capGroup);
      if (primaryName && primaryName !== c.name) parents.add(primaryName);
    }
  }
  return parents;
}

// Free-text match against everything a user might know a client by: its row name, display
// name, and every ClickUp folder behind it (`searchFolders`, set in buildClientsForMonth --
// e.g. ARAS's folder "Aged Rights Advocacy Services", or a roll-up's cost-centre folders).
// `q` is already trimmed and lower-cased.
export function matchesSearch(c, q) {
  const has = (s) => String(s || "").toLowerCase().includes(q);
  return has(c.name) || has(c.displayName) || (c.searchFolders || []).some(has);
}

// Search matches the type filter is hiding: the same list filtered with every type ("all"),
// minus what's already in view. Empty when there's no search or the filter is already "all".
// Lets the list say "1 match in other types -- ARAS (Hourly). Show all types" instead of an
// unexplained empty result (the default view is "Clients on a Package").
export function searchMatchesInOtherTypes(list, opts) {
  if (!opts.search?.trim() || opts.clientTypeFilter === "all") return [];
  const shown = new Set(filterClientList(list, opts).map((c) => c.name));
  return filterClientList(list, { ...opts, clientTypeFilter: "all" }).filter((c) => !shown.has(c.name));
}

// ---------------------------- scoped Client Invoicing ----------------------------
// For a user whose Invoicing scope is "assigned" (permissions.js). `list` is the SAME full
// card list an admin gets -- computed over every client's inputs, so every number on a card
// is identical -- and this only decides which cards are shown ("compute over full inputs,
// filter at display"). A card is kept when:
//   - it belongs to one of the user's clients (`clients`: its Clients-module profile, ledger
//     name or roll-up identity), or
//   - the user logged minutes on it this month (`userNames`: exact ClickUp spellings,
//     compared case-insensitively, see ownTime.js), or
//   - it nests under a kept card (a sub-project / capGroup sibling follows its parent).
// A parent is kept when something nested under it is kept on its own, since nested rows only
// ever render inside their parent's tile. Nesting is the same rule filterClientList uses.
export function scopeClientList(list, { clients = [], userNames = [] } = {}, primaryNameByGroup = new Map()) {
  const assigned = new Set(clients);
  const mine = ownNameSet(userNames);
  const presentNames = new Set(list.map((c) => c.name));
  const parentOf = (c) => {
    if (c.costCentreParentAccName && presentNames.has(c.costCentreParentAccName)) return c.costCentreParentAccName;
    const primaryName = c.capGroup ? primaryNameByGroup.get(c.capGroup) : null;
    return primaryName && primaryName !== c.name && presentNames.has(primaryName) ? primaryName : null;
  };
  const isAssigned = (c) => [c.profileClient, c.accruedClient?.name, c.costCentreAccruedName, c.name].some((n) => n && assigned.has(n));
  const hasOwnMinutes = (c) => [...(c.userMinutes || [])].some(([u, min]) => min > 0 && isOwnName(mine, u));
  const keptParents = new Set();
  for (const c of list) {
    if (isAssigned(c) || hasOwnMinutes(c)) keptParents.add(parentOf(c) ?? c.name);
  }
  return list.filter((c) => keptParents.has(c.name) || keptParents.has(parentOf(c)));
}

// The package figures of a card built from a client the user isn't assigned (pginvoice_
// client_directory withheld its agreed hours / balances / fee, see clientDirectory.js).
// Only reachable when fuzzy/prefix folder matching ties the user's own hours to such a
// client. Worked hours stay (they're everyone's real ClickUp time); everything derived from
// the withheld inputs is blanked rather than shown wrong, and the card says so (`withheld`).
// Keys must exist on buildClientsForMonth's cards (invoicingPipeline.js) -- pinned by
// invoicingScope.test.js, so a renamed card field can't silently stop being withheld.
export const WITHHELD_FIELDS = {
  pkg: null, priorBalance: null, priorBalanceEstimated: false, newBalance: null, remaining: null, kpiPct: null,
  status: "no-pkg", priorMismatch: null, priorRebaseline: null, resetValue: null, remainingReset: null,
  balanceForward: null, remainingShown: null, quotedAmount: null, quotedRemaining: null, lifetimeWorked: null,
  fixedFee: null,
};
// What Copy summary / the PDF say on a withheld card instead of "No package on file".
export const WITHHELD_NOTE = "Package figures not shared (not one of your clients).";
export function withholdRedactedFigures(list, redactedClients) {
  if (!redactedClients?.size) return list;
  const redacted = (n) => !!n && redactedClients.has(n);
  return list.map((c) => (redacted(c.profileClient) || redacted(c.accruedClient?.name) || redacted(c.costCentreAccruedName)
    ? { ...c, ...WITHHELD_FIELDS, withheld: true }
    : c));
}

// The three lists Client Invoicing renders from one month's full card list -- the single
// composition App.jsx and invoicingScope.test.js both call:
//   shown:   every card, figures withheld where built from an unassigned client (nested
//            rows/sibling lookups read from this);
//   inScope: the cards in view (scopeClientList over `shown`), or, given `keepNames` (the
//            current month's in-scope names), exactly those names -- used for the previous
//            month so "vs last month" compares the same set of cards, not whoever happened
//            to have the user's minutes last month;
//   primary: computePrimaryNameByGroup over the FULL list (grouping never depends on scope).
// `scopedDir` null (admin tier) -> all three are the full list, exactly as before.
export function scopedCardLists(list, scopedDir, userNames = [], { keepNames = null } = {}) {
  const primary = computePrimaryNameByGroup(list);
  if (!scopedDir) return { shown: list, inScope: list, primary };
  const shown = withholdRedactedFigures(list, scopedDir.redactedClients);
  const inScope = keepNames
    ? shown.filter((c) => keepNames.has(c.name))
    : scopeClientList(shown, { clients: [...(scopedDir.assignedClients || [])], userNames }, primary);
  return { shown, inScope, primary };
}
