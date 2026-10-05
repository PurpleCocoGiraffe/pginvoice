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

describe("parseClickupCsv space filtering", () => {
  it("marks rows from non-client spaces internal + nonClientSpace, keeps client spaces", async () => {
    const { parseClickupCsv } = await import("./parsers.js");
    const csv = [
      "Folder Name,Task Name,Time Tracked,Billable,Username,Start Text,Space ID",
      "Clarke Energy,Artwork,3600000,TRUE,Vinavie,\"10/01/2026, 9:00:00 AM ACST\",90167546842",
      "CRM,Deal follow-up,1800000,FALSE,Kelly,\"10/01/2026, 9:00:00 AM ACST\",90167737049",
    ].join("\n");
    const out = await new Promise((resolve, reject) => parseClickupCsv(csv, resolve, reject));
    const byFolder = Object.fromEntries(out.rows.map((r) => [r.folder, r]));
    expect(byFolder["Clarke Energy"]).toMatchObject({ isInternal: false, nonClientSpace: false });
    expect(byFolder["CRM"]).toMatchObject({ isInternal: true, nonClientSpace: true });
  });
});
