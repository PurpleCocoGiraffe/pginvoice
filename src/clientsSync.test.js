import { describe, it, expect } from "vitest";
import { recomputeClientCurrentState, typeTimelineFor, typeForMonth } from "./clientsSync.js";

const ev = (id, kind, effective_date, fields = {}) => ({ id, client: "A", kind, effective_date, applied: true, ...fields });
const row = (over = {}) => ({
  client: "A", base_type: "package", base_agreed_hours: 10,
  type: "package", agreed_hours: 10, consultant: "Holly L", status: "active", end_date: null, ...over,
});

describe("recomputeClientCurrentState -- type event after an offboarding re-engages the client", () => {
  it("offboarded 2026-06-01, re-signed via a type event 2026-08-01 -> active, end_date cleared (Equippers)", () => {
    const events = [ev(1, "offboarding", "2026-06-01"), ev(2, "type", "2026-08-01", { new_type: "package", new_agreed_hours: 24 })];
    expect(recomputeClientCurrentState(row(), events)).toMatchObject({ type: "package", agreed_hours: 24, status: "active", end_date: null });
  });

  it("a type event BEFORE the offboarding does not re-engage", () => {
    const events = [ev(1, "type", "2026-05-01", { new_type: "package", new_agreed_hours: 24 }), ev(2, "offboarding", "2026-06-30")];
    expect(recomputeClientCurrentState(row(), events)).toMatchObject({ status: "offboarded", end_date: "2026-06-30" });
  });

  it("a newly-due type event re-engages a stored offboarded row even with no status event due", () => {
    const events = [ev(1, "offboarding", "2026-06-01"), ev(2, "type", "2026-08-01", { new_type: "package", new_agreed_hours: 24 })];
    const stale = row({ status: "offboarded", end_date: "2026-06-01" });
    expect(recomputeClientCurrentState(stale, events, new Set([2]))).toMatchObject({ status: "active", end_date: null, agreed_hours: 24 });
  });

  it("a hold after an offboarding leaves the client on hold, not re-engaged", () => {
    const events = [ev(1, "offboarding", "2026-10-15"), ev(2, "hold", "2026-11-01")];
    expect(recomputeClientCurrentState(row(), events).status).toBe("on_hold");
  });
});

describe("recomputeClientCurrentState -- fields with no event of their kind keep the row's current value", () => {
  it("applying a consultant event keeps a directly-set 'archived' status", () => {
    const events = [ev(1, "consultant", "2026-09-01", { new_consultant: "Alice FS" })];
    const patch = recomputeClientCurrentState(row({ status: "archived", end_date: "2026-03-31" }), events, new Set([1]));
    expect(patch).toMatchObject({ consultant: "Alice FS", status: "archived", end_date: "2026-03-31" });
  });

  it("applying an unrelated event keeps a directly-set status even when older status events exist", () => {
    const events = [ev(1, "offboarding", "2025-01-31"), ev(2, "reactivation", "2025-03-01"), ev(3, "consultant", "2026-09-01", { new_consultant: "X" })];
    expect(recomputeClientCurrentState(row({ status: "archived" }), events, new Set([3])).status).toBe("archived");
  });

  it("a directly-edited quoted amount survives an unrelated event (updateQuotedAmount)", () => {
    const events = [ev(1, "type", "2026-01-01", { new_type: "quoted", new_agreed_hours: 40 }), ev(2, "consultant", "2026-09-01", { new_consultant: "X" })];
    const patch = recomputeClientCurrentState(row({ type: "quoted", agreed_hours: 55 }), events, new Set([2]));
    expect(patch).toMatchObject({ type: "quoted", agreed_hours: 55 });
  });

  it("a client with no type events keeps its current type/hours, not the base snapshot", () => {
    const patch = recomputeClientCurrentState(row({ type: "quoted", agreed_hours: 70, base_type: "quoted", base_agreed_hours: 40 }), [ev(1, "consultant", "2026-09-01", { new_consultant: "X" })], new Set([1]));
    expect(patch).toMatchObject({ type: "quoted", agreed_hours: 70 });
  });

  it("a newly-due type event still sets type/hours (and a backdated one still loses to a later applied one)", () => {
    const events = [ev(5, "type", "2026-08-01", { new_type: "package", new_agreed_hours: 13 }), ev(9, "type", "2026-07-01", { new_type: "package", new_agreed_hours: 24 })];
    expect(recomputeClientCurrentState(row({ agreed_hours: 99 }), events, new Set([9])).agreed_hours).toBe(13);
  });
});

describe("typeTimelineFor -- same-date type events tie-break by id", () => {
  it("the higher id wins for that month, matching the current row's latestByEffectiveDate", () => {
    const client = { client: "A", baseType: "package", baseAgreedHours: 10 };
    const events = [
      ev(7, "type", "2026-08-01", { new_type: "package", new_agreed_hours: 20 }),
      ev(3, "type", "2026-08-01", { new_type: "hourly", new_agreed_hours: null }),
    ];
    expect(typeTimelineFor(client, events).map((s) => s.type)).toEqual(["package", "hourly", "package"]);
    expect(typeForMonth(client, events, "2026-08")).toMatchObject({ type: "package", agreedHours: 20 });
  });
});
