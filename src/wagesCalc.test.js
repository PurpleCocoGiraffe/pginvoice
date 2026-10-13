import { describe, it, expect } from "vitest";
import {
  monthDays, wageWeekdaysInMonth, standardMonthHours, classifyClickup, attributeToPeople,
  expectedFor, computeLine, parseXeroPaste, resolveXeroBatch, parseXeroTime, matchXeroNames, normName,
  typeLabelFor, parseHoursInput,
} from "./wagesCalc.js";

const PG_CLIENTS = "54751434";
const CLIENTS = "90167546842";
const PG_HQ = "90160000001";
const SETTINGS = { pg_folders: ["Purple Giraffe"], ignored_clickup_users: ["Purple Giraffe"] };
const LINE_SETTINGS = { xero_tolerance_h: 0.25, variance_threshold_h: 3.8 };

const ft = (effective_from = "2020-01-01", daily_hours = 7.6) => ({ effective_from, basis: "ft", daily_hours });
const pattern = (basis, effective_from, h) => ({
  effective_from, basis, daily_hours: 7.6,
  mon_h: h.mon ?? 0, tue_h: h.tue ?? 0, wed_h: h.wed ?? 0, thu_h: h.thu ?? 0, fri_h: h.fri ?? 0, sat_h: h.sat ?? 0, sun_h: h.sun ?? 0,
});
const MWF = { mon: 7.6, wed: 7.6, fri: 7.6 };

describe("calendar helpers", () => {
  it("monthDays lists every date with its UTC day of week", () => {
    const days = monthDays("2026-07");
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({ date: "2026-07-01", dow: 3 }); // Wednesday
    expect(days[30]).toEqual({ date: "2026-07-31", dow: 5 });
    expect(monthDays("2028-02")).toHaveLength(29);
  });

  it("Jul 2026 has 23 weekdays and a 174.8 hour standard month", () => {
    expect(wageWeekdaysInMonth("2026-07")).toBe(23);
    expect(standardMonthHours("2026-07")).toBe(174.8);
  });

  it("rounds standard hours to 2dp", () => {
    expect(standardMonthHours("2026-10")).toBe(167.2); // 22 × 7.6 without float noise
    expect(standardMonthHours("2026-10", 7.25)).toBe(159.5);
  });
});

describe("classifyClickup", () => {
  const row = (o) => ({ user_name: "Jane Smith", folder: "Acme", space_id: CLIENTS, billable: true, taskless: false, minutes: 60, entries: 1, ...o });

  it("Purple Giraffe folder inside the PG CLIENTS space is PG", () => {
    const { perUser } = classifyClickup([row({ folder: "Purple Giraffe", space_id: PG_CLIENTS })], SETTINGS);
    expect(perUser["Jane Smith"].pgBillable).toBe(60);
    expect(perUser["Jane Smith"].clientBillable).toBe(0);
  });

  it("matches pg_folders case/whitespace-insensitively", () => {
    const { perUser } = classifyClickup([row({ folder: "  purple   GIRAFFE ", space_id: PG_CLIENTS, billable: false })], SETTINGS);
    expect(perUser["Jane Smith"].pgNonBillable).toBe(60);
  });

  it("a client folder in the Clients space is client time", () => {
    const { perUser } = classifyClickup([row({}), row({ billable: false, minutes: 30 })], SETTINGS);
    const b = perUser["Jane Smith"];
    expect(b.clientBillable).toBe(60);
    expect(b.clientNonBillable).toBe(30);
    expect(b.total).toBe(90);
    expect(b.byFolder).toEqual([
      { folder: "Acme", pg: false, billable: true, minutes: 60 },
      { folder: "Acme", pg: false, billable: false, minutes: 30 },
    ]);
  });

  it("an internal-keyword folder in the Clients space is PG", () => {
    const { perUser } = classifyClickup([row({ folder: "Villani Offboarding" })], SETTINGS);
    expect(perUser["Jane Smith"].pgBillable).toBe(60);
    expect(perUser["Jane Smith"].clientBillable).toBe(0);
  });

  it("any other space is PG", () => {
    const { perUser } = classifyClickup([row({ folder: "CRM", space_id: PG_HQ })], SETTINGS);
    expect(perUser["Jane Smith"].pgBillable).toBe(60);
  });

  it("task-less entries are PG and counted in taskless", () => {
    const { perUser, unknownSpaceMinutes } = classifyClickup([row({ folder: "Private", space_id: null, taskless: true, billable: false, minutes: 45 })], SETTINGS);
    const b = perUser["Jane Smith"];
    expect(b.pgNonBillable).toBe(45);
    expect(b.taskless).toBe(45);
    expect(b.unknownSpace).toBe(0);
    expect(unknownSpaceMinutes).toBe(0);
  });

  it("a task-less entry inside a client space is still PG", () => {
    const { perUser } = classifyClickup([row({ taskless: true })], SETTINGS);
    expect(perUser["Jane Smith"].pgBillable).toBe(60);
  });

  it("unknown-space rows with a task use nameMatch's folder rule and are surfaced", () => {
    const { perUser, unknownSpaceMinutes } = classifyClickup([
      row({ space_id: null, minutes: 20 }),
      row({ space_id: "", folder: "Purple Giraffe", minutes: 10 }),
      // BDM-space folders (isNonClientSpace's name fallback) are PG, not assumed client.
      row({ space_id: null, folder: "CRM", minutes: 5 }),
      row({ space_id: null, folder: "Events and Networking", minutes: 7 }),
    ], SETTINGS);
    const b = perUser["Jane Smith"];
    expect(b.clientBillable).toBe(20);
    expect(b.pgBillable).toBe(22);
    expect(b.unknownSpace).toBe(42);
    expect(unknownSpaceMinutes).toBe(42);
  });

  it("drops ignored users (case-insensitive) into the ignored bucket", () => {
    const { perUser, ignored } = classifyClickup([row({ user_name: "purple giraffe" }), row({})], SETTINGS);
    expect(Object.keys(perUser)).toEqual(["Jane Smith"]);
    expect(ignored["purple giraffe"].total).toBe(60);
  });

  it("trims user names and coerces string minutes", () => {
    const { perUser } = classifyClickup([row({ user_name: " Jane Smith ", minutes: "15.5" })], SETTINGS);
    expect(perUser["Jane Smith"].total).toBe(15.5);
  });
});

