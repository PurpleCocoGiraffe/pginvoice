import { describe, it, expect } from "vitest";
import {
  folderKey, buildFolderCanonicalizer, aggregateMonthRows, billableMinutesByFolder,
  reconcileClientMonth, shouldSeedPackageMonth, sumCarry, lastMonthAccruedClients,
  quotedBudgetFor, sumMinutesInRange, unfilteredForExport,
  seedBlockedBy, monthInEndPeriods, priorFolderKeysFor, subProjectType, resolveClientType,
  lifetimeBudgetFor, isLifetimeBudgetType,
} from "./reconcile.js";
import { typeLabelShort, typeTone } from "./clientTypeLabels.js";
import { endPeriodsFor } from "./accrualsSync.js";
import { multiFolderAccrualMatchesFor, setDynamicCostCentres } from "./nameMatch.js";
import { runManualSync } from "./manualSync.js";
import { afterEach } from "vitest";
import { buildPrintHtml } from "./printTemplate.js";
import { buildSummaryText } from "./clientSummary.js";

// Regression coverage for QA-confirmed silent wrong-number bugs in Client Invoicing
// (App.jsx's buildClientsForMonth, whose math now lives in reconcile.js).

// A live-sync accrued client (buildReconciliationClients shape).
const accrued = (over = {}) => ({
  name: "Acme", package: 32, agreedByMonth: {}, balances: {}, computedBalances: {}, resets: {}, ...over,
});
const row = (folder, minutes, extra = {}) => ({ folder, minutes, task: "T", user: "Suba", monthKey: "2026-09", billable: true, isInternal: false, ...extra });

describe("fix 1: package client with no billable hours this month", () => {
  it("is seeded when the month is package-like with agreed hours", () => {
    const a = accrued({ agreedByMonth: { "2026-09": 20 } });
    expect(shouldSeedPackageMonth(a, "2026-09", "package")).toBe(true);
    expect(shouldSeedPackageMonth(a, "2026-09", "strategy")).toBe(true);
    expect(shouldSeedPackageMonth(a, "2026-09", null)).toBe(true); // unregistered: ledger decides
  });
  it("is not seeded for a non-package month, a null/0 agreed row, or no row", () => {
    expect(shouldSeedPackageMonth(accrued({ agreedByMonth: { "2026-09": 20 } }), "2026-09", "hourly")).toBe(false);
    expect(shouldSeedPackageMonth(accrued({ agreedByMonth: { "2026-09": null } }), "2026-09", "package")).toBe(false);
    expect(shouldSeedPackageMonth(accrued({ agreedByMonth: { "2026-09": 0 } }), "2026-09", "package")).toBe(false);
    expect(shouldSeedPackageMonth(accrued(), "2026-09", "package")).toBe(false);
  });
  it("a seeded 0-hour month still consumes the package", () => {
    const r = reconcileClientMonth({
      worked: 0, accruedClient: accrued({ agreedByMonth: { "2026-08": 20, "2026-09": 20 }, balances: { "2026-08": -5 } }),
      monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: null, monthType: "package", priorType: "package",
    });
    expect(r.pkg).toBe(20);
    expect(r.newBalance).toBe(-25);
    expect(r.balanceForward).toBe(-25);
    expect(r.status).toBe("under");
  });
  it("only-non-billable hours with Billable only on leave no folder entry (so seeding is needed)", () => {
    const map = aggregateMonthRows([row("Acme", 120, { billable: false })], { monthKey: "2026-09", billableOnly: true, hasBillable: true });
    expect(map.size).toBe(0);
  });
});

describe("fix 2: on-hold months", () => {
  const a = accrued({ agreedByMonth: { "2026-08": 20, "2026-09": 20 }, balances: { "2026-07": -6, "2026-08": -6 } });
  it("an on-hold month carries the prior balance unchanged and isn't under/over", () => {
    const r = reconcileClientMonth({
      worked: 3, accruedClient: a, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 0,
      monthType: "package", priorType: "package", monthStatus: "on_hold", priorStatus: "active",
    });
    expect(r.newBalance).toBe(-6);
    expect(r.balanceForward).toBe(-6);
    expect(r.status).toBe("on_hold");
    expect(r.kpiPct).toBeNull();
  });
  it("no mismatch is flagged against a prior month that was on hold", () => {
    // Aug was on hold: its ledger balance (-6) is Jul's carried through, not 0 - 20 + -6.
    const r = reconcileClientMonth({
      worked: 10, accruedClient: a, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 0,
      monthType: "package", priorType: "package", monthStatus: "active", priorStatus: "on_hold",
    });
    expect(r.priorBalance).toBe(-6);
    expect(r.priorMismatch).toBeNull();
    expect(r.newBalance).toBe(10 - 20 - 6);
  });
  it("an estimated prior over an on-hold month carries the month before it through", () => {
    const b = accrued({ agreedByMonth: { "2026-09": 20 }, balances: { "2026-07": -4 } });
    const r = reconcileClientMonth({
      worked: 0, accruedClient: b, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 12,
      monthType: "package", priorType: "package", priorStatus: "on_hold",
    });
    expect(r.priorBalance).toBe(-4);
    expect(r.priorBalanceEstimated).toBe(true);
  });
  it("a still-flagged mismatch for an active prior month (control)", () => {
    const r = reconcileClientMonth({
      worked: 10, accruedClient: a, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 0,
      monthType: "package", priorType: "package", monthStatus: "active", priorStatus: "active",
    });
    expect(r.priorMismatch).toEqual({ sheetValue: -6, recomputed: -26 });
  });
});

