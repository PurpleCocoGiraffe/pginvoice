import { describe, it, expect } from "vitest";
import { pageBreaks, pdfFileNames } from "./pdfZip.js";

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

describe("pdfFileNames", () => {
  it("makes safe, unique names", () => {
    expect(pdfFileNames([{ displayName: "A/B Co" }, { displayName: "X" }, { displayName: "x" }], "October 2026"))
      .toEqual(["A-B Co - October 2026.pdf", "X - October 2026.pdf", "x - October 2026 (2).pdf"]);
  });
});
