import { describe, it, expect } from "vitest";
import { recomputeClientCurrentState, typeTimelineFor, typeForMonth, validateNewClient, newClientRow, storesAgreedHours } from "./clientsSync.js";
import { endPeriodsFor } from "./accrualsSync.js";

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

describe("one lifecycle rule: same-date offboarding beats a type event (recompute and endPeriodsFor agree)", () => {
  const offAndType = (offId, typeId) => [ev(offId, "offboarding", "2026-06-30"), ev(typeId, "type", "2026-06-30", { new_type: "package", new_agreed_hours: 24 })];

  it("offboarding + same-date type event with a HIGHER id -> still offboarded", () => {
    expect(recomputeClientCurrentState(row(), offAndType(1, 2))).toMatchObject({ status: "offboarded", end_date: "2026-06-30" });
    expect(recomputeClientCurrentState(row(), offAndType(2, 1))).toMatchObject({ status: "offboarded", end_date: "2026-06-30" });
  });

  it("endPeriodsFor ends the client from the next month, regardless of id order", () => {
    for (const events of [offAndType(1, 2), offAndType(2, 1)]) {
      const patch = recomputeClientCurrentState(row(), events);
      expect(endPeriodsFor({ client: "A", status: patch.status, endDate: patch.end_date }, events)).toEqual([{ from: "2026-07", until: null, after: null, note: "Client offboarded" }]);
    }
  });

  it("the type-only-due path applies the same rule (same date does not re-engage, later date does)", () => {
    const stored = row({ status: "offboarded", end_date: "2026-06-30" });
    const sameDay = [ev(1, "offboarding", "2026-06-30", { applied: true }), ev(2, "type", "2026-06-30", { new_type: "package", new_agreed_hours: 24 })];
    expect(recomputeClientCurrentState(stored, sameDay, new Set([2])).status).toBe("offboarded");
    const later = [ev(1, "offboarding", "2026-06-30"), ev(2, "type", "2026-07-01", { new_type: "package", new_agreed_hours: 24 })];
    expect(recomputeClientCurrentState(stored, later, new Set([2])).status).toBe("active");
  });

  it("offboarding -> hold -> type: re-engaged in both (hold doesn't end the 'ended' state)", () => {
    const events = [ev(1, "offboarding", "2026-06-30"), ev(2, "hold", "2026-07-15"), ev(3, "type", "2026-09-01", { new_type: "package", new_agreed_hours: 24 })];
    const patch = recomputeClientCurrentState(row(), events);
    expect(patch.status).toBe("active");
    expect(endPeriodsFor({ client: "A", status: patch.status, endDate: patch.end_date }, events)).toEqual([{ from: "2026-07", until: "2026-09", after: null, note: "Client offboarded" }]);
  });
});

describe("recomputeClientCurrentState -- archived is re-engaged by a type event like offboarded", () => {
  it("a directly archived client re-signed via a newly-applied type event becomes active", () => {
    const events = [ev(1, "type", "2026-09-01", { new_type: "package", new_agreed_hours: 20 })];
    expect(recomputeClientCurrentState(row({ status: "archived", end_date: null }), events, new Set([1]))).toMatchObject({ status: "active", end_date: null, agreed_hours: 20 });
  });
  it("an archived client with an end_date is only re-engaged by a type event dated after it", () => {
    const events = [ev(1, "type", "2026-03-31", { new_type: "package", new_agreed_hours: 20 })];
    expect(recomputeClientCurrentState(row({ status: "archived", end_date: "2026-03-31" }), events, new Set([1])).status).toBe("archived");
  });
});

