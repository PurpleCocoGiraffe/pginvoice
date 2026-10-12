import { describe, it, expect, vi } from "vitest";

// wagesView imports LEAVE_TYPES from leaveSync, which creates the real Supabase client.
vi.mock("./supabaseClient.js", () => ({ supabase: {} }));

import {
  buildMonthView, buildSnapshot, computeTotals, groupLines, filterLines, normaliseSettings, typeShort,
  hasExpected, adjustedExpected, variancePctOfAdjusted, toWorkbookRows, WORKBOOK_HEADINGS, REVIEW_FIELDS, COMMENT_FIELDS,
} from "./wagesView.js";
import { expectedFor, computeLine } from "./wagesCalc.js";

const round = (v) => Math.round(v * 100) / 100;
const CLIENTS = "90167546842";
const PG_HQ = "90160000001";
const MONTH = "2026-10"; // 22 weekdays; SA + QLD Labour/King's Birthday Mon 5 Oct, WA none

const roster = [
  { id: "p1", name: "Holly", role: "Consultant", state: "SA", photo: "data:image/jpeg;base64,AAAA" },
  { id: "p2", name: "Lucy", role: "Consultant", state: "QLD" },
  { id: "p3", name: "Chloe", role: "Coordinator", state: "SA" },
  { id: "p4", name: "Alice", role: "Consultant", state: "WA" },
  { id: "p5", name: "Newbie", role: "Consultant", state: "SA" }, // no wage_people row
  { id: "p6", name: "Gone", role: "Consultant", state: "SA", resignationDate: "2026-08-31" }, // resigned earlier, no row
  { id: "p7", name: "Leaver", role: "Consultant", state: "SA" },
  { id: "pg", name: "Purple Giraffe", role: "Consultant", state: "SA" },
];
const wagePeople = [
  { person_id: "p1", include: true, clickup_user_names: ["Holly Nguyen"] },
  { person_id: "p2", include: true, clickup_user_names: ["Lucy W"], start_date: "2026-10-13" },
  { person_id: "p3", include: true, clickup_user_names: ["Chloe"] },
  { person_id: "p4", include: true, clickup_user_names: ["Alice"] },
  { person_id: "p7", include: true, clickup_user_names: ["Leaver"], end_date: "2026-09-30" },
  { person_id: "pg", include: false, clickup_user_names: ["DMA Login"] },
];
const ft = (person_id) => ({ person_id, effective_from: "2025-06-01", basis: "ft", daily_hours: 7.6 });
const rules = [ft("p1"), ft("p2"), ft("p7"), { person_id: "p3", effective_from: "2025-06-01", basis: "casual_xero" }];
const row = (o) => ({ folder: "Acme", space_id: CLIENTS, billable: true, taskless: false, minutes: 60, entries: 1, ...o });
const clickupSummary = [
  row({ user_name: "Holly Nguyen", minutes: 120 * 60 }), // 120 h client billable
  row({ user_name: "Holly Nguyen", folder: "Purple Giraffe", minutes: 20 * 60 }), // 20 h PG billable
  row({ user_name: "Holly Nguyen", folder: "Admin", space_id: PG_HQ, billable: false, minutes: 27.2 * 60 }), // PG non-billable
  row({ user_name: "Lucy W", minutes: 80 * 60 }),
  row({ user_name: "Chloe", minutes: 50 * 60 }),
  row({ user_name: "Mystery Person", minutes: 90 }),
  row({ user_name: "DMA Login", minutes: 600 }),
  row({ user_name: "Leaver", minutes: 120 }),
  row({ user_name: "Purple Giraffe", minutes: 999 }), // ignored shared login
];
const lines = [
  { month_key: MONTH, person_id: "p1", xero_hours: 167.2, xero_source: "paste", kw_comment: "fine" },
  { month_key: MONTH, person_id: "p3", xero_hours: 50 },
];
const leaveEntries = [
  { person_id: "p1", month_key: MONTH, leave_type: "annual", hours: 15.2, days: 2 },
  { person_id: "p1", month_key: MONTH, leave_type: "personal", hours: 7.6, days: 1 },
];
const capLeaves = { [`p4_${MONTH}`]: 7.6, [`p1_${MONTH}`]: 99 }; // p1's legacy total is ignored: typed entries win
const settings = { hours_per_day: "7.60", xero_tolerance_h: 0.25, variance_threshold_h: 3.8, pg_folders: ["Purple Giraffe"], ignored_clickup_users: ["Purple Giraffe"], xero_name_map: {} };

