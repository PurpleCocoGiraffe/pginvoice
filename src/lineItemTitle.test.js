import { describe, it, expect } from "vitest";
import { lineItemTitle, lineItemClient, buildPrintHtml } from "./printTemplate.js";

// A cost centre's own PDF heading must not repeat the client's name (Vegetation Solutions
// came out as "Vegetation Solutions — Vegetation Solutions - Firewood Solutions") and must
// never use an em dash.
describe("lineItemTitle", () => {
  it("uses a folder that already starts with the client's name as-is", () => {
    expect(lineItemTitle("Vegetation Solutions", "Vegetation Solutions - Firewood Solutions")).toBe("Vegetation Solutions - Firewood Solutions");
    expect(lineItemTitle("Vegetation Solutions", "Vegetation Solutions - MVS")).toBe("Vegetation Solutions - MVS");
    expect(lineItemTitle("Warrina Homes", "Warrina Homes - Outsourced Marketing")).toBe("Warrina Homes - Outsourced Marketing");
    expect(lineItemTitle("Majestic Plumbing", "Majestic Plumbing (WA)")).toBe("Majestic Plumbing (WA)");
    expect(lineItemTitle("Zest", "Zest WA Outsourced Marketing")).toBe("Zest WA Outsourced Marketing");
    expect(lineItemTitle("Coonawarra", "coonawarra strategy")).toBe("coonawarra strategy");
  });
  it("swaps a leading initials prefix for the client's name", () => {
    expect(lineItemTitle("Majestic Plumbing", "MP - Commercial Leak Tech (WA)")).toBe("Majestic Plumbing - Commercial Leak Tech (WA)");
  });
  it("prefixes any other folder with the client's name, joined by a plain hyphen", () => {
    expect(lineItemTitle("Brisbane Alarm Monitoring", "BAMSS Childcare Security Services")).toBe("Brisbane Alarm Monitoring - BAMSS Childcare Security Services");
    // A longer word that merely starts with the name is not the name.
    expect(lineItemTitle("Zest", "Zesty Foods")).toBe("Zest - Zesty Foods");
  });
  it("never produces an em dash in the PDF heading or notes", () => {
    const li = lineItemClient({ displayName: "Vegetation Solutions", name: "Vegetation Solutions" },
      { name: "Vegetation Solutions - Firewood Solutions", tasksByUser: new Map([["A", new Map([["Task", 60]])]]), hours: 1 }, null);
    expect(li.displayName).toBe("Vegetation Solutions - Firewood Solutions");
    const body = buildPrintHtml(li, "October 2026", null).split("<body>")[1].replace(/<script>[\s\S]*?<\/script>/, "");
    expect(body).not.toMatch(/—| -- /);
  });
});
