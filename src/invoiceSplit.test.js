import { describe, it, expect } from "vitest";
import { splitInvoice, costCentreInvoicesFor, invoiceCapRuleFor, invoiceLineLabel, INVOICE_CAP_RULES } from "./invoiceSplit.js";
import { buildSummaryText } from "./clientSummary.js";
import { buildPrintHtml } from "./printTemplate.js";

const RULE = { rate: 190, cap: 10000 };
const sumHours = (lines) => Math.round(lines.reduce((a, l) => a + l.hours * 10000, 0)) / 10000;
const sumCents = (lines) => lines.reduce((a, l) => a + Math.round(l.amount * 100), 0);

describe("splitInvoice: no invoice above the cap", () => {
  it("127.55 h @ $190 ($24,234.50) -> two full $10,000 invoices + the remainder", () => {
    const lines = splitInvoice(127.55, RULE);
    expect(lines).toEqual([
      { hours: 52.6316, amount: 10000 },
      { hours: 52.6316, amount: 10000 },
      { hours: 22.2868, amount: 4234.5 },
    ]);
    expect(sumHours(lines)).toBe(127.55);
    expect(sumCents(lines)).toBe(2423450);
  });
  it("under the cap is a single invoice", () => {
    expect(splitInvoice(10, RULE)).toEqual([{ hours: 10, amount: 1900 }]);
  });
  it("0 h is one empty invoice, never a split", () => {
    expect(splitInvoice(0, RULE)).toEqual([{ hours: 0, amount: 0 }]);
    expect(splitInvoice(null, RULE)).toEqual([{ hours: 0, amount: 0 }]);
  });
  it("exactly the cap stays one invoice", () => {
    expect(splitInvoice(10000 / 190, RULE)).toHaveLength(1);
    expect(splitInvoice(10000 / 190, RULE)[0].amount).toBe(10000);
  });
  it("exactly two caps is two full invoices, no zero-dollar third", () => {
    const lines = splitInvoice(20000 / 190, RULE);
    expect(lines.map((l) => l.amount)).toEqual([10000, 10000]);
  });
  it("every amount is <= cap, in whole cents, and the lines add back up exactly", () => {
    for (const h of [52.64, 105.27, 116.8, 333.33, 999.99, 0.01]) {
      const lines = splitInvoice(h, RULE);
      for (const l of lines) {
        expect(l.amount).toBeLessThanOrEqual(10000);
        expect(Math.round(l.amount * 100)).toBeCloseTo(l.amount * 100, 6);
      }
      expect(sumHours(lines)).toBe(Math.round(h * 10000) / 10000);
      expect(sumCents(lines)).toBe(Math.round(h * 190 * 100));
    }
  });
  it("labels each line as 'Invoice i of n'", () => {
    const lines = splitInvoice(127.55, RULE);
    expect(invoiceLineLabel(lines[0], 0, 3)).toBe("Invoice 1 of 3: 52.63 h · $10,000.00");
    expect(invoiceLineLabel(lines[2], 2, 3)).toBe("Invoice 3 of 3: 22.29 h · $4,234.50");
  });
});

// Clarke Energy (CEA), Sep 2026: its own folder carried 116.8 billable hours ($22,192).
const clarke = (over = {}) => ({
  name: "Clarke Energy (CEA)", displayName: "Clarke Energy (CEA)", type: "hourly",
  worked: 127.6, billableWorked: 127.6,
  tasksAll: new Map([["T", 7656]]), tasksFiltered: new Map([["T", 7656]]), workedFiltered: 127.6,
  taskUsers: new Map(), userMinutes: new Map(),
  costCentre: { lineItems: [
    { name: "Clarke Energy (CEA)", hours: 116.8, billableHours: 116.8, tasksByUser: new Map() },
    { name: "CEA WAME 2026", hours: 10.8, billableHours: 10.8, tasksByUser: new Map() },
  ], accrualFolderNames: ["Clarke Energy", "CEA WAME 2026"] },
  ...over,
});

describe("Clarke Energy: per-cost-centre invoices", () => {
  it("is configured at $190/h, $10,000 cap", () => {
    expect(INVOICE_CAP_RULES["Clarke Energy (CEA)"]).toEqual({ rate: 190, cap: 10000 });
    expect(invoiceCapRuleFor({ name: "Apex Energy", displayName: "Apex Energy" })).toBe(null);
    // a sub-project nested under Clarke is one of its cost centres too
    expect(invoiceCapRuleFor({ name: "CEA Thing", displayName: "CEA Thing", costCentreParentAccName: "Clarke Energy (CEA)" })).toEqual(RULE);
  });
  it("splits only the cost centre over the cap", () => {
    const inv = costCentreInvoicesFor(clarke());
    expect(inv.map((i) => [i.name, i.amount, i.lines.length])).toEqual([
      ["Clarke Energy (CEA)", 22192, 3],
      ["CEA WAME 2026", 2052, 1],
    ]);
    expect(inv[0].lines.map((l) => l.amount)).toEqual([10000, 10000, 2192]);
  });
  it("bills from billable hours, not the displayed (toggle-following) hours", () => {
    const c = clarke({ costCentre: { lineItems: [{ name: "Clarke Energy (CEA)", hours: 60, billableHours: 50, tasksByUser: new Map() }] } });
    expect(costCentreInvoicesFor(c)[0].amount).toBe(9500);
  });
  it("a month that isn't rolled up is one cost centre: the row itself", () => {
    const inv = costCentreInvoicesFor(clarke({ costCentre: null, billableWorked: 60 }));
    expect(inv).toHaveLength(1);
    expect(inv[0].amount).toBe(11400);
    expect(inv[0].lines).toHaveLength(2);
  });
  it("other clients get no invoice section", () => {
    expect(costCentreInvoicesFor(clarke({ name: "Apex Energy", displayName: "Apex Energy" }))).toBe(null);
  });
  it("the copy summary lists every cost centre and the split", () => {
    const text = buildSummaryText(clarke(), { invoiceMonth: "September 2026" });
    expect(text).toContain("Invoices by cost centre");
    expect(text).toContain("Clarke Energy (CEA): 116.80 h · $22,192.00");
    expect(text).toContain("Invoice 1 of 3: 52.63 h · $10,000.00");
    expect(text).toContain("Invoice 3 of 3: 11.54 h · $2,192.00");
    expect(text).toContain("CEA WAME 2026: 10.80 h · $2,052.00");
    expect(text).not.toContain("Invoice 1 of 1");
  });
  it("the PDF lists the cost centres and the split", () => {
    const html = buildPrintHtml(clarke(), "September 2026", "August 2026");
    expect(html).toContain("Invoices by cost centre");
    expect(html).toContain("Invoice 2 of 3: 52.63 h · $10,000.00");
    expect(html).toContain("$2,052.00");
  });
  it("a non-capped client's PDF has no invoice section", () => {
    const html = buildPrintHtml(clarke({ name: "Apex Energy", displayName: "Apex Energy" }), "September 2026", "");
    expect(html).not.toContain("Invoices by cost centre");
  });
});