describe("attributeToPeople", () => {
  const { perUser } = classifyClickup([
    { user_name: "Jane Smith", folder: "Acme", space_id: CLIENTS, billable: true, taskless: false, minutes: 120 },
    { user_name: "jane s", folder: "Acme", space_id: CLIENTS, billable: true, taskless: false, minutes: 30 },
    { user_name: "Bob", folder: "Purple Giraffe", space_id: PG_CLIENTS, billable: false, taskless: false, minutes: 60 },
    { user_name: "Mystery", folder: "Acme", space_id: CLIENTS, billable: true, taskless: false, minutes: 90 },
    { user_name: "Shared", folder: "Acme", space_id: CLIENTS, billable: true, taskless: false, minutes: 10 },
  ], SETTINGS);

  it("sums every mapped ClickUp name into the person, case-insensitively", () => {
    const people = [{ person_id: "p1", clickup_user_names: ["JANE SMITH", " Jane S "] }, { person_id: "p2", clickup_user_names: ["Bob"] }];
    const { byPerson, unmapped } = attributeToPeople(perUser, people);
    expect(byPerson.p1.clientBillable).toBe(150);
    expect(byPerson.p1.byFolder).toEqual([{ folder: "Acme", pg: false, billable: true, minutes: 150 }]);
    expect(byPerson.p2.pgNonBillable).toBe(60);
    expect(unmapped).toEqual([{ user_name: "Mystery", minutes: 90 }, { user_name: "Shared", minutes: 10 }]);
  });

  it("does no fuzzy matching", () => {
    const { byPerson, unmapped } = attributeToPeople(perUser, [{ person_id: "p1", clickup_user_names: ["Jane"] }]);
    expect(byPerson.p1).toBeUndefined();
    expect(unmapped.map((u) => u.user_name)).toContain("Jane Smith");
  });

  it("puts a name claimed by two people into conflicts and attributes it to neither", () => {
    const people = [{ person_id: "p1", clickup_user_names: ["Shared"] }, { person_id: "p2", clickup_user_names: ["shared"] }];
    const { byPerson, conflicts, unmapped } = attributeToPeople(perUser, people);
    expect(conflicts).toEqual([{ user_name: "Shared", person_ids: ["p1", "p2"], minutes: 10 }]);
    expect(byPerson.p1).toBeUndefined();
    expect(byPerson.p2).toBeUndefined();
    expect(unmapped.map((u) => u.user_name)).not.toContain("Shared");
  });
});

