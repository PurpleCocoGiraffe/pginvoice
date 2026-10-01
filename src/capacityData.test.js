import { describe, it, expect } from "vitest";
import {
  agreedAt, computeMonthlyAvailability, resignationStatus,
  demandFor, demandForGroup, computeDynamicAverages, last6MonthKeys,
} from "./capacityData.js";
import { adelaideLocalMidnightUtcMs } from "./dateMath.js";

describe("agreedAt", () => {
  it("returns the base agreed hours when there is no history", () => {
    expect(agreedAt({ agreed: 20, history: [] }, "2026-05")).toBe(20);
  });

  it("returns 0 once a month reaches the offboarded date", () => {
    const client = { agreed: 20, history: [], offboardedFrom: "2026-06" };
    expect(agreedAt(client, "2026-05")).toBe(20);
    expect(agreedAt(client, "2026-06")).toBe(0);
    expect(agreedAt(client, "2026-07")).toBe(0);
  });

  it("uses the latest history entry whose `from` is <= the requested month", () => {
    const client = {
      agreed: 38,
      history: [
        { from: "2026-03", agreed: 32 },
        { from: "2026-06", agreed: 40 },
      ],
    };
    expect(agreedAt(client, "2026-01")).toBe(38);
    expect(agreedAt(client, "2026-03")).toBe(32);
    expect(agreedAt(client, "2026-05")).toBe(32);
    expect(agreedAt(client, "2026-06")).toBe(40);
    expect(agreedAt(client, "2026-12")).toBe(40);
  });

  it("skips malformed history entries instead of throwing", () => {
    const client = { agreed: 20, history: [null, { from: "2026-04", agreed: 25 }, {}] };
    expect(() => agreedAt(client, "2026-05")).not.toThrow();
    expect(agreedAt(client, "2026-05")).toBe(25);
  });
});

describe("resignationStatus", () => {
  it("is active with no resignation date", () => {
    expect(resignationStatus({ resignationDate: null }, "2026-05")).toEqual({ active: true, throughDay: null });
  });

  it("is fully active for months before the resignation month", () => {
    expect(resignationStatus({ resignationDate: "2026-06-15" }, "2026-05")).toEqual({ active: true, throughDay: null });
  });

  it("is inactive for months after the resignation month", () => {
    expect(resignationStatus({ resignationDate: "2026-06-15" }, "2026-07")).toEqual({ active: false, throughDay: null });
  });

  it("caps to the resignation day within the resignation month", () => {
    expect(resignationStatus({ resignationDate: "2026-06-15" }, "2026-06")).toEqual({ active: true, throughDay: 15 });
  });
});

describe("computeMonthlyAvailability", () => {
  const person = { contracted: 38, rate: 0.7, state: "SA" };

  it("returns null once a person has resigned in an earlier month", () => {
    const resigned = { ...person, resignationDate: "2026-04-30" };
    expect(computeMonthlyAvailability(resigned, "2026-05", 0)).toBeNull();
  });

  it("subtracts leave hours from total monthly hours", () => {
    const withLeave = computeMonthlyAvailability(person, "2026-05", 10);
    const withoutLeave = computeMonthlyAvailability(person, "2026-05", 0);
    expect(withLeave.totalMonthlyHours).toBeCloseTo(withoutLeave.totalMonthlyHours - 10, 5);
  });

  it("splits total hours into billable/non-billable using the person's rate", () => {
    const result = computeMonthlyAvailability(person, "2026-05", 0);
    expect(result.billableHours).toBeCloseTo(result.totalMonthlyHours * person.rate, 5);
    expect(result.billableHours + result.nonBillableHours).toBeCloseTo(result.totalMonthlyHours, 5);
  });
});

describe("demandFor", () => {
  const fixedClient = { id: "c1", basis: "Package", agreed: 20, actuals: { "2026-03": 10, "2026-04": 12 } };
  const variableClient = { id: "c2", basis: "Hourly", agreed: 0, actuals: { "2026-03": 8, "2026-04": 10 } };

  it("a fixed-basis client demands its agreed hours, not its actuals average", () => {
    const { demand, isOverridden } = demandFor(fixedClient, "2026-05", {});
    expect(demand).toBe(20);
    expect(isOverridden).toBe(false);
  });

  it("a variable-basis client demands its trailing actuals average", () => {
    const { demand } = demandFor(variableClient, "2026-05", {});
    expect(demand).toBeCloseTo(9, 5); // average of 8 and 10
  });

  it("an override value wins over the computed default", () => {
    const overrides = { "c1_2026-05": 33 };
    const { demand, isOverridden } = demandFor(fixedClient, "2026-05", overrides);
    expect(demand).toBe(33);
    expect(isOverridden).toBe(true);
  });

  it("an offboarded client's demand goes to zero once offboarded", () => {
    const offboarded = { ...fixedClient, offboardedFrom: "2026-05" };
    expect(demandFor(offboarded, "2026-04", {}).demand).toBe(20);
    expect(demandFor(offboarded, "2026-05", {}).demand).toBe(0);
    expect(demandFor(offboarded, "2026-06", {}).demand).toBe(0);
  });
});

