/** Facebook groups adapter (user joins groups manually first — PLAN §3 gap 5). */
window.__registerAdapter({
  platform: "facebook",
  containerSelector: "div[role='feed'], main",
  extractPosts(root) {
    const out = [];
    const posts = root.querySelectorAll("div[role='article']");
    for (const p of posts) {
      try {
        const textEl =
          p.querySelector("[data-ad-comet-preview='message']") ??
          p.querySelector("[data-testid='post_message']") ??
          p.querySelector("div[style*='text-direction'] > span");
        const body = textEl?.textContent?.trim().slice(0, 1200) ?? "";
        if (!body || body.length < 40) continue;
        const linkEl = p.querySelector("a[href*='/posts/'], a[href*='/groups/']");
        const externalId =
          linkEl?.getAttribute("href")?.match(/posts(?:\/(?:permalink\/)?)?\/?(\d+)/)?.[1] ??
          body.slice(0, 60);
        const url = linkEl ? new URL(linkEl.getAttribute("href"), location.origin).toString() : location.href.split("?")[0];
        // author: the first profile link usually
        const authorEl = p.querySelector("a[href*='/user/'], a[href*='/profile.php']");
        const author = authorEl?.textContent?.trim().slice(0, 80) ?? "";
        const groupName = document.title.split("|")[0].trim().slice(0, 60);
        out.push({ externalId: String(externalId), url, title: body.split("\n")[0].slice(0, 150), body, author, subgroup: location.pathname.startsWith("/groups/") ? groupName : "" });
      } catch {
        continue;
      }
    }
    return out;
  },
});
