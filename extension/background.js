/* --- inlined local store (works in Chrome service workers AND Firefox background scripts) --- */
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

async function putRow(row) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(row);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function hasRow(externalId) {
  const db = await open();
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(externalId);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => resolve(false);
  });
}

async function countRows(platform) {
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

async function prune(keep = 1000) {
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


/**
 * Background service worker — batching, dedupe, /ingest client, canary counters.
 * Dedupe here (store.js) AND scout-side (UNIQUE source/external_id) — belt & braces.
 */

const BATCH_LIMIT = 25;
const RESET_EMPTY_LIMIT = 2000;
let pending = [];
let pausedUntilFlush = false;
let sessionsSinceFlush = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["endpoint", "token"], (s) => {
    if (!s.endpoint) {
      chrome.storage.local.set({
        endpoint: "http://127.0.0.1:8787",
        token: "",
      });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "row") {
      const row = msg.row;
      await pipeline(row);
    } else if (msg?.type === "getStats") {
      const [linkedin, x, facebook, reddit] = await Promise.all(
        ["linkedin", "x", "facebook", "reddit"].map((p) => countRows(p))
      );
      const settings = await new Promise((r) => chrome.storage.local.get(["endpoint", "token"], r));
      sendResponse({ linkedin, x, facebook, reddit, endpoint: settings.endpoint, hasToken: !!settings.token });
    } else if (msg?.type === "session") {
      sessionsSinceFlush.add(msg.platform);
    } else if (msg?.type === "toggle") {
      // answered by content script directly
    } else if (msg?.type === "purge") {
      await prune(0);
      sendResponse({ purged: true });
    }
  })();
  return true; // async sendResponse
});

async function pipeline(row) {
  const externalId = `${row.platform}:row:${row.externalId}`;
  if (await hasRow(externalId)) return;
  await putRow({
    externalId,
    ts: row.ts,
    platform: row.platform,
    url: row.url,
    title: row.title,
    body: row.body,
    author: row.author,
    subgroup: row.subgroup,
    score: row.score,
    matched: row.matched,
  });
  pending.push(row);
  if (pending.length >= BATCH_LIMIT) await flush();
  await prune(RESET_EMPTY_LIMIT);
}

async function flush() {
  if (pausedUntilFlush || !pending.length) return;
  const { endpoint, token } = await new Promise((r) => chrome.storage.local.get(["endpoint", "token"], r));
  if (!endpoint) return;
  if (!token) {
    pausedUntilFlush = true;
    badge("!");
    return;
  }
  // group by platform (scout /ingest contract)
  const byPlatform = {};
  for (const row of pending) {
    (byPlatform[row.platform] ??= []).push({
      externalId: row.externalId,
      url: row.url,
      title: row.title,
      body: row.body,
      author: row.author,
      subgroup: row.subgroup,
      matched: row.matched,
      score: row.score,
    });
  }
  let allOk = true;
  for (const [platform, items] of Object.entries(byPlatform)) {
    try {
      const res = await fetch(`${endpoint}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ platform, items }),
      });
      if (res.status === 401) {
        pausedUntilFlush = true;
        badge("!");
        allOk = false;
        break;
      }
      if (!res.ok) allOk = false; // keep rows until next attempt
    } catch {
      allOk = false; // scout offline: rows stay queued until next flush
    }
  }
  if (allOk) {
    pending = [];
    badge("");
  }
  pausedUntilFlush = false;
}

function badge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: text ? "#b91c1c" : "#0f766e" });
}

chrome.alarms.create("flush", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "flush") void flush();
});
