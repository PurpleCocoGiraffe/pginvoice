import { describe, it, expect, afterEach } from "vitest";
import {
  rowsToClients, buildReconciliationClients, parseAgreedHours,
  carryOutOf, replayClientAccruals, accrualFolderMinutesFor, endPeriodsFor, mergeLatestComments,
} from "./accrualsSync.js";
import { statusForMonth } from "./clientsSync.js";
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

describe("replayClientAccruals -- offboarded/archived clients stop accruing", () => {
  const PKG = { type: "package", agreedHours: 10 };
  const minutes = (byMonth) => (mk) => (byMonth[mk] || 0) * 60;
  const profile = (status, endDate = null) => ({ client: "A", status, endDate });
  const ev = (id, kind, effective_date) => ({ id, client: "A", kind, effective_date, applied: true });
  const run = (c, { events = [], status = "active", endDate = null, worked = {}, cur = "2026-10", startMonth = "2026-06" } = {}) =>
    replayClientAccruals(c, {
      startMonth, cur, segFor: () => PKG,
      statusFor: (mk) => statusForMonth(profile(status, endDate), events, mk),
      workedMinutesFor: minutes(worked),
      endPeriods: endPeriodsFor(profile(status, endDate), events),
    });
  const stale = (accrualValue, workedHours = 0) => ({ accrualValue, workedHours, accrualNote: null, isOverride: false });
  const WORKED = { "2026-06": 12, "2026-07": 7, "2026-08": 1, "2026-09": 0, "2026-10": 0 };

  it("a month-end offboarding event (Warrina, 2026-07-31) stops accrual from the next month and clears later computed rows", () => {
    const events = [ev(1, "offboarding", "2026-07-31")];
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-08": stale(-11.66, 1), "2026-09": stale(-10.34) } };
    const rows = run(c, { events, status: "offboarded", worked: WORKED });
    expect(c.months["2026-06"].accrualValue).toBe(2);
    expect(c.months["2026-07"].accrualValue).toBe(-1); // effective month itself still accrues
    for (const mk of ["2026-08", "2026-09"]) {
      expect(c.months[mk].accrualValue).toBeNull();
      expect(c.months[mk].workedHours).toBeNull();
      expect(c.months[mk].accrualNote).toBe("Client offboarded");
    }
    expect(c.months["2026-10"]).toBeUndefined(); // no new row created after the end
    const cleared = rows.filter((r) => r.accrual_note === "Client offboarded").map((r) => r.month_key);
    expect(cleared).toEqual(["2026-08", "2026-09"]);
    for (const r of rows) expect(r).not.toHaveProperty("reset_value");
  });

  it("archived with no event (Kellybrook): stops after its last worked/override month; override rows are kept", () => {
    const c = {
      client: "A", manager: null, agreedHpm: "170", months: {
        "2026-05": { accrualValue: -340, isOverride: true },
        "2026-06": stale(-510),
        "2026-07": stale(-680),
        "2026-08": { accrualValue: 99, isOverride: true },
        "2026-09": stale(-850),
      },
    };
    // Last worked month is June, but the Aug override is later evidence.
    run(c, { status: "archived", worked: { "2026-06": 5 }, startMonth: "2026-05" });
    expect(c.months["2026-05"].accrualValue).toBe(-340);
    expect(c.months["2026-06"].accrualValue).toBe(5 - 10 - 340);
    expect(c.months["2026-07"].accrualValue).toBe(-10 + (5 - 10 - 340)); // still before last evidence
    expect(c.months["2026-08"]).toEqual({ accrualValue: 99, isOverride: true }); // override untouched
    expect(c.months["2026-09"].accrualValue).toBeNull();
    expect(c.months["2026-09"].accrualNote).toBe("Client archived");
    expect(c.months["2026-10"]).toBeUndefined();
  });

  it("archived with no evidence at all: nothing computed accrues, overrides kept", () => {
    const c = { client: "A", manager: null, agreedHpm: "16", months: { "2026-07": stale(-64), "2026-08": stale(-80), "2026-09": stale(-96) } };
    const rows = run(c, { status: "archived", startMonth: "2026-07" });
    expect(rows.map((r) => r.month_key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    for (const mk of ["2026-07", "2026-08", "2026-09"]) expect(c.months[mk].accrualValue).toBeNull();
  });

  it("a later reactivation resumes accrual with prior reset to 0", () => {
    const events = [ev(1, "offboarding", "2026-07-31"), ev(2, "reactivation", "2026-09-01")];
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {} } };
    run(c, { events, status: "active", worked: { ...WORKED, "2026-09": 13, "2026-10": 6 } });
    // Aug had 1h of wrap-up work -> a cleared row, not an accrual.
    expect(c.months["2026-08"]).toMatchObject({ accrualValue: null, workedHours: null, accrualNote: "Client offboarded" });
    expect(c.months["2026-09"].accrualValue).toBe(3);
    expect(c.months["2026-10"].accrualValue).toBe(-1);
  });

  it("a reset on an offboarded month stays on the in-memory cell (and carries forward)", () => {
    const events = [ev(1, "offboarding", "2026-07-31"), ev(2, "reactivation", "2026-09-01")];
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-08": { ...stale(-5, 1), resetValue: -20, resetNote: "macro" } } };
    const rows = run(c, { events, status: "active", worked: { ...WORKED, "2026-09": 13 } });
    expect(c.months["2026-08"].accrualValue).toBeNull();
    expect(c.months["2026-08"].resetValue).toBe(-20);
    expect(c.months["2026-08"].resetNote).toBe("macro");
    expect(c.months["2026-09"].accrualValue).toBe(13 - 10 - 20);
    for (const r of rows) {
      expect(r).not.toHaveProperty("reset_value");
      expect(r).not.toHaveProperty("reset_note");
      expect(r).not.toHaveProperty("reset_at");
    }
  });

  it("an active client is unchanged by the rule, and a second pass is idempotent", () => {
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {} } };
    run(c, { worked: WORKED });
    expect(c.months["2026-10"].accrualValue).toBe(2 - 3 - 9 - 10 - 10);
    expect(Object.values(c.months).every((m) => m.accrualNote === null)).toBe(true);

    const ended = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-09": stale(-3) } };
    const events = [ev(1, "offboarding", "2026-07-31")];
    expect(run(ended, { events, status: "offboarded", worked: WORKED }).length).toBeGreaterThan(0);
    const snapshot = JSON.parse(JSON.stringify(ended.months));
    expect(run(ended, { events, status: "offboarded", worked: WORKED })).toEqual([]);
    expect(ended.months).toEqual(snapshot);
    const archived = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-09": stale(-3) } };
    run(archived, { status: "archived", worked: WORKED });
    expect(run(archived, { status: "archived", worked: WORKED })).toEqual([]);
  });

  it("a later type/package event re-engages an offboarded client (Equippers regression)", () => {
    // offboarded 2026-06-01, re-signed as a 24h package from 2026-08-01 via a type event, no reactivation
    const events = [ev(1, "offboarding", "2026-06-01"), ev(2, "type", "2026-08-01")];
    expect(endPeriodsFor(profile("active"), events)).toEqual([{ from: "2026-06", until: "2026-08", after: null, note: "Client offboarded" }]);
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-07": stale(-10), "2026-08": stale(-20), "2026-09": stale(-30) } };
    run(c, { events, status: "active", worked: { "2026-08": 1.5 } });
    expect(c.months["2026-07"].accrualNote).toBe("Client offboarded");
    expect(c.months["2026-08"].accrualValue).toBe(-8.5); // live package month accrues again, from 0
    expect(c.months["2026-09"].accrualValue).toBe(-18.5);
  });

  it("an active client with a stale open-ended offboarding event is never cleared", () => {
    const events = [ev(1, "offboarding", "2026-06-01")];
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": stale(-10), "2026-09": stale(-20) } };
    run(c, { events, status: "active", startMonth: "2026-08", worked: {} });
    expect(c.months["2026-08"].accrualValue).toBe(-10);
    expect(c.months["2026-09"].accrualValue).toBe(-20);
  });

  it("endPeriodsFor: dated, undated, endDate-based, and reactivation-bounded periods", () => {
    expect(endPeriodsFor(profile("active"), [])).toEqual([]);
    expect(endPeriodsFor(profile("on_hold"), [])).toEqual([]);
    expect(endPeriodsFor(profile("archived"), [])).toEqual([{ from: null, until: null, after: null, note: "Client archived" }]);
    expect(endPeriodsFor(profile("offboarded"), [ev(1, "offboarding", "2026-07-31")])).toEqual([{ from: "2026-08", until: null, after: null, note: "Client offboarded" }]);
    expect(endPeriodsFor(profile("offboarded"), [ev(1, "offboarding", "2026-08-01")])[0].from).toBe("2026-08");
    expect(endPeriodsFor(profile("offboarded", "2026-07-31"), [])[0].from).toBe("2026-08");
    expect(endPeriodsFor(profile("active"), [ev(1, "reactivation", "2026-10-01")])).toEqual([{ from: null, until: "2026-10", after: null, note: "Client offboarded" }]);
    expect(endPeriodsFor(profile("archived"), [ev(1, "offboarding", "2026-01-31"), ev(2, "reactivation", "2026-03-01")])).toEqual([
      { from: "2026-02", until: "2026-03", after: null, note: "Client offboarded" },
      { from: null, until: null, after: "2026-03", note: "Client archived" },
    ]);
  });

  it("a stale end_date earlier than a later reactivation falls back to the evidence rule", () => {
    // reactivated 2026-08-01, later set offboarded by a direct edit that left end_date 2026-05-15
    const events = [ev(1, "reactivation", "2026-08-01")];
    const periods = endPeriodsFor(profile("offboarded", "2026-05-15"), events);
    expect(periods[periods.length - 1]).toEqual({ from: null, until: null, after: "2026-08", note: "Client offboarded" });
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": {} } };
    run(c, { events, status: "offboarded", endDate: "2026-05-15", startMonth: "2026-08", worked: { "2026-08": 4, "2026-09": 10 } });
    expect(c.months["2026-08"].accrualValue).toBe(-6); // reactivation month accrues
    expect(c.months["2026-09"].accrualValue).toBe(-6); // last evidence month, still accrues
    expect(c.months["2026-10"]).toBeUndefined();
  });

  it("QA repro: reactivating an archived client with no offboarding event does not re-accrue the gap", () => {
    // 10h package, work only in 2026-06, Jul/Aug already cleared as archived, then reactivated 2026-10-01.
    const cleared = (note) => ({ accrualValue: null, workedHours: null, accrualNote: note, isOverride: false });
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-07": cleared("Client archived"), "2026-08": cleared("Client archived") } };
    const events = [ev(1, "reactivation", "2026-10-01")];
    const worked = { "2026-06": 12, "2026-10": 6 };
    run(c, { events, status: "active", worked });
    expect(c.months["2026-06"].accrualValue).toBe(2);
    for (const mk of ["2026-07", "2026-08"]) expect(c.months[mk].accrualValue).toBeNull();
    expect(c.months["2026-09"]).toBeUndefined();
    expect(c.months["2026-10"].accrualValue).toBe(-4); // resumes from 0, not -30
    const snapshot = JSON.parse(JSON.stringify(c.months));
    expect(run(c, { events, status: "active", worked })).toEqual([]); // idempotent after reactivation
    expect(c.months).toEqual(snapshot);
  });

  it("an undated end bounded by a reactivation only looks at evidence before the reactivation", () => {
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-07": stale(-8), "2026-08": stale(-18) } };
    const events = [ev(1, "reactivation", "2026-09-01")];
    run(c, { events, status: "active", worked: { "2026-06": 12, "2026-09": 13, "2026-10": 6 } });
    expect(c.months["2026-07"].accrualValue).toBeNull();
    expect(c.months["2026-08"].accrualNote).toBe("Client offboarded");
    expect(c.months["2026-09"].accrualValue).toBe(3);
    expect(c.months["2026-10"].accrualValue).toBe(-1);
  });

  it("a mid-month reactivation accrues that whole month; a mid-month offboarding still accrues its whole month", () => {
    const events = [ev(1, "offboarding", "2026-07-15"), ev(2, "reactivation", "2026-09-15")];
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {} } };
    run(c, { events, status: "active", worked: { "2026-06": 12, "2026-07": 7, "2026-09": 13, "2026-10": 6 } });
    expect(c.months["2026-07"].accrualValue).toBe(-1); // offboarded 07-15, July still accrues
    expect(c.months["2026-08"]).toBeUndefined();
    expect(c.months["2026-09"].accrualValue).toBe(3); // September's hours count
    expect(c.months["2026-09"].workedHours).toBe(13);
    expect(c.months["2026-10"].accrualValue).toBe(-1);
  });

  it("wrap-up work in an ended month with no row writes a cleared row (idempotent)", () => {
    const events = [ev(1, "offboarding", "2026-07-31")];
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {} } };
    const worked = { "2026-06": 12, "2026-07": 7, "2026-08": 3 };
    const rows = run(c, { events, status: "offboarded", worked });
    expect(c.months["2026-08"]).toMatchObject({ accrualValue: null, workedHours: null, accrualNote: "Client offboarded" });
    expect(rows.find((r) => r.month_key === "2026-08")).toMatchObject({ accrual_value: null, worked_hours: null, agreed_hpm: null, accrual_note: "Client offboarded" });
    expect(c.months["2026-09"]).toBeUndefined(); // no work, no row
    expect(run(c, { events, status: "offboarded", worked })).toEqual([]);
  });

  it("uses profile.endDate as the undated end when present, over the evidence rule", () => {
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-06": {}, "2026-08": stale(-10, 2) } };
    // Evidence (worked Aug) would keep Aug accruing; endDate 2026-07-31 ends it from Aug.
    run(c, { status: "archived", endDate: "2026-07-31", worked: { "2026-06": 12, "2026-07": 7, "2026-08": 2 } });
    expect(c.months["2026-07"].accrualValue).toBe(-1);
    expect(c.months["2026-08"]).toMatchObject({ accrualValue: null, workedHours: null, accrualNote: "Client archived" });
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

describe("accrualFolderMinutesFor -- registered folder matched case/whitespace-insensitively", () => {
  // Regression: GPEx's ClickUp folder was renamed "GPEX" -> "gpex"; the registered folder
  // stayed "GPEX", so September 2026's 103.57 billable hours (all under "gpex") counted 0.
  it("sums every case/whitespace variant of the registered folder", () => {
    const worked = new Map([
      ["GPEX", new Map([["2026-08", 600]])],
      ["gpex", new Map([["2026-09", 6214]])],
      ["Apex Energy", new Map([["2026-09", 50]])],
    ]);
    const m = accrualFolderMinutesFor("GPEx", "GPEX", worked);
    expect(m.get("2026-08")).toBe(600);
    expect(m.get("2026-09")).toBe(6214);
  });
  it("matches a registered folder carrying a trailing space", () => {
    const worked = new Map([["Utter Gutters", new Map([["2026-09", 120]])]]);
    expect(accrualFolderMinutesFor("Utter Gutters", "Utter Gutters ", worked).get("2026-09")).toBe(120);
  });
});

describe("endPeriodsFor -- stale stored profile state and holds (QA)", () => {
  const ev = (id, kind, effective_date) => ({ id, client: "A", kind, effective_date, applied: true });
  const PKG = { type: "package", agreedHours: 10 };

  it("offboarding then a later type event: a still-'offboarded' stored profile (end_date = that offboarding) adds no trailing end", () => {
    const events = [ev(1, "offboarding", "2026-06-01"), ev(2, "type", "2026-08-01")];
    const periods = endPeriodsFor({ client: "A", status: "offboarded", endDate: "2026-06-01" }, events);
    expect(periods).toEqual([{ from: "2026-06", until: "2026-08", after: null, note: "Client offboarded" }]);
    // New package months with no hours yet must still accrue, not be cleared.
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": {} } };
    replayClientAccruals(c, { startMonth: "2026-08", cur: "2026-10", segFor: () => PKG, statusFor: () => "active", workedMinutesFor: (mk) => (mk === "2026-08" ? 600 : 0), endPeriods: periods });
    expect(c.months["2026-09"].accrualValue).toBe(-10);
    expect(c.months["2026-10"].accrualValue).toBe(-20);
  });

  it("a directly-set offboarding after a closed one (different end_date) still ends the client", () => {
    const events = [ev(1, "offboarding", "2026-03-01"), ev(2, "reactivation", "2026-04-01")];
    const periods = endPeriodsFor({ client: "A", status: "offboarded", endDate: "2026-08-31" }, events);
    expect(periods[periods.length - 1]).toEqual({ from: "2026-09", until: null, after: "2026-04", note: "Client offboarded" });
  });

  it("offboarding 2026-10-15 then hold 2026-11-01 stays ended (a hold doesn't re-engage)", () => {
    const events = [ev(1, "offboarding", "2026-10-15"), ev(2, "hold", "2026-11-01")];
    expect(endPeriodsFor({ client: "A", status: "on_hold", endDate: null }, events)).toEqual([{ from: "2026-11", until: null, after: null, note: "Client offboarded" }]);
  });

  it("a resume after the offboarding (and hold) re-engages from the resume month", () => {
    const events = [ev(1, "offboarding", "2026-10-15"), ev(2, "hold", "2026-11-01"), ev(3, "resume", "2027-01-01")];
    expect(endPeriodsFor({ client: "A", status: "active", endDate: null }, events)).toEqual([{ from: "2026-11", until: "2027-01", after: null, note: "Client offboarded" }]);
  });

  it("an on_hold profile from a hold BEFORE the offboarding still gets the safety net (status edited directly)", () => {
    const events = [ev(1, "hold", "2026-05-01"), ev(2, "offboarding", "2026-06-01")];
    expect(endPeriodsFor({ client: "A", status: "on_hold", endDate: null }, events)).toEqual([{ from: "2026-06", until: "2026-06", after: null, note: "Client offboarded" }]);
  });
});

describe("replayClientAccruals -- hours_flagged clears once worked hours stop changing", () => {
  const PKG = { type: "package", agreedHours: 10 };
  it("a previously-flagged closed month whose hours now match writes hours_flagged: false", () => {
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": { accrualValue: 2, workedHours: 12, accrualNote: null, isOverride: false, hoursFlagged: true } } };
    const rows = replayClientAccruals(c, { startMonth: "2026-08", cur: "2026-08", segFor: () => PKG, statusFor: () => "active", workedMinutesFor: () => 12 * 60 });
    expect(rows).toHaveLength(1);
    expect(rows[0].hours_flagged).toBe(false);
    const c2 = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": { accrualValue: 2, workedHours: 12, accrualNote: null, isOverride: false, hoursFlagged: true }, "2026-09": { accrualValue: -8, workedHours: 0, accrualNote: null, isOverride: false, hoursFlagged: false } } };
    const rows2 = replayClientAccruals(c2, { startMonth: "2026-08", cur: "2026-09", segFor: () => PKG, statusFor: () => "active", workedMinutesFor: (mk) => (mk === "2026-08" ? 12 * 60 : 0) });
    expect(rows2.map((r) => [r.month_key, r.hours_flagged])).toEqual([["2026-08", false]]);
    expect(c2.months["2026-08"].hoursFlagged).toBe(false);
  });

  it("an on-hold month carrying a stale flag gets it cleared too", () => {
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": { accrualValue: 0, workedHours: null, accrualNote: "On hold — accrual paused", isOverride: false, hoursFlagged: true } } };
    const rows = replayClientAccruals(c, { startMonth: "2026-08", cur: "2026-09", segFor: () => PKG, statusFor: () => "on_hold", workedMinutesFor: () => 0 });
    expect(rows.find((r) => r.month_key === "2026-08").hours_flagged).toBe(false);
  });
});

describe("recompute never writes comments", () => {
  const PKG = { type: "package", agreedHours: 10 };
  const HOURLY = { type: "hourly", agreedHours: null };
  it("no recompute upsert payload carries a comment column, in any branch", () => {
    const months = { "2026-06": { accrualValue: 5, workedHours: 5, comment: "keep me" }, "2026-07": { accrualValue: 1, workedHours: 1, comment: "old" }, "2026-08": { accrualValue: 1, workedHours: 1, comment: "x" }, "2026-09": { accrualValue: 1, workedHours: 1, comment: "y" } };
    const c = { client: "A", manager: null, agreedHpm: "10", months };
    const rows = replayClientAccruals(c, {
      startMonth: "2026-06", cur: "2026-10",
      segFor: (mk) => (mk === "2026-07" ? HOURLY : PKG),
      statusFor: (mk) => (mk === "2026-08" ? "on_hold" : "active"),
      workedMinutesFor: () => 60,
      endPeriods: [{ from: "2026-09", until: "2026-10", after: null, note: "Client offboarded" }],
    });
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) expect(r).not.toHaveProperty("comment");
    expect(c.months["2026-06"].comment).toBe("keep me"); // in-memory cell still carries it for display
  });

  it("mergeLatestComments keeps a comment saved while a recompute was running", () => {
    const next = [{ client: "A", months: { "2026-09": { accrualValue: -3, comment: "old" }, "2026-10": { accrualValue: -1, comment: null } } }];
    const prev = [{ client: "A", months: { "2026-09": { accrualValue: -2, comment: "new" } } }];
    const merged = mergeLatestComments(next, prev);
    expect(merged[0].months["2026-09"]).toEqual({ accrualValue: -3, comment: "new" });
    expect(merged[0].months["2026-10"].comment).toBeNull();
    expect(mergeLatestComments(next, null)).toBe(next);
  });
});