describe("fix 3: package for the viewed month is type-aware, no stale scalar on live data", () => {
  it("a month whose type isn't package-like has no package, even with a stale scalar/ledger figure", () => {
    const r = reconcileClientMonth({
      worked: 8, accruedClient: accrued({ package: 32, agreedByMonth: { "2026-09": 32 } }),
      monthKey: "2026-09", priorKey: "2026-08", monthType: "hourly", priorType: "package",
    });
    expect(r.pkg).toBeNull();
    expect(r.newBalance).toBeNull();
    expect(r.status).toBe("no-pkg");
  });
  it("live data with no row for the month never falls back to the client-level scalar", () => {
    const r = reconcileClientMonth({ worked: 8, accruedClient: accrued({ package: 32 }), monthKey: "2026-09", priorKey: "2026-08" });
    expect(r.pkg).toBeNull();
  });
  it("a manually uploaded workbook (no per-month agreed hours) may use the scalar", () => {
    const r = reconcileClientMonth({ worked: 8, accruedClient: accrued({ package: 32, agreedByMonth: undefined }), monthKey: "2026-09", priorKey: "2026-08", allowScalarPackage: true });
    expect(r.pkg).toBe(32);
  });
  it("a registered package month with no ledger row yet uses that month's own agreed hours", () => {
    const r = reconcileClientMonth({
      worked: 8, accruedClient: accrued({ package: 32 }), monthKey: "2026-09", priorKey: "2026-08",
      monthType: "package", monthSegmentAgreed: 16,
    });
    expect(r.pkg).toBe(16);
  });
});

describe("fix 4: prior month off package carries nothing", () => {
  const stale = accrued({ agreedByMonth: { "2026-09": 70 }, balances: { "2026-08": 58.32, "2026-07": 3 } });
  it("prior = 0, no estimate, no mismatch when the prior month's type isn't package-like (row present)", () => {
    const r = reconcileClientMonth({
      worked: 50, accruedClient: stale, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 128,
      monthType: "package", priorType: "hourly",
    });
    expect(r.priorBalance).toBe(0);
    expect(r.priorBalanceEstimated).toBe(false);
    expect(r.priorMismatch).toBeNull();
    expect(r.newBalance).toBe(-20);
  });
  it("same when the prior month has no ledger row at all (no estimate from hourly hours)", () => {
    const r = reconcileClientMonth({
      worked: 50, accruedClient: accrued({ agreedByMonth: { "2026-09": 70 } }), monthKey: "2026-09", priorKey: "2026-08",
      priorWorkedH: 128, monthType: "package", priorType: "hourly",
    });
    expect(r.priorBalance).toBe(0);
    expect(r.priorBalanceEstimated).toBe(false);
  });
  it("a macro-sheet reset on the off-package prior month still carries (as recomputeAccruals does)", () => {
    const r = reconcileClientMonth({
      worked: 50, accruedClient: accrued({ agreedByMonth: { "2026-09": 70 }, resets: { "2026-08": -4 }, balances: { "2026-08": -4 } }),
      monthKey: "2026-09", priorKey: "2026-08", monthType: "package", priorType: "hourly",
    });
    expect(r.priorBalance).toBe(-4);
  });
  it("last-month accrued export keeps only package-like rows with a package", () => {
    const list = [
      { name: "A", type: "package", pkg: 20 },
      { name: "B", type: "hourly", pkg: 20 },
      { name: "C", type: "strategy", pkg: 10 },
      { name: "D", type: "package", pkg: null },
      { name: "E", type: "package", pkg: 0 },
    ];
    expect(lastMonthAccruedClients(list).map((c) => c.name)).toEqual(["A", "C"]);
  });
});

