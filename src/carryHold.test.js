import { describe, it, expect } from "vitest";
import { replayClientAccruals, buildReconciliationClients } from "./accrualsSync.js";
import { typeForMonth } from "./clientsSync.js";
import { carryHoldFor, carryHeldNote, isCarryHeldNote, monthKeyLabel, HOURLY_SETTLEMENT_NOTE } from "./format.js";
import { reconcileClientMonth, hourlySettlementCarryIn } from "./reconcile.js";
import { buildSummaryText } from "./clientSummary.js";
import { buildPrintHtml } from "./printTemplate.js";

// gpex, Nov 2026 (Kelly's note to the client): Oct closed 54.79 h over the 70 h package.
// Nov and Dec bill hourly. Plain package -> hourly settlement (settleHourly) would add the
// 54.79 h to the NOVEMBER invoice; with carry_settle_month '2026-12' Nov invoices only its
// own hours and holds the 54.79 h, Dec invoices 54.79 h + every Dec hour, and Jan 2027 is
// back on the 70 h package from a clean 0.
const profile = { client: "gpex", baseType: "package", baseAgreedHours: 70 };
const ev = (id, effective_date, new_type, new_agreed_hours, extra = {}) =>
  ({ id, client: "gpex", kind: "type", effective_date, applied: true, new_type, new_agreed_hours, ...extra });
const EVENTS = [
  ev(1, "2026-11-01", "hourly", null, { carry_settle_month: "2026-12" }),
  ev(2, "2027-01-01", "package", 70),
];
const WORKED = { "2026-09": 103.57, "2026-10": 91.22, "2026-11": 15.13, "2026-12": 40, "2027-01": 60 };
const minutes = (mk) => (WORKED[mk] || 0) * 60;
const replay = (events = EVENTS, months = { "2026-09": {} }) => {
  const c = { client: "gpex", manager: null, agreedHpm: "70", months };
  const opts = {
    startMonth: "2026-09", cur: "2027-01",
    segFor: (mk) => typeForMonth(profile, events, mk), statusFor: () => "active", workedMinutesFor: minutes,
  };
  const rows = replayClientAccruals(c, opts);
  return { c, rows, again: () => replayClientAccruals(c, opts) };
};

describe("carryHoldFor", () => {
  const seg = (from, type = "hourly", carrySettleMonth = "2026-12") => ({ from, type, agreedHours: null, carrySettleMonth });
  it("applies from the segment's first month through the settle month", () => {
    expect(carryHoldFor(seg("2026-11-01"), "2026-10")).toBeNull();
    expect(carryHoldFor(seg("2026-11-01"), "2026-11")).toEqual({ fromMonth: "2026-11", settleMonth: "2026-12", settling: false });
    expect(carryHoldFor(seg("2026-11-01"), "2026-12")).toEqual({ fromMonth: "2026-11", settleMonth: "2026-12", settling: true });
    expect(carryHoldFor(seg("2026-11-01"), "2027-01")).toBeNull();
  });
  it("a mid-month event starts the hold the next month (typeForMonth's boundary)", () => {
    expect(carryHoldFor(seg("2026-11-15"), "2026-11")).toBeNull();
    expect(carryHoldFor(seg("2026-12-15", "hourly", "2027-02"), "2027-01")).toMatchObject({ fromMonth: "2027-01", settling: false });
  });
  it("only an hourly segment with a settle month holds", () => {
    expect(carryHoldFor(seg("2026-11-01", "package"), "2026-11")).toBeNull();
    expect(carryHoldFor(seg("2026-11-01", "quoted"), "2026-11")).toBeNull();
    expect(carryHoldFor(seg("2026-11-01", "hourly", null), "2026-11")).toBeNull();
    expect(carryHoldFor(null, "2026-11")).toBeNull();
  });
  it("labels/notes are locale-independent", () => {
    expect(monthKeyLabel("2026-12")).toBe("Dec 2026");
    expect(isCarryHeldNote(carryHeldNote("2026-12"))).toBe(true);
    expect(isCarryHeldNote(HOURLY_SETTLEMENT_NOTE)).toBe(false);
  });
});

