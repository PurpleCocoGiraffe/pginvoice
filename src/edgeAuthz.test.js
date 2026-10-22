import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authorize, secretsMatch, parseMonthOffset, MAX_MONTH_OFFSET } from "../supabase-functions/_shared/authz.ts";

// clickup-key and clickup-sync used to do no caller check: the app's public anon key is a
// valid JWT, so platform verify_jwt alone let anyone replace the ClickUp token or run syncs.

const anon = { authenticated: false, role: null, cronSecretOk: false };
const user = (role) => ({ authenticated: true, role, cronSecretOk: false });
const KEY_POLICY = { allowCron: false, roles: ["super_admin"] };
const SYNC_POLICY = { allowCron: true, roles: ["super_admin", "admin"] };

describe("authorize", () => {
  it("clickup-key: only a super_admin gets through", () => {
    expect(authorize(anon, KEY_POLICY)).toEqual({ ok: false, status: 401, error: "Not signed in." });
    for (const role of ["admin", "consultant", "coordinator", null, "made_up"]) {
      expect(authorize(user(role), KEY_POLICY)).toMatchObject({ ok: false, status: 403 });
    }
    expect(authorize(user("super_admin"), KEY_POLICY)).toEqual({ ok: true, via: "user" });
  });

  it("clickup-key: a cron secret is not enough", () => {
    expect(authorize({ ...anon, cronSecretOk: true }, KEY_POLICY)).toMatchObject({ ok: false, status: 401 });
  });

  it("clickup-sync: cron secret or an admin-tier user", () => {
    expect(authorize({ ...anon, cronSecretOk: true }, SYNC_POLICY)).toEqual({ ok: true, via: "cron" });
    expect(authorize(user("super_admin"), SYNC_POLICY)).toEqual({ ok: true, via: "user" });
    expect(authorize(user("admin"), SYNC_POLICY)).toEqual({ ok: true, via: "user" });
    expect(authorize(anon, SYNC_POLICY)).toMatchObject({ ok: false, status: 401 });
    expect(authorize(user("consultant"), SYNC_POLICY)).toMatchObject({ ok: false, status: 403 });
    expect(authorize(user("coordinator"), SYNC_POLICY)).toMatchObject({ ok: false, status: 403 });
    expect(authorize(user(null), SYNC_POLICY)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("secretsMatch", () => {
  it("matches only an identical, non-empty secret", () => {
    expect(secretsMatch("abc123", "abc123")).toBe(true);
    expect(secretsMatch("abc124", "abc123")).toBe(false);
    expect(secretsMatch("abc12", "abc123")).toBe(false);
    expect(secretsMatch("abc1234", "abc123")).toBe(false);
  });
  it("an unset secret never matches, even an empty header", () => {
    expect(secretsMatch("", "")).toBe(false);
    expect(secretsMatch(null, undefined)).toBe(false);
    expect(secretsMatch("anything", undefined)).toBe(false);
    expect(secretsMatch(undefined, "abc")).toBe(false);
  });
});

describe("parseMonthOffset", () => {
  it("accepts non-negative numbers, floored and capped", () => {
    expect(parseMonthOffset(0)).toBe(0);
    expect(parseMonthOffset(1)).toBe(1);
    expect(parseMonthOffset(2.9)).toBe(2);
    expect(parseMonthOffset(10_000)).toBe(MAX_MONTH_OFFSET);
  });
  it("anything else means the current month", () => {
    for (const v of [undefined, null, -1, "3", NaN, Infinity, {}]) expect(parseMonthOffset(v)).toBe(0);
  });
});

// Source-level pins (Deno files can't be imported here): the check must run before either
// function reads the stored token, touches ClickUp, or writes anything.
const read = (fn) => readFileSync(fileURLToPath(new URL(`../supabase-functions/${fn}/index.ts`, import.meta.url)), "utf8");

describe("edge functions authorize before doing anything", () => {
  it("clickup-key: super_admin only, checked before the body is read", () => {
    const src = read("clickup-key");
    const check = src.indexOf('authorize(await resolveCaller(req, supabase), { allowCron: false, roles: ["super_admin"] })');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf("await req.json()"));
    expect(check).toBeLessThan(src.indexOf('from("pginvoice_secrets")'));
    expect(src).toMatch(/if \(!decision\.ok\) return new Response/);
    // ClickUp's raw error body is no longer echoed to the caller.
    expect(src).not.toMatch(/res\.text\(\)/);
  });

  it("clickup-sync: cron or admin tier, checked before the stored token is read", () => {
    const src = read("clickup-sync");
    const check = src.indexOf('authorize(await resolveCaller(req, supabase), { allowCron: true, roles: ["super_admin", "admin"] })');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(src.indexOf('from("pginvoice_secrets")'));
    expect(check).toBeLessThan(src.indexOf("await req.json()"));
    expect(src).toMatch(/if \(!decision\.ok\) return new Response/);
    expect(src).toMatch(/monthOffset = parseMonthOffset\(body\?\.monthOffset\)/);
    // The raw ClickUp time entry (email, task, description) is no longer returned.
    expect(src).not.toMatch(/raw_sample|rawSample/);
  });
});
