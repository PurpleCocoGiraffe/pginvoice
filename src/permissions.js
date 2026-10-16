// Purple Giraffe — per-user module access (pure; see permissions.test.js).
//
// `access` is what pginvoice_my_access() returns (supabase-migrations/20261016_user_permissions.sql):
//   { role, isAdminTier, personId, clickupUserName, modules: { key: scope }, clients: [...] }
// Scopes: none / own / assigned / all. Admin tier is always "all" and ignores overrides.
// Nav built from this is cosmetic -- RLS is the real gate.
import { ADMIN_TIER_ROLES, CLIENT_SCOPED_ROLES } from "./roles.js";

export const SCOPES = ["none", "own", "assigned", "all"];
export const SCOPE_LABELS = { none: "Off", own: "Own", assigned: "Their clients", all: "All" };

// Sidebar, in the approved Design OS order. Labels are pinned by permissions.test.js.
export const NAV_MODULES = [
  { key: "overview", label: "Overview" },
  { key: "invoicing", label: "Client Invoicing" },
  { key: "capacity", label: "Capacity Planning" },
  { key: "team", label: "Consultants" },
  { key: "clients", label: "Clients" },
  { key: "timesheet", label: "Timesheets" },
  { key: "accruals", label: "Client Accruals" },
  { key: "performance", label: "Reporting" },
  { key: "wages", label: "Wages review" },
  { key: "bdm", label: "BDM" },
];
// Mobile bottom tab bar (plus "More"): short labels so five tabs fit a phone-width bar.
export const BOTTOM_NAV_MODULES = [
  { key: "overview", label: "Overview" },
  { key: "invoicing", label: "Invoicing" },
  { key: "capacity", label: "Capacity" },
  { key: "team", label: "Team" },
];
// Bottom-of-sidebar items. Settings holds the Users & permissions (admin tier) and
// Integrations (Super Admin) tabs, which used to be separate "Users" / "Integrations" items.
export const SECONDARY_MODULES = [
  { key: "settings", label: "Settings" },
  { key: "help", label: "Help" },
];
export const SETTINGS_TABS = [
  { key: "users", label: "Users & permissions" },
  { key: "integrations", label: "Integrations" },
];

// The caller's scope for one module.
export function effectiveScope(access, moduleKey) {
  if (!access) return "none";
  if (access.isAdminTier) return "all";
  return access.modules?.[moduleKey] ?? "none";
}

export function canSee(access, moduleKey) {
  return effectiveScope(access, moduleKey) !== "none";
}

// Settings tabs this user gets: Users & permissions for admin tier, Integrations for Super Admin.
export function settingsTabsFor(access) {
  if (!access?.isAdminTier) return [];
  return SETTINGS_TABS.filter((t) => t.key !== "integrations" || access.role === "super_admin");
}

// { modules, secondary }: the sidebar's main list and its bottom (secondary) list.
export function visibleNav(access) {
  const modules = NAV_MODULES.filter((m) => canSee(access, m.key));
  // Help is a placeholder and Settings is admin-tier only (both of its tabs are), so
  // non-admins get no secondary items -- as before.
  const secondary = access?.isAdminTier ? SECONDARY_MODULES : [];
  return { modules, secondary };
}

// Mobile bottom bar: the preferred four, minus anything this user can't open.
export function bottomNavFor(access) {
  return BOTTOM_NAV_MODULES.filter((m) => canSee(access, m.key));
}

// Every page key this user may land on (main + secondary).
export function reachableKeys(access) {
  const { modules, secondary } = visibleNav(access);
  return [...modules, ...secondary].map((m) => m.key);
}

// The module scope a non-admin resolves to from their role preset and own overrides.
// Mirrors pg_module_scope() (SQL) and scopeFor in manage-users: override ?? preset ?? "none". Used by Settings to show a
// user's effective access and whether each module is "Role default" or "Custom".
export function resolveModuleScope({ role, overrides, presets }, moduleKey) {
  if (ADMIN_TIER_ROLES.has(role)) return { scope: "all", source: "admin" };
  const override = overrides?.[moduleKey];
  if (override != null) return { scope: override, source: "override" };
  return { scope: presets?.[role]?.[moduleKey] ?? "none", source: "preset" };
}

