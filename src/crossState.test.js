import { describe, it, expect, afterEach } from "vitest";
import { defaultClientState, resolveClientState, assignFoldersToClients, staffFor, buildCrossStateReport, EXTERNAL, UNKNOWN } from "./crossState.js";
import { setDynamicCostCentres } from "./nameMatch.js";

afterEach(() => setDynamicCostCentres([]));

describe("defaultClientState (Kelly's confirmed list)", () => {
  it.each([
    ["Filter Supplies (WA)", "WA"], ["Green Shoots", "WA"], ["Rent Busters WA", "WA"], ["Blueforce", "WA"],
    ["Majestic Plumbing", "WA"], ["CLT Website", "WA"], ["Committee for Perth", "WA"], ["Astill Consultants", "WA"], ["Zest", "WA"],
    ["SGME", "QLD"], ["Mary Di Marco - Ray White (Qld)", "QLD"], ["Sunfresh Linen", "QLD"], ["Brisbane Alarm Monitoring", "QLD"],
    ["BAMSS Childcare Security Services (Qld)", "QLD"], ["Cowie Environmental", "QLD"], ["Prison Transport Group", "QLD"],
    ["Baintech", "QLD"], ["Barclay Recruitment", "QLD"], ["CRA Construction", "QLD"], ["By the Rules", "QLD"],
    ["Clarke Energy", "SA"], ["Clarke Energy WA", "SA"], ["Apex Energy", "SA"], ["Some Brand New Client", "SA"],
  ])("%s -> %s", (name, state) => {
    expect(defaultClientState(name)).toBe(state);
  });

  it("matches whole words only, so a short key like CLT can't hit inside another word", () => {
    expect(defaultClientState("Cultural Tours")).toBe("SA");
    expect(defaultClientState("Zesty Foods")).toBe("SA");
  });
});

describe("resolveClientState", () => {
  it("a saved state always wins over the default list", () => {
    expect(resolveClientState("Zest", { Zest: "SA" })).toEqual({ state: "SA", source: "set" });
    expect(resolveClientState("Zest", {})).toEqual({ state: "WA", source: "default" });
  });
  it("ignores a malformed saved value rather than trusting it", () => {
    expect(resolveClientState("Zest", { Zest: "NSW" }).source).toBe("default");
  });
});

describe("assignFoldersToClients", () => {
  it("prefers the registered folder, then rules, then a fuzzy match, and never assigns a folder twice", () => {
    const clients = [{ client: "Aus3C", clickupFolder: "Aus3C" }, { client: "Australian Cyber Thing", clickupFolder: null }, { client: "Green Shoots", clickupFolder: null }];
    const m = assignFoldersToClients(["Aus3C", "Aus3C IRAP", "Green Shoots Co", "Totally Unknown"], clients);
    expect(m.get("Aus3C")).toEqual({ client: "Aus3C", method: "folder" });
    expect(m.get("Aus3C IRAP")).toEqual({ client: "Aus3C", method: "rule" });
    expect(m.get("Green Shoots Co")).toEqual({ client: "Green Shoots", method: "estimated" });
    expect(m.has("Totally Unknown")).toBe(false);
  });
  it("matches a registered folder case/whitespace-insensitively", () => {
    const m = assignFoldersToClients(["gpex "], [{ client: "GPEX", clickupFolder: "GPEX" }]);
    expect(m.get("gpex ").client).toBe("GPEX");
  });
});

describe("staffFor", () => {
  const people = [{ name: "Lucy", state: "QLD" }, { name: "Holly", state: "SA" }, { name: "Amanda", state: "WA", alias: "Mandy W" }];
  it("maps users to their roster state, via alias too", () => {
    expect(staffFor("Lucy Smith", people)).toEqual({ person: "Lucy", state: "QLD", matched: true });
    expect(staffFor("Mandy W", people).state).toBe("WA");
  });
  it("treats the Purple Giraffe login as external DMA, not any state's team", () => {
    expect(staffFor("Purple Giraffe", people)).toEqual({ person: EXTERNAL, state: EXTERNAL, matched: true });
  });
  it("keeps an unmatched user visible as Unknown", () => {
    expect(staffFor("New Starter", people)).toEqual({ person: "New Starter", state: UNKNOWN, matched: false });
  });
});

describe("buildCrossStateReport", () => {
  const people = [{ name: "Holly", state: "SA" }, { name: "Lucy", state: "QLD" }, { name: "Amanda", state: "WA" }];
  const clients = [
    { client: "Sunfresh Linen", clickupFolder: "Sunfresh Linen" },
    { client: "Blueforce", clickupFolder: "Blueforce" },
    { client: "Apex Energy", clickupFolder: "Apex Energy" },
  ];
  const row = (user, folder, minutes, extra = {}) => ({ user, folder, minutes, billable: true, monthKey: "2026-09", task: "t", ...extra });
  const rows = [
    row("Holly", "Sunfresh Linen", 120),           // SA team -> QLD client
    row("Holly", "Blueforce", 60),                 // SA team -> WA client
    row("Lucy", "Apex Energy", 30),                // QLD team -> SA client
    row("Amanda", "Blueforce", 90),                // WA -> WA (same state)
    row("Holly", "Sunfresh Linen", 600, { billable: false }),
    row("Holly", "Julia Onboarding", 300),         // internal, excluded
    row("Holly", "Mystery Folder", 45),            // no client
    row("Purple Giraffe", "Apex Energy", 60),      // DMA
    row("Holly", "Blueforce", 999, { monthKey: "2026-08" }),
  ];

  it("splits hours into staff-state x client-state cells, billable only, within the months chosen", () => {
    const r = buildCrossStateReport(rows, { clients, people, months: new Set(["2026-09"]) });
    expect(r.cellHours("SA", "QLD")).toBe(2);
    expect(r.cellHours("SA", "WA")).toBe(1);
    expect(r.cellHours("QLD", "SA")).toBe(0.5);
    expect(r.cellHours("WA", "WA")).toBe(1.5);
    expect(r.cellHours(EXTERNAL, "SA")).toBe(1);
    expect(r.cellHours("SA", UNKNOWN)).toBe(0.75);
    expect(r.totalHours).toBeCloseTo(2 + 1 + 0.5 + 1.5 + 1 + 0.75);
    expect(r.unassignedFolders).toEqual([{ folder: "Mystery Folder", hours: 0.75 }]);
  });

  it("includes non-billable hours when billableOnly is off", () => {
    const r = buildCrossStateReport(rows, { clients, people, billableOnly: false, months: new Set(["2026-09"]) });
    expect(r.cellHours("SA", "QLD")).toBe(12);
  });

  it("uses a saved client state over the default", () => {
    const r = buildCrossStateReport(rows, { clients, people, months: new Set(["2026-09"]), savedStates: { Blueforce: "SA" } });
    expect(r.cellHours("SA", "WA")).toBe(0);
    expect(r.cellHours("SA", "SA")).toBe(1);
  });

  it("every included hour lands in exactly one cell (detail sums to the total)", () => {
    const r = buildCrossStateReport(rows, { clients, people });
    const sum = r.detail.reduce((a, d) => a + d.hours, 0);
    expect(sum).toBeCloseTo(r.totalHours);
  });
});
