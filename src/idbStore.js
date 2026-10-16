// Minimal IndexedDB key-value helper. Client Invoicing's parsed ClickUp export
// can run several MB as JSON (18k+ rows isn't unusual for a full org export) —
// too close to localStorage's ~5-10MB per-origin quota to risk sharing it with
// everything else the app already stores there. IndexedDB has no such practical
// ceiling for data this size, so the two large datasets live here; small settings
// (filters, name matches) still use localStorage elsewhere.
const DB_NAME = "pg-invoice-store";
const STORE = "kv";
// Fired on window after a value is written, so another mounted module (e.g. Capacity
// Planning reading the same ClickUp data Client Invoicing just saved) can react live
// instead of only picking up changes on its own next mount.
export const PG_DATA_EVENT = "pg-idb-updated";

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("indexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return undefined; }
}

export async function idbSet(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PG_DATA_EVENT, { detail: { key } }));
  } catch (e) { /* ignore — persistence is best-effort */ }
}

export async function idbDel(key) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* ignore */ }
}

// Empties the whole store (cache isolation on user change / sign-out, see cacheOwner.js).
// Unlike the helpers above this rejects on failure, so the caller knows the previous
// user's data may still be there. No IndexedDB at all means nothing is cached: resolves.
export async function idbClear() {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
