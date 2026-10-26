import { describe, it, expect } from "vitest";
import {
  effectiveScope, visibleNav, bottomNavFor, settingsTabsFor, reachableKeys, resolveModuleScope,
  accessFromRole, isMissingRpcError, accessSummary, resolveAccess, overrideChanges, hasAccessConfig, moduleScopeProps,
} from "./permissions.js";

// What Shell.jsx rendered before per-user permissions (main @ 106b899), copied verbatim
// as data so the new access-driven nav can be pinned against it.
const OLD_MODULES = [
  ["overview", "Overview"], ["invoicing", "Client Accruals"], ["capacity", "Capacity Planning"],
  ["team", "Consultants"], ["clients", "Clients"], ["timesheet", "Timesheets"],
  ["accruals", "Client Accruals Management"], ["performance", "Reporting"], ["wages", "Billability Overview"], ["bdm", "BDM"],
];
const OLD_BOTTOM = [["overview", "Overview"], ["invoicing", "Accruals"], ["capacity", "Capacity"], ["team", "Team"]];
const OLD_CLIENT_SCOPED = new Set(["overview", "clients", "accruals", "performance"]);
const oldNav = (role) => {
  const scoped = role === "consultant" || role === "coordinator";
  const admin = role === "super_admin" || role === "admin";
  const modules = scoped ? OLD_MODULES.filter(([k]) => OLD_CLIENT_SCOPED.has(k)) : OLD_MODULES.filter(([k]) => admin || k !== "wages");
  const bottom = scoped ? OLD_BOTTOM.filter(([k]) => OLD_CLIENT_SCOPED.has(k)) : OLD_BOTTOM;
  const secondary = scoped ? [] : [["settings", "Settings"], ...(role === "super_admin" ? [["integrations", "Integrations"]] : []), ["help", "Help"]];
  if (admin) secondary.push(["users", "Users"]);
  return { modules, bottom, secondary };
};
const pairs = (list) => list.map((m) => [m.key, m.label]);

// Shaped exactly like pginvoice_my_access() output (see supabase-tests/user_permissions_check.sql).
const PHASE1_MODULE_KEYS = ["overview", "clients", "accruals", "performance"];
const rpcAccess = (role, modules) => {
  const isAdminTier = role === "super_admin" || role === "admin";
  return {
    role, isAdminTier, personId: null, clickupUserName: null, clients: [],
    modules: modules ?? Object.fromEntries(PHASE1_MODULE_KEYS.map((k) => [k, isAdminTier ? "all" : "assigned"])),
  };
};

describe("effectiveScope", () => {
  it("admin tier is all everywhere, including modules that aren't grantable and despite any modules map", () => {
    const kelly = { ...rpcAccess("admin"), modules: { overview: "none" } };
    for (const k of ["overview", "invoicing", "capacity", "team", "wages", "bdm", "anything"]) expect(effectiveScope(kelly, k)).toBe("all");
  });
  it("non-admin: the server-resolved scope, else none", () => {
    const a = rpcAccess("consultant", { overview: "assigned", clients: "none" });
    expect(effectiveScope(a, "overview")).toBe("assigned");
    expect(effectiveScope(a, "clients")).toBe("none");
    expect(effectiveScope(a, "wages")).toBe("none");
    expect(effectiveScope(null, "overview")).toBe("none");
  });
});

describe("resolveModuleScope -- preset + override, mirrors pg_module_scope()", () => {
  const presets = { consultant: { overview: "assigned", clients: "assigned" } };
  it("override beats preset; no override inherits; no preset is none", () => {
    expect(resolveModuleScope({ role: "consultant", overrides: { clients: "none" }, presets }, "clients")).toEqual({ scope: "none", source: "override" });
    expect(resolveModuleScope({ role: "consultant", overrides: {}, presets }, "overview")).toEqual({ scope: "assigned", source: "preset" });
    expect(resolveModuleScope({ role: "consultant", overrides: {}, presets }, "accruals")).toEqual({ scope: "none", source: "preset" });
  });
  it("coordinator without presets of its own gets none; admin tier ignores overrides", () => {
    expect(resolveModuleScope({ role: "coordinator", overrides: {}, presets }, "overview").scope).toBe("none");
    expect(resolveModuleScope({ role: "admin", overrides: { overview: "none" }, presets }, "overview")).toEqual({ scope: "all", source: "admin" });
  });
});

