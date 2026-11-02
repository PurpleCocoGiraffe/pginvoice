import { describe, it, expect } from "vitest";
import { settleHourly, HOURLY_SETTLEMENT_NOTE } from "./format.js";
import { replayClientAccruals } from "./accrualsSync.js";
import { reconcileClientMonth, hourlySettlementCarryIn } from "./reconcile.js";
import { buildPrintHtml } from "./printTemplate.js";
import { buildSummaryText } from "./clientSummary.js";

// A client moving off a package onto hourly settles its package balance on its hourly
// invoices (from 2026-10) instead of silently dropping it. First case: Treasure Boxes,
// Sep 2026 closing -1.70 h (unused hours we owe them) -> hourly from Oct 2026.
describe("settleHourly", () => {
  it("deducts owed hours from the month's hours", () => {
    expect(settleHourly(-1.7, 5)).toEqual({ prior: -1.7, applied: -1.7, hoursToInvoice: 3.3, remaining: 0 });
  });
  it("carries owed hours the month can't cover into the next month", () => {
    expect(settleHourly(-10, 6)).toEqual({ prior: -10, applied: -6, hoursToInvoice: 0, remaining: -4 });
  });
  it("adds an over-use in full", () => {
    expect(settleHourly(0.92, 5)).toEqual({ prior: 0.92, applied: 0.92, hoursToInvoice: 5.92, remaining: 0 });
  });
});

describe("replayClientAccruals -- package -> hourly settlement", () => {
  const PKG = { type: "package", agreedHours: 10 };
  const HOURLY = { type: "hourly", agreedHours: null };
  const minutes = (byMonth) => (mk) => (byMonth[mk] || 0) * 60;
  const run = (c, segFor, worked, cur = "2026-12") => replayClientAccruals(c, {
    startMonth: "2026-08", cur, segFor, statusFor: () => "active", workedMinutesFor: minutes(worked),
  });

  it("writes a settlement row for the first hourly month and stops once settled", () => {
    // Aug package: 8.3 worked -> -1.7 owed. Hourly from Sep... but settlement only starts
    // 2026-10, so use Sep package too.
    const segFor = (mk) => (mk <= "2026-09" ? PKG : HOURLY);
    const c = { client: "TB", manager: null, agreedHpm: "10", months: { "2026-10": { accrualValue: null, accrualNote: "Not on a package this month", workedHours: null } } };
    const rows = run(c, segFor, { "2026-08": 10, "2026-09": 8.3, "2026-10": 5, "2026-11": 4 });
    expect(c.months["2026-09"].accrualValue).toBe(-1.7);
    expect(c.months["2026-10"]).toMatchObject({ accrualValue: 0, accrualNote: HOURLY_SETTLEMENT_NOTE, agreedHpm: null, workedHours: 5 });
    expect(rows.find((r) => r.month_key === "2026-10")).toMatchObject({ accrual_value: 0, accrual_note: HOURLY_SETTLEMENT_NOTE, agreed_hpm: null });
    // Settled: November is plain hourly again (no row).
    expect(c.months["2026-11"]).toBeUndefined();
  });

  it("carries the unsettled part of owed hours into the next hourly month", () => {
    const segFor = (mk) => (mk <= "2026-09" ? PKG : HOURLY);
    const c = { client: "X", manager: null, agreedHpm: "10", months: {} };
    run(c, segFor, { "2026-08": 0, "2026-09": 10, "2026-10": 6, "2026-11": 2, "2026-12": 9 });
    // Aug -10, Sep -10 (10 worked - 10 + -10)... carry -10 into Oct.
    expect(c.months["2026-10"].accrualValue).toBe(-4);
    expect(c.months["2026-11"].accrualValue).toBe(-2);
    expect(c.months["2026-12"].accrualValue).toBe(0);
  });

  it("leaves transitions before 2026-10 alone (balance dropped as before)", () => {
    const segFor = (mk) => (mk <= "2026-08" ? PKG : HOURLY);
    const c = { client: "G", manager: null, agreedHpm: "10", months: { "2026-09": { accrualValue: 1, workedHours: 1, accrualNote: null } } };
    run(c, segFor, { "2026-08": 12, "2026-09": 5 }, "2026-10");
    expect(c.months["2026-09"].accrualNote).toBe("Not on a package this month");
    expect(c.months["2026-10"]).toBeUndefined();
  });
});

describe("Client Accruals -- hourly settlement month", () => {
  const ledger = { name: "Treasure Boxes", balances: { "2026-09": -1.7 }, agreedByMonth: { "2026-09": 10 }, settledHourly: {} };

  it("reads the package carry-out as the settlement carry-in", () => {
    expect(hourlySettlementCarryIn(ledger, "2026-09", "package")).toBe(-1.7);
    expect(hourlySettlementCarryIn(ledger, "2026-09", "hourly")).toBe(null);
    expect(hourlySettlementCarryIn({ ...ledger, settledHourly: { "2026-09": true } }, "2026-09", "hourly")).toBe(-1.7);
  });

  it("returns the hours to invoice, leaving the rest of the hourly row unchanged", () => {
    const r = reconcileClientMonth({ worked: 5, accruedClient: ledger, monthKey: "2026-10", priorKey: "2026-09", monthType: "hourly", priorType: "package", hourlySettlementPrior: -1.7 });
    expect(r.hourlySettlement).toEqual({ prior: -1.7, applied: -1.7, hoursToInvoice: 3.3, remaining: 0 });
    expect(r.status).toBe("no-pkg");
    expect(r.priorBalance).toBe(null);
  });

  it("does nothing before 2026-10", () => {
    const r = reconcileClientMonth({ worked: 5, accruedClient: ledger, monthKey: "2026-09", priorKey: "2026-08", monthType: "hourly", priorType: "package", hourlySettlementPrior: -1.7 });
    expect(r.hourlySettlement).toBeFalsy();
  });

  it("shows on the PDF and Copy summary", () => {
    const c = {
      name: "Treasure Boxes", displayName: "Treasure Boxes", type: "hourly", worked: 5, billableWorked: 5,
      tasksAll: new Map([["Task", 300]]), taskUsers: new Map(), userMinutes: new Map(),
      hourlySettlement: settleHourly(-1.7, 5),
    };
    const html = buildPrintHtml(c, "October 2026", "September 2026");
    expect(html).toContain("Hours to invoice");
    expect(html).toContain("3.30 h");
    const text = buildSummaryText(c, { invoiceMonth: "October 2026", priorMonthPretty: "September 2026" });
    expect(text).toContain("Hours to invoice: 3.30 h");
  });
});