describe("expectedFor", () => {
  it("FT SA Oct 2026: 22 × 7.6 = 167.2 with Labour Day as 7.6 public holiday hours", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [ft()] });
    expect(e.S).toBe(167.2);
    expect(e.Q).toBe(7.6);
    expect(e.holidays).toEqual([{ date: "2026-10-05", name: "Labour Day" }]);
    expect(e.varianceApplicable).toBe(true);
    expect(e.missingRule).toBe(false);
    expect(e.employedWeekdays).toBe(22);
    expect(e.segments).toEqual([expect.objectContaining({ from: "2026-10-01", to: "2026-10-31", basis: "ft", S: 167.2, Q: 7.6, working: "22 weekdays × 7.6 = 167.2" })]);
  });

  it("FT WA Sep 2026 gets King's Birthday (2026-09-28)", () => {
    const e = expectedFor({ monthKey: "2026-09", person: { state: "WA" }, rules: [ft()] });
    expect(e.Q).toBe(7.6);
    expect(e.holidays).toEqual([{ date: "2026-09-28", name: "King's Birthday" }]);
  });

  it("FT starting 13 Jul 2026: 15 weekdays × 7.6 = 114.0", () => {
    const e = expectedFor({ monthKey: "2026-07", person: { state: "SA", start_date: "2026-07-13" }, rules: [ft("2026-07-13")] });
    expect(e.S).toBe(114);
    expect(e.employedWeekdays).toBe(15);
    expect(e.segments[0].working).toBe("15 weekdays × 7.6 = 114.0");
  });

  it("FT leaving mid-month only counts weekdays up to end_date", () => {
    const e = expectedFor({ monthKey: "2026-07", person: { state: "SA", end_date: "2026-07-10" }, rules: [ft()] });
    expect(e.S).toBe(round(8 * 7.6)); // 1-3, 6-10 July
  });

  it("excludes a public holiday before start_date", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA", start_date: "2026-10-06" }, rules: [ft("2026-10-06")] });
    expect(e.Q).toBe(0);
    expect(e.holidays).toEqual([]);
    expect(e.S).toBe(round(19 * 7.6)); // 1, 2 and 5 Oct fall before the start
  });

  it("PT Mon/Wed/Fri with a Monday public holiday counts it in Q", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [pattern("pt_pattern", "2026-01-01", MWF)] });
    expect(e.S).toBe(98.8); // 4 Mon + 4 Wed + 5 Fri = 13 × 7.6
    expect(e.Q).toBe(7.6);
    expect(e.segments[0].working).toBe("4 Mon × 7.6 + 4 Wed × 7.6 + 5 Fri × 7.6 = 98.8");
  });

  it("PT with the public holiday on a non-working day gets Q 0", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [pattern("pt_pattern", "2026-01-01", { tue: 7.6, thu: 7.6 })] });
    expect(e.S).toBe(68.4);
    expect(e.Q).toBe(0);
    expect(e.holidays).toEqual([]);
  });

  it("splits a mid-month FT → PT change into two segments (rules in any order)", () => {
    const e = expectedFor({
      monthKey: "2026-07", person: { state: "SA" },
      rules: [pattern("pt_pattern", "2026-07-16", MWF), ft("2025-01-01")],
    });
    expect(e.segments.map((s) => [s.from, s.to, s.basis, s.S])).toEqual([
      ["2026-07-01", "2026-07-15", "ft", 83.6], // 11 weekdays
      ["2026-07-16", "2026-07-31", "pt_pattern", 53.2], // 2 Mon + 2 Wed + 3 Fri
    ]);
    expect(e.S).toBe(136.8);
    expect(typeLabelFor(e.segments)).toBe("F/T → P/T");
  });

  it("casual_xero: S null, not variance-assessed, no public holidays", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [{ effective_from: "2026-01-01", basis: "casual_xero" }] });
    expect(e.S).toBeNull();
    expect(e.Q).toBe(0);
    expect(e.varianceApplicable).toBe(false);
    expect(e.allCasualXero).toBe(true);
  });

  it("mixed casual_xero + FT: S sums the non-xero segments, variance not applicable", () => {
    const e = expectedFor({
      monthKey: "2026-07", person: { state: "SA" },
      rules: [ft("2025-01-01"), { effective_from: "2026-07-16", basis: "casual_xero" }],
    });
    expect(e.S).toBe(83.6);
    expect(e.varianceApplicable).toBe(false);
    expect(e.allCasualXero).toBe(false);
  });

  it("casual_pattern excludes public holidays from S and never pays Q", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [pattern("casual_pattern", "2026-01-01", { mon: 7.6 })] });
    expect(e.S).toBe(22.8); // 4 Mondays less Labour Day
    expect(e.Q).toBe(0);
    expect(e.varianceApplicable).toBe(true);
  });

  it("casual_target is prorated for a mid-month starter", () => {
    const e = expectedFor({
      monthKey: "2026-07", person: { state: "SA", start_date: "2026-07-13" },
      rules: [{ effective_from: "2026-07-13", basis: "casual_target", monthly_target_h: 120 }],
    });
    expect(e.S).toBe(78.26); // 120 × 15/23
    expect(e.Q).toBe(0);
    expect(e.segments[0].working).toBe("120.0 × 15/23 weekdays = 78.26");
  });

  it("flags days with no rule and leaves them out", () => {
    const e = expectedFor({ monthKey: "2026-07", person: { state: "SA" }, rules: [ft("2026-07-16")] });
    expect(e.missingRule).toBe(true);
    expect(e.varianceApplicable).toBe(false);
    expect(e.S).toBe(round(12 * 7.6));
    expect(expectedFor({ monthKey: "2026-07", person: { state: "SA" }, rules: [] }).missingRule).toBe(true);
  });

  it("S is null (not 0) when no rule covers any employed day", () => {
    const none = expectedFor({ monthKey: "2026-07", person: { state: "SA" }, rules: [] });
    expect(none.S).toBeNull();
    expect(none.segments).toEqual([]);
    expect(none.allCasualXero).toBe(false);
    const later = expectedFor({ monthKey: "2026-07", person: { state: "SA" }, rules: [ft("2026-08-01")] });
    expect(later.S).toBeNull();
    expect(later.missingRule).toBe(true);
  });

  it("an unknown state gets no public holidays and is flagged", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "NSW" }, rules: [ft()] });
    expect(e.Q).toBe(0);
    expect(e.unknownState).toBe(true);
  });
});