describe("nav: admin tier unchanged; phase-1 consultants keep their sidebar", () => {
  for (const role of ["super_admin", "admin"]) {
    it(`${role}: sidebar and mobile bottom bar identical to before`, () => {
      for (const access of [rpcAccess(role), accessFromRole(role)]) {
        const before = oldNav(role);
        expect(pairs(visibleNav(access).modules)).toEqual(before.modules);
        expect(pairs(bottomNavFor(access))).toEqual(before.bottom);
      }
    });
  }

  it("secondary nav: Settings + Help; the old Users / Integrations items are now Settings tabs (approved change)", () => {
    expect(oldNav("super_admin").secondary.map(([k]) => k)).toEqual(["settings", "integrations", "help", "users"]);
    expect(oldNav("admin").secondary.map(([k]) => k)).toEqual(["settings", "help", "users"]);
    expect(pairs(visibleNav(rpcAccess("super_admin")).secondary)).toEqual([["settings", "Settings"], ["help", "Help"]]);
    expect(pairs(visibleNav(rpcAccess("admin")).secondary)).toEqual([["settings", "Settings"], ["help", "Help"]]);
    expect(settingsTabsFor(rpcAccess("super_admin")).map((t) => t.key)).toEqual(["users", "integrations"]);
    expect(settingsTabsFor(rpcAccess("admin")).map((t) => t.key)).toEqual(["users"]);
  });

  for (const role of ["consultant", "coordinator"]) {
    // Phase 2 (approved change): the bottom bar now fills its spare slots from the user's
    // other visible modules, so a phase-1 consultant gets Overview / Clients / Accruals /
    // Reporting instead of Overview alone. Sidebar and secondary are unchanged.
    it(`${role} with phase-1 access: sidebar and secondary identical to before; bottom bar filled`, () => {
      for (const access of [rpcAccess(role), accessFromRole(role, ["Aus3C"])]) {
        const before = oldNav(role);
        expect(pairs(visibleNav(access).modules)).toEqual(before.modules);
        expect(pairs(bottomNavFor(access))).toEqual([["overview", "Overview"], ["clients", "Clients"], ["accruals", "Accruals Mgmt"], ["performance", "Reporting"]]);
        expect(pairs(visibleNav(access).secondary)).toEqual(before.secondary);
        expect(settingsTabsFor(access)).toEqual([]);
      }
    });
  }
});

describe("phase 2 consultant / coordinator preset (20261017_scoped_modules.sql)", () => {
  const PRESET = {
    overview: "assigned", invoicing: "assigned", timesheet: "own", wages: "own",
    clients: "none", accruals: "none", performance: "none",
  };
  for (const role of ["consultant", "coordinator"]) {
    it(`${role}: Overview / Client Accruals / Timesheets / Billability Overview, and all four on the bottom bar`, () => {
      const a = rpcAccess(role, PRESET);
      expect(pairs(visibleNav(a).modules)).toEqual([
        ["overview", "Overview"], ["invoicing", "Client Accruals"], ["timesheet", "Timesheets"], ["wages", "Billability Overview"],
      ]);
      expect(pairs(bottomNavFor(a))).toEqual([["overview", "Overview"], ["invoicing", "Accruals"], ["timesheet", "Timesheet"], ["wages", "Billability"]]);
      expect(visibleNav(a).secondary).toEqual([]);
    });
  }
  it("the bottom bar never exceeds four tabs and keeps the preferred ones first", () => {
    const a = rpcAccess("consultant", { ...PRESET, clients: "assigned", accruals: "assigned" });
    expect(bottomNavFor(a).map((m) => m.key)).toEqual(["overview", "invoicing", "clients", "timesheet"]);
  });
});