describe("fix 8: Billable only toggle never moves the accrual math", () => {
  const rows = [row("Acme", 600), row("Acme", 300, { billable: false, task: "Internal sync" })];
  it("billableMin is identical with the toggle on or off; only the displayed total changes", () => {
    const on = aggregateMonthRows(rows, { monthKey: "2026-09", billableOnly: true, hasBillable: true }).get("Acme");
    const off = aggregateMonthRows(rows, { monthKey: "2026-09", billableOnly: false, hasBillable: true }).get("Acme");
    expect(on.billableMin).toBe(600);
    expect(off.billableMin).toBe(600);
    expect(on.totalMin).toBe(600);
    expect(off.totalMin).toBe(900);
  });
  it("prior-month minutes for estimate/mismatch are billable-only", () => {
    expect(billableMinutesByFolder(rows, "2026-09", true).get("acme")).toBe(600);
    expect(billableMinutesByFolder(rows, "2026-08", true)).toBeNull();
  });
  it("an export without a billable column counts everything as billable", () => {
    const m = aggregateMonthRows(rows, { monthKey: "2026-09", billableOnly: true, hasBillable: false }).get("Acme");
    expect(m.billableMin).toBe(900);
  });
});

describe("fix 9: folder-name case/whitespace variants are one client", () => {
  const rows = [row("GPEX", 600), row("gpex", 60), row("GPEX ", 30), row("Other", 10)];
  it("canonicalizes every variant to one display name (most minutes wins)", () => {
    const { canon, variantsOf } = buildFolderCanonicalizer(rows);
    expect(canon("gpex")).toBe("GPEX");
    expect(canon(" GPEX ")).toBe("GPEX");
    expect(variantsOf("GPEX").sort()).toEqual(["GPEX", "GPEX ", "gpex"].sort());
  });
  it("a registered spelling wins over the busiest variant", () => {
    const { canon } = buildFolderCanonicalizer(rows, ["GPEx"]);
    expect(canon("GPEX")).toBe("GPEx");
  });
  it("aggregates the variants into a single row", () => {
    const { canon } = buildFolderCanonicalizer(rows);
    const map = aggregateMonthRows(rows, { monthKey: "2026-09", billableOnly: true, hasBillable: true, canon });
    expect([...map.keys()].sort()).toEqual(["GPEX", "Other"]);
    expect(map.get("GPEX").totalMin).toBe(690);
  });
  it("folderKey-keyed lookups agree across variants", () => {
    expect(folderKey(" GPEX ")).toBe(folderKey("gpex"));
    expect(billableMinutesByFolder(rows, "2026-09", true).get(folderKey("Gpex"))).toBe(690);
  });
});

describe("fix 11: no carry on a row that isn't package-like", () => {
  it("a month after package -> hourly shows no prior balance", () => {
    const r = reconcileClientMonth({
      worked: 5, accruedClient: accrued({ agreedByMonth: { "2026-08": 20 }, balances: { "2026-08": -12 } }),
      monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 8, monthType: "hourly", priorType: "package",
    });
    expect(r.priorBalance).toBeNull();
    expect(r.priorMismatch).toBeNull();
  });
  it("the Carry KPI sums only package-like rows", () => {
    expect(sumCarry([
      { type: "package", priorBalance: -4 },
      { type: "strategy", priorBalance: 2 },
      { type: "hourly", priorBalance: -12 },
      { type: "package", priorBalance: null },
    ])).toBe(6);
  });
});

// A reconciled client object as App.jsx builds it, filtered to one consultant.
const pdfClient = (over = {}) => {
  const tasksAll = new Map([["Strategy call", 120], ["Ads build", 240]]);
  return {
    name: "Acme", displayName: "Acme", type: "package", accruedClient: null,
    tasksAll, taskUsers: new Map(), userMinutes: new Map([["Suba", 120], ["Chloe", 240]]),
    worked: 6, billableWorked: 6,
    tasksFiltered: new Map([["Strategy call", 120]]), workedFiltered: 2, // filtered to Suba
    pkg: 10, priorBalance: -2, priorRebaseline: null, status: "ok",
    newBalance: -6, remaining: 6, balanceForward: -6, remainingShown: 6, resetValue: null, kpiPct: -60,
    ...over,
  };
};