function round(n) { return Math.round(n * 100) / 100; }

describe("computeLine", () => {
  const ftOct = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [ft()] });
  const clickup = { pgBillable: 600, pgNonBillable: 300, clientBillable: 6000, clientNonBillable: 900, taskless: 0, unknownSpace: 0, total: 7800, byFolder: [] };

  it("builds the workbook columns in hours", () => {
    const l = computeLine({ clickup, leave: { annual: 7.6, personal: 0, lwop: 0, unspecified: 0 }, xeroHours: 130, expected: ftOct, settings: LINE_SETTINGS });
    expect(l.D).toBe(110);
    expect(l.E).toBe(10);
    expect(l.F).toBe(100);
    expect(l.G).toBe(20);
    expect(l.H).toBe(130);
    expect(l.J).toBe(0.7692);
    expect(l.K).toBe(0.8462);
    expect(l.M).toBe(0);
    expect(l.Q).toBe(7.6);
    expect(l.R).toBe(145.2);
    expect(l.S).toBe(167.2);
    expect(l.T).toBe(-22);
    expect(l.status).toBe("under");
    expect(l.type).toBe("F/T");
  });

  it("is null-safe when Xero isn't entered: L, M, R, T null and awaiting_xero", () => {
    const l = computeLine({ clickup, leave: null, xeroHours: null, expected: ftOct, settings: LINE_SETTINGS });
    expect(l.L).toBeNull();
    expect(l.M).toBeNull();
    expect(l.R).toBeNull();
    expect(l.T).toBeNull();
    expect(l.Tpct).toBeNull();
    expect(l.status).toBe("awaiting_xero");
    expect(l.flags.missingXero).toBe(true);
  });

  it("keeps a Xero value of 0 distinct from not entered", () => {
    const l = computeLine({ clickup: null, leave: null, xeroHours: 0, expected: ftOct, settings: LINE_SETTINGS });
    expect(l.L).toBe(0);
    expect(l.M).toBe(0);
    expect(l.flags.missingXero).toBe(false);
  });

  it("with no tracked time: H 0 → J and K null", () => {
    const l = computeLine({ clickup: null, leave: null, xeroHours: 0, expected: ftOct, settings: LINE_SETTINGS });
    expect(l.H).toBe(0);
    expect(l.J).toBeNull();
    expect(l.K).toBeNull();
    expect(l.flags.noClickup).toBe(true);
  });

  it("check_sync outranks over/under when ClickUp and Xero disagree", () => {
    const l = computeLine({ clickup, leave: null, xeroHours: 131, expected: ftOct, settings: LINE_SETTINGS });
    expect(l.M).toBe(1);
    expect(l.flags.xeroMismatch).toBe(true);
    expect(l.status).toBe("check_sync");
  });

  it("flags over when T exceeds the threshold and ok within it", () => {
    const over = computeLine({ clickup: { ...clickup, clientBillable: 6000 + 60 * 35 }, leave: null, xeroHours: 165, expected: ftOct, settings: LINE_SETTINGS });
    expect(over.T).toBe(5.4);
    expect(over.status).toBe("over");
    const ok = computeLine({ clickup: { ...clickup, clientBillable: 6000 + 60 * 30 }, leave: null, xeroHours: 160, expected: ftOct, settings: LINE_SETTINGS });
    expect(ok.T).toBe(0.4);
    expect(ok.status).toBe("ok");
  });

  it("casual_xero: S = R so T is 0 once Xero is in, null before; not assessed", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [{ effective_from: "2026-01-01", basis: "casual_xero" }] });
    const l = computeLine({ clickup, leave: null, xeroHours: 130, expected: e, settings: LINE_SETTINGS });
    expect(l.S).toBe(130);
    expect(l.T).toBe(0);
    expect(l.status).toBe("not_assessed");
    expect(l.type).toBe("Casual");
    const pending = computeLine({ clickup, leave: null, xeroHours: null, expected: e, settings: LINE_SETTINGS });
    expect(pending.S).toBeNull();
    expect(pending.T).toBeNull();
    expect(pending.status).toBe("awaiting_xero");
  });

  it("missing rule → not_assessed with S and T null (never 0 / a fake variance)", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [] });
    const l = computeLine({ clickup, leave: null, xeroHours: 130, expected: e, settings: LINE_SETTINGS });
    expect(l.flags.missingRule).toBe(true);
    expect(l.status).toBe("not_assessed");
    expect(l.S).toBeNull();
    expect(l.T).toBeNull();
    expect(l.Tpct).toBeNull();
  });

  it("a partial rule (some days uncovered) keeps S but blanks T", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [ft("2026-10-16")] });
    const l = computeLine({ clickup, leave: null, xeroHours: 130, expected: e, settings: LINE_SETTINGS });
    expect(l.S).toBe(e.S);
    expect(l.R).toBe(130);
    expect(l.T).toBeNull();
    expect(l.status).toBe("not_assessed");
  });

  it("mixed FT → casual_xero month: T blank even once Xero is in", () => {
    const e = expectedFor({ monthKey: "2026-07", person: { state: "SA" }, rules: [ft("2025-01-01"), { effective_from: "2026-07-16", basis: "casual_xero" }] });
    const l = computeLine({ clickup, leave: null, xeroHours: 130, expected: e, settings: LINE_SETTINGS });
    expect(l.S).toBe(83.6);
    expect(l.T).toBeNull();
    expect(l.Tpct).toBeNull();
    expect(l.allCasualXero).toBe(false);
    expect(l.status).toBe("not_assessed");
  });

  it("applies overrides for Q and S, and an S override makes the variance assessable", () => {
    const e = expectedFor({ monthKey: "2026-10", person: { state: "SA" }, rules: [{ effective_from: "2026-01-01", basis: "casual_xero" }] });
    const l = computeLine({ clickup, leave: null, xeroHours: 130, expected: e, overrides: { ph_override_h: 0, expected_override_h: 100 }, settings: LINE_SETTINGS });
    expect(l.Q).toBe(0);
    expect(l.S).toBe(100);
    expect(l.T).toBe(30);
    expect(l.Tpct).toBe(0.3);
    expect(l.flags.overridden).toBe(true);
    expect(l.status).toBe("over");
    const keepQ = computeLine({ clickup, leave: null, xeroHours: 130, expected: ftOct, overrides: { ph_override_h: null }, settings: LINE_SETTINGS });
    expect(keepQ.Q).toBe(7.6);
  });

  it("counts unspecified leave into R and flags it", () => {
    const l = computeLine({ clickup, leave: { annual: 0, personal: 7.6, lwop: 0, unspecified: 7.6 }, xeroHours: 130, expected: ftOct, settings: LINE_SETTINGS });
    expect(l.O).toBe(7.6);
    expect(l.unspecified).toBe(7.6);
    expect(l.R).toBe(152.8);
    expect(l.flags.unspecifiedLeave).toBe(true);
  });
});

