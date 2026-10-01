import { describe, it, expect } from "vitest";
import { filterClientList, computePrimaryNameByGroup, matchesSearch, searchMatchesInOtherTypes } from "./clientListFilter.js";

const row = (name, userMinutes, extra = {}) => ({ name, type: "package", userMinutes: new Map(userMinutes), ...extra });
const opts = (over = {}) => ({ clientTypeFilter: "all", consultantFilter: "", search: "", primaryNameByGroup: new Map(), ...over });

describe("filterClientList consultant filter", () => {
  // Regression: the consultant filter only checked the parent row's own hours, and a
  // sub-project is only ever rendered nested under its parent -- so a consultant whose
  // billable time was all on Apex Comms Website (QP) (none on Apex Energy itself) saw
  // Apex disappear entirely.
  it("keeps a parent when the consultant only worked on its cost-centre sub-project", () => {
    const list = [
      row("Apex Energy", [["Chloe", 60]]),
      row("Apex Comms Website (QP)", [["Suba", 341]], { type: "quoted", costCentreParentAccName: "Apex Energy" }),
      row("Villani Jewellers", [["Suba", 222]]),
      row("Coonawarra", [["Chloe", 20]]),
    ];
    const names = filterClientList(list, opts({ consultantFilter: "Suba" })).map((c) => c.name);
    expect(names).toEqual(["Apex Energy", "Villani Jewellers"]);
  });

  it("keeps a capGroup primary when the consultant only worked on a non-primary sibling", () => {
    const list = [
      row("Warrina Homes", [], { capGroup: "g1" }),
      row("Warrina Homes - Employee Guide", [["Suba", 30]], { capGroup: "g1" }),
    ];
    const names = filterClientList(list, opts({ consultantFilter: "Suba", primaryNameByGroup: new Map([["g1", "Warrina Homes"]]) })).map((c) => c.name);
    expect(names).toEqual(["Warrina Homes"]);
  });

  it("still drops a client the consultant didn't touch at all", () => {
    const list = [row("Apex Energy", [["Chloe", 60]]), row("Apex Comms Website (QP)", [["Chloe", 10]], { costCentreParentAccName: "Apex Energy" })];
    expect(filterClientList(list, opts({ consultantFilter: "Suba" }))).toEqual([]);
  });
});

describe("computePrimaryNameByGroup: a sub-project is never a group's primary", () => {
  const visibleNames = (list) => filterClientList(list, opts({ primaryNameByGroup: computePrimaryNameByGroup(list) })).map((c) => c.name);

  // Live Sep 2026: the sub-project out-worked its parent, became the group primary, and was
  // then hidden as a sub-project too -- ARAS and its project both vanished from the list.
  it("ARAS: the most-worked member being a sub-project doesn't hide the parent", () => {
    const list = [
      row("ARAS", [["Suba", 5]], { type: "hourly", worked: 0.08, capGroup: "ARAS", accruedClient: { name: "ARAS" }, costCentreAccruedName: "ARAS", registered: true }),
      row("ARAS Website Optimisation Project", [["Suba", 660]], { type: "hourly", worked: 11, capGroup: "ARAS", costCentreParentAccName: "ARAS" }),
    ];
    expect(computePrimaryNameByGroup(list).get("ARAS")).toBe("ARAS");
    expect(visibleNames(list)).toEqual(["ARAS"]);
  });

  // Live Sep 2026: the sub-project (wrongly typed package) was found first by the
  // package-like check.
  it("Majestic Plumbing: a package-typed sub-project listed first doesn't win", () => {
    const list = [
      row("Majestic Plumbing Quoted Web Project (WA)", [], { type: "package", worked: 2.17, capGroup: "Majestic Plumbing", costCentreParentAccName: "Majestic Plumbing" }),
      row("Majestic Plumbing", [], { type: "package", worked: 18.23, capGroup: "Majestic Plumbing", accruedClient: { name: "Majestic Plumbing" } }),
    ];
    expect(computePrimaryNameByGroup(list).get("Majestic Plumbing")).toBe("Majestic Plumbing");
    expect(visibleNames(list)).toEqual(["Majestic Plumbing"]);
  });

  it("prefers the package-like member, then the registered/ledger owner, then most hours", () => {
    const pkg = [row("A", [], { type: "hourly", worked: 9, capGroup: "g" }), row("B", [], { type: "package", worked: 1, capGroup: "g" })];
    expect(computePrimaryNameByGroup(pkg).get("g")).toBe("B");
    const owner = [row("A", [], { type: "hourly", worked: 9, capGroup: "g" }), row("B", [], { type: "hourly", worked: 1, capGroup: "g", registered: true })];
    expect(computePrimaryNameByGroup(owner).get("g")).toBe("B");
    const hours = [row("A", [], { type: "hourly", worked: 9, capGroup: "g" }), row("B", [], { type: "hourly", worked: 1, capGroup: "g" })];
    expect(computePrimaryNameByGroup(hours).get("g")).toBe("A");
  });
});

