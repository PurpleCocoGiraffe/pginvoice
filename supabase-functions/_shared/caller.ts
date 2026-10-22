// Resolves who is calling an Edge Function. The decision about whether that caller
// is allowed lives in ./authz.ts (pure, unit-tested).
import { createClient } from "jsr:@supabase/supabase-js@2";
import type { Caller } from "./authz.ts";

// `admin` is a service-role client; the role is read with it (not the caller's own
// JWT) so RLS on pginvoice_profiles can't hide the row and turn a real admin into
// "no role". The user identity itself always comes from auth.getUser(jwt), never
// from anything in the request body.
export async function resolveCaller(req: Request, admin: any): Promise<Caller> {
  const cronSecretOk = await cronSecretMatches(admin, req.headers.get("x-cron-secret"));

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return { authenticated: false, role: null, cronSecretOk };

  // The anon key is a JWT with no user behind it: getUser rejects it, so it
  // resolves to "not signed in" here.
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authClient = createClient(supabaseUrl, anonKey);
  const { data, error } = await authClient.auth.getUser(jwt);
  if (error || !data?.user) return { authenticated: false, role: null, cronSecretOk };

  const { data: profile, error: profileError } = await admin
    .from("pginvoice_profiles")
    .select("role")
    .eq("user_id", data.user.id)
    .maybeSingle();
  // A failed role read must not grant anything -- treat it as "no role" (403).
  if (profileError) console.error("Couldn't read caller's role:", profileError);
  return { authenticated: true, role: profileError ? null : profile?.role ?? null, cronSecretOk };
}

// The cron secret lives only in Vault (pginvoice_cron_secret, generated in the database --
// never in a file, an env var or a chat). pginvoice_cron_secret_ok() compares it there and
// is executable by the service role only. Any error counts as "no match".
async function cronSecretMatches(admin: any, given: string | null): Promise<boolean> {
  if (!given) return false;
  const { data, error } = await admin.rpc("pginvoice_cron_secret_ok", { p_secret: given });
  if (error) {
    console.error("Couldn't check the cron secret:", error);
    return false;
  }
  return data === true;
}
