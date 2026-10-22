import { describe, it, expect } from "vitest";
import { buildCapIndexes } from "./invoicingPipeline.js";

// Non-admins get cap_clients through pginvoice_client_directory() with `agreed` replaced by
// its dense rank within the row's group (20261022_capacity_admin_only.sql). Client Invoicing
// must reach the same per-group results from either, or a consultant's cards would differ
// from an admin's. This mirrors the SQL: dense_rank() over (partition by group order by
// coalesce(agreed, 0)).
function rankAgreed(rows) {
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, new Set());
    byGroup.get(r.group).add(Number.isFinite(r.agreed) ? r.agreed : 0);
  }
  const ranks = new Map([...byGroup].map(([g, vals]) => [g, [...vals].sort((a, b) => a - b)]));
  return rows.map((r) => ({ ...r, agreed: ranks.get(r.group).indexOf(Number.isFinite(r.agreed) ? r.agreed : 0) + 1 }));
}

const ROWS = [
  // Mixed group: the fixed-basis row with the most agreed hours decides the type.
  { id: "1", client: "Majestic Plumbing (WA)", group: "Majestic", basis: "Package", agreed: 24.5, status: "active" },
  { id: "2", client: "MP Quoted Web (WA)", group: "Majestic", basis: "Quoted", agreed: 40, status: "active" },
  { id: "3", client: "MP Leak Tech", group: "Majestic", basis: "Hourly", agreed: null, status: "active" },
  // Tie on agreed hours: the first row wins in both.
  { id: "4", client: "Tie A", group: "Tie", basis: "MAP", agreed: 10, status: "active" },
  { id: "5", client: "Tie B", group: "Tie", basis: "Package", agreed: 10, status: "active" },
  // A zero/null-only fixed group, and an offboarded group.
  { id: "6", client: "Zero", group: "Zero", basis: "Strategy", agreed: 0, status: "active" },
  { id: "7", client: "Zero B", group: "Zero", basis: "Package", agreed: null, status: "active" },
  { id: "8", client: "Gone", group: "Gone", basis: "Package", agreed: 16, status: "inactive", offboardedFrom: "2026-05", offboardNote: "done" },
  { id: "9", client: "Gone 2", group: "Gone", basis: "Hourly", agreed: null, status: "inactive", offboardedFrom: "2026-07" },
];

describe("cap_clients agreed hours as per-group ranks", () => {
  it("buildCapIndexes gives identical types, offboarded groups, names and rows", () => {
    const admin = buildCapIndexes(ROWS);
    const scoped = buildCapIndexes(rankAgreed(ROWS));
    expect([...scoped.capTypeByGroup]).toEqual([...admin.capTypeByGroup]);
    expect([...scoped.capOffboardedByGroup]).toEqual([...admin.capOffboardedByGroup]);
    expect(scoped.capGroupNames).toEqual(admin.capGroupNames);
    const strip = (m) => [...m].map(([k, v]) => [k, { ...v, agreed: undefined }]);
    expect(strip(scoped.capRowByClientName)).toEqual(strip(admin.capRowByClientName));
    // Sanity: the mixed group really is decided by agreed hours (Quoted's 40 beats Package's 24.5).
    expect(admin.capTypeByGroup.get("Majestic")).toBe("quoted");
  });

  it("ranks never carry the real hours", () => {
    expect(rankAgreed(ROWS).map((r) => r.agreed)).toEqual([2, 3, 1, 1, 1, 1, 1, 2, 1]);
  });
});