describe("fix 5: PDF / copy never mix consultant-filtered hours with whole-client balances", () => {
  it("unfilteredForExport swaps in the whole client's tasks and hours", () => {
    const u = unfilteredForExport(pdfClient());
    expect(u.workedFiltered).toBe(6);
    expect([...u.tasksFiltered.keys()]).toEqual(["Strategy call", "Ads build"]);
  });
  it("the PDF lists every task and the full hours alongside the balance", () => {
    const html = buildPrintHtml(pdfClient(), "September 2026", "August 2026");
    expect(html).toContain("Ads build");
    expect(html).toMatch(/Time tracked this month<\/td><td class="right">6\.00 h/);
    expect(html).toMatch(/Total accrued time<\/td><td class="right">4\.00 h/);
  });
  it("the copy summary uses the full hours too", () => {
    const text = buildSummaryText(pdfClient(), { invoiceMonth: "September 2026", priorMonthPretty: "August 2026" });
    expect(text).toContain("Ads build");
    expect(text).toContain("Time tracked this month: 6.00 h");
    expect(text).not.toContain("Filtered to consultant");
  });
});

describe("fix 12: package client with no package on file", () => {
  for (const pkg of [null, 0]) {
    it(`PDF and copy say so instead of "0.00 h over" (pkg ${pkg})`, () => {
      const c = pdfClient({ pkg, newBalance: null, remaining: null, balanceForward: null, remainingShown: null, status: "no-pkg", kpiPct: null });
      const html = buildPrintHtml(c, "September 2026", "August 2026");
      expect(html).toContain("No package on file");
      expect(html).not.toContain("h over");
      expect(html).not.toContain("New balance going forward");
      const text = buildSummaryText(c, {});
      expect(text).toContain("No package on file");
      expect(text).not.toMatch(/Over by|Remaining this month/);
    });
  }
  it("an on-hold month's PDF says the package is paused", () => {
    const html = buildPrintHtml(pdfClient({ status: "on_hold", newBalance: -2, balanceForward: -2, remaining: 2, remainingShown: 2, kpiPct: null }), "September 2026", "August 2026");
    expect(html).toContain("On hold this month");
    expect(html).not.toContain("Remaining this month");
  });
});

describe("fix 6: quoted budget counts only the current quote's months", () => {
  const timeline = [
    { from: null, type: "package", agreedHours: 20 },
    { from: "2026-03-01", type: "quoted", agreedHours: 40 },
    { from: "2026-06-15", type: "hourly", agreedHours: null },
    { from: "2026-08-01", type: "quoted", agreedHours: 25 },
  ];
  it("starts at the quoted segment and uses that segment's amount", () => {
    expect(quotedBudgetFor(timeline, "2026-05")).toEqual({ fromMonth: "2026-03", amount: 40 });
  });
  it("the current (last) segment prefers the live profile amount (direct quoted-amount edits)", () => {
    expect(quotedBudgetFor(timeline, "2026-09", { currentAgreedHours: 30 })).toEqual({ fromMonth: "2026-08", amount: 30 });
  });
  it("a mid-month start begins the following month, matching typeForMonth", () => {
    const t = [{ from: null, type: "hourly", agreedHours: null }, { from: "2026-04-10", type: "quoted", agreedHours: 12 }];
    expect(quotedBudgetFor(t, "2026-06")).toEqual({ fromMonth: "2026-05", amount: 12 });
  });
  it("a base quoted client has no lower bound; not quoted -> null", () => {
    expect(quotedBudgetFor([{ from: null, type: "quoted", agreedHours: 10 }], "2026-09")).toEqual({ fromMonth: null, amount: 10 });
    expect(quotedBudgetFor(timeline, "2026-07")).toBeNull();
  });
  it("sums minutes only within the quote window", () => {
    const byMonth = new Map([["2026-02", 600], ["2026-03", 60], ["2026-05", 120], ["2026-06", 999], ["", 7]]);
    expect(sumMinutesInRange(byMonth, "2026-03", "2026-05")).toBe(180);
    expect(sumMinutesInRange(byMonth, null, null)).toBe(600 + 60 + 120 + 999 + 7);
  });
});

// ------------------------------ QA follow-up round ------------------------------

describe("QA 1: seeded zero-hour rows never shadow real data", () => {
  const monthFolderKeys = new Set(["coonawarra grape and wine inc", "bamss childcare security services", "other"].map(folderKey));
  it("not seeded when the ledger name is already matched by a real row", () => {
    expect(seedBlockedBy({ ledgerName: "Acme", matchedLedgerNames: new Set(["Acme"]), monthFolderKeys })).toBe(true);
  });
  it("not seeded when its registered folder (any case/whitespace variant) has rows -- e.g. an unmatched hourly row awaiting a manual match", () => {
    expect(seedBlockedBy({ ledgerName: "Coonwarra", matchedLedgerNames: new Set(), ownFolder: "COONAWARRA Grape and Wine Inc ", monthFolderKeys })).toBe(true);
  });
  it("not seeded when one of its multi-folder/cost-centre folders has rows (claimed by another client's roll-up)", () => {
    expect(seedBlockedBy({ ledgerName: "BAMSS", matchedLedgerNames: new Set(), ownFolder: "BAMSS Folder Elsewhere", clientFolders: ["BAMSS Childcare Security Services"], monthFolderKeys })).toBe(true);
  });
  it("seeded when nothing of the client's has rows this month", () => {
    expect(seedBlockedBy({ ledgerName: "Quiet Co", matchedLedgerNames: new Set(["Acme"]), ownFolder: "Quiet Co", clientFolders: [], monthFolderKeys })).toBe(false);
  });
});