describe("replayClientAccruals -- carry hold (gpex Nov/Dec 2026)", () => {
  it("Oct closes 54.79; Nov holds it; Dec settles it (0); Jan restarts the package from 0", () => {
    const { c, rows } = replay();
    expect(c.months["2026-10"].accrualValue).toBe(54.79);
    expect(c.months["2026-11"]).toMatchObject({ accrualValue: 54.79, agreedHpm: null, pct: null, workedHours: 15.13, accrualNote: carryHeldNote("2026-12") });
    expect(c.months["2026-12"]).toMatchObject({ accrualValue: 0, agreedHpm: null, workedHours: 40, accrualNote: HOURLY_SETTLEMENT_NOTE });
    expect(c.months["2027-01"]).toMatchObject({ accrualValue: -10, agreedHpm: "70" });
    expect(rows.find((r) => r.month_key === "2026-11")).not.toHaveProperty("reset_value");
  });

  it("without a settle month, plain settlement charges it in Nov (the first hourly month)", () => {
    const { c } = replay([ev(1, "2026-11-01", "hourly", null), ev(2, "2027-01-01", "package", 70)]);
    expect(c.months["2026-11"]).toMatchObject({ accrualValue: 0, accrualNote: HOURLY_SETTLEMENT_NOTE });
    expect(c.months["2026-12"]).toBeUndefined();
  });

  it("heals the stale Nov package row written before the switch, and is idempotent", () => {
    const { c, again } = replay(EVENTS, { "2026-09": {}, "2026-11": { accrualValue: -0.08, agreedHpm: "70", pct: -0.0011, workedHours: 15.13 } });
    expect(c.months["2026-11"]).toMatchObject({ accrualValue: 54.79, agreedHpm: null, pct: null });
    expect(again()).toEqual([]);
  });
});

describe("Client Invoicing -- carry hold", () => {
  // The ledger as the replay leaves it, read back the way Client Invoicing does.
  const { c } = replay();
  const accrued = buildReconciliationClients([c]).clients[0];
  const recon = (mk, priorKey, worked) => {
    const seg = typeForMonth(profile, EVENTS, mk);
    const priorType = typeForMonth(profile, EVENTS, priorKey).type;
    return reconcileClientMonth({
      worked, accruedClient: accrued, monthKey: mk, priorKey,
      monthType: seg.type, priorType, monthSegmentAgreed: seg.agreedHours,
      hourlySettlementPrior: seg.type === "hourly" ? hourlySettlementCarryIn(accrued, priorKey, priorType) : null,
      carryHold: carryHoldFor(seg, mk),
    });
  };

  it("Nov: invoices only its own hours, 54.79 h held for Dec", () => {
    expect(recon("2026-11", "2026-10", 15.13).hourlySettlement)
      .toEqual({ prior: 54.79, applied: 0, hoursToInvoice: 15.13, remaining: 54.79, held: true, settleMonth: "2026-12" });
  });

  it("Dec: invoices 54.79 h + Dec hours, nothing left", () => {
    expect(recon("2026-12", "2026-11", 40).hourlySettlement).toEqual({ prior: 54.79, applied: 54.79, hoursToInvoice: 94.79, remaining: 0 });
  });

  it("Jan 2027: back on the 70 h package with no carry in", () => {
    const r = recon("2027-01", "2026-12", 60);
    expect(r).toMatchObject({ pkg: 70, priorBalance: 0, hourlySettlement: null });
    expect(r.newBalance).toBe(-10);
  });

  const card = (worked, hourlySettlement) => ({
    name: "gpex", displayName: "gpex", type: "hourly", status: "no-pkg", worked, billableWorked: worked, workedFiltered: worked,
    tasksAll: new Map([["SEO", worked * 60]]), taskUsers: new Map(), userMinutes: new Map(), hourlySettlement,
  });
  it("Copy summary and PDF say the Nov balance is held, Dec's is added", () => {
    const nov = card(15.13, recon("2026-11", "2026-10", 15.13).hourlySettlement);
    const dec = card(40, recon("2026-12", "2026-11", 40).hourlySettlement);
    const n = buildSummaryText(nov, { invoiceMonth: "November 2026", priorMonthPretty: "October 2026" });
    expect(n).toContain("Package hours over-used (from October 2026): 54.79 h, held, settled in Dec 2026");
    expect(n).toContain("Hours to invoice: 15.13 h");
    expect(buildSummaryText(dec, { invoiceMonth: "December 2026" })).toContain("Hours to invoice: 94.79 h");
    const pdf = buildPrintHtml(nov, "November 2026", "October 2026");
    expect(pdf).toContain("Held, settled in Dec 2026");
    expect(pdf).toMatch(/Hours to invoice<\/td><td class="right">15\.13 h/);
    expect(buildPrintHtml(dec, "December 2026", "November 2026")).toMatch(/Hours to invoice<\/td><td class="right">94\.79 h/);
  });
});
