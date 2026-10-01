import { isPackageLikeType } from "./format.js";

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
export function filterClientList(list, { clientTypeFilter, consultantFilter, search, primaryNameByGroup }) {
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
    const parentsWithNestedWork = new Set();
    for (const c of list) {
      if (!worked(c)) continue;
      if (c.costCentreParentAccName) parentsWithNestedWork.add(c.costCentreParentAccName);
      if (c.capGroup) {
        const primaryName = primaryNameByGroup.get(c.capGroup);
        if (primaryName && primaryName !== c.name) parentsWithNestedWork.add(primaryName);
      }
    }
    out = out.filter((c) => worked(c) || parentsWithNestedWork.has(c.name));
  }
  // A non-primary capGroup member, or a folder explicitly tagged as another cost-centre
  // client's sub-project (see costCentreParentAccName in buildClientsForMonth), is shown
  // nested under that parent's tile, never again as its own top-level card -- the first
  // driven by Capacity Planning's grouping, the second by nameMatch.js's rules.
  out = out.filter((c) => !nestedUnderPresent(c));
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    out = out.filter((c) => c.name.toLowerCase().includes(q) || (c.displayName || "").toLowerCase().includes(q));
  }
  return out;
}