describe("parseXeroPaste: Xero report table", () => {
  const H = "Employee\tEmployee group\tEarnings Rate\tCalendar\tTimesheet Category\tUnits";
  const row = (name, rate, units) => `${name}\tNone\t${rate}\tMonthly\t(none)\t${units}`;

  it("takes only the Employee and Units columns", () => {
    const r = parseXeroPaste([H, row("Alexander Banitsiotis", "Ordinary Hours", "141.58"), row("Alice Fulton-Sherriff", "Ordinary Hours", "75.20"), row("Vinavie Gayara Malagammanage", "Ordinary Hours", "136.95")].join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.name, x.hours])).toEqual([["Alexander Banitsiotis", 141.58], ["Alice Fulton-Sherriff", 75.2], ["Vinavie Gayara Malagammanage", 136.95]]);
  });

  it("skips non-ordinary earnings rates with a note and keeps repeated ordinary rows separate", () => {
    const r = parseXeroPaste([H, row("Holly Latham", "Ordinary Hours", "100"), row("Holly Latham", "Public Holiday", "7.6"), row("Holly Latham", "Ordinary Hours", "50.5"), "Total\t\t\t\t\t158.1"].join("\r\n"));
    expect(r.rows.map((x) => [x.name, x.hours])).toEqual([["Holly Latham", 100], ["Holly Latham", 50.5]]);
    expect(r.errors).toEqual([]);
    expect(r.notes.some((n) => /Public Holiday/.test(n))).toBe(true);
  });

  it("reports unreadable units and thousands commas instead of guessing", () => {
    const r = parseXeroPaste([H, row("Jane Doe", "Ordinary Hours", "abc"), row("John Roe", "Ordinary Hours", "1,234.5")].join("\n"));
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(2);
  });
});

