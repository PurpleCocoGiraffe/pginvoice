import { describe, it, expect } from "vitest";
import {
  cellKind, hasLedgerFigure, normalizeRange, MAX_RANGE_MONTHS, agreedForMonth, agreedLabel, latestCarry,
  filterClients, sortClients, ledgerHealth, watchReasons, carryInto, notInvoicedBalance, monthActions,
  resetKind, accrualsWorkbookRows,
} from "./accrualsView.js";
import { rowsToClients, replayClientAccruals, NOT_INVOICED_NOTE, WRAP_UP_NOTE } from "./accrualsSync.js";
import { HOURLY_SETTLEMENT_NOTE } from "./format.js";

// Client Accruals Management display rules. Several pin bugs the old inline component had:
// a 0 balance (or a write-off to 0, or a settled hourly month) hid the client, the Agreed
// column showed today's package for every month, a reversed range built 240 columns.

const cell = (o = {}) => ({
  accrualValue: null, accrualNote: null, pct: null, comment: null, workedHours: null, isOverride: false,
  hoursFlagged: false, flaggedFromHours: null, agreedHpm: null, resetValue: null, resetNote: null, ...o,
});
const client = (name, months, extra = {}) => ({ client: name, manager: null, agreedHpm: null, months, ...extra });

describe("cellKind", () => {
  it("names every kind of ledger entry", () => {
    expect(cellKind(undefined)).toBeNull();
    expect(cellKind(cell({ accrualValue: 2 }))).toBe("computed");
    expect(cellKind(cell({ isOverride: true, accrualValue: 4.58, accrualNote: NOT_INVOICED_NOTE }))).toBe("not_invoiced");
    expect(cellKind(cell({ isOverride: true, accrualValue: 12 }))).toBe("sheet");
    expect(cellKind(cell({ accrualValue: 0, accrualNote: HOURLY_SETTLEMENT_NOTE }))).toBe("settlement");
    expect(cellKind(cell({ accrualValue: -5, accrualNote: WRAP_UP_NOTE }))).toBe("wrap_up");
    expect(cellKind(cell({ accrualValue: -3, accrualNote: "On hold — accrual paused" }))).toBe("on_hold");
    expect(cellKind(cell({ accrualNote: "Client offboarded" }))).toBe("ended");
    expect(cellKind(cell({ accrualNote: "Not on a package this month" }))).toBe("off_package");
  });

  it("tells a macro-sheet reset from a write-off", () => {
    expect(resetKind("2026-08", cell({ resetValue: -13.41 }))).toBe("macro");
    expect(resetKind("2026-09", cell({ resetValue: 0 }))).toBe("write_off");
    expect(resetKind("2026-09", cell())).toBeNull();
  });
});

describe("hasLedgerFigure — 0 is a real figure", () => {
  it("keeps a 0 balance and a reset to 0", () => {
    expect(hasLedgerFigure(cell({ accrualValue: 0 }))).toBe(true);
    expect(hasLedgerFigure(cell({ resetValue: 0 }))).toBe(true);
    expect(hasLedgerFigure(cell({ accrualNote: "Client offboarded" }))).toBe(false);
    expect(hasLedgerFigure(undefined)).toBe(false);
  });
});