describe("QA 2: prior-month hours resolve the client's real folders, not its display name", () => {
  afterEach(() => setDynamicCostCentres([]));
  const allFolders = ["Aged Rights Advocacy Services", "ARAS Website Optimisation Project", "Unrelated"];
  it("a renamed row (c.name = client name) uses the registered folder", () => {
    const keys = priorFolderKeysFor({ name: "ARAS", clientName: "ARAS", ownFolder: "Aged Rights Advocacy Services", allFolders, accrualMatchesFor: multiFolderAccrualMatchesFor });
    expect(keys).toEqual([folderKey("Aged Rights Advocacy Services")]);
  });
  it("a seeded row whose client has a dynamic cost centre sums every accrual folder (own folder folded in)", () => {
    setDynamicCostCentres([
      { client: "Majestic Plumbing", folder: "MP - Commercial Leak Tech", kind: "cost_centre" },
      { client: "Majestic Plumbing", folder: "MP Quoted Web Project", kind: "sub_project" },
    ]);
    const keys = priorFolderKeysFor({
      name: "Majestic Plumbing", clientName: "Majestic Plumbing", ownFolder: "Majestic Plumbing (WA)",
      allFolders: ["Majestic Plumbing (WA)", "MP - Commercial Leak Tech", "MP Quoted Web Project"], accrualMatchesFor: multiFolderAccrualMatchesFor,
    });
    expect(keys.sort()).toEqual([folderKey("MP - Commercial Leak Tech"), folderKey("Majestic Plumbing (WA)")].sort());
  });
  it("a sub-project and an unregistered folder row keep their own folder", () => {
    expect(priorFolderKeysFor({ name: "ARAS Website Optimisation Project", clientName: "ARAS", isSubProject: true, allFolders })).toEqual([folderKey("ARAS Website Optimisation Project")]);
    expect(priorFolderKeysFor({ name: "Some Folder ", clientName: null, allFolders })).toEqual(["some folder"]);
  });
  it("with the real folder's hours the ledger balance is not a false mismatch (sheet -2 vs recomputed -32 before)", () => {
    const a = accrued({ name: "ARAS", agreedByMonth: { "2026-08": 32, "2026-09": 32 }, balances: { "2026-08": -2, "2026-07": 0 } });
    const priorWorked = new Map([[folderKey("Aged Rights Advocacy Services"), 30 * 60]]);
    const keys = priorFolderKeysFor({ name: "ARAS", clientName: "ARAS", ownFolder: "Aged Rights Advocacy Services", allFolders, accrualMatchesFor: multiFolderAccrualMatchesFor });
    const priorWorkedH = keys.reduce((s, k) => s + (priorWorked.get(k) || 0), 0) / 60;
    const r = reconcileClientMonth({ worked: 0, accruedClient: a, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH, monthType: "package", priorType: "package" });
    expect(priorWorkedH).toBe(30);
    expect(r.priorMismatch).toBeNull();
  });
});

describe("QA 3: prior month inside an end period carries nothing", () => {
  // Equippers: offboarded 2026-06-01, re-signed as a 24h package from 2026-08-01 via a type event.
  const profile = { client: "Equippers", status: "active", endDate: null, baseType: "package", baseAgreedHours: 24 };
  const events = [
    { id: 1, client: "Equippers", kind: "offboarding", applied: true, effective_date: "2026-06-01" },
    { id: 2, client: "Equippers", kind: "type", applied: true, effective_date: "2026-08-01", new_type: "package", new_agreed_hours: 24 },
  ];
  const periods = endPeriodsFor(profile, events);
  it("finds July inside the end period and August outside it", () => {
    expect(monthInEndPeriods(periods, "2026-07")).toBe(true);
    expect(monthInEndPeriods(periods, "2026-06")).toBe(true);
    expect(monthInEndPeriods(periods, "2026-08")).toBe(false);
    expect(monthInEndPeriods(periods, "2026-05")).toBe(false);
  });
  it("re-engagement month starts from 0, not an estimated 24h carry", () => {
    const a = accrued({ name: "Equippers", agreedByMonth: { "2026-08": 24 }, balances: {} });
    const r = reconcileClientMonth({
      worked: 10, accruedClient: a, monthKey: "2026-08", priorKey: "2026-07", priorWorkedH: 0,
      monthType: "package", priorType: "package", priorStatus: "offboarded", priorEnded: true,
    });
    expect(r.priorBalance).toBe(0);
    expect(r.priorBalanceEstimated).toBe(false);
    expect(r.priorMismatch).toBeNull();
    expect(r.newBalance).toBe(-14);
  });
  it("an undated end period counts a month as ended only without evidence of its own", () => {
    const undated = [{ from: null, until: null, after: "2026-03", note: "Client offboarded" }];
    expect(monthInEndPeriods(undated, "2026-07")).toBe(true);
    expect(monthInEndPeriods(undated, "2026-07", { hasEvidence: true })).toBe(false);
    expect(monthInEndPeriods(undated, "2026-02")).toBe(false);
  });
});

