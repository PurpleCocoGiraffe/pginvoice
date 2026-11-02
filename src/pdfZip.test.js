import { describe, it, expect } from "vitest";
import { pageBreaks, allocateTasks, planClientPdfs } from "./pdfZip.js";
import { buildPrintHtml } from "./printTemplate.js";

describe("pageBreaks", () => {
  it("keeps a short document on one page", () => {
    expect(pageBreaks(300, 1000, [100, 200, 300])).toEqual([[0, 300]]);
  });
  it("cuts on the last row boundary that fits", () => {
    expect(pageBreaks(2500, 1000, [400, 900, 1100, 1800, 2100, 2500])).toEqual([[0, 900], [900, 1800], [1800, 2500]]);
  });
  it("cuts mid-row only when a row is taller than a page", () => {
    expect(pageBreaks(2500, 1000, [2500])).toEqual([[0, 1000], [1000, 2000], [2000, 2500]]);
  });
});

describe("allocateTasks", () => {
  it("fills invoices largest task first and splits the straddling task", () => {
    const parts = allocateTasks(new Map([["A", 120], ["B", 60], ["C", 30]]), [2.5, 1]);
    expect([...parts[0].tasks]).toEqual([["A", 120], ["B (part)", 30]]);
    expect([...parts[1].tasks]).toEqual([["B (part)", 30], ["C", 30]]);
    expect(parts.map((p) => p.minutes)).toEqual([150, 60]);
  });
  it("scales tracked time to the billable invoice hours", () => {
    const parts = allocateTasks(new Map([["A", 100], ["B", 100]]), [1, 1]); // 200 tracked min vs 120 billable
    expect(parts.map((p) => p.minutes)).toEqual([100, 100]);
  });
});

const task = (name, min) => ({ name, displayName: name, worked: min / 60, billableWorked: min / 60, tasksAll: new Map([["Work", min]]), type: "hourly" });

describe("planClientPdfs", () => {
  it("puts each client in a folder and nested rows in sub-folders", () => {
    const parent = task("Apex Energy", 60);
    const sub = task("Apex Comms Website (QP)", 30);
    const plan = planClientPdfs([parent, task("A/B Co", 10)], (n) => (n === "Apex Energy" ? [sub] : []), "October 2026");
    expect(plan.map((e) => e.path)).toEqual([
      "Apex Energy/Apex Energy - October 2026.pdf",
      "Apex Energy/Apex Comms Website (QP)/Apex Comms Website (QP) - October 2026.pdf",
      "A-B Co/A-B Co - October 2026.pdf",
    ]);
  });
  it("splits Clarke Energy (CEA) into one PDF per capped invoice", () => {
    const cea = task("Clarke Energy (CEA)", 80 * 60); // 80 h x $190 = $15,200 -> 2 invoices
    const plan = planClientPdfs([cea], () => [], "October 2026");
    expect(plan.map((e) => e.path)).toEqual([
      "Clarke Energy (CEA)/Clarke Energy (CEA) - October 2026.pdf",
      "Clarke Energy (CEA)/Clarke Energy (CEA) - October 2026 - Invoice 1 of 2.pdf",
      "Clarke Energy (CEA)/Clarke Energy (CEA) - October 2026 - Invoice 2 of 2.pdf",
    ]);
    expect(plan[1].client.invoicePart.line.amount).toBe(10000);
    expect(plan[2].client.invoicePart.line.amount).toBe(5200);
    expect(plan[1].client.workedFiltered + plan[2].client.workedFiltered).toBeCloseTo(80);    // Each invoice's own PDF shows hours only: no rate, amount or dollar cap (Nov 2026).
    for (const e of plan) {
      const body = buildPrintHtml(e.client, "October 2026", null).split("<body>")[1].replace(/<script>[\s\S]*?<\/script>/, "");
      expect(body).not.toMatch(/\$\d/);
    }
  });
  it("leaves Clarke Energy (CEA) as one PDF under the cap", () => {
    expect(planClientPdfs([task("Clarke Energy (CEA)", 600)], () => [], "October 2026")).toHaveLength(1);
  });
  it("gives a rolled-up client's other cost centres their own folders, splitting any over the cap", () => {
    const item = (name, h) => ({ name, hours: h, billableHours: h, tasksByUser: new Map([["Holly", new Map([[`${name} work`, h * 60]])]]) });
    const cea = { ...task("Clarke Energy (CEA)", 107 * 60), costCentre: { lineItems: [item("Clarke Energy (CEA)", 73.55), item("CEA V8s 2026", 33.17), item("CEA AEP 2027", 0.33)] } };
    const plan = planClientPdfs([cea], () => [], "October 2026");
    expect(plan.map((e) => e.path)).toEqual([
      "Clarke Energy (CEA)/Clarke Energy (CEA) - October 2026.pdf",
      "Clarke Energy (CEA)/Clarke Energy (CEA) - October 2026 - Invoice 1 of 2.pdf",
      "Clarke Energy (CEA)/Clarke Energy (CEA) - October 2026 - Invoice 2 of 2.pdf",
      "Clarke Energy (CEA)/CEA V8s 2026/CEA V8s 2026 - October 2026.pdf",
      "Clarke Energy (CEA)/CEA AEP 2027/CEA AEP 2027 - October 2026.pdf",
    ]);
    expect(plan[1].client.displayName).toBe("Clarke Energy (CEA)");
    expect(plan.slice(1, 3).map((e) => e.client.invoicePart.line.amount)).toEqual([10000, 3974.5]);
    expect(plan[3].client.workedFiltered).toBeCloseTo(33.17);
  });
  it("gives every sibling folder its own folder when the client has no umbrella folder", () => {
    const item = (name, h) => ({ name, hours: h, billableHours: h, tasksByUser: new Map([["A", new Map([["x", h * 60]])]]) });
    const magain = { ...task("Magain Real Estate", 600), costCentre: { lineItems: [item("Magain Agent One", 6), item("Magain", 4)] } };
    expect(planClientPdfs([magain], () => [], "October 2026").map((e) => e.path)).toEqual([
      "Magain Real Estate/Magain Real Estate - October 2026.pdf",
      "Magain Real Estate/Magain Agent One/Magain Agent One - October 2026.pdf",
      "Magain Real Estate/Magain/Magain - October 2026.pdf",
    ]);
  });
});
