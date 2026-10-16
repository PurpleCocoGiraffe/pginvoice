// Purple Giraffe — role vocabulary. Plain data (no Supabase import) so pure modules like
// permissions.js can use it; usersSync.js re-exports it for existing callers.
export const ROLES = ["super_admin", "admin", "consultant", "coordinator"];
export const ROLE_LABELS = {
  super_admin: "Super Admin",
  admin: "Admin",
  consultant: "Consultant",
  coordinator: "Coordinator",
};
// Roles scoped to only their assigned clients, rather than the whole client base.
export const CLIENT_SCOPED_ROLES = new Set(["consultant", "coordinator"]);
// Always full access; per-user module overrides never apply (so they can't be locked out).
export const ADMIN_TIER_ROLES = new Set(["super_admin", "admin"]);
// These two need a linked ClickUp identity -- it's how their client access
// mostly gets derived. Admin-tier roles see everything regardless, so it's
// optional for them.
export const CLICKUP_REQUIRED_ROLES = new Set(["consultant", "coordinator"]);
export const CLIENT_SOURCE_LABELS = { manual: "manual", clickup: "via ClickUp", capacity_lead: "via Capacity lead" };
