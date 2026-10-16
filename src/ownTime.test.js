import { describe, it, expect } from "vitest";
import { filterOwnRows, ownNameSet } from "./ownTime.js";

const r = (user, folder, minutes) => ({ user, folder, minutes, dateKey: "2026-09-01" });

describe("filterOwnRows (Timesheets / Overview own mode)", () => {
  const rows = [
    r("Holly Fraser", "Majestic Plumbing (WA)", 60),
    r("holly fraser ", "Majestic Plumbing (WA)", 30), // stored spelling drift
    r("Chloe Smith", "Majestic Plumbing (WA)", 90), // someone else on the same shared folder
    r("C. Smith", "Aus3C IRAP", 15),
    r("Holly F", "Apex", 20), // a resembling name is not a match
    r("", "Apex", 5),
  ];

  it("is case-insensitive and trims", () => {
    expect(filterOwnRows(rows, ["HOLLY FRASER"]).map((x) => x.minutes)).toEqual([60, 30]);
  });
  it("handles several names (profile name + wage person's ClickUp names)", () => {
    expect(filterOwnRows(rows, ["Chloe Smith", "c. smith"]).map((x) => x.minutes)).toEqual([90, 15]);
  });
  it("excludes everyone else's time on shared folders, and never matches fuzzily", () => {
    const own = filterOwnRows(rows, ["Holly Fraser"]);
    expect(own.every((x) => x.user.trim().toLowerCase() === "holly fraser")).toBe(true);
    expect(own.some((x) => x.user === "Holly F")).toBe(false);
  });
  it("no names means no rows (never everyone's)", () => {
    expect(filterOwnRows(rows, [])).toEqual([]);
    expect(filterOwnRows(rows, undefined)).toEqual([]);
    expect(filterOwnRows(rows, ["", "  "])).toEqual([]);
    expect(ownNameSet([" A ", "a"]).size).toBe(1);
  });
});
