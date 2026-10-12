import { describe, it, expect, vi } from "vitest";

// leaveSync imports the real Supabase client; the pure helpers under test never touch it.
vi.mock("./supabaseClient.js", () => ({ supabase: {} }));

import { totalLeaveHours, deriveLeaveRows, entriesForPerson, LEAVE_TYPES, SELECTABLE_LEAVE_TYPES, leaveDayHours } from "./leaveSync.js";
import { round2 } from "./wagesCalc.js";

const e = (id, person_id, month_key, leave_type, hours) => ({ id, person_id, month_key, leave_type, hours, days: null });

describe("leave types", () => {
  it("never offers 'unspecified' for new entries", () => {
    expect(LEAVE_TYPES.map((t) => t.key)).toEqual(["annual", "personal", "lwop", "unspecified"]);
    expect(SELECTABLE_LEAVE_TYPES.map((t) => t.key)).not.toContain("unspecified");
  });
});

describe("totalLeaveHours", () => {
  it("sums hours without float jitter", () => {
    expect(totalLeaveHours([{ hours: 7.6 }, { hours: 7.6 }, { hours: 7.6 }])).toBe(22.8);
  });
  it("is 0 for no entries", () => {
    expect(totalLeaveHours([])).toBe(0);
    expect(totalLeaveHours(undefined)).toBe(0);
  });
  it("tolerates numeric strings from PostgREST", () => {
    expect(totalLeaveHours([{ hours: "3.25" }, { hours: 1 }])).toBe(4.25);
  });
  it("round2 rounds to numeric(6,2)", () => {
    expect(round2(1.005 + 0.001)).toBe(1.01);
  });
});

describe("entriesForPerson", () => {
  it("filters by person and month", () => {
    const all = [e("1", "p1", "2026-10", "annual", 8), e("2", "p2", "2026-10", "annual", 8), e("3", "p1", "2026-09", "lwop", 4)];
    expect(entriesForPerson(all, "p1", "2026-10").map((x) => x.id)).toEqual(["1"]);
  });
});

describe("deriveLeaveRows", () => {
  it("shows typed entries when any exist, ignoring the stored total", () => {
    const rows = deriveLeaveRows([e("1", "p1", "2026-10", "annual", 7.6)], 30);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "1", legacy: false, leave_type: "annual" });
  });
  it("shows a legacy total with no typed entries as one untyped row, never a real type", () => {
    const rows = deriveLeaveRows([], 15.2);
    expect(rows).toEqual([{ id: null, legacy: true, leave_type: "unspecified", hours: 15.2, days: null }]);
  });
  it("shows nothing for a zero / missing total", () => {
    expect(deriveLeaveRows([], 0)).toEqual([]);
    expect(deriveLeaveRows([], undefined)).toEqual([]);
  });
});

describe("leaveDayHours", () => {
  it("full-time (38 h/week) converts days at 7.6 h", () => {
    expect(leaveDayHours({ contracted: 38 })).toBe(7.6);
    expect(leaveDayHours({ contracted: "38" })).toBe(7.6);
  });

  it("part-time / casual / unset get 0 (enter hours; days vary)", () => {
    expect(leaveDayHours({ contracted: 22.8 })).toBe(0);
    expect(leaveDayHours({ contracted: 0 })).toBe(0);
    expect(leaveDayHours({})).toBe(0);
    expect(leaveDayHours(null)).toBe(0);
  });
});