const sources = (o = {}) => ({ roster, wagePeople, rules, settings, monthRow: null, lines, leaveEntries, capLeaves, clickupSummary, ...o });
const byId = (view, id) => view.lines.find((l) => l.person_id === id);

describe("buildMonthView (draft month)", () => {
  const view = buildMonthView(sources(), MONTH);

  it("lists included roster people inside their employment window, sorted by name", () => {
    expect(view.lines.map((l) => l.name)).toEqual(["Alice", "Chloe", "Holly", "Lucy"]);
    expect(view.closed).toBe(false);
    expect(view.standardHours).toBe(167.2);
    expect(view.weekdays).toBe(22);
  });

  it("computes the workbook columns for a full-time person with typed leave and a public holiday", () => {
    const h = byId(view, "p1");
    expect(h).toMatchObject({ D: 140, E: 20, F: 120, G: 27.2, H: 167.2, L: 167.2, M: 0, N: 15.2, O: 7.6, P: 0, Q: 7.6, S: 167.2 });
    expect(h.R).toBe(197.6);
    expect(h.T).toBe(30.4);
    expect(h.status).toBe("over");
    expect(h.typeShort).toBe("FT");
    expect(h.leave.days.annual).toBe(2);
    expect(h.leave.legacy).toBe(false);
    expect(h.expected.holidays).toEqual([{ date: "2026-10-05", name: "Labour Day" }]);
    expect(h.split).toMatchObject({ clientBillable: 120, pgBillable: 20, clientNonBillable: 0, pgNonBillable: 27.2 });
    expect(h.byFolder[0]).toMatchObject({ folder: "Acme", pg: false, billableH: 120, nonBillableH: 0 });
    expect(h.kw_comment).toBe("fine");
    expect(h.xero_source).toBe("paste");
  });

  it("keeps a missing Xero entry null, never 0", () => {
    const lucy = byId(view, "p2");
    expect(lucy.L).toBeNull();
    expect(lucy.T).toBeNull();
    expect(lucy.status).toBe("awaiting_xero");
    expect(lucy.hasLineRow).toBe(false);
  });

  it("prorates a mid-month starter and flags the lifecycle", () => {
    const lucy = byId(view, "p2");
    expect(lucy.expected.employedWeekdays).toBe(14); // Tue 13 - Fri 30 Oct
    expect(lucy.S).toBe(106.4);
    expect(lucy.lifecycle.started).toBe("2026-10-13");
    expect(lucy.Q).toBe(0); // QLD King's Birthday (5 Oct) is before her start
  });

  it("casual expected-equals-Xero is not assessed", () => {
    const chloe = byId(view, "p3");
    expect(chloe.S).toBe(50);
    expect(chloe.T).toBe(0);
    expect(chloe.status).toBe("not_assessed");
    expect(chloe.typeShort).toBe("Casual");
  });

  it("uses a legacy cap_leaves total as untyped leave when no typed entries exist", () => {
    const alice = byId(view, "p4");
    expect(alice.unspecified).toBe(7.6);
    expect(alice.leave.legacy).toBe(true);
    expect(view.warnings.untypedLeave).toEqual([{ person_id: "p4", name: "Alice", hours: 7.6, legacy: true }]);
  });

  it("reports warnings: unmapped users, needs setup, no rule, outside window", () => {
    expect(view.warnings.unmapped).toEqual([{ user_name: "Mystery Person", hours: 1.5 }]);
    expect(view.warnings.needsSetup).toEqual([{ person_id: "p5", name: "Newbie" }]); // "Gone" resigned before the month
    expect(view.warnings.noRule).toEqual([{ person_id: "p4", name: "Alice" }]);
    expect(view.warnings.outsideWindow).toEqual([{ person_id: "p7", name: "Leaver", hours: 2 }]);
    expect(view.warnings.conflicts).toEqual([]);
    expect(view.warnings.unknownSpaceHours).toBe(0);
    expect(view.warnings.holidaysNotLoaded).toBe(false);
  });

  it("a person with no hours rule has S null (not 0) and no variance", () => {
    const alice = byId(view, "p4");
    expect(alice.S).toBeNull();
    expect(alice.T).toBeNull();
    expect(hasExpected(alice)).toBe(false);
    expect(hasExpected(byId(view, "p1"))).toBe(true);
  });

  it("warns when the month is past the public holiday table's coverage", () => {
    const v = buildMonthView(sources({ lines: [], leaveEntries: [], clickupSummary: [] }), "2028-01");
    expect(v.warnings.holidaysNotLoaded).toBe(true);
    expect(buildMonthView(sources(), "2027-12").warnings.holidaysNotLoaded).toBe(false);
  });

  it("flags ClickUp names claimed by two people as conflicts", () => {
    const wp = wagePeople.map((w) => (w.person_id === "p4" ? { ...w, clickup_user_names: ["Alice", "Chloe"] } : w));
    const v = buildMonthView(sources({ wagePeople: wp }), MONTH);
    expect(v.warnings.conflicts).toEqual([{ user_name: "Chloe", hours: 50, people: [{ person_id: "p3", name: "Chloe" }, { person_id: "p4", name: "Alice" }] }]);
    expect(byId(v, "p3").H).toBe(0);
  });

  it("team totals sum only known values", () => {
    const t = view.totals;
    expect(t.people).toBe(4);
    expect(t.xeroEntered).toBe(2);
    expect(t.awaiting).toBe(2);
    expect(t.L).toBe(217.2);
    expect(t.H).toBe(297.2);
    expect(t.netT).toBe(30.4); // only Holly is assessable
    expect(t.J).toBeCloseTo((120 + 80 + 50) / 297.2, 3);
  });

  it("expected override makes the row assessable and wins over the rule", () => {
    const ls = [...lines, { month_key: MONTH, person_id: "p4", xero_hours: 100, expected_override_h: 98, expected_override_reason: "agreed" }];
    const alice = byId(buildMonthView(sources({ lines: ls }), MONTH), "p4");
    expect(alice.S).toBe(98);
    expect(alice.R).toBe(107.6);
    expect(alice.status).toBe("check_sync"); // ClickUp 0 vs Xero 100
  });
});

