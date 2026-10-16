import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./supabaseClient.js", () => ({ supabase: {} }));

import { buildInvoicingContext, buildClientsForMonth } from "./invoicingPipeline.js";
import { setDynamicCostCentres } from "./nameMatch.js";
import { rowToClient } from "./clientsSync.js";
import { rowsToClients, buildReconciliationClients, ACCRUALS_LIVE_SYNC_LABEL } from "./accrualsSync.js";
import { directoryToInputs } from "./clientDirectory.js";
import { scopeClientList, withholdRedactedFigures, computePrimaryNameByGroup, filterClientList, scopedCardLists, WITHHELD_FIELDS } from "./clientListFilter.js";
import { sumCarry } from "./reconcile.js";

// Parity: a scoped (Invoicing "assigned") user runs the admin pipeline over the directory's
// inputs, then filters cards. Every card they can see must carry exactly the admin card's
// numbers -- including everyone else's minutes -- and the inputs they'd get from their own
// RLS reads alone must NOT be enough (the fuzzy trap below proves why).

const MONTH = "2026-09";
const PRIOR = "2026-08";

// ---- the database, as raw table rows (what the admin path reads) ----
const CLIENT_ROWS = [
  // Holly's (assigned): a package whose folder is a substring trap for "Apex Energy Solutions".
  { client: "Apex", type: "package", base_type: "package", agreed_hours: 20, base_agreed_hours: 20, status: "active", clickup_folder: "Apex", fixed_fee: null, start_date: null, end_date: null, logo_url: null },
  // Not Holly's: if its row were hidden, its folder would substring-match "Apex" above.
  { client: "Apex Energy Solutions", type: "package", base_type: "package", agreed_hours: 30, base_agreed_hours: 30, status: "active", clickup_folder: "Apex Energy Solutions", fixed_fee: null, start_date: null, end_date: null, logo_url: null },
  // Holly's: a multi-folder (dynamic cost-centre) package with a separately billed sub-project.
  { client: "Majestic Plumbing", type: "package", base_type: "package", agreed_hours: 24, base_agreed_hours: 12, status: "active", clickup_folder: "Majestic Plumbing (WA)", fixed_fee: null, start_date: null, end_date: null, logo_url: null },
  // The sub-project, registered as its own quoted client (assigned via its parent).
  { client: "MP Web Project", type: "quoted", base_type: "quoted", agreed_hours: 40, base_agreed_hours: 40, status: "active", clickup_folder: "Majestic Plumbing Quoted Web Project (WA)", fixed_fee: null, start_date: "2026-07-01", end_date: null, logo_url: null },
  // Not Holly's; no hours this month -> a seeded zero-hour package row (admin only).
  { client: "Toto and Co", type: "package", base_type: "package", agreed_hours: 10, base_agreed_hours: 10, status: "active", clickup_folder: "Toto and Co", fixed_fee: null, start_date: null, end_date: null, logo_url: null },
  // Not Holly's and no folder registered: Holly logged time in "Brightside Marketing", which
  // only fuzzy-matches it -- so ClickUp-derived access never assigned it.
  { client: "Brightside", type: "hourly", base_type: "hourly", agreed_hours: null, base_agreed_hours: null, status: "active", clickup_folder: null, fixed_fee: 2500, start_date: null, end_date: null, logo_url: null },
];
const EVENT_ROWS = [
  { id: 1, client: "Majestic Plumbing", kind: "type", effective_date: "2026-03-01", applied: true, new_type: "package", new_agreed_hours: 24, note: "Hours increased" },
  { id: 2, client: "Apex Energy Solutions", kind: "hold", effective_date: "2026-05-01", applied: true, new_type: null, new_agreed_hours: null, note: "Paused" },
  { id: 3, client: "Apex Energy Solutions", kind: "resume", effective_date: "2026-06-01", applied: true, new_type: null, new_agreed_hours: null, note: null },
];
const COST_CENTRE_ROWS = [
  { client: "Majestic Plumbing", folder: "MP - Commercial Leak Tech (WA)", kind: "cost_centre", source_folder: null, task_prefix: null },
  { client: "Majestic Plumbing", folder: "Majestic Plumbing Quoted Web Project (WA)", kind: "sub_project", source_folder: null, task_prefix: null },
];
const ACCRUAL_ROWS = [
  { client: "Apex", month_key: "2026-08", agreed_hpm: "20", accrual_value: -5, reset_value: null },
  { client: "Apex", month_key: "2026-09", agreed_hpm: "20", accrual_value: null, reset_value: null },
  { client: "Apex Energy Solutions", month_key: "2026-08", agreed_hpm: "30", accrual_value: -2, reset_value: -4 },
  { client: "Apex Energy Solutions", month_key: "2026-09", agreed_hpm: "30", accrual_value: null, reset_value: null },
  { client: "Majestic Plumbing", month_key: "2026-08", agreed_hpm: "24 (Aug)", accrual_value: 3.5, reset_value: -1 },
  { client: "Majestic Plumbing", month_key: "2026-09", agreed_hpm: "24", accrual_value: null, reset_value: null },
  { client: "Toto and Co", month_key: "2026-08", agreed_hpm: "10", accrual_value: 0, reset_value: null },
  { client: "Toto and Co", month_key: "2026-09", agreed_hpm: "10", accrual_value: null, reset_value: null },
].map((r) => ({ account_manager: null, accrual_note: null, pct_over_under: null, comment: "ledger note", worked_hours: null, is_override: false, hours_flagged: false, flagged_from_hours: null, reset_note: null, ...r }));
const CAP_CLIENTS = [
  { group: "Majestic Plumbing", client: "Majestic Plumbing (WA)", basis: "Package", agreed: 24, status: "active" },
  { group: "Majestic Plumbing", client: "Majestic Plumbing Quoted Web Project (WA)", basis: "Quoted", agreed: 0, status: "active" },
];
const row = (user, folder, minutes, monthKey = MONTH, task = "Work") => ({
  folder, task, taskId: null, minutes, billable: true, hasBillableCol: true, user, isInternal: false, nonClientSpace: false,
  monthKey, monthLabel: monthKey, dateKey: `${monthKey}-10`,
});
const CLICKUP = {
  rows: [
    row("Holly Fraser", "Majestic Plumbing (WA)", 600),
    row("Chloe Smith", "MP - Commercial Leak Tech (WA)", 300),
    row("Kelly W", "Majestic Plumbing Quoted Web Project (WA)", 120),
    row("Chloe Smith", "Apex", 240),
    row("Chloe Smith", "Apex Energy Solutions", 480),
    row("Holly Fraser", "Brightside Marketing", 60),
    // Folders only a manual name-match override ties to a client (NAME_MATCHES below).
    row("Holly Fraser", "HF - Social Ads", 90),
    row("Chloe Smith", "AES Retainer", 120),
    row("Holly Fraser", "Majestic Plumbing (WA)", 900, PRIOR),
    row("Chloe Smith", "Apex", 300, PRIOR),
    row("Chloe Smith", "Apex Energy Solutions", 600, PRIOR),
    row("Kelly W", "Majestic Plumbing Quoted Web Project (WA)", 240, PRIOR),
  ],
  hasBillable: true, hasUser: true, hasStartDate: true, warnings: [], fileName: "Live sync from ClickUp",
};

