/**
 * LinkedIn adapter (Phase 4/5 — blind build per PLAN §2).
 * Extraction points: home feed, saved-search results, group feeds.
 * Stable-ish wrappers with generic role=article fallbacks; fixtures live in
 * extension/fixtures/ for offline regression (PLAN §10 — never debug on the
 * primary account).
 */
window.__registerAdapter({
  platform: "linkedin",
  containerSelector: "main",
  extractPosts(root) {
    const out = [];
    // v1: known LinkedIn post wrappers; fallback: role=article blocks
    const nodes =
      root.querySelectorAll(
        "div.feed-shared-update-v2, div[data-test-id='feed-shared-update-v2'], div[role='article']"
      ) ?? [];
    for (const node of nodes) {
      try {
        const idEl =
          node.querySelector("[data-urn]") ??
          node.querySelector("a[href*='/feed/update/urn:li:activity:']");
        const urn =
          idEl?.getAttribute("data-urn") ??
          idEl?.getAttribute("href")?.match(/activity:(\d+)/)?.[1] ??
          node.textContent?.slice(0, 60);
        if (!urn) continue;

        const linkEl = node.querySelector("a[href*='/feed/update/urn:li:activity']");
        const url = linkEl ? `https://www.linkedin.com${linkEl.getAttribute("href").split("?")[0]}` : location.href.split("?")[0];

        // text: prefer the full post body element
        const bodyEl =
          node.querySelector(".feed-shared-update-v2__commentary .feed-shared-inline-show-more-text") ??
          node.querySelector(".feed-shared-update-v2__commentary") ??
          node.querySelector("[class*='update-components-text']");
        const body = bodyEl?.textContent?.trim().slice(0, 1200) ?? "";
        if (!body || body.length < 40) continue;

        const authorEl = node.querySelector("[data-test-id='feed-shared-actor'] a, .update-components-actor__title span");
        const author = authorEl?.textContent?.trim().slice(0, 80) ?? "";

        const groupEl = node.querySelector("a[href*='/groups/']");
        const subgroup = groupEl?.textContent?.trim() ?? (location.pathname.startsWith("/groups/") ? document.title.slice(0, 50) : "");

        out.push({ externalId: String(urn).slice(0, 120), url, title: body.split("\n")[0].slice(0, 150), body, author, subgroup });
      } catch {
        continue;
      }
    }
    return out;
  },
});