describe("overrides change only the overridden modules", () => {
  it("a consultant with Clients and Reporting turned off", () => {
    const a = rpcAccess("consultant", { overview: "assigned", clients: "none", accruals: "assigned", performance: "none" });
    expect(visibleNav(a).modules.map((m) => m.key)).toEqual(["overview", "accruals"]);
    expect(bottomNavFor(a).map((m) => m.key)).toEqual(["overview", "accruals"]);
    expect(reachableKeys(a)).toEqual(["overview", "accruals"]);
  });
  it("Overview off: the bottom bar shows what's left, overview unreachable", () => {
    const a = rpcAccess("consultant", { overview: "none", clients: "assigned", accruals: "none", performance: "none" });
    expect(pairs(bottomNavFor(a))).toEqual([["clients", "Clients"]]);
    expect(reachableKeys(a)).toEqual(["clients"]);
  });
  it("admin reachable keys include settings and help", () => {
    expect(reachableKeys(rpcAccess("admin"))).toContain("settings");
    expect(reachableKeys(rpcAccess("admin"))).toContain("wages");
  });
});

describe("accessFromRole (fallback while pginvoice_my_access isn't deployed)", () => {
  it("client-scoped roles get today's four modules as assigned, with their clients", () => {
    expect(accessFromRole("consultant", ["A"])).toMatchObject({
      isAdminTier: false, clients: ["A"],
      modules: { overview: "assigned", clients: "assigned", accruals: "assigned", performance: "assigned" },
    });
  });
  it("an unknown role gets nothing (fail closed)", () => {
    expect(visibleNav(accessFromRole("mystery")).modules).toEqual([]);
  });
});

describe("resolveAccess (Shell's access for a fetched profile)", () => {
  const admin = { userId: "a", role: "admin", clients: [] };
  const consultant = { userId: "c", role: "consultant", clients: ["Aus3C"] };
  const missing = { error: { code: "PGRST202", message: "Could not find the function" } };
  const outage = { error: new TypeError("Failed to fetch") };

  it("RPC not deployed: derived from role for everyone", () => {
    expect(resolveAccess(consultant, missing, null)).toMatchObject({ isAdminTier: false, clients: ["Aus3C"], modules: { overview: "assigned" } });
    expect(resolveAccess(admin, missing, null)).toMatchObject({ isAdminTier: true });
  });
  it("any other RPC failure: an admin is never locked out", () => {
    const a = resolveAccess(admin, outage, null);
    expect(a.isAdminTier).toBe(true);
    expect(pairs(visibleNav(a).modules)).toEqual(oldNav("admin").modules);
  });
  it("any other RPC failure: a non-admin keeps their previous access, else fails closed (null)", () => {
    const prevAccess = rpcAccess("consultant", { overview: "assigned", clients: "none" });
    expect(resolveAccess(consultant, outage, { userId: "c", access: prevAccess })).toBe(prevAccess);
    expect(resolveAccess(consultant, outage, null)).toBeNull();
    expect(resolveAccess(consultant, outage, { userId: "someone-else", access: prevAccess })).toBeNull();
  });
  it("success: the RPC's answer; no access row means nothing", () => {
    const a = rpcAccess("consultant");
    expect(resolveAccess(consultant, { access: a }, null)).toBe(a);
    expect(visibleNav(resolveAccess(consultant, { access: null }, null)).modules).toEqual([]);
  });
});

describe("overrideChanges -> set_access moduleChanges", () => {
  it("only the modules that differ; cleared overrides are null", () => {
    expect(overrideChanges({ clients: "none", performance: "none" }, { clients: "none", accruals: "none" }))
      .toEqual({ performance: null, accruals: "none" });
    expect(overrideChanges({}, {})).toEqual({});
    expect(overrideChanges(undefined, { overview: "none" })).toEqual({ overview: "none" });
  });
});