// pginvoice_name_matches: shared manual overrides (admin-set), read by admin and scoped users
// alike -- including one for a client that isn't Holly's.
const NAME_MATCHES = { "HF - Social Ads": "Apex", "AES Retainer": "Apex Energy Solutions" };

// Holly: pginvoice_user_clients (ClickUp-derived + manual).
const HOLLY_CLIENTS = ["Apex", "Majestic Plumbing"];
const HOLLY_NAMES = ["holly fraser"]; // compared case-insensitively

// ---- what the admin path builds (fetchClients / fetchClientEvents / fetchAccruedForReconciliation) ----
const adminInputs = () => ({
  pgClients: CLIENT_ROWS.map(rowToClient),
  pgClientEvents: EVENT_ROWS,
  accrued: { ...buildReconciliationClients(rowsToClients(ACCRUAL_ROWS)), warnings: [], fileName: ACCRUALS_LIVE_SYNC_LABEL },
});

// ---- JS mirror of pginvoice_client_directory() (20261017_scoped_modules.sql) for `mine` ----
const sign = (v) => (v == null ? null : Math.sign(Number(v)));
function directoryFor(mine) {
  const direct = new Set(mine);
  const ok = new Set(direct);
  // A client whose own folder is a cost-centre folder of an assigned client follows it.
  for (const c of CLIENT_ROWS) {
    if (COST_CENTRE_ROWS.some((cc) => direct.has(cc.client) && c.clickup_folder && cc.folder.trim().toLowerCase() === c.clickup_folder.trim().toLowerCase())) ok.add(c.client);
  }
  const parseNum = (s) => { const m = String(s ?? "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
  return {
    clients: CLIENT_ROWS.map((c) => {
      const a = ok.has(c.client);
      return {
        client: c.client, clickup_folder: c.clickup_folder, status: c.status, type: c.type, base_type: c.base_type,
        start_date: c.start_date, end_date: c.end_date, logo_url: c.logo_url,
        agreed_hours: a ? c.agreed_hours : sign(c.agreed_hours), base_agreed_hours: a ? c.base_agreed_hours : sign(c.base_agreed_hours),
        fixed_fee: a ? c.fixed_fee : null, assigned: a,
      };
    }),
    events: EVENT_ROWS.filter((e) => e.applied).map((e) => ({ ...e, new_agreed_hours: ok.has(e.client) ? e.new_agreed_hours : sign(e.new_agreed_hours), note: ok.has(e.client) ? e.note : null })),
    costCentres: COST_CENTRE_ROWS,
    accruals: ACCRUAL_ROWS.map((x) => {
      const a = ok.has(x.client);
      const n = parseNum(x.agreed_hpm);
      return {
        client: x.client, month_key: x.month_key,
        agreed_hpm: a ? x.agreed_hpm : (n == null ? null : String(Math.sign(n))),
        accrual_value: a ? x.accrual_value : null, reset_value: a ? x.reset_value : null,
      };
    }),
  };
}

const build = ({ pgClients, pgClientEvents, accrued }, costCentres, monthKey = MONTH, priorKey = PRIOR, nameMap = NAME_MATCHES) => {
  setDynamicCostCentres(costCentres);
  const ctx = buildInvoicingContext({ clickup: CLICKUP, accrued, nameMap, billableOnly: true, pgClients, pgClientEvents, capClients: CAP_CLIENTS });
  return buildClientsForMonth(ctx, monthKey, priorKey, { currentMonthKey: MONTH });
};

// What App.jsx shows a scoped user: the SAME scopedCardLists call App makes (its `clients`).
const scopedView = (full, dir, opts) => scopedCardLists(full, dir, HOLLY_NAMES, opts).inScope;

// Everything a card displays or exports that comes out of the reconciliation.
const FIGURES = [
  "name", "displayName", "type", "worked", "billableWorked", "pkg", "priorBalance", "priorBalanceEstimated", "newBalance",
  "remaining", "kpiPct", "status", "priorMismatch", "priorRebaseline", "resetValue", "remainingReset", "balanceForward",
  "remainingShown", "quotedAmount", "quotedRemaining", "lifetimeWorked", "fixedFee", "costCentreParentAccName", "capGroup",
  "seeded", "matched",
];
const figures = (c) => ({
  ...Object.fromEntries(FIGURES.map((k) => [k, c[k] ?? null])),
  userMinutes: Object.fromEntries(c.userMinutes),
  lineItems: (c.costCentre?.lineItems || []).map((i) => [i.name, i.hours, i.billableHours]),
});

describe("scoped Client Invoicing: same numbers as admin", () => {
  let admin, dir, scopedFull, view;
  beforeEach(() => {
    admin = build(adminInputs(), COST_CENTRE_ROWS);
    dir = directoryToInputs(directoryFor(HOLLY_CLIENTS));
    scopedFull = build(dir, dir.costCentres);
    view = scopedView(scopedFull, dir);
  });

  it("shows only Holly's cards: assigned clients, her own time, and sub-projects of those", () => {
    expect(view.map((c) => c.name).sort()).toEqual(["Apex", "Brightside Marketing", "HF - Social Ads", "Majestic Plumbing", "Majestic Plumbing Quoted Web Project (WA)"]);
    // Not Holly's, and she logged nothing there: hidden even though the pipeline computed them.
    expect(scopedFull.map((c) => c.name)).toEqual(expect.arrayContaining(["Apex Energy Solutions", "Toto and Co"]));
  });

  it("every visible card's figures deep-equal the admin card's (worked, carry, balance, roll-up, sub-project)", () => {
    const adminByName = new Map(admin.map((c) => [c.name, c]));
    for (const c of view.filter((v) => !v.withheld)) {
      expect(adminByName.has(c.name)).toBe(true);
      expect(figures(c)).toEqual(figures(adminByName.get(c.name)));
    }
  });

  it("the whole scoped pipeline output equals the admin output for every client Holly is assigned", () => {
    // Not just the filtered cards: the full run agrees row for row wherever no input was withheld.
    const withheldInputs = new Set([...dir.redactedClients]);
    const clean = (list) => list
      .filter((c) => ![c.profileClient, c.accruedClient?.name, c.costCentreAccruedName].some((n) => n && withheldInputs.has(n)))
      .map(figures);
    expect(clean(scopedFull)).toEqual(clean(admin));
    // Grouping/nesting decisions are identical too (sign-only agreed hours keep the seeded row).
    expect(scopedFull.map((c) => c.name)).toEqual(admin.map((c) => c.name));
    expect([...computePrimaryNameByGroup(scopedFull)]).toEqual([...computePrimaryNameByGroup(admin)]);
  });

  it("totals include everyone's minutes, not just Holly's", () => {
    const mp = view.find((c) => c.name === "Majestic Plumbing");
    // Holly 10 h on the parent + Chloe 5 h on the Commercial Leak Tech cost centre.
    expect(mp.worked).toBe(15);
    expect(Object.fromEntries(mp.userMinutes)).toEqual({ "Holly Fraser": 600, "Chloe Smith": 300 });
    expect(mp.costCentre.lineItems.map((i) => i.name)).toEqual(["Majestic Plumbing", "MP - Commercial Leak Tech (WA)"]);
    // Apex: Holly logged nothing; it's hers by assignment, and shows Chloe's 4 h.
    const apex = view.find((c) => c.name === "Apex");
    expect(apex.worked).toBe(4);
    expect(apex.priorBalance).toBe(-5);
    expect(apex.newBalance).toBe(4 - 20 - 5);
    // Carry (KPI) over the visible list matches the admin's same cards.
    const adminSame = admin.filter((c) => view.some((v) => v.name === c.name));
    expect(sumCarry(view)).toBe(sumCarry(adminSame));
    // The macro-sheet reset carries forward (Majestic Aug reset -1, not the computed 3.5).
    expect(mp.priorBalance).toBe(-1);
  });

  it("the sub-project nests under its parent with the parent-assigned (unwithheld) quoted budget", () => {
    const sub = view.find((c) => c.name === "Majestic Plumbing Quoted Web Project (WA)");
    expect(sub.costCentreParentAccName).toBe("Majestic Plumbing");
    expect(sub.withheld).toBeUndefined();
    expect(sub.quotedAmount).toBe(40);
    expect(sub.lifetimeWorked).toBe(6); // Kelly's 2 h this month + 4 h in Aug
    // filterClientList renders it inside the parent's tile, not as its own top-level card.
    const top = filterClientList(view, { clientTypeFilter: "all", consultantFilter: "", search: "", primaryNameByGroup: computePrimaryNameByGroup(scopedFull) });
    expect(top.map((c) => c.name).sort()).toEqual(["Apex", "Brightside Marketing", "HF - Social Ads", "Majestic Plumbing"]);
  });

  it("a shared name-match override applies identically for the scoped user and the admin", () => {
    const hf = view.find((c) => c.name === "HF - Social Ads");
    const adminHf = admin.find((c) => c.name === "HF - Social Ads");
    expect(hf.matchInfo).toEqual({ name: "Apex", confidence: 1, method: "manual" });
    expect(hf.accruedClient?.name).toBe("Apex");
    expect(hf.withheld).toBeUndefined();
    expect(figures(hf)).toEqual(figures(adminHf));
    // The override for a client that isn't Holly's still shapes the full computation the same
    // way (its card stays hidden: not hers and she logged nothing there).
    expect(scopedFull.find((c) => c.name === "AES Retainer").accruedClient?.name).toBe("Apex Energy Solutions");
    expect(admin.find((c) => c.name === "AES Retainer").accruedClient?.name).toBe("Apex Energy Solutions");
    expect(view.some((c) => c.name === "AES Retainer")).toBe(false);
    // ...and it really is the override doing it: without the shared rows neither folder matches.
    const noOverrides = build(dir, dir.costCentres, MONTH, PRIOR, {});
    expect(noOverrides.find((c) => c.name === "HF - Social Ads").accruedClient).toBeNull();
    expect(noOverrides.find((c) => c.name === "AES Retainer").accruedClient).toBeNull();
  });

  it("a card reached only through fuzzy matching to an unassigned client shows hours but withholds its figures", () => {
    const b = view.find((c) => c.name === "Brightside Marketing");
    const adminB = admin.find((c) => c.name === "Brightside Marketing");
    expect(b.withheld).toBe(true);
    expect(b.worked).toBe(adminB.worked);
    expect(b.fixedFee).toBeNull();
    expect(b.status).toBe("no-pkg");
  });

  it("the previous month (prevStats) keeps this month's cards, computed the same way", () => {
    const adminPrev = build(adminInputs(), COST_CENTRE_ROWS, PRIOR, "2026-07");
    const scopedPrev = build(dir, dir.costCentres, PRIOR, "2026-07");
    // As App.jsx does: last month filtered to THIS month's in-scope card names.
    const keepNames = new Set(view.map((c) => c.name));
    const prevView = scopedView(scopedPrev, dir, { keepNames });
    expect(prevView.map((c) => c.name).every((n) => keepNames.has(n))).toBe(true);
    expect(prevView.map((c) => c.name).sort()).toEqual(scopedPrev.map((c) => c.name).filter((n) => keepNames.has(n)).sort());
    const adminByName = new Map(adminPrev.map((c) => [c.name, c]));
    for (const c of prevView.filter((v) => !v.withheld)) expect(figures(c)).toEqual(figures(adminByName.get(c.name)));
  });

  it("the previous month never adds a card this month doesn't show (filter by kept names, not last month's minutes)", () => {
    const scopedPrev = build(dir, dir.costCentres, PRIOR, "2026-07");
    const keepNames = new Set(["Apex"]);
    expect(scopedView(scopedPrev, dir, { keepNames }).map((c) => c.name)).toEqual(["Apex"]);
  });

  it("admin tier (no directory): scopedCardLists returns the full list for all three", () => {
    const { shown, inScope, primary } = scopedCardLists(admin, null, []);
    expect(shown).toBe(admin);
    expect(inScope).toBe(admin);
    expect([...primary]).toEqual([...computePrimaryNameByGroup(admin)]);
  });

  it("every WITHHELD_FIELDS key is a real card field (a renamed field can't silently stop being withheld)", () => {
    // Some fields only exist on some card types (quoted, fixed fee), so check the union.
    const cardKeys = new Set(admin.flatMap((c) => Object.keys(c)));
    expect(Object.keys(WITHHELD_FIELDS).filter((k) => !cardKeys.has(k))).toEqual([]);
  });

  it("control: Holly's own RLS-scoped rows alone would misroute hours (why the directory exists)", () => {
    const mine = (r) => HOLLY_CLIENTS.includes(r.client);
    const naive = build({
      pgClients: CLIENT_ROWS.filter(mine).map(rowToClient),
      pgClientEvents: EVENT_ROWS.filter(mine),
      accrued: { ...buildReconciliationClients(rowsToClients(ACCRUAL_ROWS.filter(mine))), warnings: [], fileName: ACCRUALS_LIVE_SYNC_LABEL },
    }, COST_CENTRE_ROWS.filter(mine));
    const trap = naive.find((c) => c.name === "Apex Energy Solutions");
    // With "Apex Energy Solutions" unregistered, its folder substring-matches Holly's "Apex"
    // and claims Apex's package -- a second card showing Apex's numbers.
    expect(trap.accruedClient?.name).toBe("Apex");
    expect(trap.pkg).toBe(20);
    expect(admin.find((c) => c.name === "Apex Energy Solutions").accruedClient?.name).toBe("Apex Energy Solutions");
    // ...and it would then pass the scope filter as one of "her" clients.
    expect(scopeClientList(naive, { clients: HOLLY_CLIENTS, userNames: HOLLY_NAMES }, computePrimaryNameByGroup(naive)).map((c) => c.name)).toContain("Apex Energy Solutions");
  });
});

describe("scopeClientList", () => {
  const card = (name, extra = {}) => ({ name, userMinutes: new Map(), ...extra });
  it("keeps a parent when only something nested under it is the user's", () => {
    const list = [
      card("Apex Energy"),
      card("Apex Comms Website (QP)", { costCentreParentAccName: "Apex Energy", userMinutes: new Map([["Holly Fraser", 30]]) }),
      card("Other"),
    ];
    expect(scopeClientList(list, { userNames: ["HOLLY FRASER "] }).map((c) => c.name)).toEqual(["Apex Energy", "Apex Comms Website (QP)"]);
  });
  it("capGroup siblings follow their primary; zero minutes don't count; no scope = nothing", () => {
    const list = [
      card("Warrina Homes", { capGroup: "g", profileClient: "Warrina Homes" }),
      card("Warrina Homes - Employee Guide", { capGroup: "g" }),
      card("Idle", { userMinutes: new Map([["Holly Fraser", 0]]) }),
    ];
    const primary = new Map([["g", "Warrina Homes"]]);
    expect(scopeClientList(list, { clients: ["Warrina Homes"], userNames: ["Holly Fraser"] }, primary).map((c) => c.name))
      .toEqual(["Warrina Homes", "Warrina Homes - Employee Guide"]);
    expect(scopeClientList(list, {}, primary)).toEqual([]);
  });
  it("withholdRedactedFigures leaves cards alone when nothing is redacted (admin)", () => {
    const list = [card("A", { pkg: 10, accruedClient: { name: "A" } })];
    expect(withholdRedactedFigures(list, new Set())).toBe(list);
  });
});
