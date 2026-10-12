import { describe, it, expect } from "vitest";
import { PUBLIC_HOLIDAYS, holidaysFor } from "./publicHolidays.js";
import { PUBLIC_HOLIDAYS as FROM_CAPACITY, publicHolidayDays } from "./capacityData.js";

const dow = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

describe("PUBLIC_HOLIDAYS", () => {
  it("is the same object re-exported from capacityData.js", () => {
    expect(FROM_CAPACITY).toBe(PUBLIC_HOLIDAYS);
  });

  it("covers SA, WA and QLD", () => {
    expect(Object.keys(PUBLIC_HOLIDAYS).sort()).toEqual(["QLD", "SA", "WA"]);
  });

  for (const [state, list] of Object.entries(PUBLIC_HOLIDAYS)) {
    it(`${state}: every date is a real weekday inside 2025-06-01..2027-12-31`, () => {
      for (const h of list) {
        expect(h.date, h.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const [y, m, d] = h.date.split("-").map(Number);
        const back = new Date(Date.UTC(y, m - 1, d));
        expect(back.getUTCMonth() + 1, h.date).toBe(m); // not e.g. 2026-02-30
        expect(back.getUTCDate(), h.date).toBe(d);
        expect([1, 2, 3, 4, 5], `${state} ${h.date} ${h.name}`).toContain(dow(h.date));
        expect(h.date >= "2025-06-01" && h.date <= "2027-12-31", h.date).toBe(true);
        expect(typeof h.name).toBe("string");
      }
    });

    it(`${state}: dates are sorted and unique`, () => {
      const dates = list.map((h) => h.date);
      expect([...dates].sort()).toEqual(dates);
      expect(new Set(dates).size).toBe(dates.length);
    });
  }

  it("includes the newly added 2025 and 2027 dates", () => {
    const has = (s, d) => PUBLIC_HOLIDAYS[s].some((h) => h.date === d);
    expect(has("SA", "2025-06-09")).toBe(true);
    expect(has("SA", "2025-10-06")).toBe(true);
    expect(has("WA", "2025-06-02")).toBe(true);
    expect(has("WA", "2025-09-29")).toBe(true);
    expect(has("QLD", "2025-10-06")).toBe(true);
    for (const s of ["SA", "WA", "QLD"]) {
      for (const d of ["2027-01-01", "2027-01-26", "2027-03-26", "2027-03-29", "2027-12-27", "2027-12-28"]) expect(has(s, d), `${s} ${d}`).toBe(true);
    }
    expect(has("SA", "2027-03-08")).toBe(true);
    expect(has("SA", "2027-06-14")).toBe(true);
    expect(has("SA", "2027-10-04")).toBe(true);
    expect(has("WA", "2027-03-01")).toBe(true);
    expect(has("WA", "2027-04-26")).toBe(true);
    expect(has("WA", "2027-06-07")).toBe(true);
    expect(has("WA", "2027-09-27")).toBe(true);
    expect(has("QLD", "2027-05-03")).toBe(true);
    expect(has("QLD", "2027-10-04")).toBe(true);
  });

  it("marks the Ekka as Brisbane-only", () => {
    const ekka = PUBLIC_HOLIDAYS.QLD.filter((h) => h.region === "Brisbane").map((h) => h.date);
    expect(ekka).toEqual(["2025-08-13", "2026-08-12", "2027-08-11"]);
  });

  it("keeps the existing capacity counts for 2026 (consumers unaffected)", () => {
    expect(publicHolidayDays("SA", "2026-10")).toBe(1);
    expect(publicHolidayDays("WA", "2026-04")).toBe(3);
    expect(publicHolidayDays("QLD", "2026-08")).toBe(1);
  });
});

describe("holidaysFor", () => {
  it("returns the state's holidays for the month", () => {
    expect(holidaysFor("SA", "2026-10")).toEqual([{ date: "2026-10-05", name: "Labour Day" }]);
    expect(holidaysFor("WA", "2026-09")).toEqual([{ date: "2026-09-28", name: "King's Birthday" }]);
    expect(holidaysFor("QLD", "2027-08")).toEqual([{ date: "2027-08-11", name: "Royal Queensland Show (Ekka, Brisbane)", region: "Brisbane" }]);
  });

  it("is case-insensitive on the state", () => {
    expect(holidaysFor("qld", "2026-05").map((h) => h.date)).toEqual(["2026-05-04"]);
  });

  it("returns [] for an unknown or missing state (no silent SA fallback)", () => {
    expect(holidaysFor("NSW", "2026-10")).toEqual([]);
    expect(holidaysFor(null, "2026-10")).toEqual([]);
    expect(holidaysFor("", "2026-10")).toEqual([]);
  });

  it("returns [] for a month with no holidays", () => {
    expect(holidaysFor("SA", "2026-07")).toEqual([]);
  });

  it("returns copies so callers can't mutate the shared table", () => {
    holidaysFor("SA", "2026-10")[0].name = "changed";
    expect(holidaysFor("SA", "2026-10")[0].name).toBe("Labour Day");
  });
});
