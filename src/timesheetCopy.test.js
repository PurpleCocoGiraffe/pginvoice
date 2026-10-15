import { describe, it, expect } from "vitest";
import { buildXeroTimesheetText } from "./timesheetCopy.js";

describe("buildXeroTimesheetText -- month copy for the Xero extension", () => {
  it("one 'D Mon-H.HH' line per day with time, in date order", () => {
    const daily = new Map([["2026-10-21", 459], ["2026-10-20", 391.8], ["2026-10-01", 456]]);
    expect(buildXeroTimesheetText("2026-10", daily)).toBe("1 Oct-7.60\n20 Oct-6.53\n21 Oct-7.65");
  });
  it("skips days with no time, and days from other months", () => {
    const daily = new Map([["2026-10-05", 0], ["2026-11-01", 60], ["2026-10-31", 30]]);
    expect(buildXeroTimesheetText("2026-10", daily)).toBe("31 Oct-0.50");
  });
  it("is empty with no month or no time", () => {
    expect(buildXeroTimesheetText("", new Map())).toBe("");
    expect(buildXeroTimesheetText("2026-02", new Map())).toBe("");
  });
});
