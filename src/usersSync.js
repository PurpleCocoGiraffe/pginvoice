// Purple Giraffe — role & user-management data access.
//
// Reading your own role/assignments goes straight through Supabase (RLS on
// pginvoice_profiles/pginvoice_user_clients already scopes it to "your own
// row, or all rows if you're admin-tier"). Anything that creates, edits, or
// deletes a user goes through the manage-users Edge Function instead, since
// only it holds the service-role key needed to touch auth.users.
import { supabase } from "./supabaseClient.js";

export const ROLES = ["super_admin", "admin", "consultant", "coordinator"];
export const ROLE_LABELS = {
  super_admin: "Super Admin",
  admin: "Admin",
  consultant: "Consultant",
  coordinator: "Coordinator",
};
// Roles scoped to only their assigned clients, rather than the whole client base.
export const CLIENT_SCOPED_ROLES = new Set(["consultant", "coordinator"]);
export const ADMIN_TIER_ROLES = new Set(["super_admin", "admin"]);
// These two need a linked ClickUp identity -- it's how their client access
// mostly gets derived. Admin-tier roles see everything regardless, so it's
// optional for them.
export const CLICKUP_REQUIRED_ROLES = new Set(["consultant", "coordinator"]);
export const CLIENT_SOURCE_LABELS = { manual: "manual", clickup: "via ClickUp", capacity_lead: "via Capacity lead" };

// Called once per session (Shell.jsx) to know what nav/data this signed-in
// user gets. Returns null if the user has no pginvoice_profiles row yet
// (shouldn't happen for anyone created through this feature, but a legacy
// login predating it would hit this — treated as "no access" rather than a
// crash, since silently granting a role here would be the wrong failure mode).
export async function fetchOwnProfile() {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return null;
  const { data, error } = await supabase
    .from("pginvoice_profiles")
    .select("user_id, role, must_change_password")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (error || !data) return null;

  let clients = [];
  if (CLIENT_SCOPED_ROLES.has(data.role)) {
    const { data: rows } = await supabase.from("pginvoice_user_clients").select("client").eq("user_id", data.user_id);
    clients = (rows || []).map((r) => r.client);
  }
  return { userId: data.user_id, role: data.role, mustChangePassword: !!data.must_change_password, clients };
}

// The signed-in user's effective module access, from pginvoice_my_access() (one RPC,
// computed server-side: admin tier "all", else override ?? role preset ?? "none"). Returns
// null when they have no profile. Throws the raw PostgREST error on failure -- Shell.jsx
// checks it with permissions.js's isMissingRpcError to fall back to role-derived access
// while the 20261016_user_permissions migration isn't applied yet.
export async function fetchOwnAccess() {
  const { data, error } = await supabase.rpc("pginvoice_my_access");
  if (error) throw error;
  return data ?? null;
}

// After a successful password change, clear the flag so LoginGate/Shell.jsx
// stop showing the forced-change screen on future logins.
export async function clearMustChangePassword(userId) {
  const { error } = await supabase.from("pginvoice_profiles").update({ must_change_password: false }).eq("user_id", userId);
  if (error) throw error;
}

// Routes through supabase-js's own functions.invoke, matching every other
// Edge Function call in this codebase (clickupSync.js) — it resolves the
// project URL from the client config and attaches the caller's auth header
// automatically, rather than this module hand-rolling a fetch against a
// hardcoded URL that would silently point at the wrong project anywhere but
// production.
async function callManageUsers(payload) {
  const { data, error } = await supabase.functions.invoke("manage-users", { body: payload });
  if (error) {
    // FunctionsHttpError carries the real JSON body (our `{ ok:false, error }`)
    // on error.context; supabase-js doesn't parse it for us.
    const parsed = await error.context?.json?.().catch(() => null);
    throw new Error(parsed?.error || error.message || "Request failed.");
  }
  if (data?.ok === false) throw new Error(data.error || "Request failed.");
  return data;
}

// { users, presets: { role: { module: scope } }, moduleScopes: { module: [scopes] } } --
// moduleScopes lists only the modules a non-admin can be granted.
export async function fetchUsers() {
  const body = await callManageUsers({ action: "list" });
  return { users: body.users || [], presets: body.presets || {}, moduleScopes: body.moduleScopes || {} };
}

export async function createUser({ email, password, role, clients, clickupUserName, personId, moduleOverrides }) {
  return callManageUsers({ action: "create", email, password, role, clients, clickupUserName, personId, moduleOverrides });
}

// Roster person link + module overrides for a non-admin. personId: undefined = unchanged,
// null = unlink. modules: { module_key: scope | null } for just the modules being changed,
// null = back to the role default. The server refuses self-edits and admin-tier targets.
export async function setUserAccess({ userId, personId, modules }) {
  return callManageUsers({ action: "set_access", userId, personId, modules });
}

export async function updateUserRoleAndClients({ userId, role, clients, clickupUserName }) {
  return callManageUsers({ action: "update_role_and_clients", userId, role, clients, clickupUserName });
}

export async function deleteUser(userId) {
  return callManageUsers({ action: "delete", userId });
}

// Only Users.jsx calls this (admin-tier), reading pginvoice_clickup_entries
// directly rather than through the Edge Function -- its RLS policy still
// allows any authenticated read (it was never scoped per-client like the
// billing tables), so there's no need to round-trip through manage-users
// just to list distinct ClickUp names for the autocomplete.
//
// Paginated (PostgREST caps a single request at 1000 rows) -- with 49k+
// entries in this table, an unpaginated select only ever saw whichever
// person's rows happened to fall in that first 1000, silently hiding
// everyone else from the picker.
const PAGE_SIZE = 1000;
export async function fetchClickupUserNames() {
  const names = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("pginvoice_clickup_entries")
      .select("user_name")
      // Unique order -- without one, pages can skip/duplicate rows between requests.
      .order("entry_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    for (const r of data) if (r.user_name) names.add(r.user_name);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return [...names].sort();
}

// CapacityDashboard.jsx calls this whenever an active project's lead changes --
// assignments is [{ client, lead }] for active (non-offboarded) projects only.
export async function syncCapacityLeads(assignments) {
  return callManageUsers({ action: "sync_capacity_leads", assignments });
}
