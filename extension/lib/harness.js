/**
 * Shared adapter harness (content scripts). Read-only, never performs writes.
 * Each platform adapter registers itself via registerAdapter(); the common
 * machinery handles MutationObserver scrolling, scoring, dedupe signalling.
 *
 * ⚠ INVARIANT (PLAN §5): extraction only. No likes/DMs/posts — ever.
 */
window.__registerAdapter = function registerAdapter({ platform, extractPosts, containerSelector }) {
  const seen = new Set();
  let paused = false;

  function send(row) {
    chrome.runtime.sendMessage({ type: "row", row }, () => void chrome.runtime.lastError);
  }

  function scan() {
    if (paused) return;
    const root = document.querySelector(containerSelector) ?? document;
    const posts = extractPosts(root);
    for (const post of posts) {
      const externalId = `${platform}:${post.externalId}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      const { score, matched } = window.__scoreText(post.title, post.body);
      if (score < window.__SCOUT_THRESHOLD) continue;
      send({
        platform,
        externalId: post.externalId,
        url: post.url,
        title: post.title,
        body: post.body,
        author: post.author,
        subgroup: post.subgroup,
        score,
        matched: matched.join(","),
        ts: Date.now(),
      });
    }
  }

  const mo = new MutationObserver(() => {
    // debounce bursts
    mo.__queued = mo.__queued ?? false;
    if (mo.__queued) return;
    mo.__queued = true;
    setTimeout(() => {
      mo.__queued = false;
      scan();
    }, 800);
  });

  function start() {
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
    chrome.runtime.sendMessage({ type: "session", platform }, () => void chrome.runtime.lastError);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "toggle" && msg.platform === platform) {
      paused = !paused;
      chrome.storage.local.set({ [`paused:${platform}`]: paused });
      sendResponse({ paused });
    }
    if (msg?.type === "getState" && msg.platform === platform) {
      sendResponse({ paused });
    }
    return false;
  });

  // pause state persists in chrome.storage (popup-controlled; Insight-Social parity)
  chrome.storage.local.get([`paused:${platform}`], (items) => {
    paused = !!items[`paused:${platform}`];
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  });
};