describe("QA 4: current month seeded before recompute has written its ledger row", () => {
  it("falls back to the month's own agreed hours for a registered package-like client", () => {
    const a = accrued({ agreedByMonth: { "2026-08": 20 } });
    expect(shouldSeedPackageMonth(a, "2026-10", "package", 20)).toBe(true);
    expect(shouldSeedPackageMonth(a, "2026-10", "package", null)).toBe(false);
    expect(shouldSeedPackageMonth(a, "2026-10", null, 20)).toBe(false); // unregistered: ledger only
    expect(shouldSeedPackageMonth(accrued({ agreedByMonth: { "2026-10": null } }), "2026-10", "package", 20)).toBe(false); // ledger says no package
  });
});

describe("QA 5: Sync now reloads data even when one month's sync failed", () => {
  it("returns the fresh data and the error together", async () => {
    const live = { rows: [] };
    const out = await runManualSync({
      trigger: async () => { throw new Error("Current month: boom"); },
      fetchLive: async () => live,
      fetchMeta: async () => ({ last_sync_status: "error" }),
    });
    expect(out.live).toBe(live);
    expect(out.meta).toEqual({ last_sync_status: "error" });
    expect(out.error.message).toBe("Current month: boom");
  });
  it("no error on success", async () => {
    const out = await runManualSync({ trigger: async () => ({}), fetchLive: async () => null, fetchMeta: async () => null });
    expect(out.error).toBeNull();
  });
});

// Live Sep 2026: "Majestic Plumbing Quoted Web Project (WA)" showed PACKAGE (its name
// fuzzy-matched the parent's profile/ledger) and "Apex Comms Website (QP)" HOURLY.
describe("unregistered sub-project folders are never package-like", () => {
  it("a quoted-looking folder name is quoted, anything else hourly", () => {
    expect(subProjectType("Majestic Plumbing Quoted Web Project (WA)")).toBe("quoted");
    expect(subProjectType("Apex Comms Website (QP)")).toBe("quoted");
    expect(subProjectType("Acme QP Brochure")).toBe("quoted");
    expect(subProjectType("ARAS Website Optimisation Project")).toBe("hourly");
    expect(subProjectType("BAMSS Childcare Security Services")).toBe("hourly");
    expect(subProjectType("Aqpa Things")).toBe("hourly"); // "QP" only as its own word
  });
  it("its own registered profile's type wins, unless that's package-like", () => {
    expect(subProjectType("Apex Comms Sales Presenter (QP)", { profileType: "quoted" })).toBe("quoted");
    expect(subProjectType("Website (QP)", { profileType: "hourly" })).toBe("hourly");
    expect(subProjectType("Website (QP)", { profileType: "package" })).toBe("quoted");
    expect(subProjectType("Website", { profileType: "strategy" })).toBe("hourly");
  });
  it("Capacity Planning's basis for the exact folder is next, also never package-like", () => {
    expect(subProjectType("Employee Guide", { capType: "quoted" })).toBe("quoted");
    expect(subProjectType("Employee Guide", { capType: "package" })).toBe("hourly");
  });
  it("as the month type it keeps the parent's package off the row entirely", () => {
    const parentLedger = accrued({ name: "Majestic Plumbing", agreedByMonth: { "2026-08": 16, "2026-09": 16 }, balances: { "2026-08": 6 } });
    const r = reconcileClientMonth({
      worked: 2.17, accruedClient: parentLedger, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 3,
      monthType: subProjectType("Majestic Plumbing Quoted Web Project (WA)"), priorType: "quoted",
    });
    expect(r.pkg).toBe(null);
    expect(r.priorBalance).toBe(null);
    expect(r.remaining).toBe(null);
    expect(r.status).toBe("no-pkg");
  });
});

