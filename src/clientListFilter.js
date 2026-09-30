// Shared type/consultant/search filter + primary-group suppression for Client Invoicing's
// client list (everything App.jsx's `visible` list needs except the final sort). Used for
// both the current month's `visible` list and the prior month's `prevStats` comparison list,
// so "what's currently in view" can't silently diverge between the two. Pure (no React/
// Supabase imports) so it's directly testable.
export function filterClientList(list, { clientTypeFilter, consultantFilter, search, primaryNameByGroup }) {
  let out = clientTypeFilter === "all" ? list.slice()
    : clientTypeFilter === "map" ? list.filter((c) => c.isMap)
    : list.filter((c) => c.type === clientTypeFilter);
  if (consultantFilter) {
    // A sub-project/sibling row is only ever shown nested under its parent (the two
    // filters below), so a parent must stay in view when the consultant worked on
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
  out = out.filter((c) => {
    if (!c.capGroup) return true;
    const primaryName = primaryNameByGroup.get(c.capGroup);
    return !primaryName || c.name === primaryName;
  });
  // A folder explicitly tagged as another cost-centre client's sub-project (see
  // costCentreParentAccName in buildClientsForMonth) is always shown nested under that
  // parent's tile, never again as its own top-level card -- same rule as capGroup above,
  // just driven by nameMatch.js's rules instead of Capacity Planning's grouping.
  out = out.filter((c) => !c.costCentreParentAccName);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    out = out.filter((c) => c.name.toLowerCase().includes(q) || (c.displayName || "").toLowerCase().includes(q));
  }
  return out;
}
