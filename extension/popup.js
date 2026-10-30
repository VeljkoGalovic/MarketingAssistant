const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: "getStats" }, (stats) => {
  if (!stats) return;
  for (const p of ["linkedin", "x", "facebook", "reddit"]) {
    $(`st-${p}`).textContent = stats[p] ?? 0;
  }
  $("endpoint").value = stats.endpoint ?? "";
  if (!stats.hasToken) {
    $("status").textContent = "⚠ No ingest token set — batches are held locally.";
    $("status").className = "warn";
  }
});

// pause/resume capture for the site in the active tab (Insight-Social parity)
$("toggle").addEventListener("click", async () => {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.url) return;
  const platform = [
    ["linkedin.com", "linkedin"],
    ["x.com", "x"],
    ["twitter.com", "x"],
    ["facebook.com", "facebook"],
    ["reddit.com", "reddit"],
  ].find(([host]) => tab.url.includes(host))?.[1];
  if (!platform) {
    $("status").textContent = "This site isn't covered by an adapter.";
    return;
  }
  chrome.tabs.sendMessage(
    tab.id,
    { type: "toggle", platform },
    (resp) => {
      $("toggle").textContent = resp?.paused ? "▶ Resume this site's capture" : "⏸ Pause this site's capture";
      $("status").textContent = resp?.paused ? `Paused: ${platform}` : `Capturing: ${platform}`;
    }
  );
});

// reflect current pause state on open
chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!tab?.url) return;
  const platform = [
    ["linkedin.com", "linkedin"],
    ["x.com", "x"],
    ["twitter.com", "x"],
    ["facebook.com", "facebook"],
    ["reddit.com", "reddit"],
  ].find(([host]) => tab.url.includes(host))?.[1];
  if (platform) {
    chrome.tabs.sendMessage(tab.id, { type: "getState", platform }, (resp) => {
      $("toggle").textContent = resp?.paused ? "▶ Resume this site's capture" : "⏸ Pause this site's capture";
    });
  }
});

$("save").addEventListener("click", () => {
  const endpoint = $("endpoint").value.trim().replace(/\/$/, "");
  const token = $("token").value.trim();
  chrome.storage.local.set({ endpoint, token }, async () => {
    if (!token) {
      $("status").textContent = "Saved. Without a token rows stay on-device.";
      return;
    }
    try {
      const res = await fetch(`${endpoint}/healthz`);
      $("status").textContent = res.ok ? "✅ Scout reachable — batches will flow." : `⚠ Scout replied ${res.status}`;
    } catch {
      $("status").textContent = "⚠ Scout unreachable — check endpoint/bind.";
    }
  });
});
