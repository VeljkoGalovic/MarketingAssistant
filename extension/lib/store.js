/**
 * IndexedDB store — dedupe/archive ledger (background service worker only).
 * Rows are deduped by externalId inside the extension before they ever reach
 * the scout. Archive pruned at 1000 rows.
 */

const DB_NAME = "lodgetrack-growth";
const STORE = "rows";
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "externalId" });
        store.createIndex("platform", "platform");
        store.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putRow(row) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function hasRow(externalId) {
  const db = await open();
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(externalId);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => resolve(false);
  });
}

export async function countRows(platform) {
  const db = await open();
  return new Promise((resolve) => {
    let n = 0;
    const store = db.transaction(STORE, "readonly").objectStore(STORE);
    const rangeFn = platform ? () => store.index("platform").openCursor(platform) : () => store.openCursor();
    const req = rangeFn();
    req.onsuccess = () => {
      if (req.result) {
        n++;
        req.result.continue();
      } else resolve(n);
    };
    req.onerror = () => resolve(n);
  });
}

export async function prune(keep = 1000) {
  const db = await open();
  const all = [];
  await new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => {
      if (req.result) {
        all.push(req.result.value);
        req.result.continue();
      } else resolve();
    };
  });
  all.sort((a, b) => b.ts - a.ts);
  const toDelete = all.slice(keep);
  if (!toDelete.length) return;
  const tx = db.transaction(STORE, "readwrite");
  for (const r of toDelete) tx.objectStore(STORE).delete(r.externalId);
}
