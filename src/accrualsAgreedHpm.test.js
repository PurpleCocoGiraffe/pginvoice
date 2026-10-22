import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: saving a Client Accruals comment after the page's auto-recompute wiped that
// month's agreed_hpm. replayClientAccruals rebuilt every cell WITHOUT agreedHpm, so the
// comment save sent `agreed_hpm: null`, Client Invoicing then read the month as "No
// package", and the recompute never repaired it (its change check ignored agreed_hpm).

const upserts = [];
vi.mock("./supabaseClient.js", () => ({
  supabase: {
    from: (table) => ({
      upsert: (row, opts) => { upserts.push({ table, row, opts }); return Promise.resolve({ error: null }); },
    }),
  },
}));

const { replayClientAccruals, buildReconciliationClients, upsertAccrualCell } = await import("./accrualsSync.js");

const PKG = { type: "package", agreedHours: 10 };
const HOURLY = { type: "hourly", agreedHours: null };
const minutes = (byMonth) => (mk) => (byMonth[mk] || 0) * 60;
const run = (c, { segFor = () => PKG, statusFor = () => "active", worked = {}, cur = "2026-10", startMonth = "2026-08" } = {}) =>
  replayClientAccruals(c, { startMonth, cur, segFor, statusFor, workedMinutesFor: minutes(worked) });

describe("replayClientAccruals carries agreedHpm on every rebuilt cell", () => {
  it("package months keep their agreed hours, so a later comment save can't null them", () => {
    const c = { client: "A", manager: "M", agreedHpm: "10", months: { "2026-08": { agreedHpm: "10" } } };
    run(c, { worked: { "2026-08": 9, "2026-09": 11, "2026-10": 4 } });
    for (const mk of ["2026-08", "2026-09", "2026-10"]) expect(c.months[mk].agreedHpm).toBe("10");
    const { clients } = buildReconciliationClients([c]);
    expect(clients[0].agreedByMonth).toEqual({ "2026-08": 10, "2026-09": 10, "2026-10": 10 });
  });

  it("on hold keeps the segment's hours; off package is null", () => {
    const c = { client: "A", manager: null, agreedHpm: "10", months: { "2026-08": {} } };
    const segFor = (mk) => (mk === "2026-10" ? HOURLY : PKG);
    const statusFor = (mk) => (mk === "2026-09" ? "on_hold" : "active");
    run(c, { segFor, statusFor, worked: { "2026-08": 10, "2026-10": 5 } });
    expect(c.months["2026-08"].agreedHpm).toBe("10");
    expect(c.months["2026-09"].agreedHpm).toBe("10");
    // Off package with no prior computed row writes nothing, so no cell is built for it.
    expect(c.months["2026-10"]?.agreedHpm ?? null).toBeNull();
  });

  it("heals a package row whose agreed_hpm was already wiped (same accrual, null agreed)", () => {
    const c = {
      client: "A", manager: null, agreedHpm: "10",
      months: { "2026-08": { accrualValue: -1, workedHours: 9, agreedHpm: null, hoursFlagged: false, flaggedFromHours: null } },
    };
    const rows = run(c, { worked: { "2026-08": 9 }, cur: "2026-08" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month_key: "2026-08", agreed_hpm: "10", accrual_value: -1 });
  });

  it("a row already carrying the same hours (in any text form) isn't rewritten", () => {
    const c = {
      client: "A", manager: null, agreedHpm: "10",
      months: { "2026-08": { accrualValue: -1, workedHours: 9, agreedHpm: "10.0", hoursFlagged: false, flaggedFromHours: null } },
    };
    expect(run(c, { worked: { "2026-08": 9 }, cur: "2026-08" })).toEqual([]);
  });
});

describe("upsertAccrualCell only writes agreed_hpm when it's known", () => {
  beforeEach(() => { upserts.length = 0; });

  it("a comment save with no agreed figure leaves the column out of the upsert", async () => {
    await upsertAccrualCell("A", "2026-09", { comment: "hi" }, { manager: "M", agreedHpm: undefined });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].row).toEqual({ client: "A", month_key: "2026-09", account_manager: "M", comment: "hi" });
    expect("agreed_hpm" in upserts[0].row).toBe(false);
  });

  it("an explicit value (including null) is still written", async () => {
    await upsertAccrualCell("A", "2026-09", { comment: "x" }, { agreedHpm: "16" });
    await upsertAccrualCell("A", "2026-10", { comment: "y" }, { agreedHpm: null });
    expect(upserts.map((u) => u.row.agreed_hpm)).toEqual(["16", null]);
  });
});
