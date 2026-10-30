document.getElementById("endpoint").placeholder = document.getElementById("endpoint").placeholder;
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
