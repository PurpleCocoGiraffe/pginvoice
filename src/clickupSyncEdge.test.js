import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The clickup-sync Edge Function runs under Deno (jsr: imports) and can't be imported into
// vitest, so these pin its error handling at the source level: a failed read there used to
// be indistinguishable from an empty result, with destructive consequences (dropped
// departed-user ids).
const src = readFileSync(fileURLToPath(new URL("../supabase-functions/clickup-sync/index.ts", import.meta.url)), "utf8");
const fnBody = (name) => {
  const start = src.indexOf(`async function ${name}`);
  return src.slice(start, src.indexOf("\n}\n", start));
};

describe("clickup-sync edge function -- read errors are never treated as empty", () => {
  it("unionKnownUserIds throws on a select error instead of treating it as 'no known ids'", () => {
    const body = fnBody("unionKnownUserIds");
    expect(body).toMatch(/const \{ data, error \} = await supabase\.from\("pginvoice_app_state"\)/);
    expect(body).toMatch(/if \(error\) throw/);
  });

  // It used to rebuild source='clickup' grants (every client a person had EVER logged time on)
  // on every run, re-granting that history to all 13 consultants 2 minutes after they were
  // created. Client access comes from the Clients module's Consultant field (database triggers).
  it("never grants or revokes client access", () => {
    expect(src).not.toMatch(/pginvoice_user_clients/);
  });
});
