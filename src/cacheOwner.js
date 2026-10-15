// Cache isolation per signed-in user. The IndexedDB cache (full ClickUp export, accrued
// sheet) and a few localStorage entries (USER_DATA_LOCAL_KEYS) are not keyed per user, so
// on a shared browser a consultant signing in after an admin would otherwise be shown the
// admin's cached data. Shell.jsx records which user the cache belongs to and wipes it
// before any module mounts when a different user (or an unknown owner) signs in, and on
// explicit sign-out. The same user signing back in keeps their cache.
//
// Storage and the IndexedDB clear are injected so this stays pure and testable.
import { CACHE_OWNER_KEY, USER_DATA_LOCAL_KEYS } from "./storageKeys.js";

// An unrecorded owner (first run after this shipped, or after a sign-out) counts as a
// mismatch: the cache could be anyone's.
export function shouldClearCache(recordedOwner, userId) {
  if (!userId) return false;
  return recordedOwner !== userId;
}

function readOwner(storage) {
  try { return storage.getItem(CACHE_OWNER_KEY); } catch (e) { return null; }
}

// Wipes every user-data cache. Only the listed keys are touched -- never theme/sidebar
// prefs or supabase-js's own "sb-*" auth keys. Rejects if the IndexedDB clear fails.
export async function clearUserCache({ storage, clearIdb }) {
  for (const key of USER_DATA_LOCAL_KEYS) {
    try { storage.removeItem(key); } catch (e) { /* storage disabled: nothing to clear */ }
  }
  await clearIdb();
}

// Called once a session is known, before modules mount. Clears when the cache isn't this
// user's, then records them as owner -- but only if the clear fully succeeded, so a failed
// clear is retried on the next load instead of being marked as done. Returns true if it cleared.
export async function ensureCacheOwner(userId, { storage, clearIdb }) {
  if (!shouldClearCache(readOwner(storage), userId)) return false;
  await clearUserCache({ storage, clearIdb });
  try { storage.setItem(CACHE_OWNER_KEY, userId); } catch (e) { /* ignore */ }
  return true;
}

// Explicit sign-out: forget the owner first (synchronously), so even if the async wipe
// below is interrupted, the next sign-in -- same user or not -- sees an unknown owner and
// clears again before anything mounts.
export async function releaseCacheOwner({ storage, clearIdb }) {
  try { storage.removeItem(CACHE_OWNER_KEY); } catch (e) { /* ignore */ }
  await clearUserCache({ storage, clearIdb });
}
