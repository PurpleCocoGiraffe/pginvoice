// Purple Giraffe — user management (Super Admin / Admin only)
//
// Creating or modifying an auth.users row requires the Supabase service-role
// key, which the browser never holds -- so this function does that step
// server-side. Every action first re-derives the caller's own role from
// pginvoice_profiles (via a second client scoped to their JWT, so RLS applies
// to them) rather than trusting anything the request body claims about who's
// calling, since the body is attacker-controlled input.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { passwordResetDecision } from "../_shared/authz.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };

const ROLES = ["super_admin", "admin", "consultant", "coordinator"];
// These two roles only ever see their assigned clients -- a ClickUp identity is
// how most of that assignment gets derived, so it's required for them and
// optional for admin-tier roles (who see everything regardless).
const CLICKUP_REQUIRED_ROLES = new Set(["consultant", "coordinator"]);
// Always full access (pg_module_scope returns 'all'); per-user module overrides never apply.
const ADMIN_TIER_ROLES = new Set(["super_admin", "admin"]);

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSON_HEADERS });
}

async function clickupNameExists(admin: any, name: string): Promise<boolean> {
  const { data, error } = await admin.from("pginvoice_clickup_entries").select("user_name").ilike("user_name", name).limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

// A consultant/coordinator's clients come from the Clients module's Consultant field
// (source='consultant', 20261026_consultant_clients.sql), rebuilt by database triggers whenever
// a profile's role / ClickUp name or a client's consultant / status changes -- this function
// writes the profile and lets the trigger do it. The old all-time ClickUp-history grants
// (source='clickup') gave people every client they had ever logged time on.

// Ends every session of a user (refresh tokens deleted; an issued access token lasts until
// it expires). Via an RPC because admin.auth.admin.signOut takes the user's own JWT, not a
// user id. Returns an error message, or null.
async function revokeSessions(admin: any, userId: string): Promise<string | null> {
  const { error } = await admin.rpc("pginvoice_revoke_user_sessions", { p_user_id: userId });
  return error ? error.message : null;
}

// Capacity Planning's "lead" is a free-text first name (e.g. "Holly"), not tied
// to any account id -- fuzzy-matched here against clickup_user_name (which is
// usually a fuller name, e.g. "Holly Fraser") rather than requiring an exact
// match, since that's the only identity string these two systems share.
function normalizeName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function namesLikelyMatch(leadName: string, clickupName: string): boolean {
  const a = normalizeName(leadName);
  const b = normalizeName(clickupName);
  if (!a || !b) return false;
  if (a === b) return true;
  const aTokens = a.split(" ").filter((t) => t.length >= 3);
  const bTokens = new Set(b.split(" ").filter((t) => t.length >= 3));
  return aTokens.some((t) => bTokens.has(t));
}

// The permissions migration (20261016_user_permissions.sql) isn't applied yet: a missing
// column (42703) or table (42P01; PGRST204/PGRST205 from PostgREST's schema cache). `list`
// then degrades to the pre-permissions shape and the UI hides the access editors.
function isMissingSchemaError(err: any): boolean {
  return ["42703", "42P01", "PGRST204", "PGRST205"].includes(err?.code);
}

// Module-access config (supabase-migrations/20261016_user_permissions.sql): which scopes
// each grantable module allows, and each non-admin role's preset scope per module.
type AccessConfig = { moduleScopes: Record<string, string[]>; presets: Record<string, Record<string, string>> };
async function loadAccessConfig(admin: any): Promise<AccessConfig> {
  const [{ data: scopes, error: scopesErr }, { data: presetRows, error: presetsErr }] = await Promise.all([
    admin.from("pginvoice_module_scopes").select("module_key, scope"),
    admin.from("pginvoice_role_presets").select("role, module_key, scope"),
  ]);
  if (scopesErr) throw scopesErr;
  if (presetsErr) throw presetsErr;
  const moduleScopes: Record<string, string[]> = Object.create(null);
  for (const r of scopes || []) (moduleScopes[r.module_key] ||= []).push(r.scope);
  const presets: Record<string, Record<string, string>> = Object.create(null);
  for (const r of presetRows || []) (presets[r.role] ||= {})[r.module_key] = r.scope;
  return { moduleScopes, presets };
}

async function rosterHasPerson(admin: any, personId: string): Promise<boolean> {
  const { data, error } = await admin.from("pginvoice_app_state").select("value").eq("key", "cap_people").maybeSingle();
  if (error) throw error;
  const people = Array.isArray(data?.value) ? data.value : [];
  return people.some((p: any) => p && p.id === personId);
}

// Validates a requested access change for a non-admin and returns the resulting state.
// personIdInput: undefined = unchanged, null/"" = unlink, string = link. modulesInput:
// { module_key: scope | null } for the modules being changed (null = inherit the role
// preset, i.e. delete the override); modules not listed keep their current override.
async function resolveAccessChange(admin: any, opts: {
  targetUserId: string | null; role: string; config: AccessConfig;
  currentPersonId: string | null; currentOverrides: Record<string, string>;
  personIdInput: unknown; modulesInput: unknown;
}): Promise<{ error: string } | { personId: string | null; overrides: Record<string, string> }> {
  const { targetUserId, role, config, currentPersonId, currentOverrides, personIdInput, modulesInput } = opts;

  let personId = currentPersonId;
  if (personIdInput !== undefined) {
    if (personIdInput !== null && typeof personIdInput !== "string") return { error: "Invalid personId." };
    personId = typeof personIdInput === "string" && personIdInput.trim() ? personIdInput.trim() : null;
  }

  const overrides: Record<string, string> = Object.assign(Object.create(null), currentOverrides);
  if (modulesInput !== undefined && modulesInput !== null) {
    if (typeof modulesInput !== "object" || Array.isArray(modulesInput)) return { error: "Invalid module access." };
    for (const [moduleKey, scope] of Object.entries(modulesInput as Record<string, unknown>)) {
      // hasOwn, not a plain lookup: "__proto__" / "constructor" must not pass as modules.
      if (!Object.hasOwn(config.moduleScopes, moduleKey)) return { error: `"${moduleKey}" isn't a module that can be granted.` };
      const allowed = config.moduleScopes[moduleKey];
      if (scope === null) { delete overrides[moduleKey]; continue; }
      if (typeof scope !== "string" || !allowed.includes(scope)) {
        return { error: `"${String(scope)}" isn't an allowed access level for ${moduleKey} (allowed: ${allowed.join(", ")}).` };
      }
      overrides[moduleKey] = scope;
    }
  }

  // 'own' means "this person's own rows", so explicitly granting it needs a linked roster
  // person. Only overrides count: since 20261017_scoped_modules the consultant/coordinator
  // presets are Timesheets/Wages 'own', and an unlinked user on those defaults is fine --
  // the modules say "no roster person linked" and the own-wages RPC refuses them.
  const needsPerson = Object.values(overrides).some((s) => s === "own");
  if (needsPerson && !personId) return { error: "Link a roster person before granting \"own\" access to a module." };

  if (personId && personId !== currentPersonId) {
    let q = admin.from("pginvoice_profiles").select("email").eq("person_id", personId);
    if (targetUserId) q = q.neq("user_id", targetUserId);
    const { data: linked, error: linkedErr } = await q.limit(1);
    if (linkedErr) throw linkedErr;
    if (linked && linked.length) return { error: `That roster person is already linked to ${linked[0].email || "another account"}.` };
    if (!(await rosterHasPerson(admin, personId))) return { error: "That person isn't on the Consultants roster." };
  }
  return { personId, overrides };
}

// { personId?: {from, to}, modules?: { key: {from, to} } } -- only what changed; null = inherit/unlinked.
function accessDiff(before: { personId: string | null; overrides: Record<string, string> },
                    after: { personId: string | null; overrides: Record<string, string> }) {
  const diff: Record<string, unknown> = {};
  if (before.personId !== after.personId) diff.personId = { from: before.personId, to: after.personId };
  const modules: Record<string, { from: string | null; to: string | null }> = {};
  for (const k of new Set([...Object.keys(before.overrides), ...Object.keys(after.overrides)])) {
    const from = before.overrides[k] ?? null;
    const to = after.overrides[k] ?? null;
    if (from !== to) modules[k] = { from, to };
  }
  if (Object.keys(modules).length) diff.modules = modules;
  return diff;
}

function friendlyDbError(err: any): Error {
  // The unique index on pginvoice_profiles.person_id: a concurrent link won the race.
  if (err?.code === "23505") return new Error("That roster person is already linked to another account.");
  return err instanceof Error ? err : new Error(err?.message || String(err));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return bad("Not signed in.", 401);

  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: callerUser, error: callerErr } = await callerClient.auth.getUser(jwt);
  if (callerErr || !callerUser?.user) return bad("Not signed in.", 401);

  const { data: callerProfile } = await callerClient
    .from("pginvoice_profiles")
    .select("role")
    .eq("user_id", callerUser.user.id)
    .maybeSingle();
  const callerRole = callerProfile?.role;
  if (callerRole !== "super_admin" && callerRole !== "admin") {
    return bad("You don't have permission to manage users.", 403);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  async function logAudit(action: string, target: { userId?: string; email?: string }, detail?: Record<string, unknown>) {
    await admin.from("pginvoice_audit_log").insert({
      actor_user_id: callerUser.user.id,
      actor_email: callerUser.user.email,
      action,
      target_user_id: target.userId ?? null,
      target_email: target.email ?? null,
      detail: detail ?? null,
    });
  }

  async function superAdminCount(excludingUserId?: string): Promise<number> {
    let q = admin.from("pginvoice_profiles").select("user_id", { count: "exact", head: true }).eq("role", "super_admin");
    if (excludingUserId) q = q.neq("user_id", excludingUserId);
    const { count, error } = await q;
    if (error) throw error;
    return count ?? 0;
  }

  let body: any = {};
  try { body = await req.json(); } catch (_) { return bad("Invalid request body."); }
  const action = body?.action;

  try {
    if (action === "list") {
      const { data: authList, error: authListErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
      if (authListErr) throw authListErr;
      let { data: profiles, error: profilesErr } = await admin
        .from("pginvoice_profiles")
        .select("user_id, role, must_change_password, clickup_user_name, person_id");
      if (profilesErr && isMissingSchemaError(profilesErr)) {
        ({ data: profiles, error: profilesErr } = await admin
          .from("pginvoice_profiles")
          .select("user_id, role, must_change_password, clickup_user_name"));
      }
      if (profilesErr) throw profilesErr;
      const { data: assignments, error: assignErr } = await admin.from("pginvoice_user_clients").select("user_id, client, source");
      if (assignErr) throw assignErr;
      // Before the permissions migration: no overrides and empty config (the UI then hides
      // the access editors rather than collect input this function can't store).
      let overrideRows: any[] = [];
      let config: AccessConfig = { moduleScopes: {}, presets: {} };
      try {
        const { data, error } = await admin.from("pginvoice_user_module_access").select("user_id, module_key, scope");
        if (error) throw error;
        overrideRows = data || [];
        config = await loadAccessConfig(admin);
      } catch (e) {
        if (!isMissingSchemaError(e)) throw e;
      }
      // Client Accruals "can also see client hours of" (20261029_viewable_people.sql); none until it's applied.
      const viewableByUser = new Map<string, string[]>();
      {
        const { data, error } = await admin.from("pginvoice_user_viewable_people").select("user_id, person_id").order("person_id");
        if (error && !isMissingSchemaError(error)) throw error;
        for (const v of data || []) viewableByUser.set(v.user_id, [...(viewableByUser.get(v.user_id) || []), v.person_id]);
      }
      const overridesByUser = new Map<string, Record<string, string>>();
      for (const o of overrideRows || []) {
        const m = overridesByUser.get(o.user_id) || {};
        m[o.module_key] = o.scope;
        overridesByUser.set(o.user_id, m);
      }

      const profileByUser = new Map((profiles || []).map((p: any) => [p.user_id, p]));
      const clientsByUser = new Map<string, { client: string; source: string }[]>();
      for (const a of assignments || []) {
        const list = clientsByUser.get(a.user_id) || [];
        list.push({ client: a.client, source: a.source });
        clientsByUser.set(a.user_id, list);
      }

      const users = (authList.users || [])
        .filter((u: any) => profileByUser.has(u.id))
        .map((u: any) => {
          const p = profileByUser.get(u.id);
          const clientDetails = clientsByUser.get(u.id) || [];
          return {
            id: u.id,
            email: u.email,
            role: p?.role,
            mustChangePassword: !!p?.must_change_password,
            clickupUserName: p?.clickup_user_name || "",
            personId: p?.person_id || null,
            moduleOverrides: overridesByUser.get(u.id) || {},
            viewablePersonIds: viewableByUser.get(u.id) || [],
            clients: clientDetails.map((c) => c.client),
            clientDetails,
            createdAt: u.created_at,
            lastSignInAt: u.last_sign_in_at,
          };
        });
      // Consultant names on active clients that match no account or several (nobody gets those
      // clients automatically). [] until 20261026_consultant_clients.sql is applied.
      let consultantMatchIssues: unknown[] = [];
      const { data: issues, error: issuesErr } = await admin.rpc("pginvoice_consultant_match_issues");
      if (issuesErr) {
        if (!["PGRST202", "42883"].includes(issuesErr.code)) throw issuesErr;
      } else if (Array.isArray(issues)) {
        consultantMatchIssues = issues;
      }
      return new Response(JSON.stringify({ ok: true, users, presets: config.presets, moduleScopes: config.moduleScopes, consultantMatchIssues }), { headers: JSON_HEADERS });
    }

    if (action === "create") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const role = body.role;
      const clients: string[] = Array.isArray(body.clients) ? body.clients.filter((c: any) => typeof c === "string") : [];
      const clickupUserName = typeof body.clickupUserName === "string" ? body.clickupUserName.trim() : "";

      if (!email || !email.includes("@")) return bad("A valid email is required.");
      if (!password || password.length < 8) return bad("Password must be at least 8 characters.");
      if (!ROLES.includes(role)) return bad("Invalid role.");
      if (role === "super_admin" && callerRole !== "super_admin") {
        return bad("Only a Super Admin can create another Super Admin.", 403);
      }

      const requiresClickup = CLICKUP_REQUIRED_ROLES.has(role);
      if (requiresClickup) {
        if (!clickupUserName) return bad("A ClickUp name is required for Consultant/Coordinator accounts.");
        if (!(await clickupNameExists(admin, clickupUserName))) {
          return bad(`No ClickUp user named "${clickupUserName}" was found in synced time entries.`);
        }
      }

      // Roster person + module overrides apply to non-admin roles only (admin tier is always
      // full access, matching set_access).
      let access = { personId: null as string | null, overrides: {} as Record<string, string> };
      const hasAccessInput = (typeof body.personId === "string" && body.personId.trim())
        || (body.moduleOverrides && typeof body.moduleOverrides === "object" && Object.keys(body.moduleOverrides).length);
      if (ADMIN_TIER_ROLES.has(role)) {
        if (hasAccessInput) return bad("Admins always have full access — module access and a roster person don't apply.");
      } else {
        const resolved = await resolveAccessChange(admin, {
          targetUserId: null, role, config: await loadAccessConfig(admin),
          currentPersonId: null, currentOverrides: {},
          personIdInput: body.personId ?? undefined, modulesInput: body.moduleOverrides ?? undefined,
        });
        if ("error" in resolved) return bad(resolved.error);
        access = resolved;
      }

      // Validated everything possible before creating the auth user -- from here
      // any failure needs to unwind it, otherwise it's stranded: invisible in
      // `list` (which only shows users with a profile row) but "already
      // registered" on retry, with no way to fix it from this UI.
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr) throw createErr;
      const newUserId = created.user!.id;

      try {
        const { error: profileErr } = await admin
          .from("pginvoice_profiles")
          .insert({ user_id: newUserId, email, role, must_change_password: true, clickup_user_name: clickupUserName || null, person_id: access.personId });
        if (profileErr) throw friendlyDbError(profileErr);

        const overrideRows = Object.entries(access.overrides)
          .map(([module_key, scope]) => ({ user_id: newUserId, module_key, scope, updated_by: callerUser.user.id }));
        if (overrideRows.length) {
          const { error: overridesErr } = await admin.from("pginvoice_user_module_access").insert(overrideRows);
          if (overridesErr) throw overridesErr;
        }

        if ((role === "consultant" || role === "coordinator") && clients.length) {
          const rows = clients.map((client) => ({ user_id: newUserId, client, source: "manual" }));
          const { error: assignErr } = await admin.from("pginvoice_user_clients").insert(rows);
          if (assignErr) throw assignErr;
        }
      } catch (setupErr) {
        await admin.auth.admin.deleteUser(newUserId).catch(() => {});
        throw setupErr;
      }

      await logAudit("create_user", { userId: newUserId, email }, { role, clients, clickupUserName, personId: access.personId, moduleOverrides: access.overrides });
      return new Response(JSON.stringify({ ok: true, userId: newUserId }), { headers: JSON_HEADERS });
    }

    if (action === "update_role_and_clients") {
      const targetUserId = body.userId;
      const role = body.role;
      const clients: string[] = Array.isArray(body.clients) ? body.clients.filter((c: any) => typeof c === "string") : [];
      const clickupUserName = typeof body.clickupUserName === "string" ? body.clickupUserName.trim() : "";
      if (!targetUserId) return bad("Missing userId.");
      if (!ROLES.includes(role)) return bad("Invalid role.");
      if (targetUserId === callerUser.user.id) {
        return bad("You can't change your own role — ask another Super Admin or Admin to do it.");
      }
      if (role === "super_admin" && callerRole !== "super_admin") {
        return bad("Only a Super Admin can grant the Super Admin role.", 403);
      }

      const requiresClickup = CLICKUP_REQUIRED_ROLES.has(role);
      if (requiresClickup) {
        if (!clickupUserName) return bad("A ClickUp name is required for Consultant/Coordinator accounts.");
        if (!(await clickupNameExists(admin, clickupUserName))) {
          return bad(`No ClickUp user named "${clickupUserName}" was found in synced time entries.`);
        }
      }

      const { data: targetProfile, error: targetErr } = await admin
        .from("pginvoice_profiles")
        .select("role, email")
        .eq("user_id", targetUserId)
        .maybeSingle();
      if (targetErr) throw targetErr;
      if (!targetProfile) return bad("User not found.", 404);

      if (targetProfile.role === "super_admin" && role !== "super_admin") {
        const remaining = await superAdminCount(targetUserId);
        if (remaining === 0) return bad("Can't remove the last Super Admin — promote someone else first.");
      }

      // Admin tier is always full access, so a promotion drops the user's module overrides
      // and roster-person link (recorded in the audit detail below) instead of leaving
      // dormant rows that would silently reapply on a later demotion.
      const promotingToAdmin = ADMIN_TIER_ROLES.has(role);
      let clearedAccess: { personId: string | null; moduleOverrides: Record<string, string> } | null = null;
      if (promotingToAdmin) {
        const [{ data: personRow, error: personErr }, { data: overrideRows, error: ovErr }] = await Promise.all([
          admin.from("pginvoice_profiles").select("person_id").eq("user_id", targetUserId).maybeSingle(),
          admin.from("pginvoice_user_module_access").select("module_key, scope").eq("user_id", targetUserId),
        ]);
        if (personErr) throw personErr;
        if (ovErr) throw ovErr;
        if (personRow?.person_id || (overrideRows || []).length) {
          clearedAccess = {
            personId: personRow?.person_id || null,
            moduleOverrides: Object.fromEntries((overrideRows || []).map((r: any) => [r.module_key, r.scope])),
          };
        }
        if ((overrideRows || []).length) {
          const { error: delOvErr } = await admin.from("pginvoice_user_module_access").delete().eq("user_id", targetUserId);
          if (delOvErr) throw delOvErr;
        }
      }

      const { error: updErr } = await admin
        .from("pginvoice_profiles")
        .update({
          role, clickup_user_name: clickupUserName || null, updated_at: new Date().toISOString(),
          ...(promotingToAdmin ? { person_id: null } : {}),
        })
        .eq("user_id", targetUserId);
      if (updErr) throw updErr;

      // Only the manual grants are replaced wholesale here -- consultant-source rows were
      // just rebuilt by the profile trigger (role / ClickUp name are always in this update),
      // and capacity_lead rows are left untouched entirely (only sync_capacity_leads owns
      // those), so neither gets wiped out by an unrelated manual edit.
      const { error: delManualErr } = await admin.from("pginvoice_user_clients").delete().eq("user_id", targetUserId).eq("source", "manual");
      if (delManualErr) throw delManualErr;
      // Retired all-time ClickUp-history grants: the migration deleted them, but the previous
      // manage-users could re-add some between the migration and this deploy. Any edit clears them.
      const { error: delClickupErr } = await admin.from("pginvoice_user_clients").delete().eq("user_id", targetUserId).eq("source", "clickup");
      if (delClickupErr) throw delClickupErr;
      if ((role === "consultant" || role === "coordinator") && clients.length) {
        const rows = clients.map((client) => ({ user_id: targetUserId, client, source: "manual" }));
        const { error: insErr } = await admin.from("pginvoice_user_clients").insert(rows);
        if (insErr) throw insErr;
      }

      // Sign out only when the role itself changed: a demoted admin's open browser still holds
      // admin-only data already loaded (wages, roster) that RLS can't take back. A client or
      // ClickUp-name change doesn't sign out -- RLS applies it on the next query and their nav
      // refetches on focus.
      if (targetProfile.role !== role) {
        const signOutError = await revokeSessions(admin, targetUserId);
        if (signOutError) console.error("Couldn't sign the user out after a role change:", signOutError);
      }

      await logAudit("update_role", { userId: targetUserId, email: targetProfile.email }, {
        from: targetProfile.role, to: role, clients, clickupUserName, ...(clearedAccess ? { clearedAccess } : {}),
      });
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (action === "set_access") {
      // Roster person link + per-module overrides for one non-admin user. Body: userId,
      // personId (undefined = unchanged, null = unlink), moduleChanges ({ key: scope | null },
      // null = back to the role default). No forced sign-out: their nav refetches
      // pginvoice_my_access on window focus.
      const targetUserId = typeof body.userId === "string" ? body.userId : "";
      if (!targetUserId) return bad("Missing userId.");
      if (targetUserId === callerUser.user.id) {
        return bad("You can't change your own access — ask another Super Admin or Admin to do it.");
      }

      const { data: targetProfile, error: targetErr } = await admin
        .from("pginvoice_profiles")
        .select("role, email, person_id")
        .eq("user_id", targetUserId)
        .maybeSingle();
      if (targetErr) throw targetErr;
      if (!targetProfile) return bad("User not found.", 404);
      // Lockout guard: admin tier is always full access and can't be overridden.
      if (ADMIN_TIER_ROLES.has(targetProfile.role)) {
        return bad("Admins always have full access — their module access can't be changed.");
      }

      const { data: existingRows, error: existingErr } = await admin
        .from("pginvoice_user_module_access")
        .select("module_key, scope")
        .eq("user_id", targetUserId);
      if (existingErr) throw existingErr;
      const before = {
        personId: targetProfile.person_id || null,
        overrides: Object.fromEntries((existingRows || []).map((r: any) => [r.module_key, r.scope])) as Record<string, string>,
      };

      const resolved = await resolveAccessChange(admin, {
        targetUserId, role: targetProfile.role, config: await loadAccessConfig(admin),
        currentPersonId: before.personId, currentOverrides: before.overrides,
        personIdInput: body.personId, modulesInput: body.moduleChanges,
      });
      if ("error" in resolved) return bad(resolved.error);

      const diff: Record<string, unknown> = accessDiff(before, resolved);

      // viewablePersonIds (optional, the full new list): roster people whose client hours this
      // user may also see in Client Accruals (20261029_viewable_people.sql; the entries policy
      // enforces it). Undefined = unchanged. Never their own person; every id must be on the roster.
      let viewable: { from: string[]; to: string[] } | null = null;
      if (body.viewablePersonIds !== undefined) {
        if (!Array.isArray(body.viewablePersonIds) || body.viewablePersonIds.some((id: unknown) => typeof id !== "string" || !id.trim())) {
          return bad("Invalid viewablePersonIds.");
        }
        const to = [...new Set<string>(body.viewablePersonIds.map((id: string) => id.trim()))].sort();
        if (resolved.personId && to.includes(resolved.personId)) return bad("They already see their own client hours.");
        for (const id of to) {
          if (!(await rosterHasPerson(admin, id))) return bad(`"${id}" isn't on the Consultants roster.`);
        }
        const { data: currentRows, error: currentErr } = await admin.from("pginvoice_user_viewable_people").select("person_id").eq("user_id", targetUserId);
        if (currentErr) throw currentErr;
        const from = (currentRows || []).map((r: any) => r.person_id).sort();
        if (from.join("\u0000") !== to.join("\u0000")) viewable = { from, to };
      }
      if (viewable) diff.viewablePeople = viewable;
      if (!Object.keys(diff).length) {
        return new Response(JSON.stringify({ ok: true, personId: resolved.personId, moduleOverrides: resolved.overrides }), { headers: JSON_HEADERS });
      }

      // Three separate writes (no transaction through PostgREST). Each step's success is
      // recorded so the audit log always says what actually changed, even if a later step
      // fails; the admin can retry, and set_access is idempotent.
      const applied: Record<string, unknown> = {};
      const changedModules = (diff.modules || {}) as Record<string, { from: string | null; to: string | null }>;
      const toClear = Object.keys(changedModules).filter((k) => changedModules[k].to === null);
      const toSet = Object.keys(changedModules).filter((k) => changedModules[k].to !== null);
      const pick = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, changedModules[k]]));
      try {
        if (diff.personId) {
          const { error: personErr } = await admin
            .from("pginvoice_profiles")
            .update({ person_id: resolved.personId, updated_at: new Date().toISOString() })
            .eq("user_id", targetUserId);
          if (personErr) throw friendlyDbError(personErr);
          applied.personId = diff.personId;
        }
        if (toClear.length) {
          const { error: clearErr } = await admin.from("pginvoice_user_module_access").delete().eq("user_id", targetUserId).in("module_key", toClear);
          if (clearErr) throw clearErr;
          applied.modules = pick(toClear);
        }
        if (toSet.length) {
          const now = new Date().toISOString();
          const { error: setErr } = await admin
            .from("pginvoice_user_module_access")
            .upsert(toSet.map((k) => ({ user_id: targetUserId, module_key: k, scope: changedModules[k].to, updated_at: now, updated_by: callerUser.user.id })),
              { onConflict: "user_id,module_key" });
          if (setErr) throw setErr;
          applied.modules = pick([...toClear, ...toSet]);
        }
        if (viewable) {
          const removed = viewable.from.filter((id) => !viewable!.to.includes(id));
          const added = viewable.to.filter((id) => !viewable!.from.includes(id));
          if (removed.length) {
            const { error: delErr } = await admin.from("pginvoice_user_viewable_people").delete().eq("user_id", targetUserId).in("person_id", removed);
            if (delErr) throw delErr;
          }
          if (added.length) {
            const { error: insErr } = await admin.from("pginvoice_user_viewable_people")
              .insert(added.map((person_id) => ({ user_id: targetUserId, person_id, created_by: callerUser.user.id })));
            if (insErr) throw insErr;
          }
          applied.viewablePeople = viewable;
        }
      } catch (writeErr) {
        if (Object.keys(applied).length) {
          await logAudit("set_access", { userId: targetUserId, email: targetProfile.email }, {
            ...applied, partial: true, error: writeErr instanceof Error ? writeErr.message : String(writeErr),
          }).catch(() => {});
        }
        throw writeErr;
      }

      await logAudit("set_access", { userId: targetUserId, email: targetProfile.email }, diff);
      return new Response(JSON.stringify({ ok: true, personId: resolved.personId, moduleOverrides: resolved.overrides }), { headers: JSON_HEADERS });
    }

    if (action === "reset_password") {
      // An admin sets a new temporary password (same as create): the user is signed out
      // everywhere and must choose their own password at next sign-in. The password itself
      // is never written to the audit log.
      const targetUserId = typeof body.userId === "string" ? body.userId : "";
      const { data: targetProfile, error: targetErr } = targetUserId
        ? await admin.from("pginvoice_profiles").select("role, email").eq("user_id", targetUserId).maybeSingle()
        : { data: null, error: null };
      if (targetErr) throw targetErr;
      const decision = passwordResetDecision(
        { callerRole, callerId: callerUser.user.id },
        { targetRole: targetProfile?.role ?? null, targetId: targetUserId },
        body.password,
      );
      if (!decision.ok) return bad(decision.error, decision.status);

      const { error: pwErr } = await admin.auth.admin.updateUserById(targetUserId, { password: body.password });
      if (pwErr) throw pwErr;
      // Password is already changed: still record it even if a follow-up step fails.
      let flagError: string | null = null;
      const { error: flagErr } = await admin
        .from("pginvoice_profiles")
        .update({ must_change_password: true, updated_at: new Date().toISOString() })
        .eq("user_id", targetUserId);
      if (flagErr) flagError = flagErr.message;
      const signOutError = await revokeSessions(admin, targetUserId);

      const problems = { ...(flagError ? { mustChangePasswordError: flagError } : {}), ...(signOutError ? { signOutError } : {}) };
      await logAudit("reset_password", { userId: targetUserId, email: targetProfile!.email }, Object.keys(problems).length ? problems : undefined);
      if (flagError) return bad(`Password was reset, but they won't be asked to change it: ${flagError}`, 500);
      if (signOutError) return bad(`Password was reset, but their existing sessions couldn't be ended: ${signOutError}`, 500);
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (action === "sync_capacity_leads") {
      // Called from CapacityDashboard.jsx whenever the lead on an active project
      // changes -- body.assignments is [{ client, lead }] for active projects
      // only (offboarded ones are omitted by the caller, so their leads' access
      // gets revoked here same as any other no-longer-current assignment).
      const assignments: { client?: unknown; lead?: unknown }[] = Array.isArray(body.assignments) ? body.assignments : [];

      const { data: profiles, error: profilesErr } = await admin
        .from("pginvoice_profiles")
        .select("user_id, clickup_user_name, role")
        .in("role", ["consultant", "coordinator"])
        .not("clickup_user_name", "is", null);
      if (profilesErr) throw profilesErr;

      const desired: { user_id: string; client: string }[] = [];
      for (const a of assignments) {
        const client = typeof a.client === "string" ? a.client : "";
        const lead = typeof a.lead === "string" ? a.lead : "";
        if (!client || !lead || lead.toLowerCase() === "unassigned") continue;
        for (const p of profiles || []) {
          if (namesLikelyMatch(lead, p.clickup_user_name)) desired.push({ user_id: p.user_id, client });
        }
      }

      const { data: existingRows, error: existingErr } = await admin
        .from("pginvoice_user_clients")
        .select("user_id, client")
        .eq("source", "capacity_lead");
      if (existingErr) throw existingErr;

      const desiredKeys = new Set(desired.map((d) => `${d.user_id}::${d.client}`));
      const existingKeys = new Set((existingRows || []).map((r: any) => `${r.user_id}::${r.client}`));
      const toDelete = (existingRows || []).filter((r: any) => !desiredKeys.has(`${r.user_id}::${r.client}`));
      const toInsert = desired.filter((d) => !existingKeys.has(`${d.user_id}::${d.client}`));

      for (const row of toDelete) {
        await admin.from("pginvoice_user_clients").delete().eq("user_id", row.user_id).eq("client", row.client).eq("source", "capacity_lead");
      }
      if (toInsert.length) {
        const { error: insErr } = await admin
          .from("pginvoice_user_clients")
          .insert(toInsert.map((d) => ({ user_id: d.user_id, client: d.client, source: "capacity_lead" })));
        if (insErr) throw insErr;
      }

      return new Response(JSON.stringify({ ok: true, granted: toInsert.length, revoked: toDelete.length }), { headers: JSON_HEADERS });
    }

    if (action === "delete") {
      const targetUserId = body.userId;
      if (!targetUserId) return bad("Missing userId.");
      if (targetUserId === callerUser.user.id) return bad("You can't remove your own account.");

      const { data: targetProfile } = await admin
        .from("pginvoice_profiles")
        .select("role, email")
        .eq("user_id", targetUserId)
        .maybeSingle();

      if (targetProfile?.role === "super_admin") {
        const remaining = await superAdminCount(targetUserId);
        if (remaining === 0) return bad("Can't remove the last Super Admin — promote someone else first.");
      }

      const { error: authDelErr } = await admin.auth.admin.deleteUser(targetUserId);
      if (authDelErr) throw authDelErr;
      // pginvoice_profiles references auth.users(id) ON DELETE CASCADE, and
      // pginvoice_user_clients references pginvoice_profiles(user_id) ON DELETE
      // CASCADE in turn (see the pginvoice_rbac_users migration) -- both rows
      // are cleaned up by the delete above, nothing further to do here.

      await logAudit("delete_user", { userId: targetUserId, email: targetProfile?.email }, { role: targetProfile?.role });
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    return bad("Unknown action.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return bad(message, 400);
  }
});