describe("resolveClientType: a fixed-price type can't be turned back into a package", () => {
  it("the Clients month type wins over the ledger guess", () => {
    expect(resolveClientType({ name: "Rent Busters", matched: true, pkg: 8, monthType: "digital" }).type).toBe("digital");
    expect(resolveClientType({ name: "Astill", matched: true, pkg: 80, monthType: "map" }).type).toBe("map");
  });
  it("the Capacity Planning basis only demotes, never promotes", () => {
    expect(resolveClientType({ name: "Rent Busters", monthType: "digital", capType: "package" })).toEqual({ type: "digital", demoted: false });
    expect(resolveClientType({ name: "Astill", monthType: "map", capType: "strategy" })).toEqual({ type: "map", demoted: false });
    expect(resolveClientType({ name: "Warrina Guide", matched: true, pkg: 24, capType: "quoted" })).toEqual({ type: "quoted", demoted: true });
  });
  it("unregistered fallbacks: matched with a package -> package, (Qld) -> queensland, else hourly", () => {
    expect(resolveClientType({ name: "Acme", matched: true, pkg: 20 }).type).toBe("package");
    expect(resolveClientType({ name: "Acme (QLD)" }).type).toBe("queensland");
    expect(resolveClientType({ name: "Acme", matched: true, pkg: null }).type).toBe("hourly");
  });
});

// "Any MAP we do will be 80 hrs altogether, not just for the month. We quote 80 hrs to do a
// MAP." -- a MAP is a lifetime budget exactly like Quoted, never a monthly package.
describe("MAP: one fixed hour budget for the whole plan, no accrual", () => {
  it("is a lifetime-budget type alongside Quoted; package/digital/hourly aren't", () => {
    expect(isLifetimeBudgetType("map")).toBe(true);
    expect(isLifetimeBudgetType("quoted")).toBe(true);
    for (const t of ["package", "strategy", "hourly", "digital", null]) expect(isLifetimeBudgetType(t)).toBe(false);
  });
  // Astill Consultants: base type map, 80 h, start_date 2026-08-01.
  const astill = [{ from: null, type: "map", agreedHours: 80 }];
  it("the budget runs from the profile start date for a base-type MAP", () => {
    expect(lifetimeBudgetFor(astill, "2026-09", { type: "map", currentAgreedHours: 80, startDate: "2026-08-01" })).toEqual({ fromMonth: "2026-08", amount: 80 });
    expect(lifetimeBudgetFor(astill, "2026-09", { type: "map", startDate: "2026-08-15" }).fromMonth).toBe("2026-09");
  });
  it("Astill Sep 2026: remaining = 80 - (Aug + Sep billable), nothing before the start counted", () => {
    const b = lifetimeBudgetFor(astill, "2026-09", { type: "map", currentAgreedHours: 80, startDate: "2026-08-01" });
    const byMonth = new Map([["2026-07", 600], ["2026-08", 23.53 * 60], ["2026-09", 46.3 * 60], ["2026-10", 300]]);
    const lifetime = sumMinutesInRange(byMonth, b.fromMonth, "2026-09") / 60;
    expect(lifetime).toBeCloseTo(69.83, 6);
    expect(b.amount - lifetime).toBeCloseTo(10.17, 6);
  });
  it("a MAP segment after another type starts at that segment, and a quoted run isn't a MAP", () => {
    const t = [{ from: null, type: "package", agreedHours: 20 }, { from: "2026-05-01", type: "map", agreedHours: 80 }, { from: "2026-09-01", type: "quoted", agreedHours: 30 }];
    expect(lifetimeBudgetFor(t, "2026-07", { type: "map" })).toEqual({ fromMonth: "2026-05", amount: 80 });
    expect(lifetimeBudgetFor(t, "2026-09", { type: "map" })).toBeNull();
    expect(quotedBudgetFor(t, "2026-09")).toEqual({ fromMonth: "2026-09", amount: 30 });
  });
  it("the reconciliation gives a MAP month no package, carry or balance, even with a ledger on file", () => {
    const ledger = accrued({ name: "Astill Consultants", agreedByMonth: { "2026-08": 40, "2026-09": 40 }, balances: { "2026-08": -12 }, resets: { "2026-09": 3 } });
    const r = reconcileClientMonth({
      worked: 46.3, accruedClient: ledger, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 30,
      monthType: "map", priorType: "map", monthSegmentAgreed: 80, allowScalarPackage: true,
    });
    expect(r).toMatchObject({ pkg: null, priorBalance: null, priorBalanceEstimated: false, newBalance: null, remaining: null, priorMismatch: null, priorRebaseline: null });
  });
  it("never counts toward the Carry KPI or the last-month accrued export, and is never seeded", () => {
    const c = { type: "map", pkg: null, priorBalance: null, quotedAmount: 80 };
    expect(sumCarry([c])).toBe(0);
    expect(lastMonthAccruedClients([c])).toEqual([]);
    expect(shouldSeedPackageMonth(accrued({ agreedByMonth: { "2026-09": 80 } }), "2026-09", "map", 80)).toBe(false);
  });
  it("a package month after a MAP month starts with no carry", () => {
    const r = reconcileClientMonth({
      worked: 10, accruedClient: accrued({ agreedByMonth: { "2026-09": 20 }, balances: { "2026-08": -40 } }),
      monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 40, monthType: "package", priorType: "map",
    });
    expect(r.priorBalance).toBe(0);
  });
  it("the copy summary and PDF report the MAP budget like a quote, in MAP wording", () => {
    const c = {
      name: "Astill Consultants", displayName: "Astill Consultants", type: "map", pkg: null, worked: 46.3, billableWorked: 46.3,
      quotedAmount: 80, lifetimeWorked: 69.83, quotedRemaining: 10.17,
      tasksAll: new Map(), taskUsers: new Map(), userMinutes: new Map(),
    };
    const text = buildSummaryText(c, { invoiceMonth: "September 2026" });
    expect(text).toContain("MAP hours: 80.00 h");
    expect(text).toContain("Total time tracked on this MAP: 69.83 h");
    expect(text).toContain("Remaining of MAP amount: 10.17 h");
    expect(text).not.toContain("Carried in");
    const html = buildPrintHtml(c, "September 2026", "August 2026");
    expect(html).toContain("MAP summary");
    expect(html).toContain("Remaining of MAP amount");
    expect(html).not.toContain("Carried in from previous month");
  });
});