describe("buildMonthView (closed month)", () => {
  const draft = buildMonthView(sources(), MONTH);
  const snapshot = JSON.parse(JSON.stringify(buildSnapshot(draft, "2026-11-03T00:00:00.000Z")));
  const monthRow = { month_key: MONTH, status: "closed", snapshot };

  it("renders from the snapshot, not a recompute, with live comments merged in", () => {
    const changedLines = [{ ...lines[0], xero_hours: 1, kw_comment: "updated after close" }, lines[1]];
    const v = buildMonthView(sources({ monthRow, lines: changedLines, clickupSummary: [] }), MONTH);
    expect(v.closed).toBe(true);
    expect(v.fromSnapshot).toBe(true);
    expect(v.computedAt).toBe("2026-11-03T00:00:00.000Z");
    const h = byId(v, "p1");
    expect(h.L).toBe(167.2);
    expect(h.kw_comment).toBe("updated after close");
    expect(v.totals.H).toBe(297.2);
  });

  it("reports people whose live ClickUp total moved by more than 0.1 h", () => {
    const v = buildMonthView(sources({ monthRow, clickupSummary: clickupSummary.filter((r) => r.user_name !== "Lucy W") }), MONTH);
    expect(v.liveDiffers).toEqual([{ person_id: "p2", name: "Lucy", missing: false, fields: [{ key: "H", label: "ClickUp", snapshot: 80, live: 0 }] }]);
  });

  it("also reports leave (N/O/P/untyped) and public holiday (Q) changes, naming each field", () => {
    const moreLeave = [...leaveEntries, { person_id: "p1", month_key: MONTH, leave_type: "lwop", hours: 7.6, days: 1 }];
    const v = buildMonthView(sources({ monthRow, leaveEntries: moreLeave, capLeaves: {} }), MONTH);
    expect(v.liveDiffers).toEqual([
      { person_id: "p4", name: "Alice", missing: false, fields: [{ key: "unspecified", label: "Untyped leave", snapshot: 7.6, live: 0 }] },
      { person_id: "p1", name: "Holly", missing: false, fields: [{ key: "P", label: "LWOP", snapshot: 0, live: 7.6 }] },
    ]);
    const qMoved = buildMonthView(sources({ monthRow, lines: [{ ...lines[0], ph_override_h: 0 }, lines[1]] }), MONTH);
    expect(qMoved.liveDiffers).toEqual([{ person_id: "p1", name: "Holly", missing: false, fields: [{ key: "Q", label: "Public holiday", snapshot: 7.6, live: 0 }] }]);
  });

  it("the snapshot drops the photo and other display-only bulk; the live roster photo is merged back", () => {
    expect(snapshot.lines.find((l) => l.person_id === "p1")).not.toHaveProperty("photo");
    expect(snapshot.lines[0]).not.toHaveProperty("stateHolidays");
    expect(snapshot.lines[0]).toHaveProperty("byFolder");
    const v = buildMonthView(sources({ monthRow }), MONTH);
    expect(byId(v, "p1").photo).toBe("data:image/jpeg;base64,AAAA");
    expect(byId(buildMonthView({ monthRow, lines }, MONTH), "p1").photo).toBe("");
  });

  it("works with only the month row and lines (live sources failed)", () => {
    const v = buildMonthView({ monthRow, lines }, MONTH);
    expect(v.lines).toHaveLength(4);
    expect(v.liveDiffers).toEqual([]);
  });

  it("falls back to a live recompute when a closed month has no snapshot", () => {
    const v = buildMonthView(sources({ monthRow: { month_key: MONTH, status: "closed", snapshot: null } }), MONTH);
    expect(v.closed).toBe(true);
    expect(v.fromSnapshot).toBe(false);
    expect(v.snapshotMissing).toBe(true);
  });
});