// TEMPORARY (remove once 20261016_user_permissions is applied everywhere): the access the
// pre-permissions code implied from role alone -- client-scoped roles got these four
// modules. Used when pginvoice_my_access() isn't deployed, and to keep an admin in when it
// fails. Admin tier needs no modules map: effectiveScope is "all" for them regardless.
export const LEGACY_CLIENT_SCOPED_MODULES = ["overview", "clients", "accruals", "performance"];
export function accessFromRole(role, clients = []) {
  const isAdminTier = ADMIN_TIER_ROLES.has(role);
  const modules = {};
  if (!isAdminTier && CLIENT_SCOPED_ROLES.has(role)) for (const k of LEGACY_CLIENT_SCOPED_MODULES) modules[k] = "assigned";
  return { role, isAdminTier, personId: null, clickupUserName: null, modules, clients: isAdminTier ? [] : clients, legacy: true };
}

// Shell's effective access for a freshly fetched profile, given the pginvoice_my_access()
// result ({ access } or { error }) and the previous profile state:
// - RPC not deployed yet: derive from role, exactly the pre-permissions behaviour.
// - Any other RPC failure: admin tier still derives from role (Lynda/Kelly must never be
//   locked out); everyone else keeps their previous access (a refocus blip mustn't change
//   the nav) or, on first load, null -> a reload screen. Non-admins fail closed.
// - Success: the RPC's answer; a profile with no access row (race with a delete) gets nothing.
export function resolveAccess(profile, result, prev) {
  if (result.error) {
    if (isMissingRpcError(result.error) || ADMIN_TIER_ROLES.has(profile.role)) return accessFromRole(profile.role, profile.clients);
    return prev && prev.userId === profile.userId ? prev.access ?? null : null;
  }
  return result.access ?? { role: profile.role, isAdminTier: false, modules: {}, clients: [] };
}

// True when an RPC error means "this function isn't deployed yet" rather than a real
// failure: PostgREST's schema-cache miss (PGRST202), or Postgres undefined_function
// (42883), which is what a stale schema cache passes through when the function is gone.
export function isMissingRpcError(error) {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message || "");
}

// { module_key: scope | null } for the modules whose override differs between two override
// maps (null = cleared, back to the role default) -- the set_access `moduleChanges` payload.
export function overrideChanges(before = {}, after = {}) {
  const changes = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[k] ?? null) !== (after[k] ?? null)) changes[k] = after[k] ?? null;
  }
  return changes;
}

// True once manage-users' `list` has returned the grantable modules. An older function
// (deployed before the permissions migration) returns none: the UI then hides the module
// editor and roster-person picker rather than collect input it would silently drop.
export function hasAccessConfig(moduleScopes) {
  return !!moduleScopes && Object.keys(moduleScopes).length > 0;
}

// One-line summary for a user row, e.g. "Overview · Clients (12 clients) · Reporting".
// Without access config (older manage-users) it shows the role default.
export function accessSummary({ role, overrides, presets, moduleScopes, clientCount = 0 }) {
  if (ADMIN_TIER_ROLES.has(role)) return "Full access";
  const known = hasAccessConfig(moduleScopes);
  const legacy = accessFromRole(role).modules;
  const parts = [];
  for (const m of NAV_MODULES) {
    if (known ? !moduleScopes[m.key] : !legacy[m.key]) continue;
    const scope = known ? resolveModuleScope({ role, overrides, presets }, m.key).scope : legacy[m.key];
    if (scope === "none") continue;
    if (scope === "assigned") parts.push(`${m.label} (${clientCount} client${clientCount === 1 ? "" : "s"})`);
    else if (scope === "own") parts.push(`${m.label} (own)`);
    else parts.push(m.label);
  }
  return parts.length ? parts.join(" · ") : "No modules";
}