describe("recomputeClientCurrentState -- stored status repaired when it disagrees with the event replay", () => {
  it("a lost patch (events applied, row still active) is repaired by the next unrelated event", () => {
    const events = [ev(1, "offboarding", "2026-06-30"), ev(2, "consultant", "2026-09-01", { new_consultant: "Y" })];
    expect(recomputeClientCurrentState(row({ status: "active" }), events, new Set([2]))).toMatchObject({ status: "offboarded", end_date: "2026-06-30" });
  });
  it("stale 'offboarded' left by older code after a type re-engagement is repaired", () => {
    const events = [ev(1, "offboarding", "2026-06-01"), ev(2, "type", "2026-08-01", { new_type: "package", new_agreed_hours: 24 }), ev(3, "consultant", "2026-09-01", { new_consultant: "Y" })];
    expect(recomputeClientCurrentState(row({ status: "offboarded", end_date: "2026-06-01" }), events, new Set([3]))).toMatchObject({ status: "active", end_date: null });
  });
  it("a status set directly with no status events at all is kept", () => {
    const events = [ev(1, "consultant", "2026-09-01", { new_consultant: "Y" })];
    expect(recomputeClientCurrentState(row({ status: "offboarded", end_date: "2026-05-31" }), events, new Set([1]))).toMatchObject({ status: "offboarded", end_date: "2026-05-31" });
  });
});

describe("Add client -- validateNewClient / newClientRow", () => {
  const roster = [{ client: "Rent Busters (Bunbury, WA)", clickupFolder: "Rent Busters Bunbury (WA)" }];
  const form = (over = {}) => ({ name: "Russell and Suitor", type: "package", hours: "16", consultant: "", clickupFolder: "", startDate: "", ...over });

  it("trims the name and rejects blanks and case-insensitive duplicates", () => {
    expect(validateNewClient(form({ name: "   " }), roster).error).toMatch(/client name/);
    expect(validateNewClient(form({ name: "  rent busters (bunbury, wa) " }), roster).error).toMatch(/already exists/);
    expect(validateNewClient(form({ name: "  Russell and Suitor  " }), roster).name).toBe("Russell and Suitor");
  });

  it("requires hours for package/strategy/map, optional for quoted, ignored for the rest", () => {
    for (const type of ["package", "strategy", "map"]) {
      expect(validateNewClient(form({ type, hours: "" }), roster).error).toMatch(/hours/);
      expect(validateNewClient(form({ type, hours: "12" }), roster).fields.agreedHours).toBe(12);
    }
    expect(validateNewClient(form({ type: "quoted", hours: "" }), roster).fields.agreedHours).toBeNull();
    expect(validateNewClient(form({ type: "quoted", hours: "40" }), roster).fields.agreedHours).toBe(40);
    expect(validateNewClient(form({ type: "package", hours: "-1" }), roster).error).toMatch(/valid number/);
    for (const type of ["hourly", "project", "ad_hoc", "digital"]) {
      expect(validateNewClient(form({ type, hours: "12" }), roster).fields.agreedHours).toBeNull();
    }
  });

  it("0 hours is a real value, not blank", () => {
    expect(validateNewClient(form({ hours: "0" }), roster).fields.agreedHours).toBe(0);
  });

  it("builds the insert row: base snapshot = current, folder/consultant/start date carried, digital stores no hours", () => {
    const { fields } = validateNewClient(form({ consultant: " Amanda S ", clickupFolder: " Russell & Suitor ", startDate: "2026-10-01" }), roster);
    expect(newClientRow("Russell and Suitor", fields)).toEqual({
      client: "Russell and Suitor", type: "package", agreed_hours: 16, base_type: "package", base_agreed_hours: 16,
      consultant: "Amanda S", start_date: "2026-10-01", status: "active", clickup_folder: "Russell & Suitor",
    });
    expect(newClientRow("X", { type: "digital", agreedHours: 10 })).toMatchObject({ type: "digital", agreed_hours: null, base_agreed_hours: null, clickup_folder: null });
    expect(newClientRow("X", { type: "map", agreedHours: 6 })).toMatchObject({ agreed_hours: 6, base_agreed_hours: 6 });
    expect(storesAgreedHours("digital")).toBe(false);
  });
});