describe("helpers", () => {
  const view = buildMonthView(sources(), MONTH);

  it("groups lines by status, attention sorted by |T| then |M|", () => {
    const groups = groupLines(view.lines);
    expect(groups.map((g) => g.key)).toEqual(["attention", "awaiting", "not_assessed"]);
    const a = groupLines([
      { name: "a", status: "under", T: -5, M: 0 },
      { name: "b", status: "over", T: 12, M: 0 },
      { name: "c", status: "check_sync", T: null, M: 3 },
    ])[0].lines.map((l) => l.name);
    expect(a).toEqual(["b", "a", "c"]);
  });

  it("filters by search, state, type and status", () => {
    expect(filterLines(view.lines, { q: "hol" }).map((l) => l.name)).toEqual(["Holly"]);
    expect(filterLines(view.lines, { state: "QLD" }).map((l) => l.name)).toEqual(["Lucy"]);
    expect(filterLines(view.lines, { type: "Casual" }).map((l) => l.name)).toEqual(["Chloe"]);
    expect(filterLines(view.lines, { status: "attention" }).map((l) => l.name)).toEqual(["Holly"]);
    expect(filterLines(view.lines, { status: "awaiting_xero" }).map((l) => l.name)).toEqual(["Alice", "Lucy"]);
  });

  it("normaliseSettings coerces numeric strings and fills defaults", () => {
    expect(normaliseSettings({ hours_per_day: "7.25" }).hours_per_day).toBe(7.25);
    expect(normaliseSettings(null).xero_tolerance_h).toBe(0.25);
  });

  it("adjustedExpected is S less leave and public holidays, null when S is null; T is L minus it", () => {
    const line = { S: 167.2, N: 15.2, O: 7.6, P: 0, unspecified: 1, Q: 7.6, L: 140, T: 4.2 };
    expect(adjustedExpected(line)).toBe(135.8);
    expect(round(line.L - adjustedExpected(line))).toBe(line.T);
    expect(variancePctOfAdjusted(line)).toBe(0.0309);
    expect(adjustedExpected({ S: null, N: 7.6, Q: 7.6 })).toBeNull();
    expect(variancePctOfAdjusted({ S: null, T: null })).toBeNull();
    expect(variancePctOfAdjusted({ S: 160, N: 0, Q: 0, T: null })).toBeNull();
  });

  it("typeShort shortens workbook labels", () => {
    expect(typeShort("F/T → P/T")).toBe("FT → PT");
    expect(typeShort("")).toBe("");
  });

  it("computeTotals leaves netT and L null when nothing is known", () => {
    const t = computeTotals([{ H: 0, D: 0, F: 0, L: null, T: null, varianceApplicable: false, status: "awaiting_xero", flags: {} }]);
    expect(t.L).toBeNull();
    expect(t.netT).toBeNull();
    expect(t.J).toBeNull();
  });
});

