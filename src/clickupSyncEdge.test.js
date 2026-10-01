import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The clickup-sync Edge Function runs under Deno (jsr: imports) and can't be imported into
// vitest, so these pin its error handling at the source level: a failed read there used to
// be indistinguishable from an empty result, with destructive consequences (dropped
// departed-user ids; revoked client access).
const src = readFileSync(fileURLToPath(new URL("../supabase-functions/clickup-sync/index.ts", import.meta.url)), "utf8");
const fnBody = (name) => {
  const start = src.indexOf(`async function ${name}`);
  return src.slice(start, src.indexOf("\n}\n", start));
};
const reconcileBlock = src.slice(src.indexOf('.from("pginvoice_profiles")'), src.indexOf("reconcileErr"));

describe("clickup-sync edge function -- read errors are never treated as empty", () => {
  it("unionKnownUserIds throws on a select error instead of treating it as 'no known ids'", () => {
    const body = fnBody("unionKnownUserIds");
    expect(body).toMatch(/const \{ data, error \} = await supabase\.from\("pginvoice_app_state"\)/);
    expect(body).toMatch(/if \(error\) throw/);
  });

  it("access reconciliation checks every read's error and skips (never revokes for) a user on failure", () => {
    for (const name of ["profilesError", "pageError", "clientsError", "costCentresError", "existingRowsError"]) {
      expect(reconcileBlock).toMatch(new RegExp(`if \\(${name}\\) throw ${name}`));
    }
    expect(reconcileBlock).toMatch(/catch \(userErr\)/);
    // The per-user catch must come before the revoke/insert diff could run for the next user.
    expect(reconcileBlock.indexOf("catch (userErr)")).toBeGreaterThan(reconcileBlock.indexOf(".delete()"));
  });

  it("the per-user paged entries select has a unique order", () => {
    expect(reconcileBlock).toMatch(/\.ilike\("user_name", p\.clickup_user_name\)\s*\.order\("entry_id"/);
  });
});
