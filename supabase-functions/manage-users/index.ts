// Purple Giraffe — user management (Super Admin / Admin only)
//
// Creating or modifying an auth.users row requires the Supabase service-role
// key, which the browser never holds -- so this function does that step
// server-side. Every action first re-derives the caller's own role from
// pginvoice_profiles (via a second client scoped to their JWT, so RLS applies
// to them) rather than trusting anything the request body claims about who's
// calling, since the body is attacker-controlled input.
import { createClient } from "jsr:@supabase/supabase-js@2";

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

function bad(message: string, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSON_HEADERS });
}

const PAGE_SIZE = 1000; // PostgREST's default row cap per request -- paginate past it

// PostgREST caps a single request at PAGE_SIZE rows regardless of role/RLS --
// several people here have well over 1000 logged entries (Alexander: 6851,
// Vinavie: 4687, Holly: 4644, ...), so an unpaginated select silently missed
// every folder past the first page, which meant this whole feature under-
// assigned clients for exactly the busiest consultants.
async function fetchAllFolders(admin: any, clickupUserName: string): Promise<string[]> {
  const folders = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("pginvoice_clickup_entries")
      .select("folder")
      .ilike("user_name", clickupUserName)
      // Unique order -- without one, pages can skip/duplicate rows between requests.
      .order("entry_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    for (const e of data) if (e.folder) folders.add(e.folder);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return [...folders];
}

// Resolves a ClickUp person's worked folders (all-time, not just recent syncs)
// into real pginvoice_clients client names -- via the two exact-match columns
// that already link a folder to a client (pginvoice_clients.clickup_folder for
// a client's primary folder, pginvoice_cost_centres.folder for every
// sub-project/cost-centre folder rolled into a client). Doesn't chase the
// fuzzy client-side matching nameMatch.js does for edge cases with no direct
// mapping row -- those just won't auto-assign, which is a reasonable scope cut
// (an admin can still tick the client manually) rather than porting that whole
// matcher into this Deno runtime.
async function resolveClickupClients(admin: any, clickupUserName: string): Promise<string[]> {
  const folders = await fetchAllFolders(admin, clickupUserName);
  if (!folders.length) return [];

  const [{ data: directClients, error: dcErr }, { data: costCentres, error: ccErr }] = await Promise.all([
    admin.from("pginvoice_clients").select("client, clickup_folder").in("clickup_folder", folders),
    admin.from("pginvoice_cost_centres").select("client, folder").in("folder", folders),
  ]);
  if (dcErr) throw dcErr;
  if (ccErr) throw ccErr;
  const clients = new Set<string>();
  for (const c of directClients || []) if (c.client) clients.add(c.client);
  for (const c of costCentres || []) if (c.client) clients.add(c.client);
  return [...clients];
}

async function clickupNameExists(admin: any, name: string): Promise<boolean> {
  const { data, error } = await admin.from("pginvoice_clickup_entries").select("user_name").ilike("user_name", name).limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

// Replaces every source='clickup' row for one user with exactly what
// resolveClickupClients currently says -- used both at create time and
// whenever an admin edits a consultant/coordinator's role or ClickUp name.
// Rows with source='manual' or 'capacity_lead' are never touched here.
async function syncClickupClientsForUser(admin: any, userId: string, clickupUserName: string) {
  const clients = await resolveClickupClients(admin, clickupUserName);
  const { error: delErr } = await admin.from("pginvoice_user_clients").delete().eq("user_id", userId).eq("source", "clickup");
  if (delErr) throw delErr;
  if (clients.length) {
    const { error: insErr } = await admin
      .from("pginvoice_user_clients")
      .insert(clients.map((client) => ({ user_id: userId, client, source: "clickup" })));
    if (insErr) throw insErr;
  }
  return clients;
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
      const { data: profiles, error: profilesErr } = await admin
        .from("pginvoice_profiles")
        .select("user_id, role, must_change_password, clickup_user_name");
      if (profilesErr) throw profilesErr;
      const { data: assignments, error: assignErr } = await admin.from("pginvoice_user_clients").select("user_id, client, source");
      if (assignErr) throw assignErr;

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
            clients: clientDetails.map((c) => c.client),
            clientDetails,
            createdAt: u.created_at,
            lastSignInAt: u.last_sign_in_at,
          };
        });
      return new Response(JSON.stringify({ ok: true, users }), { headers: JSON_HEADERS });
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
          .insert({ user_id: newUserId, email, role, must_change_password: true, clickup_user_name: clickupUserName || null });
        if (profileErr) throw profileErr;

        if ((role === "consultant" || role === "coordinator") && clients.length) {
          const rows = clients.map((client) => ({ user_id: newUserId, client, source: "manual" }));
          const { error: assignErr } = await admin.from("pginvoice_user_clients").insert(rows);
          if (assignErr) throw assignErr;
        }
        if (requiresClickup) await syncClickupClientsForUser(admin, newUserId, clickupUserName);
      } catch (setupErr) {
        await admin.auth.admin.deleteUser(newUserId).catch(() => {});
        throw setupErr;
      }

      await logAudit("create_user", { userId: newUserId, email }, { role, clients, clickupUserName });
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

      const { error: updErr } = await admin
        .from("pginvoice_profiles")
        .update({ role, clickup_user_name: clickupUserName || null, updated_at: new Date().toISOString() })
        .eq("user_id", targetUserId);
      if (updErr) throw updErr;

      // Only the manual grants are replaced wholesale here -- clickup-source rows
      // are re-derived below (or cleared if the role/name no longer qualifies),
      // and capacity_lead rows are left untouched entirely (only sync_capacity_leads
      // owns those), so neither gets wiped out by an unrelated manual edit.
      const { error: delManualErr } = await admin.from("pginvoice_user_clients").delete().eq("user_id", targetUserId).eq("source", "manual");
      if (delManualErr) throw delManualErr;
      if ((role === "consultant" || role === "coordinator") && clients.length) {
        const rows = clients.map((client) => ({ user_id: targetUserId, client, source: "manual" }));
        const { error: insErr } = await admin.from("pginvoice_user_clients").insert(rows);
        if (insErr) throw insErr;
      }
      if (requiresClickup) {
        await syncClickupClientsForUser(admin, targetUserId, clickupUserName);
      } else {
        await admin.from("pginvoice_user_clients").delete().eq("user_id", targetUserId).eq("source", "clickup");
      }

      await admin.auth.admin.signOut(targetUserId, "global").catch(() => {});

      await logAudit("update_role", { userId: targetUserId, email: targetProfile.email }, { from: targetProfile.role, to: role, clients, clickupUserName });
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