describe("demandForGroup", () => {
  const rowA = { id: "a1", basis: "Package", agreed: 15, actuals: {} };
  const rowB = { id: "a2", basis: "Project", agreed: 5, actuals: {} };

  it("a single-row group behaves the same as demandFor on that row", () => {
    const result = demandForGroup("Solo Client", [rowA], "2026-05", {}, new Map());
    expect(result.demand).toBe(15);
  });

  it("a multi-row Combined group sums each sub-row's demand when nothing is overridden and there's no dynamic average", () => {
    const result = demandForGroup("Combined Client", [rowA, rowB], "2026-05", {}, new Map());
    expect(result.demand).toBe(20);
    expect(result.isDynamic).toBe(false);
  });

  it("a multi-row group with a matched dynamic average uses the group total directly instead of summing sub-rows", () => {
    const dyn = new Map([["Combined Client", { avgHours: 42, matchedFolder: "2 folders", monthsCounted: 3, confidence: 1 }]]);
    const result = demandForGroup("Combined Client", [rowA, rowB], "2026-05", {}, dyn);
    expect(result.demand).toBe(42);
    expect(result.isDynamic).toBe(true);
  });
});

describe("computeDynamicAverages", () => {
  const clients = [{ group: "Aus3C" }, { group: "Solo Client" }];

  it("returns an empty map when there's no ClickUp data", () => {
    expect(computeDynamicAverages(null, clients).size).toBe(0);
    expect(computeDynamicAverages({ rows: [] }, clients).size).toBe(0);
  });

  it("sums minutes across all of a multi-folder client's real folders, per month", () => {
    const clickupData = {
      hasBillable: false,
      rows: [
        { folder: "Aus3C Cyber Battle", monthKey: "2026-06", minutes: 60, billable: true },
        { folder: "Aus3C IRAP", monthKey: "2026-06", minutes: 120, billable: true },
        { folder: "Aus3C Cyber Battle", monthKey: "2026-05", minutes: 60, billable: true },
        { folder: "Aus3C IRAP", monthKey: "2026-05", minutes: 60, billable: true },
      ],
    };
    const result = computeDynamicAverages(clickupData, clients);
    const aus3c = result.get("Aus3C");
    expect(aus3c).toBeDefined();
    expect(aus3c.monthsCounted).toBe(2);
    // (180 min + 120 min) / 60 / 2 months = 2.5h avg
    expect(aus3c.avgHours).toBeCloseTo(2.5, 5);
  });

  it("uses a single best-match folder (not multi-folder summing) for an ordinary client", () => {
    const clickupData = {
      hasBillable: false,
      rows: [
        { folder: "Solo Client", monthKey: "2026-06", minutes: 120, billable: true },
        { folder: "Unrelated Folder", monthKey: "2026-06", minutes: 999, billable: true },
      ],
    };
    const result = computeDynamicAverages(clickupData, clients);
    const solo = result.get("Solo Client");
    expect(solo).toBeDefined();
    expect(solo.matchedFolder).toBe("Solo Client");
    expect(solo.avgHours).toBeCloseTo(2, 5);
  });

  it("a client with no months of matching actuals data is skipped entirely (not present in the result)", () => {
    const clickupData = {
      hasBillable: false,
      rows: [{ folder: "Totally Unrelated", monthKey: "2026-06", minutes: 60, billable: true }],
    };
    const result = computeDynamicAverages(clickupData, clients);
    expect(result.has("Solo Client")).toBe(false);
    expect(result.has("Aus3C")).toBe(false);
  });
});

describe("computeDynamicAverages -- folder-name drift (GPEX renamed gpex)", () => {
  it("sums every case/whitespace variant of the single matched folder", () => {
    const keys = last6MonthKeys();
    const clickupData = {
      hasBillable: false,
      rows: [
        { folder: "GPEX", monthKey: keys[1], minutes: 120, billable: true },
        { folder: "gpex", monthKey: keys[0], minutes: 240, billable: true },
      ],
    };
    const gpex = computeDynamicAverages(clickupData, [{ group: "GPEX" }]).get("GPEX");
    expect(gpex.monthsCounted).toBe(2);
    expect(gpex.avgHours).toBeCloseTo(3, 5);
  });
});

describe("adelaideLocalMidnightUtcMs", () => {
  it("resolves standard-time (UTC+9:30) local midnight to the correct UTC instant", () => {
    // 1 July 2026 00:00 Adelaide (ACST, UTC+9:30) is 30 June 16:30 UTC.
    const ms = adelaideLocalMidnightUtcMs(2026, 7, 1);
    expect(new Date(ms).toISOString()).toBe("2026-06-30T14:30:00.000Z");
  });

  it("resolves daylight-saving (UTC+10:30) local midnight to the correct UTC instant", () => {
    // 1 January 2026 00:00 Adelaide (ACDT, UTC+10:30) is 31 Dec 13:30 UTC.
    const ms = adelaideLocalMidnightUtcMs(2026, 1, 1);
    expect(new Date(ms).toISOString()).toBe("2025-12-31T13:30:00.000Z");
  });

  it("gives consecutive months a positive, correctly-ordered gap", () => {
    const start = adelaideLocalMidnightUtcMs(2026, 7, 1);
    const end = adelaideLocalMidnightUtcMs(2026, 8, 1);
    expect(end).toBeGreaterThan(start);
  });
});
