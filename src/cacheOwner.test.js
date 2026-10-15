import { describe, it, expect, vi } from "vitest";
import { shouldClearCache, clearUserCache, ensureCacheOwner, releaseCacheOwner } from "./cacheOwner.js";
import { CACHE_OWNER_KEY, USER_DATA_LOCAL_KEYS, NAMEMAP_KEY, VIEWSTATE_KEY, PERF_NOTES_KEY, WAGES_PREFS_KEY, THEME_KEY, COLLAPSE_KEY } from "./storageKeys.js";

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    has: (k) => m.has(k),
  };
}

const AUTH_KEY = "sb-fzvlnzlecchsubkpsmew-auth-token";
function populated(owner) {
  const init = {
    [THEME_KEY]: "dark",
    [COLLAPSE_KEY]: "1",
    [AUTH_KEY]: "{\"access_token\":\"x\"}",
    [NAMEMAP_KEY]: "{}", [VIEWSTATE_KEY]: "{}", [PERF_NOTES_KEY]: "[]", [WAGES_PREFS_KEY]: "{}",
  };
  if (owner) init[CACHE_OWNER_KEY] = owner;
  return fakeStorage(init);
}

describe("shouldClearCache -- whose cache is it", () => {
  it("same user keeps the cache", () => {
    expect(shouldClearCache("user-a", "user-a")).toBe(false);
  });
  it("a different user clears it", () => {
    expect(shouldClearCache("user-a", "user-b")).toBe(true);
  });
  it("an unrecorded owner clears it (could be anyone's)", () => {
    expect(shouldClearCache(null, "user-a")).toBe(true);
  });
  it("no signed-in user never clears", () => {
    expect(shouldClearCache("user-a", null)).toBe(false);
    expect(shouldClearCache(null, undefined)).toBe(false);
  });
});

describe("clearUserCache -- only user data goes", () => {
  it("removes every user-data key and clears IndexedDB, keeps device prefs and the auth session", async () => {
    const s = populated("user-a");
    const clearIdb = vi.fn().mockResolvedValue();
    await clearUserCache({ storage: s, clearIdb });
    expect(clearIdb).toHaveBeenCalledTimes(1);
    for (const k of USER_DATA_LOCAL_KEYS) expect(s.has(k)).toBe(false);
    expect(s.getItem(THEME_KEY)).toBe("dark");
    expect(s.getItem(COLLAPSE_KEY)).toBe("1");
    expect(s.has(AUTH_KEY)).toBe(true);
  });
  it("never lists a supabase auth key or the owner marker as user data", () => {
    expect(USER_DATA_LOCAL_KEYS.some((k) => k.startsWith("sb-"))).toBe(false);
    expect(USER_DATA_LOCAL_KEYS).not.toContain(CACHE_OWNER_KEY);
  });
});

describe("ensureCacheOwner -- runs before modules mount", () => {
  it("same user: no clear, cache kept", async () => {
    const s = populated("user-a");
    const clearIdb = vi.fn().mockResolvedValue();
    expect(await ensureCacheOwner("user-a", { storage: s, clearIdb })).toBe(false);
    expect(clearIdb).not.toHaveBeenCalled();
    expect(s.has(NAMEMAP_KEY)).toBe(true);
  });
  it("different user: clears, then records the new owner", async () => {
    const s = populated("user-a");
    const clearIdb = vi.fn().mockResolvedValue();
    expect(await ensureCacheOwner("user-b", { storage: s, clearIdb })).toBe(true);
    expect(clearIdb).toHaveBeenCalledTimes(1);
    expect(s.has(NAMEMAP_KEY)).toBe(false);
    expect(s.getItem(CACHE_OWNER_KEY)).toBe("user-b");
  });
  it("unknown owner (pre-existing cache): clears and records", async () => {
    const s = populated(null);
    const clearIdb = vi.fn().mockResolvedValue();
    expect(await ensureCacheOwner("user-a", { storage: s, clearIdb })).toBe(true);
    expect(s.getItem(CACHE_OWNER_KEY)).toBe("user-a");
  });
  it("a failed IndexedDB clear doesn't record the new owner, so it's retried next load", async () => {
    const s = populated("user-a");
    const clearIdb = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(ensureCacheOwner("user-b", { storage: s, clearIdb })).rejects.toThrow("boom");
    expect(s.getItem(CACHE_OWNER_KEY)).toBe("user-a");
  });
});

describe("releaseCacheOwner -- explicit sign-out", () => {
  it("forgets the owner before the async wipe, so an interrupted wipe still clears on next sign-in", async () => {
    const s = populated("user-a");
    let ownerDuringWipe;
    const clearIdb = vi.fn(async () => { ownerDuringWipe = s.getItem(CACHE_OWNER_KEY); });
    await releaseCacheOwner({ storage: s, clearIdb });
    expect(ownerDuringWipe).toBe(null);
    expect(s.has(NAMEMAP_KEY)).toBe(false);
    expect(s.getItem(THEME_KEY)).toBe("dark");
    expect(s.has(AUTH_KEY)).toBe(true);
  });
});

describe("storage that throws (disabled/blocked localStorage)", () => {
  const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  it("ensureCacheOwner still wipes IndexedDB and resolves", async () => {
    const clearIdb = vi.fn().mockResolvedValue();
    expect(await ensureCacheOwner("user-a", { storage: throwing, clearIdb })).toBe(true);
    expect(clearIdb).toHaveBeenCalledTimes(1);
  });
  it("releaseCacheOwner still wipes IndexedDB", async () => {
    const clearIdb = vi.fn().mockResolvedValue();
    await releaseCacheOwner({ storage: throwing, clearIdb });
    expect(clearIdb).toHaveBeenCalledTimes(1);
  });
});
