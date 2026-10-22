// Pure caller-authorization decisions shared by the Edge Functions. No Deno or
// supabase-js imports here, so vitest can import this file directly
// (src/edgeAuthz.test.js); resolving WHO is calling (JWT -> user -> role) lives in
// ./caller.ts.
//
// Why this exists: clickup-key and clickup-sync used to do no caller check at all.
// Their only gate was the platform's verify_jwt, and the app's public anon key is
// itself a valid JWT -- so anyone holding it (i.e. anyone who has loaded the login
// page) could replace the org's ClickUp token or trigger syncs.

export const ADMIN_TIER_ROLES = ["super_admin", "admin"];

export type Caller = {
  // A signed-in user (a real auth.users row), not the anon key.
  authenticated: boolean;
  // That user's pginvoice_profiles role, or null if they have no profile.
  role: string | null;
  // The request carried the x-cron-secret header matching the CRON_SECRET secret.
  cronSecretOk: boolean;
};

export type Policy = { allowCron: boolean; roles: string[] };

export type Decision = { ok: true; via: "cron" | "user" } | { ok: false; status: 401 | 403; error: string };

export function authorize(caller: Caller, policy: Policy): Decision {
  if (policy.allowCron && caller.cronSecretOk) return { ok: true, via: "cron" };
  if (!caller.authenticated) return { ok: false, status: 401, error: "Not signed in." };
  if (!caller.role || !policy.roles.includes(caller.role)) {
    return { ok: false, status: 403, error: "You don't have permission to do this." };
  }
  return { ok: true, via: "user" };
}

// Constant-time string comparison for the cron secret, so response timing doesn't
// leak how many leading characters of a guess were right. An unset/empty secret
// never matches anything.
export function secretsMatch(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// monthOffset from a request body: an integer 0..MAX_MONTH_OFFSET, anything else
// falls back to 0 (the current month). Bounded so a caller can't make the sync
// walk arbitrarily far back.
export const MAX_MONTH_OFFSET = 60;
export function parseMonthOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_MONTH_OFFSET);
}
