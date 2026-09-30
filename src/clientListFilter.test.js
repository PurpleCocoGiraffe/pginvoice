import { describe, it, expect } from "vitest";
import { filterClientList } from "./clientListFilter.js";

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
