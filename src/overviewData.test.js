import { describe, it, expect } from "vitest";
import {
  activeClientStats, accrualHealth, NEGATIVE_BALANCE_THRESHOLD_HRS,
  teamUtilization, sixMonthTrend, clientTypeMix, teamMonthlyTotals,
  overUtilizedConsultants, OVER_UTILIZATION_PCT, filterToActiveClients,
} from "./overviewData.js";

describe("activeClientStats", () => {
  it("does not divide by zero when there are no active clients", () => {
    const result = activeClientStats([]);
    expect(result.active).toBe(0);
    expect(result.overServicedPct).toBeNull();
  });

  it("counts only status === 'active', excluding both offboarded AND archived", () => {
    // Regression test: pginvoice_clients has three real statuses, not two.
    // This used to be `status !== "offboarded"`, which silently counted every
    // archived client as active too (42 active + 26 archived = 68, the exact
    // wrong number Overview was showing against the Clients module's 42).
    const clients = [
      { client: "A", status: "active" },
      { client: "B", status: "active" },
      { client: "C", status: "offboarded" },
      { client: "D", status: "archived" },
    ];
    expect(activeClientStats(clients).active).toBe(2);
  });
});

describe("filterToActiveClients", () => {
  it("keeps only accrual rows whose client is status === 'active'", () => {
    const clients = [
      { client: "A", status: "active" },
      { client: "B", status: "offboarded" },
      { client: "C", status: "archived" },
    ];
    const accrualClients = [
      { client: "A", months: {} },
      { client: "B", months: {} },
      { client: "C", months: {} },
    ];
    const result = filterToActiveClients(accrualClients, clients);
    expect(result.map((c) => c.client)).toEqual(["A"]);
  });

  it("passes through null (no accrual data on file) unchanged", () => {
    expect(filterToActiveClients(null, [{ client: "A", status: "active" }])).toBeNull();
  });
});

describe("accrualHealth", () => {
  it("does not let sign-cancellation hide a meaningfully negative client", () => {
    const accrualClients = [
      { client: "Over", months: { "2026-06": { accrualValue: 40 } } },
      { client: "Under", months: { "2026-06": { accrualValue: -40 } } },
    ];
    const result = accrualHealth(accrualClients);
    expect(result.netHours).toBeCloseTo(0, 5);
    expect(result.negativeCount).toBe(1);
    expect(result.negativeList[0].client).toBe("Under");
  });

  it("uses the founder-set -20h threshold by default", () => {
    expect(NEGATIVE_BALANCE_THRESHOLD_HRS).toBe(20);
    const accrualClients = [
      { client: "Slightly negative", months: { "2026-06": { accrualValue: -15 } } },
      { client: "Meaningfully negative", months: { "2026-06": { accrualValue: -25 } } },
    ];
    const result = accrualHealth(accrualClients);
    expect(result.negativeCount).toBe(1);
    expect(result.negativeList[0].client).toBe("Meaningfully negative");
  });

  it("ignores clients with no accrual value on file", () => {
    const accrualClients = [{ client: "No data", months: {} }];
    const result = accrualHealth(accrualClients);
    expect(result.netHours).toBe(0);
    expect(result.negativeCount).toBe(0);
  });
});

describe("teamUtilization", () => {
  const person = { name: "Holly", contracted: 38, rate: 0.7, state: "SA" };

  it("min, max and avg all equal each other for a single consultant", () => {
    const monthKey = "2026-05";
    const teamMonthly = new Map([
      ["Holly", new Map([[monthKey, { total: 100, clientBillable: 80, pgBillable: 0, unbillable: 20 }]])],
    ]);
    const result = teamUtilization([person], teamMonthly, monthKey);
    expect(result.perConsultant.length).toBe(1);
    expect(result.avgPct).toBeCloseTo(result.minPct, 5);
    expect(result.avgPct).toBeCloseTo(result.maxPct, 5);
  });

  it("returns nulls (not a fabricated average) when nobody has availability that month", () => {
    const result = teamUtilization([], new Map(), "2026-05");
    expect(result.avgPct).toBeNull();
    expect(result.minPct).toBeNull();
    expect(result.maxPct).toBeNull();
  });
});

describe("overUtilizedConsultants", () => {
  it("only includes consultants at or above the 100% threshold, sorted highest first", () => {
    const perConsultant = [
      { name: "A", pct: 80 },
      { name: "B", pct: 120 },
      { name: "C", pct: 100 },
    ];
    const result = overUtilizedConsultants(perConsultant);
    expect(result.map((c) => c.name)).toEqual(["B", "C"]);
    expect(OVER_UTILIZATION_PCT).toBe(100);
  });
});

describe("sixMonthTrend", () => {
  it("omits months with no matching data rather than zero-filling them", () => {
    const accrualClients = [
      { client: "A", months: { "2026-06": { pct: 0.05, accrualValue: 3 } } },
    ];
    const result = sixMonthTrend(accrualClients, [], ["2026-01", "2026-02", "2026-06"]);
    expect(result.months).toEqual(["2026-06"]);
    expect(result.overServicedCounts.length).toBe(1);
    expect(result.totalAccruedHours.length).toBe(1);
  });

  it("counts over-serviced months (pct > 10%) correctly", () => {
    const accrualClients = [
      { client: "Over", months: { "2026-06": { pct: 0.25, accrualValue: 5 } } },
      { client: "OnTrack", months: { "2026-06": { pct: 0.02, accrualValue: 1 } } },
    ];
    const result = sixMonthTrend(accrualClients, [], ["2026-06"]);
    expect(result.overServicedCounts).toEqual([1]);
  });
});

describe("clientTypeMix", () => {
  it("does not throw on an unrecognized type string, and still counts it", () => {
    const clients = [{ type: "package" }, { type: "some_future_type" }, { type: "package" }];
    expect(() => clientTypeMix(clients)).not.toThrow();
    const mix = clientTypeMix(clients);
    expect(mix.package).toBe(2);
    expect(mix.some_future_type).toBe(1);
  });
});

describe("teamMonthlyTotals", () => {
  it("returns an empty map when there's no ClickUp data", () => {
    expect(teamMonthlyTotals([], null, []).size).toBe(0);
  });
});

describe("accrual reset (macro-sheet re-baseline) -- Overview uses the carry-out figure", () => {
  it("accrualHealth and sixMonthTrend read reset ?? accrualValue for a re-baselined month (0 included)", () => {
    const clients = [
      { client: "Reset", months: { "2026-08": { accrualValue: 5, resetValue: -30 } } },
      { client: "ZeroReset", months: { "2026-08": { accrualValue: 7, resetValue: 0 } } },
      { client: "Plain", months: { "2026-08": { accrualValue: 2 } } },
    ];
    const health = accrualHealth(clients);
    expect(health.netHours).toBe(-28);
    expect(health.negativeList.map((n) => n.client)).toEqual(["Reset"]);
    expect(sixMonthTrend(clients, [], ["2026-08"]).totalAccruedHours).toEqual([-28]);
  });
});