describe("resolveXeroBatch", () => {
  it("applies new people, skips identical saved values, and leaves people not in the batch alone", () => {
    const r = resolveXeroBatch([{ target: "a", hours: 150, name: "A" }, { target: "b", hours: 120, name: "B" }], { a: null, b: 120, c: 99 });
    expect(r.apply).toEqual([{ person_id: "a", hours: 150, names: ["A"] }]);
    expect(r.unchanged).toEqual(["b"]);
    expect(r.conflicts).toEqual([]);
  });

  it("asks when a later batch differs from saved hours, and applies only the chosen value", () => {
    const rows = [{ target: "a", hours: 40, name: "A" }];
    const open = resolveXeroBatch(rows, { a: 100 });
    expect(open.apply).toEqual([]);
    expect(open.conflicts[0].options.map((o) => [o.key, o.hours])).toEqual([["row:0", 40], ["saved", 100], ["sum", 140]]);
    expect(resolveXeroBatch(rows, { a: 100 }, { a: "row:0" }).apply).toEqual([{ person_id: "a", hours: 40, names: ["A"] }]);
    expect(resolveXeroBatch(rows, { a: 100 }, { a: "saved" })).toMatchObject({ apply: [], keep: ["a"] });
    expect(resolveXeroBatch(rows, { a: 100 }, { a: "sum" }).apply[0].hours).toBe(140);
  });

  it("asks which row to use when one paste has the same person twice", () => {
    const rows = [{ target: "a", hours: 100, name: "A" }, { target: "a", hours: 50.5, name: "A" }];
    const open = resolveXeroBatch(rows, {});
    expect(open.apply).toEqual([]);
    expect(open.conflicts[0].options.map((o) => o.hours)).toEqual([100, 50.5, 150.5]);
    expect(resolveXeroBatch(rows, {}, { a: "row:1" }).apply[0].hours).toBe(50.5);
    expect(resolveXeroBatch(rows, {}, { a: "bogus" }).conflicts[0].choice).toBe(null);
  });
});

