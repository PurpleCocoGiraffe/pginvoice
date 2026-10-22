// Purple Giraffe — ClickUp API key management
//
// Lets Settings save a ClickUp personal API token from the browser instead of
// requiring a Supabase dashboard visit to update the CLICKUP_API_TOKEN Edge
// Function secret. The token is validated against ClickUp's own API before
// being persisted, and is stored in pginvoice_secrets — a table with RLS
// enabled and no policies, so it's reachable only via the service role used
// here, never by the anon key the frontend otherwise uses. The raw token is
// never sent back to the client after being saved; only a masked preview and
// the connected workspace name are returned.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authorize } from "../_shared/authz.ts";
import { resolveCaller } from "../_shared/caller.ts";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const SECRET_KEY = "clickup_api_token";

// Called from the browser (Settings), unlike clickup-sync which only ever runs
// from cron/manual-invoke server-side — so unlike that function, this one needs
// real CORS headers or the browser silently drops the response before
// supabase-js ever sees it, surfacing as "Failed to send a request to the Edge
// Function" with no further detail.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };

function maskToken(token: string) {
  if (token.length <= 4) return "****";
  return `••••${token.slice(-4)}`;
}

async function validateToken(token: string) {
  const res = await fetch(`${CLICKUP_BASE}/team`, { headers: { Authorization: token } });
  if (!res.ok) {
    // Status only: ClickUp's raw error body isn't echoed back to the browser.
    throw new Error(`ClickUp rejected this key (HTTP ${res.status}). Check it was copied in full and belongs to the Purple Giraffe workspace.`);
  }
  const data = await res.json();
  const teams = data.teams || [];
  if (!teams.length) throw new Error("ClickUp accepted this key, but it isn't a member of any workspace.");
  return teams.map((t: any) => t.name).filter(Boolean);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Super Admin only -- both actions. Replacing this token redirects every scheduled
  // sync, and even `status` reveals the masked token and workspace names. Settings is
  // the only caller and is itself Super Admin only, but that nav filter is cosmetic.
  const decision = authorize(await resolveCaller(req, supabase), { allowCron: false, roles: ["super_admin"] });
  if (!decision.ok) return new Response(JSON.stringify({ ok: false, error: decision.error }), { status: decision.status, headers: JSON_HEADERS });

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* default to status check below */ }
  const action = body?.action === "set" ? "set" : "status";

  try {
    if (action === "set") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) return new Response(JSON.stringify({ ok: false, error: "No API key provided." }), { status: 400, headers: JSON_HEADERS });

      const workspaceNames = await validateToken(token);
      const { error } = await supabase.from("pginvoice_secrets").upsert({
        key: SECRET_KEY, value: token,
        meta: { masked: maskToken(token), workspaces: workspaceNames, validated_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
      if (error) throw error;

      return new Response(JSON.stringify({ ok: true, masked: maskToken(token), workspaces: workspaceNames }), { headers: JSON_HEADERS });
    }

    // action === "status" — report whether a key is stored and whether it still
    // validates, without ever returning the token itself.
    const { data, error } = await supabase.from("pginvoice_secrets").select("meta, updated_at").eq("key", SECRET_KEY).maybeSingle();
    if (error) throw error;
    if (!data) return new Response(JSON.stringify({ ok: true, connected: false }), { headers: JSON_HEADERS });

    return new Response(JSON.stringify({
      ok: true, connected: true,
      masked: data.meta?.masked ?? null,
      workspaces: data.meta?.workspaces ?? [],
      validatedAt: data.meta?.validated_at ?? data.updated_at,
    }), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 400, headers: JSON_HEADERS });
  }
});
