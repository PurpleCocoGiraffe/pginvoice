// A package month that was NOT invoiced (Comunet, Sept 2026): recorded as a human override
// with NOT_INVOICED_NOTE, agreed 0, closing balance = its worked hours against the carry
// into it. The next month carries that figure and shows the working on its PDF / summary.
import { describe, it, expect } from "vitest";
import { buildReconciliationClients, NOT_INVOICED_NOTE } from "./accrualsSync.js";
import { reconcileClientMonth } from "./reconcile.js";
import { buildPrintHtml } from "./printTemplate.js";
import { buildSummaryText, notInvoicedLines } from "./clientSummary.js";

const cell = (over) => ({ accrualValue: null, accrualNote: null, agreedHpm: null, isOverride: false, resetValue: null, ...over });
// Comunet's live ledger: Aug re-baselined to 1.80 h owed; Sept not invoiced (6.38 h worked).
const comunet = {
  client: "Comunet", agreedHpm: "16",
  months: {
    "2026-08": cell({ accrualValue: -1.8, resetValue: -1.8, agreedHpm: "32" }),
    "2026-09": cell({ accrualValue: 4.58, agreedHpm: "0", isOverride: true, accrualNote: NOT_INVOICED_NOTE }),
    "2026-10": cell({ accrualValue: 18.18, agreedHpm: "16" }),
  },
};
const october = () => {
  const [a] = buildReconciliationClients([comunet]).clients;
  return reconcileClientMonth({
    worked: 29.6, accruedClient: a, monthKey: "2026-10", priorKey: "2026-09", priorWorkedH: 6.38,
    monthType: "package", priorType: "package",
  });
};

describe("not-invoiced month", () => {
  it("flags only an override month carrying the marker", () => {
    const [a] = buildReconciliationClients([comunet]).clients;
    expect(a.notInvoiced).toEqual({ "2026-09": true });
    const plain = { ...comunet, months: { ...comunet.months, "2026-09": cell({ accrualValue: 4.58, agreedHpm: "0", accrualNote: NOT_INVOICED_NOTE }) } };
    expect(buildReconciliationClients([plain]).clients[0].notInvoiced).toEqual({});
  });

  it("October carries September's worked hours minus the hours owed, with no mismatch", () => {
    const r = october();
    expect(r.priorBalance).toBeCloseTo(4.58);
    expect(r.newBalance).toBeCloseTo(18.18); // 4.58 + 29.6 - 16
    expect(r.priorMismatch).toBeNull(); // agreed 0: 6.38 - 0 - 1.80 = 4.58 matches the override
    expect(r.priorNotInvoiced).toEqual({ monthKey: "2026-09", workedH: 6.38, carriedInKey: "2026-08", carriedIn: -1.8 });
  });

  it("is null for an ordinary prior month", () => {
    const [a] = buildReconciliationClients([{ ...comunet, months: { ...comunet.months, "2026-09": cell({ accrualValue: -27.42, agreedHpm: "32" }) } }]).clients;
    const r = reconcileClientMonth({ worked: 29.6, accruedClient: a, monthKey: "2026-10", priorKey: "2026-09", priorWorkedH: 6.38, monthType: "package", priorType: "package" });
    expect(r.priorNotInvoiced).toBeNull();
  });

  it("shows the working on the PDF and in the copy summary", () => {
    const r = october();
    const c = { name: "Comunet", displayName: "Comunet", type: "package", worked: 29.6, billableWorked: 29.6, tasksAll: new Map([["Work", 29.6 * 60]]), userMinutes: new Map(), taskUsers: new Map(), ...r };
    const lines = notInvoicedLines(r.priorNotInvoiced);
    expect(lines.rows.map(([, h]) => h)).toEqual([6.38, 1.8]);
    const html = buildPrintHtml(c, "October 2026", "September 2026");
    expect(html).toContain("(not invoiced): time tracked");
    expect(html).toContain("Less hours owed carried in from");
    expect(html).toContain("4.58 h");
    expect(html).toContain("was not invoiced, so no package hours were billed for it");
    const text = buildSummaryText(c, { invoiceMonth: "October 2026", priorMonthPretty: "September 2026" });
    expect(text).toContain("(not invoiced): time tracked: 6.38 h");
    expect(text).toContain("Over-used in September 2026: 4.58 h");
  });
});
