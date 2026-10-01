import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal stand-in for supabase-js's query builder: records every chained call per query,
// and serves `range(from, to)` pages out of a per-table dataset (sorted by whatever
// `.order()` calls were made, so a missing unique tie-breaker shows up in the recorded calls).
const tables = {};
const queries = [];
function builder(table) {
  const q = { table, calls: [] };
  queries.push(q);
  const api = {};
  for (const m of ["select", "order", "eq", "gte", "lt", "in", "lte", "ilike", "not"]) {
    api[m] = (...args) => { q.calls.push([m, ...args]); return api; };
  }
  api.range = (from, to) => {
    q.calls.push(["range", from, to]);
    const rows = tables[table] || [];
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  };
  return api;
}
const invoke = vi.fn();
vi.mock("./supabaseClient.js", () => ({
  supabase: { from: (t) => builder(t), functions: { invoke: (...a) => invoke(...a) } },
}));

const { fetchClickupFromSupabase, triggerManualSync, functionErrorMessage } = await import("./clickupSync.js");
const { fetchAccrualsFromSupabase } = await import("./accrualsSync.js");
const { fetchClientEvents } = await import("./clientsSync.js");

const ordersOf = (q) => q.calls.filter((c) => c[0] === "order").map((c) => c[1]);

beforeEach(() => {
  queries.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  invoke.mockReset();
});

describe("paginated reads order by a unique key (tied rows skipped/duplicated across pages)", () => {
  it("fetchClickupFromSupabase orders by entry_start then entry_id on every page", async () => {
    tables.pginvoice_clickup_entries = Array.from({ length: 1001 }, (_, i) => ({ folder: "F", minutes: 1, month_key: "2026-09" }));
    const out = await fetchClickupFromSupabase();
    expect(out.rows).toHaveLength(1001);
    const pages = queries.filter((q) => q.table === "pginvoice_clickup_entries");
    expect(pages).toHaveLength(2);
    for (const q of pages) expect(ordersOf(q)).toEqual(["entry_start", "entry_id"]);
  });

  it("fetchAccrualsFromSupabase orders by client then month_key", async () => {
    tables.pginvoice_accruals = [{ client: "A", month_key: "2026-09", accrual_value: 1 }];
    await fetchAccrualsFromSupabase();
    expect(ordersOf(queries.find((q) => q.table === "pginvoice_accruals"))).toEqual(["client", "month_key"]);
  });

  it("fetchClientEvents paginates past 1000 rows, ordered by effective_date then id", async () => {
    tables.pginvoice_client_events = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, client: "A", kind: "consultant", effective_date: "2026-01-01" }));
    const events = await fetchClientEvents();
    expect(events).toHaveLength(1500);
    const pages = queries.filter((q) => q.table === "pginvoice_client_events");
    expect(pages).toHaveLength(2);
    for (const q of pages) expect(ordersOf(q)).toEqual(["effective_date", "id"]);
    expect(pages[1].calls.find((c) => c[0] === "range")).toEqual(["range", 1000, 1999]);
  });
});

describe("triggerManualSync (Sync now)", () => {
  const httpError = (body) => ({ message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify(body), { status: 500 }) });

  it("still runs last month (offset 1) when the current month fails, and surfaces the function's own error", async () => {
    invoke
      .mockResolvedValueOnce({ data: null, error: httpError({ ok: false, error: "Refusing stale-row cleanup: 900 of 1000" }) })
      .mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(triggerManualSync()).rejects.toThrow("Current month: Refusing stale-row cleanup: 900 of 1000");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toEqual({ body: { monthOffset: 1 } });
  });

  it("returns both results when both succeed", async () => {
    invoke.mockResolvedValueOnce({ data: { n: 1 }, error: null }).mockResolvedValueOnce({ data: { n: 2 }, error: null });
    expect(await triggerManualSync()).toEqual({ current: { n: 1 }, lastMonth: { n: 2 } });
  });

  it("functionErrorMessage falls back to the generic message when the body isn't JSON", async () => {
    const err = { message: "generic", context: new Response("not json", { status: 502 }) };
    expect(await functionErrorMessage(err)).toBe("generic");
    expect(await functionErrorMessage(new Error("plain"))).toBe("plain");
  });
});