describe("parseXeroPaste", () => {
  const pairs = (text) => parseXeroPaste(text).rows.map((r) => [r.name, r.hours]);

  it("reads one pair per line with tab, comma, 2+ spaces or a single space", () => {
    expect(pairs("Jane Smith\t142.5\nBob Jones, 166.2\nAmy Lee    120\nTom Ng 98.75")).toEqual([
      ["Jane Smith", 142.5], ["Bob Jones", 166.2], ["Amy Lee", 120], ["Tom Ng", 98.75],
    ]);
  });

  it("reads alternating name / time lines", () => {
    expect(pairs("Jane Smith\n142.5\n\nBob Jones\n166.2\n")).toEqual([["Jane Smith", 142.5], ["Bob Jones", 166.2]]);
  });

  it("reads a single comma-separated line", () => {
    expect(pairs("Jane Smith, 142.5, Bob Jones, 166.2")).toEqual([["Jane Smith", 142.5], ["Bob Jones", 166.2]]);
  });

  it("ignores header lines", () => {
    const r = parseXeroPaste("Employee  Hours\nJane Smith\t142.5");
    expect(r.rows.map((x) => x.name)).toEqual(["Jane Smith"]);
    expect(r.errors).toEqual([]);
  });

  it("accepts 142:30, 142h 30m and 142 hrs", () => {
    expect(pairs("Jane\t142:30\nBob\t142h 30m\nAmy\t142 hrs\nTom 7:05")).toEqual([
      ["Jane", 142.5], ["Bob", 142.5], ["Amy", 142], ["Tom", 7.08],
    ]);
    expect(parseXeroTime("142:30")).toBe(142.5);
    expect(parseXeroTime("142h30m")).toBe(142.5);
    expect(parseXeroTime("142:75")).toBeNull();
    expect(parseXeroTime("abc")).toBeNull();
  });

  it("reports a decimal comma instead of splitting it into two numbers", () => {
    const r = parseXeroPaste("Jane Smith, 142,5");
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([{ raw: "Jane Smith, 142,5", message: "Use a dot for decimals: 142,5 → 142.5" }]);
  });

  it("scratch: 'Jane Smith<TAB>152,5' is a decimal-comma error, not 152 h", () => {
    const r = parseXeroPaste("Jane Smith\t152,5\nBob Jones\t160");
    expect(r.rows).toEqual([{ name: "Bob Jones", hours: 160, raw: "Bob Jones 160" }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toBe("Use a dot for decimals: 152,5 → 152.5");
  });

  it("scratch: 'Jane Smith 2<TAB>40' splits on the tab: name 'Jane Smith 2', 40 h", () => {
    const r = parseXeroPaste("Jane Smith 2\t40");
    expect(r.rows).toEqual([{ name: "Jane Smith 2", hours: 40, raw: "Jane Smith 2 40" }]);
    expect(r.errors).toEqual([]);
  });

  it("scratch: 'Smith, Jane<TAB>152.5' keeps the whole name and doesn't first-name match Jane", () => {
    const r = parseXeroPaste("Smith, Jane\t152.5");
    expect(r.rows).toEqual([{ name: "Smith, Jane", hours: 152.5, raw: "Smith, Jane 152.5" }]);
    const [m] = matchXeroNames(r.rows, [{ person_id: "p1", display_name: "Jane Smith", full_name: "Jane Smith", clickup_user_names: [] }], {});
    expect(m.person_id).toBeNull();
    expect(m.method).toBe("unmatched");
  });

  it("'Smith, Jane 152.5' with no tab is reported, not read as Jane", () => {
    const r = parseXeroPaste("Smith, Jane 152.5");
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/put a tab between the name and the hours/);
  });

  it("scratch: 'Jane\\nSmith\\n152.5' gives one row for Smith and an error for Jane", () => {
    const r = parseXeroPaste("Jane\nSmith\n152.5");
    expect(r.rows).toEqual([{ name: "Smith", hours: 152.5, raw: "Smith 152.5" }]);
    expect(r.errors).toEqual([{ raw: "Jane", message: 'No hours found for "Jane"' }]);
  });

  it("alternating layout with a decimal-comma hours line reports one error for the pair", () => {
    const r = parseXeroPaste("Jane Smith\n152,5");
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toBe("Jane Smith: Use a dot for decimals: 152,5 → 152.5");
  });

  it("reports unparseable chunks", () => {
    const r = parseXeroPaste("Jane Smith\nBob Jones\t166.2\n12.5\nR2D2 ??");
    expect(r.rows).toEqual([{ name: "Bob Jones", hours: 166.2, raw: "Bob Jones 166.2" }]);
    expect(r.errors.map((e) => e.raw)).toEqual(["Jane Smith", "12.5", "R2D2 ??"]);
  });

  it("returns empty results for empty input", () => {
    expect(parseXeroPaste("")).toEqual({ rows: [], errors: [], notes: [] });
    expect(parseXeroPaste(null)).toEqual({ rows: [], errors: [], notes: [] });
  });
});

describe("matchXeroNames", () => {
  const people = [
    { person_id: "p1", display_name: "Jane Smith", full_name: "Jane Smith", xero_name: "Smith, Jane", clickup_user_names: ["Jane S"] },
    { person_id: "p2", display_name: "Bob Jones", full_name: "Robert Jones", clickup_user_names: [] },
    { person_id: "p3", display_name: "Amy Lee", clickup_user_names: [] },
    { person_id: "p4", display_name: "Amy Chen", clickup_user_names: [] },
  ];
  const match = (name, map) => matchXeroNames([{ name, hours: 1 }], people, map)[0];

  it("uses the remembered map first", () => {
    expect(match("Bobby", { [normName("  BOBBY ")]: "p2" })).toMatchObject({ person_id: "p2", method: "remembered", needsConfirm: false });
  });

  it("ignores a remembered id for someone no longer in the list", () => {
    expect(match("Ghost", { ghost: "gone" })).toMatchObject({ person_id: null, method: "unmatched" });
  });

  it("matches xero_name, then full/display/ClickUp names, case-insensitively", () => {
    expect(match("smith,  jane")).toMatchObject({ person_id: "p1", method: "xero_name" });
    expect(match("Robert Jones")).toMatchObject({ person_id: "p2", method: "name" });
    expect(match("bob jones")).toMatchObject({ person_id: "p2", method: "name" });
    expect(match("Jane S")).toMatchObject({ person_id: "p1", method: "name" });
  });

  it("falls back to a unique first name, as a suggestion that needs confirming", () => {
    expect(match("Robert J")).toMatchObject({ person_id: "p2", method: "first_name", needsConfirm: true });
    expect(match("Robert Jones")).toMatchObject({ method: "name", needsConfirm: false });
  });

  it("refuses an ambiguous first name", () => {
    expect(match("Amy")).toMatchObject({ person_id: null, method: "ambiguous" });
    expect(match("Zed")).toMatchObject({ person_id: null, method: "unmatched" });
  });

  it("keeps the pasted name and hours", () => {
    expect(matchXeroNames([{ name: "Amy Lee", hours: 99.5 }], people, {})).toEqual([{ name: "Amy Lee", hours: 99.5, person_id: "p3", method: "name", needsConfirm: false }]);
  });
});

describe("parseHoursInput", () => {
  it("blank clears to null, never 0", () => {
    expect(parseHoursInput("")).toEqual({ ok: true, value: null });
    expect(parseHoursInput("   ")).toEqual({ ok: true, value: null });
    expect(parseHoursInput("0")).toEqual({ ok: true, value: 0 });
  });

  it("reads plain numbers and rounds to 2dp", () => {
    expect(parseHoursInput(" 152.5 ")).toEqual({ ok: true, value: 152.5 });
    expect(parseHoursInput("152.456")).toEqual({ ok: true, value: 152.46 });
    expect(parseHoursInput(".5")).toEqual({ ok: true, value: 0.5 });
  });

  it("refuses a decimal comma with a hint instead of reading 152,5 as 1525", () => {
    expect(parseHoursInput("152,5")).toEqual({ ok: false, value: null, error: "Use a dot for decimals: 152,5 → 152.5" });
    expect(parseHoursInput("1,5,0").ok).toBe(false);
  });

  it("accepts a real thousands separator (and warns: over 400 h)", () => {
    expect(parseHoursInput("1,234.5")).toMatchObject({ ok: true, value: 1234.5, warning: expect.any(String) });
    expect(parseHoursInput("00,123").ok).toBe(false);
  });

  it("refuses a pasted line with a thousands separator rather than reading 1,234.5 as 1 h", () => {
    const { rows, errors } = parseXeroPaste("Jane Smith 1,234.5");
    expect(rows).toEqual([]);
    expect(errors[0].message).toMatch(/thousands/);
  });

  it("warns (doesn't block) over 400 h in a month", () => {
    expect(parseHoursInput("400")).toEqual({ ok: true, value: 400 });
    expect(parseHoursInput("400.5")).toMatchObject({ ok: true, value: 400.5, warning: expect.stringMatching(/400/) });
  });

  it("rejects negatives, garbage, exponents and absurd values", () => {
    for (const t of ["-1", "abc", "1e3", "12h", "10000"]) expect(parseHoursInput(t).ok).toBe(false);
  });
});
