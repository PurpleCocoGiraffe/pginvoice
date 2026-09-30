import { describe, it, expect, afterEach } from "vitest";
import {
  rowsToClients, buildReconciliationClients, parseAgreedHours,
  carryOutOf, replayClientAccruals, accrualFolderMinutesFor,
} from "./accrualsSync.js";
import { setDynamicCostCentres } from "./nameMatch.js";

// Regression coverage for two real production bugs found and fixed in this codebase's
// history (see accrualsSync.js's comments on agreedByMonth and rowsToClients' agreedHpm) --
// both were silent, both shipped to production before being caught by inspection rather
// than a test. Written so either bug reintroduces itself as a failing test, not a support
// ticket.

describe("parseAgreedHours", () => {
  it("extracts the first number, including from an annotated string", () => {
    expect(parseAgreedHours("24 (Aug)")).toBe(24);
    expect(parseAgreedHours("8 (increased to 10 Aug)")).toBe(8);
    expect(parseAgreedHours(16)).toBe(16);
    expect(parseAgreedHours(null)).toBeNull();
    expect(parseAgreedHours(undefined)).toBeNull();
  });
});

describe("buildReconciliationClients — per-month agreed hours (ARAS regression)", () => {
  // A client that was on package for a while, then moved to hourly -- e.g. ARAS, off
  // package since August 2026. The August row exists (recomputeAccruals ran and
  // determined "not on a package this month") but its agreed_hpm is null, distinct from
  // "no row for this month at all."
  const rows = [
    { client: "ARAS", account_manager: "Chloe James", agreed_hpm: "32", month_key: "2026-03", accrual_value: "4.7", accrual_note: null, pct_over_under: null, comment: null, worked_hours: null, is_override: true, hours_flagged: false },
    { client: "ARAS", account_manager: "Chloe James", agreed_hpm: null, month_key: "2026-08", accrual_value: null, accrual_note: "Not on a package this month", pct_over_under: null, comment: null, worked_hours: null, is_override: false, hours_flagged: false },
  ];

  it("keeps a covered-but-null month's agreed hours as null, not falling back to the stale client-level scalar", () => {
    const { clients } = buildReconciliationClients(rowsToClients(rows));
    const aras = clients.find((c) => c.name === "ARAS");
    // The client-level scalar is stale (picks up whichever row had a non-null agreed_hpm --
    // here, March's leftover "32") -- callers must never read it for a specific month.
    expect(aras.package).toBe(32);
    // But the August row itself explicitly has no package -- "in agreedByMonth" must be
    // true (a row exists) with value null, not simply absent (which would read as "no
    // data, fall back to package").
    expect("2026-08" in aras.agreedByMonth).toBe(true);
    expect(aras.agreedByMonth["2026-08"]).toBeNull();
    expect(aras.agreedByMonth["2026-03"]).toBe(32);
  });

  it("omits agreedByMonth entirely for a month with no row at all -- the one case a caller SHOULD fall back to the scalar for", () => {
    const { clients } = buildReconciliationClients(rowsToClients(rows));
    const aras = clients.find((c) => c.name === "ARAS");
    expect("2026-01" in aras.agreedByMonth).toBe(false);
  });
});

describe("rowsToClients — agreed_hpm is a stale client-level snapshot, never authoritative per month", () => {
  it("does not let a later null agreed_hpm row erase an earlier real one from the client-level scalar (documents existing last-write-wins behavior)", () => {
    // This is the exact shape that caused Amorim Cork/Warrina Homes/Apex Energy to show a
    // stuck, wrong package figure: whichever row happens to be scanned last with a non-null
    // agreed_hpm wins the client-level `agreedHpm`, regardless of which month is "current."
    // The fix was moving callers off this field for anything month-specific (see the test
    // above) -- this test just pins down that the field itself still behaves this way, so a
    // future edit doesn't quietly change rowsToClients' contract without the per-month
    // fallback logic being re-examined too.
    const rows = [
      { client: "Amorim Cork", agreed_hpm: "0", month_key: "2026-01", accrual_value: null, is_override: true },
      { client: "Amorim Cork", agreed_hpm: "16", month_key: "2026-09", accrual_value: "-47.92", is_override: false },
    ];
    const [client] = rowsToClients(rows);
    // Whichever row is scanned LAST with a truthy agreed_hpm wins -- here, September's 16.
    expect(client.agreedHpm).toBe("16");
    // Per-row data is still correct regardless -- this is what callers must use instead.
    expect(client.months["2026-01"].agreedHpm).toBe("0");
    expect(client.months["2026-09"].agreedHpm).toBe("16");
  });
});

// ------------------------------ August 2026 macro-sheet reset ------------------------------
// The legacy macro sheet's August closing accrual is stored as reset_value on the 2026-08
// row. It replaces our computed balance as the NEXT month's carry-in (every branch), but is
// never written by recompute and never overwrites the computed accrual_value itself.