describe("isMissingRpcError", () => {
  it("recognises PostgREST's schema-cache miss and Postgres undefined_function", () => {
    expect(isMissingRpcError({ code: "PGRST202", message: "Could not find the function public.pginvoice_my_access without parameters in the schema cache" })).toBe(true);
    expect(isMissingRpcError({ code: "42883", message: "function public.pginvoice_my_access() does not exist" })).toBe(true);
    expect(isMissingRpcError({ message: "function pginvoice_my_access() does not exist" })).toBe(true);
  });
  it("does not treat real failures as not-deployed", () => {
    expect(isMissingRpcError(null)).toBe(false);
    expect(isMissingRpcError({ code: "42501", message: "permission denied for function pginvoice_my_access" })).toBe(false);
    expect(isMissingRpcError(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("accessSummary", () => {
  const moduleScopes = { overview: ["none", "assigned"], clients: ["none", "assigned"], accruals: ["none", "assigned"], performance: ["none", "assigned"] };
  const presets = { consultant: { overview: "assigned", clients: "assigned", accruals: "assigned", performance: "assigned" } };
  it("lists granted modules in nav order with client counts", () => {
    expect(accessSummary({ role: "consultant", overrides: { performance: "none" }, presets, moduleScopes, clientCount: 12 }))
      .toBe("Overview (12 clients) · Clients (12 clients) · Client Accruals Management (12 clients)");
  });
  it("an older manage-users (no moduleScopes): the role default, never 'No modules'", () => {
    expect(hasAccessConfig({})).toBe(false);
    expect(hasAccessConfig(undefined)).toBe(false);
    expect(accessSummary({ role: "consultant", overrides: {}, presets: {}, moduleScopes: {}, clientCount: 2 }))
      .toBe("Overview (2 clients) · Clients (2 clients) · Client Accruals Management (2 clients) · Reporting (2 clients)");
  });
  it("admins are full access; nothing granted says so", () => {
    expect(accessSummary({ role: "admin", overrides: {}, presets, moduleScopes })).toBe("Full access");
    expect(accessSummary({ role: "coordinator", overrides: {}, presets, moduleScopes })).toBe("No modules");
  });
});

describe("moduleScopeProps", () => {
  it("admin tier: every module null (everything, as before)", () => {
    expect(moduleScopeProps(rpcAccess("admin"))).toEqual({ overview: null, invoicing: null, timesheet: null, wages: null });
    expect(moduleScopeProps(null)).toEqual({ overview: null, invoicing: null, timesheet: null, wages: null });
  });
  it("consultant preset: one shape for every scoped module; userNames null when the RPC predates them", () => {
    const a = { ...rpcAccess("consultant", { overview: "assigned", invoicing: "assigned", timesheet: "own", wages: "own" }),
      personId: "p1", clients: ["Apex"], clickupUserNames: ["Holly Fraser"] };
    const shape = { personId: "p1", userNames: ["Holly Fraser"], clients: ["Apex"] };
    expect(moduleScopeProps(a)).toEqual({ overview: { ...shape, activityClients: [] }, invoicing: shape, timesheet: shape, wages: shape });
    const { clickupUserNames: _drop, ...old } = a;
    expect(moduleScopeProps(old).timesheet.userNames).toBeNull();
  });
  it("activityClients (this month's other clients) reach the Overview scope only", () => {
    const activityClients = [{ client: "Aus 3C", status: "active", type: "package" }];
    const a = { ...rpcAccess("consultant", { overview: "assigned", invoicing: "assigned", timesheet: "own", wages: "own" }),
      personId: "p1", clients: ["HTSA"], clickupUserNames: ["Holly Latham"], activityClients };
    const props = moduleScopeProps(a);
    expect(props.overview.activityClients).toEqual(activityClients);
    for (const k of ["invoicing", "timesheet", "wages"]) expect(props[k]).not.toHaveProperty("activityClients");
    expect(props.invoicing.clients).toEqual(["HTSA"]); // never widened by activity
  });
  it("a non-admin granted all / none gets null", () => {
    const a = rpcAccess("consultant", { overview: "all", invoicing: "none" });
    expect(moduleScopeProps(a)).toEqual({ overview: null, invoicing: null, timesheet: null, wages: null });
  });
});
