import { describe, it, expect } from "vitest";
import { parseHeaderToMonth } from "./parsers.js";

describe("parseHeaderToMonth", () => {
  it("reads an accrued balance column", () => {
    expect(parseHeaderToMonth("Aug 26 Accrued")).toMatchObject({ year: 2026, month: 7 });
  });
  // Regression: Client Accruals' export adds "<Mon YY> Reset (macro sheet)" to the right of
  // the month's Accrued column; read as a balance column it won the rightmost-duplicate rule
  // and blanked every non-reset client's August balance on re-import.
  it("ignores the macro-sheet reset column", () => {
    expect(parseHeaderToMonth("Aug 26 Reset (macro sheet)")).toBeNull();
  });
});