// Rent Busters moves to "digital" (Digital Package): a fixed price, never accrues.
describe("Digital Package: fixed price, no package math", () => {
  const ledger = accrued({ name: "Rent Busters (Bunbury, WA)", package: 8, agreedByMonth: { "2026-08": 8, "2026-09": 8 }, balances: { "2026-08": -4 } });
  it("no package, carry, remaining or balance even with a ledger on file; status is fixed price", () => {
    const r = reconcileClientMonth({
      worked: 7.08, accruedClient: ledger, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 6,
      monthType: "digital", priorType: "package", monthSegmentAgreed: 8, allowScalarPackage: true,
    });
    expect(r).toMatchObject({
      pkg: null, priorBalance: null, priorBalanceEstimated: false, newBalance: null, remaining: null,
      kpiPct: null, priorMismatch: null, balanceForward: null, remainingShown: null, status: "fixed_price",
    });
  });
  it("is never seeded as a zero-hour package row", () => {
    expect(shouldSeedPackageMonth(ledger, "2026-09", "digital", 8)).toBe(false);
  });
  it("never counts toward Carry or the last-month accrued export", () => {
    const c = { type: "digital", pkg: null, priorBalance: null };
    expect(sumCarry([c])).toBe(0);
    expect(lastMonthAccruedClients([c])).toEqual([]);
  });
  it("a package month after a digital one carries nothing", () => {
    const r = reconcileClientMonth({
      worked: 4, accruedClient: ledger, monthKey: "2026-09", priorKey: "2026-08", priorWorkedH: 6,
      monthType: "package", priorType: "digital",
    });
    expect(r.priorBalance).toBe(0);
  });
  it("labels: the Digital badge falls back when nameMatch has no entry yet", () => {
    expect(["Digital", "Digital Package"]).toContain(typeLabelShort("digital"));
    expect(typeLabelShort("package")).toBe("Package");
    expect(typeTone("digital")).toMatch(/^var\(/);
  });
  it("the copy summary and PDF say fixed price with no package lines", () => {
    const c = {
      name: "Rent Busters (Bunbury, WA)", displayName: "Rent Busters (Bunbury, WA)", type: "digital", pkg: null, worked: 7.08, billableWorked: 7.08,
      tasksAll: new Map(), taskUsers: new Map(), userMinutes: new Map(),
    };
    const text = buildSummaryText(c, { invoiceMonth: "September 2026" });
    expect(text).toContain("fixed monthly price");
    expect(text).not.toMatch(/^Package:/m);
    expect(text).not.toContain("Carried in");
    expect(text).not.toContain("Remaining");
    expect(text).not.toContain("undefined");
    const html = buildPrintHtml(c, "September 2026", "");
    expect(html).toContain("Digital Package: fixed monthly price");
  });
});