const row = (client, month_key, extra = {}) => ({
  client, account_manager: null, agreed_hpm: "10", month_key, accrual_value: null, accrual_note: null,
  pct_over_under: null, comment: null, worked_hours: null, is_override: false, hours_flagged: false, ...extra,
});

describe("rowsToClients / buildReconciliationClients -- reset_value", () => {
  it("maps reset_value (including a real 0) and leaves it null when absent", () => {
    const [a, b] = rowsToClients([
      row("A", "2026-08", { accrual_value: "-3.5", reset_value: "-12.25", reset_note: "macro sheet" }),
      row("A", "2026-07", { accrual_value: "1" }),
      row("B", "2026-08", { accrual_value: "4", reset_value: 0 }),
    ]);
    expect(a.months["2026-08"].resetValue).toBe(-12.25);
    expect(a.months["2026-08"].resetNote).toBe("macro sheet");
    expect(a.months["2026-08"].accrualValue).toBe(-3.5); // computed figure untouched
    expect(a.months["2026-07"].resetValue).toBeNull();
    expect(b.months["2026-08"].resetValue).toBe(0);
  });

  it("carryOutOf prefers the reset, treats 0 as real, and falls back to the computed balance", () => {
    expect(carryOutOf({ accrualValue: -3.5, resetValue: -12.25 })).toBe(-12.25);
    expect(carryOutOf({ accrualValue: 4, resetValue: 0 })).toBe(0);
    expect(carryOutOf({ accrualValue: 4, resetValue: null })).toBe(4);
    expect(carryOutOf({ accrualValue: 4 })).toBe(4); // manual-upload / pre-migration cell shape
    expect(carryOutOf({ accrualValue: null, resetValue: null })).toBeNull();
    expect(carryOutOf(undefined)).toBeNull();
  });

  it("exposes carry-out as `balances`, plus the system figure and the reset separately", () => {
    const { clients } = buildReconciliationClients(rowsToClients([
      row("A", "2026-07", { accrual_value: "1" }),
      row("A", "2026-08", { accrual_value: "-3.5", reset_value: "-12.25" }),
      row("B", "2026-08", { accrual_value: "4", reset_value: "0" }),
    ]));
    const [a, b] = clients;
    expect(a.balances).toEqual({ "2026-07": 1, "2026-08": -12.25 });
    expect(a.computedBalances).toEqual({ "2026-07": 1, "2026-08": -3.5 });
    expect(a.resets).toEqual({ "2026-08": -12.25 });
    expect(b.balances["2026-08"]).toBe(0);
    expect(b.resets["2026-08"]).toBe(0);
  });
});

