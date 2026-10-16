import { describe, it, expect, vi } from "vitest";

vi.mock("./supabaseClient.js", () => ({ supabase: {} }));

import {
  parseLegacyNameMap, legacyMatchesToMigrate, applyNameMatch, rowsToNameMap, withPendingMatches,
  isMissingTableError, CLEAR_MATCH,
} from "./nameMatchesSync.js";

describe("parseLegacyNameMap (the old per-browser 'pg-name-map-v1' value)", () => {
  it("reads a plain folder -> accrued name map", () => {
    expect(parseLegacyNameMap('{"Apex Social":"Apex","BAMSS":"Brisbane Alarm Monitoring"}'))
      .toEqual({ "Apex Social": "Apex", BAMSS: "Brisbane Alarm Monitoring" });
  });
  it("drops clears, blanks and non-strings; anything unreadable is empty", () => {
    expect(parseLegacyNameMap('{"A":"__none__","B":"","C":7,"  ":"X","D":"Dee"}')).toEqual({ D: "Dee" });
    for (const raw of [null, "", "not json", "[1,2]", "null", '"str"']) expect(parseLegacyNameMap(raw)).toEqual({});
  });
});

describe("legacyMatchesToMigrate (never let the local copy override the shared table)", () => {
  it("only folders the table has no row for", () => {
    const db = { BAMSS: "BAMSS Childcare Security Services" };
    const legacy = { BAMSS: "Brisbane Alarm Monitoring", "Apex Social": "Apex" };
    expect(legacyMatchesToMigrate(legacy, db)).toEqual([{ clickup_folder: "Apex Social", accrued_name: "Apex" }]);
  });
  it("a differently cased / spaced spelling of an existing folder counts as existing (the pipeline treats them as one)", () => {
    expect(legacyMatchesToMigrate({ " bamss ": "Other" }, { BAMSS: "BAMSS Childcare Security Services" })).toEqual([]);
  });
  it("two legacy spellings of one folder migrate once; invalid values never", () => {
    const rows = legacyMatchesToMigrate({ "Apex Social": "Apex", "apex social ": "Apex Energy", X: CLEAR_MATCH, Y: "" }, {});
    expect(rows).toEqual([{ clickup_folder: "Apex Social", accrued_name: "Apex" }]);
  });
  it("empty inputs -> nothing to insert", () => {
    expect(legacyMatchesToMigrate({}, {})).toEqual([]);
    expect(legacyMatchesToMigrate(null, null)).toEqual([]);
  });
});

describe("applyNameMatch / withPendingMatches / rowsToNameMap", () => {
  it("sets, replaces and clears without mutating", () => {
    const m = { A: "Apex" };
    expect(applyNameMatch(m, "B", "Bee")).toEqual({ A: "Apex", B: "Bee" });
    expect(applyNameMatch(m, "A", "Other")).toEqual({ A: "Other" });
    expect(applyNameMatch(m, "A", CLEAR_MATCH)).toEqual({});
    expect(m).toEqual({ A: "Apex" });
  });
  it("queued edits are laid over a freshly loaded map", () => {
    const pending = new Map([["A", CLEAR_MATCH], ["C", "Cee"]]);
    expect(withPendingMatches({ A: "Apex", B: "Bee" }, pending)).toEqual({ B: "Bee", C: "Cee" });
    expect(withPendingMatches({ A: "Apex" }, new Map())).toEqual({ A: "Apex" });
  });
  it("table rows -> map, ignoring anything that isn't a real match", () => {
    expect(rowsToNameMap([
      { clickup_folder: "A", accrued_name: "Apex" }, { clickup_folder: "B", accrued_name: "__none__" }, { clickup_folder: "", accrued_name: "X" },
    ])).toEqual({ A: "Apex" });
    expect(rowsToNameMap(null)).toEqual({});
  });
});

describe("isMissingTableError", () => {
  it("recognises 'table not deployed yet', nothing else", () => {
    expect(isMissingTableError({ code: "PGRST205", message: "Could not find the table 'public.pginvoice_name_matches' in the schema cache" })).toBe(true);
    expect(isMissingTableError({ code: "42P01", message: 'relation "pginvoice_name_matches" does not exist' })).toBe(true);
    expect(isMissingTableError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });
});
