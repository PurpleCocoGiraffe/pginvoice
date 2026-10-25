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
  // The request carried the x-cron-secret header matching Vault's pginvoice_cron_secret.
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

// monthOffset from a request body: an integer 0..MAX_MONTH_OFFSET, anything else
// falls back to 0 (the current month). Bounded so a caller can't make the sync
// walk arbitrarily far back.
export const MAX_MONTH_OFFSET = 60;
export function parseMonthOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_MONTH_OFFSET);
}

// manage-users reset_password: may this admin-tier caller set a new temporary password for
// the target? Never your own (use the normal password change), and only a Super Admin may
// reset a Super Admin's -- otherwise an Admin could take over a Super Admin account.
export const MIN_PASSWORD_LENGTH = 8;
export function passwordResetDecision(
  { callerRole, callerId }: { callerRole: string | null; callerId: string },
  { targetRole, targetId }: { targetRole: string | null; targetId: string },
  password: unknown,
): { ok: true } | { ok: false; status: 400 | 403 | 404; error: string } {
  if (!callerRole || !ADMIN_TIER_ROLES.includes(callerRole)) {
    return { ok: false, status: 403, error: "You don't have permission to manage users." };
  }
  if (!targetId) return { ok: false, status: 400, error: "Missing userId." };
  if (targetId === callerId) {
    return { ok: false, status: 400, error: "You can't reset your own password here — sign out and use your normal password change." };
  }
  if (!targetRole) return { ok: false, status: 404, error: "User not found." };
  if (targetRole === "super_admin" && callerRole !== "super_admin") {
    return { ok: false, status: 403, error: "Only a Super Admin can reset a Super Admin's password." };
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  return { ok: true };
}