describe("filterClientList never hides a row under a parent that isn't there", () => {
  it("a sub-project whose parent has no row this month stays visible top-level", () => {
    const list = [row("Apex Comms Website (QP)", [["Suba", 60]], { type: "quoted", costCentreParentAccName: "Apex Energy" })];
    expect(filterClientList(list, opts()).map((c) => c.name)).toEqual(["Apex Comms Website (QP)"]);
  });
  it("a group member whose primary isn't in the list stays visible", () => {
    const list = [row("Warrina Homes - Employee Guide", [], { capGroup: "g1" })];
    const names = filterClientList(list, opts({ primaryNameByGroup: new Map([["g1", "Warrina Homes"]]) })).map((c) => c.name);
    expect(names).toEqual(["Warrina Homes - Employee Guide"]);
  });
  it("the MAP bucket includes a month typed map as well as the Capacity Planning overlay", () => {
    const list = [row("Astill Consultants", [], { type: "map" }), row("Companion Software", [], { type: "package", isMap: true }), row("Acme", [])];
    expect(filterClientList(list, opts({ clientTypeFilter: "map" })).map((c) => c.name)).toEqual(["Astill Consultants", "Companion Software"]);
  });
  it("the digital bucket filters by type", () => {
    const list = [row("Rent Busters (Bunbury, WA)", [], { type: "digital" }), row("Acme", [])];
    expect(filterClientList(list, opts({ clientTypeFilter: "digital" })).map((c) => c.name)).toEqual(["Rent Busters (Bunbury, WA)"]);
  });
});

// "Can't find Aged Rights": ARAS's row is named after the client, its ClickUp folder is
// "Aged Rights Advocacy Services", and it's hourly (hidden by the default package filter).
describe("search: folder names, nested rows, and matches hidden by the type filter", () => {
  const list = [
    row("ARAS", [], { type: "hourly", capGroup: "ARAS", searchFolders: ["Aged Rights Advocacy Services"], registered: true }),
    row("ARAS Website Optimisation Project", [], { type: "hourly", capGroup: "ARAS", costCentreParentAccName: "ARAS", searchFolders: ["ARAS Website Optimisation Project"] }),
    row("Clarke Energy (CEA)", [], { type: "hourly", searchFolders: ["Clarke Energy", "CEA WAME 2026"] }),
    row("Majestic Plumbing", [], { type: "package" }),
  ];
  const o = (over) => opts({ primaryNameByGroup: computePrimaryNameByGroup(list), ...over });
  it("matches a row by its registered/source ClickUp folder", () => {
    expect(filterClientList(list, o({ search: "aged" })).map((c) => c.name)).toEqual(["ARAS"]);
    expect(filterClientList(list, o({ search: "wame" })).map((c) => c.name)).toEqual(["Clarke Energy (CEA)"]);
  });
  it("matches a parent by the name of a row nested under it", () => {
    expect(filterClientList(list, o({ search: "optimisation" })).map((c) => c.name)).toEqual(["ARAS"]);
  });
  it("matchesSearch covers name, display name and folders", () => {
    expect(matchesSearch({ name: "x", displayName: "Aged" }, "aged")).toBe(true);
    expect(matchesSearch({ name: "x", searchFolders: ["Aged Rights"] }, "aged")).toBe(true);
    expect(matchesSearch({ name: "x" }, "aged")).toBe(false);
  });
  it("reports matches the type filter hides (default view = package)", () => {
    expect(filterClientList(list, o({ clientTypeFilter: "package", search: "aged" }))).toEqual([]);
    expect(searchMatchesInOtherTypes(list, o({ clientTypeFilter: "package", search: "aged" })).map((c) => c.name)).toEqual(["ARAS"]);
    expect(searchMatchesInOtherTypes(list, o({ clientTypeFilter: "all", search: "aged" }))).toEqual([]);
    expect(searchMatchesInOtherTypes(list, o({ clientTypeFilter: "package", search: "" }))).toEqual([]);
    expect(searchMatchesInOtherTypes(list, o({ clientTypeFilter: "package", search: "majestic" }))).toEqual([]);
  });
});