describe("replayClientAccruals -- chaining through a reset", () => {
  const PKG = { type: "package", agreedHours: 10 };
  const HOURLY = { type: "hourly", agreedHours: null };
  // worked hours per month (in minutes for the replay API)
  const minutes = (byMonth) => (mk) => (byMonth[mk] || 0) * 60;
  const client = (months) => ({ client: "A", manager: null, agreedHpm: "10", months });
  const run = (c, { segFor = () => PKG, statusFor = () => "active", worked = {}, cur = "2026-10", startMonth = "2026-07" } = {}) =>
    replayClientAccruals(c, { startMonth, cur, segFor, statusFor, workedMinutesFor: minutes(worked) });

  const WORKED = { "2026-07": 12, "2026-08": 7, "2026-09": 13, "2026-10": 6 };

  it("with no reset anywhere, behaviour is unchanged (plain worked - agreed + prior chain)", () => {
    const c = client({ "2026-07": { accrualValue: null, workedHours: null } });
    run(c, { worked: WORKED });
    expect(c.months["2026-07"].accrualValue).toBe(2);
    expect(c.months["2026-08"].accrualValue).toBe(-1);
    expect(c.months["2026-09"].accrualValue).toBe(2);
    expect(c.months["2026-10"].accrualValue).toBe(-2);
  });

  it("Sep = worked - agreed + Aug reset; Aug keeps its own computed figure; Oct chains off Sep", () => {
    const c = client({ "2026-07": {}, "2026-08": { accrualValue: null, resetValue: -20 } });
    run(c, { worked: WORKED });
    expect(c.months["2026-08"].accrualValue).toBe(-1); // system figure still computed
    expect(c.months["2026-08"].resetValue).toBe(-20); // and the reset kept on the rebuilt cell
    expect(c.months["2026-09"].accrualValue).toBe(13 - 10 - 20);
    expect(c.months["2026-10"].accrualValue).toBe(6 - 10 + (13 - 10 - 20));
  });

  it("a reset of 0 is honoured (not treated as absent)", () => {
    const c = client({ "2026-07": {}, "2026-08": { resetValue: 0 } });
    run(c, { worked: WORKED });
    expect(c.months["2026-09"].accrualValue).toBe(3);
  });

  it("a second pass in the same session is idempotent and keeps resetValue", () => {
    const c = client({ "2026-07": {}, "2026-08": { resetValue: -20, resetNote: "macro" } });
    const firstRows = run(c, { worked: WORKED });
    expect(firstRows.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(JSON.stringify(c.months));
    const secondRows = run(c, { worked: WORKED });
    expect(secondRows).toEqual([]);
    expect(c.months).toEqual(snapshot);
    expect(c.months["2026-08"].resetValue).toBe(-20);
    expect(c.months["2026-08"].resetNote).toBe("macro");
  });

  it("never emits reset_value/reset_note in upsert payloads", () => {
    const c = client({ "2026-07": {}, "2026-08": { resetValue: -20, resetNote: "macro" } });
    const rows = [
      ...run(c, { worked: WORKED }),
      ...run(client({ "2026-07": {}, "2026-08": { resetValue: -5, accrualValue: 1, workedHours: 1 } }), { segFor: (mk) => (mk === "2026-08" ? HOURLY : PKG), worked: WORKED }),
      ...run(client({ "2026-07": {}, "2026-08": { resetValue: -5 } }), { statusFor: (mk) => (mk >= "2026-08" ? "on_hold" : "active"), worked: WORKED }),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toHaveProperty("reset_value");
      expect(r).not.toHaveProperty("reset_note");
      expect(r).not.toHaveProperty("reset_at");
    }
  });

  it("on hold Aug + Sep: Aug pauses on the prior balance, Sep carries the Aug reset forward unchanged (Duco)", () => {
    const c = client({ "2026-07": {}, "2026-08": { resetValue: -30 } });
    run(c, { worked: WORKED, statusFor: (mk) => (mk === "2026-08" || mk === "2026-09" ? "on_hold" : "active") });
    expect(c.months["2026-08"].accrualValue).toBe(2); // July's balance, paused
    expect(c.months["2026-08"].resetValue).toBe(-30);
    expect(c.months["2026-09"].accrualValue).toBe(-30);
    expect(c.months["2026-10"].accrualValue).toBe(6 - 10 - 30);
  });

  it("an is_override month with a reset hands the reset forward, not its override figure", () => {
    const c = client({ "2026-07": {}, "2026-08": { accrualValue: 5, isOverride: true, resetValue: -10 } });
    run(c, { worked: WORKED });
    expect(c.months["2026-08"].accrualValue).toBe(5); // override untouched
    expect(c.months["2026-09"].accrualValue).toBe(13 - 10 - 10);
  });

  it("an off-package month with a reset carries the reset (instead of resetting prior to 0)", () => {
    const c = client({ "2026-07": {}, "2026-08": { accrualValue: 1, workedHours: 7, resetValue: -8 } });
    run(c, { worked: WORKED, segFor: (mk) => (mk === "2026-08" ? HOURLY : PKG) });
    expect(c.months["2026-08"].accrualValue).toBeNull();
    expect(c.months["2026-08"].resetValue).toBe(-8);
    expect(c.months["2026-09"].accrualValue).toBe(13 - 10 - 8);
  });

  it("an off-package month without a reset still resets prior to 0 (unchanged behaviour)", () => {
    const c = client({ "2026-07": {} });
    run(c, { worked: WORKED, segFor: (mk) => (mk === "2026-08" ? HOURLY : PKG) });
    expect(c.months["2026-09"].accrualValue).toBe(3);
  });
});

describe("accrualFolderMinutesFor -- Majestic Plumbing's own folder counts toward its accrual", () => {
  afterEach(() => setDynamicCostCentres([]));

  it("sums own folder + cost centre, excluding the billed-separately sub-project", () => {
    setDynamicCostCentres([
      { client: "Majestic Plumbing + CLT", folder: "MP - Commercial Leak Tech (WA)", kind: "cost_centre" },
      { client: "Majestic Plumbing + CLT", folder: "Majestic Plumbing Quoted Web Project (WA)", kind: "sub_project" },
    ]);
    const worked = new Map([
      ["Majestic Plumbing (WA)", new Map([["2026-08", 19.13 * 60]])],
      ["MP - Commercial Leak Tech (WA)", new Map([["2026-07", 0.42 * 60], ["2026-09", 10.33 * 60]])],
      ["Majestic Plumbing Quoted Web Project (WA)", new Map([["2026-08", 50 * 60]])],
    ]);
    const m = accrualFolderMinutesFor("Majestic Plumbing + CLT", "Majestic Plumbing (WA)", worked);
    expect(m.get("2026-07") / 60).toBeCloseTo(0.42);
    expect(m.get("2026-08") / 60).toBeCloseTo(19.13); // was 0 -- own folder dropped
    expect(m.get("2026-09") / 60).toBeCloseTo(10.33);
  });
});