describe("toWorkbookRows", () => {
  const ft = { effective_from: "2020-01-01", basis: "ft", daily_hours: 7.6 };
  const LINE_SETTINGS = { xero_tolerance_h: 0.25, variance_threshold_h: 3.8 };
  const line = (rules, xeroHours, monthKey = "2026-10") => {
    const e = expectedFor({ monthKey, person: { state: "SA" }, rules });
    return { person_id: "p1", ...computeLine({ clickup: null, leave: null, xeroHours, expected: e, settings: LINE_SETTINGS }) };
  };
  const people = [{ person_id: "p1", display_name: "Jane Smith", state: "SA" }];

  it("emits the workbook headings A–Y in order, blanks for nulls", () => {
    const [row] = toWorkbookRows([{ ...line([ft], null), kw_comment: "chasing Xero" }], people);
    expect(Object.keys(row)).toEqual(WORKBOOK_HEADINGS);
    expect(WORKBOOK_HEADINGS).toHaveLength(25);
    expect(WORKBOOK_HEADINGS.slice(20)).toEqual(["PG", "KW", "LS", "Phil", "KW comment round 2"]);
    expect(row.Employee).toBe("Jane Smith");
    expect(row.State).toBe("SA");
    expect(row.Type).toBe("F/T");
    expect(row["% billed total"]).toBe("");
    expect(row.Xero).toBe("");
    expect(row["Public Holiday"]).toBe(7.6);
    expect(row["Should be"]).toBe(167.2);
    expect(row.Variance).toBe("");
    expect(row.KW).toBe("chasing Xero");
    expect(row.LS).toBe("");
  });

  it("REVIEW_FIELDS drives the comment columns and COMMENT_FIELDS", () => {
    expect(COMMENT_FIELDS).toEqual(REVIEW_FIELDS.map((f) => f.key));
    const [row] = toWorkbookRows([{ ...line([ft], 0), kw2_comment: "ok now" }], people);
    expect(row["KW comment round 2"]).toBe("ok now");
  });

  it("blanks S and T for a person with no hours rule", () => {
    const [row] = toWorkbookRows([line([], 100)], people);
    expect(row["Should be"]).toBe("");
    expect(row.Variance).toBe("");
    expect(row.Total).toBe(107.6 - 7.6); // R is still known (no PH without a rule)
  });

  it("blanks T for a mixed FT → casual_xero month even when R and S exist", () => {
    const [row] = toWorkbookRows([line([ft, { effective_from: "2026-07-16", basis: "casual_xero" }], 100, "2026-07")], people);
    expect(row["Should be"]).toBe(83.6);
    expect(row.Variance).toBe("");
  });

  it("keeps T = 0 for an all casual_xero month once Xero is in", () => {
    const [row] = toWorkbookRows([line([{ effective_from: "2020-01-01", basis: "casual_xero" }], 100)], people);
    expect(row["Should be"]).toBe(100);
    expect(row.Variance).toBe(0);
  });
});