describe("normalizeRange", () => {
  it("swaps a reversed range and caps its length", () => {
    expect(normalizeRange("2026-10", "2026-08")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(normalizeRange("2010-01", "2026-12")).toHaveLength(MAX_RANGE_MONTHS);
  });
});

describe("agreed hours per month (stale-scalar regression)", () => {
  // Warrina Homes: 24 h until Aug 2026, then 13 h. The client-level agreedHpm scalar is
  // whatever row rowsToClients scanned last -- it must never drive a month's figure.
  const rows = [
    { client: "Warrina Homes", account_manager: null, agreed_hpm: "24", month_key: "2026-07", accrual_value: 1, accrual_note: null, pct_over_under: null, comment: null, worked_hours: 25, is_override: false, hours_flagged: false, flagged_from_hours: null, reset_value: null, reset_note: null },
    { client: "Warrina Homes", account_manager: null, agreed_hpm: "13", month_key: "2026-08", accrual_value: 2, accrual_note: null, pct_over_under: null, comment: null, worked_hours: 14, is_override: false, hours_flagged: false, flagged_from_hours: null, reset_value: null, reset_note: null },
    { client: "Warrina Homes", account_manager: null, agreed_hpm: null, month_key: "2026-09", accrual_value: null, accrual_note: "Client offboarded", pct_over_under: null, comment: null, worked_hours: null, is_override: false, hours_flagged: false, flagged_from_hours: null, reset_value: null, reset_note: null },
  ];
  const [w] = rowsToClients(rows);

  it("reads each month's own row", () => {
    expect(w.agreedHpm).toBe("13"); // the stale scalar exists...
    expect(agreedForMonth(w, "2026-07")).toBe(24); // ...and is not used
    expect(agreedForMonth(w, "2026-09")).toBeNull();
    expect(agreedForMonth(w, "2026-10")).toBeNull(); // no row: no figure, not the scalar
  });

  it("shows a change inside the range", () => {
    expect(agreedLabel(w, ["2026-07", "2026-08", "2026-09"])).toBe("24 → 13");
    expect(agreedLabel(w, ["2026-09"])).toBe("—");
  });

  it("a not-invoiced month (agreed stored as 0) is not a package figure", () => {
    const c = client("Comunet", { "2026-09": cell({ isOverride: true, accrualNote: NOT_INVOICED_NOTE, agreedHpm: "0", accrualValue: 4.58 }) });
    expect(agreedForMonth(c, "2026-09")).toBeNull();
  });
});

describe("filterClients", () => {
  const months = ["2026-10"];
  const statuses = { Settled: "active", Offboarded: "offboarded", WrapUp: "offboarded", Flagged: "active" };
  const statusOf = (name, mk) => (name in statuses ? (mk ? (name === "Offboarded" || name === "WrapUp" ? "offboarded" : "active") : statuses[name]) : null);
  const list = [
    client("Settled", { "2026-10": cell({ accrualValue: 0, accrualNote: HOURLY_SETTLEMENT_NOTE }) }),
    client("Offboarded", { "2026-10": cell({ accrualNote: "Client offboarded" }) }),
    client("WrapUp", { "2026-10": cell({ accrualValue: -4, accrualNote: WRAP_UP_NOTE }) }),
    client("Flagged", { "2026-10": cell({ accrualValue: 3, hoursFlagged: true }) }),
    client("Orphan", { "2026-10": cell({ accrualValue: -2 }) }),
  ];
  const names = (o) => filterClients(list, { months, statusOf, ...o }).map((c) => c.client);

  it("keeps a settled (0) month, a wrap-up drawdown and an unmatched client; drops a month with no figure", () => {
    expect(names()).toEqual(["Settled", "WrapUp", "Flagged", "Orphan"]);
  });

  it("current-status filters still work, and never hide an unmatched client", () => {
    expect(names({ statusFilter: "offboarded" })).toEqual(["WrapUp", "Orphan"]);
    expect(names({ statusFilter: "active" })).toEqual(["Settled", "Flagged", "Orphan"]);
  });

  it("sign and view filters", () => {
    expect(names({ signFilter: "negative" })).toEqual(["WrapUp", "Orphan"]);
    expect(names({ signFilter: "positive" })).toEqual(["Flagged"]);
    expect(names({ view: "flagged" })).toEqual(["Flagged"]);
    expect(names({ view: "watch", watchFor: (c) => (c.client === "Orphan" ? [{ kind: "x" }] : []) })).toEqual(["Orphan"]);
  });
});

describe("sortClients / latestCarry", () => {
  const months = ["2026-09", "2026-10"];
  const a = client("A", { "2026-10": cell({ accrualValue: -10 }) });
  const b = client("B", { "2026-10": cell({ accrualValue: 4 }) });
  const c = client("C", { "2026-09": cell({ accrualValue: 30, resetValue: 0 }) }); // written off to 0

  it("uses the carry-out (reset over accrual)", () => {
    expect(latestCarry(c, months)).toEqual({ monthKey: "2026-09", value: 0 });
  });

  it("sorts by balance", () => {
    expect(sortClients([a, b, c], "largest", months).map((x) => x.client)).toEqual(["A", "B", "C"]);
    expect(sortClients([a, b, c], "over", months).map((x) => x.client)).toEqual(["B", "C", "A"]);
    expect(sortClients([a, b, c], "under", months).map((x) => x.client)).toEqual(["A", "C", "B"]);
    expect(sortClients([c, b, a], "name", months).map((x) => x.client)).toEqual(["A", "B", "C"]);
  });
});

describe("ledgerHealth — owed and over never net out", () => {
  it("sums each side separately", () => {
    const list = [
      client("Over", { "2026-10": cell({ accrualValue: 10 }) }),
      client("Under", { "2026-10": cell({ accrualValue: -10, hoursFlagged: true }) }),
    ];
    const h = ledgerHealth(list, ["2026-10"], { watchFor: (x) => (x.client === "Over" ? [{}] : []) });
    expect(h).toMatchObject({ owedToClients: 10, owedToClientsCount: 1, owedByClients: 10, owedByClientsCount: 1, flagged: 1, watch: 1 });
  });
});

describe("watchReasons", () => {
  it("flags a balance growing the same way three months running", () => {
    const c = client("Grow", {
      "2026-08": cell({ accrualValue: -2, agreedHpm: "20" }),
      "2026-09": cell({ accrualValue: -5, agreedHpm: "20" }),
      "2026-10": cell({ accrualValue: -9, agreedHpm: "20" }),
    });
    expect(watchReasons(c, "2026-10").map((r) => r.kind)).toEqual(["trend"]);
    // Broken by a gap month: no trend.
    const gap = client("Gap", { "2026-07": cell({ accrualValue: -2 }), "2026-09": cell({ accrualValue: -5 }), "2026-10": cell({ accrualValue: -9 }) });
    expect(watchReasons(gap, "2026-10").map((r) => r.kind)).toEqual([]);
  });

  it("flags a balance of a month of package or more, and unacknowledged hours changes", () => {
    const c = client("Big", { "2026-10": cell({ accrualValue: 21, agreedHpm: "20", hoursFlagged: true }) });
    expect(watchReasons(c, "2026-10").map((r) => r.kind)).toEqual(["large", "flags"]);
    // A not-invoiced month has agreed 0 -- falls back to the profile figure passed in.
    const ni = client("NI", { "2026-10": cell({ isOverride: true, accrualNote: NOT_INVOICED_NOTE, agreedHpm: "0", accrualValue: -12 }) });
    expect(watchReasons(ni, "2026-10").map((r) => r.kind)).toEqual([]);
    expect(watchReasons(ni, "2026-10", { agreedFallback: 10 }).map((r) => r.kind)).toEqual(["large"]);
  });
});

describe("not-invoiced balance (Comunet, Sep 2026)", () => {
  it("is the month's worked hours against the balance carried in", () => {
    const c = client("Comunet", {
      "2026-08": cell({ accrualValue: -1.8 }),
      "2026-09": cell({ accrualValue: -9.42, workedHours: 6.38, agreedHpm: "16" }),
    });
    expect(carryInto(c, "2026-09")).toBe(-1.8);
    expect(notInvoicedBalance(c, "2026-09")).toBe(4.58);
  });

  it("uses a reset as the carry in", () => {
    const c = client("X", { "2026-08": cell({ accrualValue: 5, resetValue: 0 }), "2026-09": cell({ workedHours: 3 }) });
    expect(notInvoicedBalance(c, "2026-09")).toBe(3);
  });
});

describe("monthActions", () => {
  it("offers only what fits the month", () => {
    const c = client("C", {
      "2026-08": cell({ accrualValue: -13.41, resetValue: -13.41, agreedHpm: "24" }),
      "2026-09": cell({ accrualValue: 27.16, resetValue: 0, agreedHpm: "24" }),
      "2026-10": cell({ accrualValue: 1.15, agreedHpm: "24", hoursFlagged: true }),
      "2026-11": cell({ isOverride: true, accrualNote: NOT_INVOICED_NOTE, agreedHpm: "0", accrualValue: 2 }),
      "2026-12": cell({ isOverride: true, accrualValue: 5, agreedHpm: "24" }),
    });
    expect(monthActions(c, "2026-08")).toEqual(["not_invoiced"]); // macro reset: never removed here
    expect(monthActions(c, "2026-09")).toEqual(["not_invoiced", "remove_write_off"]);
    expect(monthActions(c, "2026-10")).toEqual(["acknowledge", "not_invoiced", "write_off"]);
    expect(monthActions(c, "2026-11")).toEqual(["undo_not_invoiced", "write_off"]);
    expect(monthActions(c, "2026-12")).toEqual(["write_off"]); // historical sheet figure
  });
});

describe("accrualsWorkbookRows", () => {
  it("adds entry and reset columns only where needed, with the reason; agreed from the month's own row", () => {
    const c = client("Coonawarra", {
      "2026-09": cell({ accrualValue: 27.16, workedHours: 40, agreedHpm: "24", resetValue: 0, resetNote: "Write-off: Lynda's request" }),
      "2026-10": cell({ accrualValue: 1.15, workedHours: 25.15, agreedHpm: "24" }),
    }, { agreedHpm: "99" });
    const s = client("Treasure Boxes", { "2026-10": cell({ accrualValue: 0, accrualNote: HOURLY_SETTLEMENT_NOTE, workedHours: 6.33 }) });
    const { aoa, cols } = accrualsWorkbookRows([c, s], ["2026-09", "2026-10"]);
    const header = aoa[2];
    expect(header.filter((h) => /Balance reset|Reset reason/.test(h))).toHaveLength(2);
    expect(header.some((h) => /macro sheet/i.test(h))).toBe(false);
    expect(header.filter((h) => /Entry$/.test(h))).toHaveLength(1); // Oct only
    expect(cols).toHaveLength(header.length);
    const row = aoa[3];
    expect(row[1]).toBe(24); // never the "99" scalar
    expect(row).toContain("Write-off: Lynda's request");
    expect(aoa[4]).toContain("Hourly settlement");
    expect(aoa[4][1]).toBe(""); // hourly: no package figure
  });
});

describe("acknowledging a changed-hours flag sticks", () => {
  // acknowledgeHoursFlag clears hours_flagged and leaves the new hours stored; the next
  // replay must not raise it again (it compares stored vs fresh hours, which now agree).
  it("stays cleared until the hours move again", () => {
    const c = client("P", { "2026-09": cell({ accrualValue: 2, workedHours: 22, agreedHpm: "20" }) });
    const opts = (worked) => ({
      startMonth: "2026-09", cur: "2026-11", segFor: () => ({ type: "package", agreedHours: 20 }), statusFor: () => "active",
      workedMinutesFor: (mk) => (mk === "2026-09" ? worked * 60 : 0),
    });
    replayClientAccruals(c, opts(22));
    expect(c.months["2026-09"].hoursFlagged).toBe(false);
    replayClientAccruals(c, opts(24));
    expect(c.months["2026-09"].hoursFlagged).toBe(true);
    // acknowledged: flag cleared, stored hours already 24
    c.months["2026-09"] = { ...c.months["2026-09"], hoursFlagged: false, flaggedFromHours: null };
    replayClientAccruals(c, opts(24));
    expect(c.months["2026-09"].hoursFlagged).toBe(false);
    replayClientAccruals(c, opts(25));
    expect(c.months["2026-09"].hoursFlagged).toBe(true);
  });

  it("undoing a not-invoiced mark lets the replay recompute the month and heal agreed hours", () => {
    const c = client("Comunet", {
      "2026-08": cell({ accrualValue: -1.8, workedHours: 14.2, agreedHpm: "16" }),
      "2026-09": cell({ isOverride: false, accrualNote: null, accrualValue: 4.58, workedHours: 6.38, agreedHpm: "0" }),
    });
    const rows = replayClientAccruals(c, {
      startMonth: "2026-08", cur: "2026-09", segFor: () => ({ type: "package", agreedHours: 16 }), statusFor: () => "active",
      workedMinutesFor: (mk) => ({ "2026-08": 14.2, "2026-09": 6.38 }[mk] || 0) * 60,
    });
    const sep = rows.find((r) => r.month_key === "2026-09");
    expect(sep).toMatchObject({ accrual_value: -11.42, agreed_hpm: "16", is_override: false });
  });
});
