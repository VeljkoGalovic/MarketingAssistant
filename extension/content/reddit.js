/** Reddit mirror adapter — fallback/validation lane; JSON poller stays primary (§N/A per plan). */
window.__registerAdapter({
  platform: "reddit",
  containerSelector: "main",
  extractPosts(root) {
    const out = [];
    const posts = root.querySelectorAll("shreddit-post");
    for (const p of posts) {
      try {
        const id = p.getAttribute("id") ?? p.getAttribute("permalink");
        const url = `https://www.reddit.com${p.getAttribute("permalink") ?? ""}`;
        const title = p.getAttribute("post-title") ?? "";
        const author = p.getAttribute("author") ?? "";
        const bodyEl = p.querySelector("div[slot='text-body']");
        const body = bodyEl?.textContent?.trim().slice(0, 1200) ?? title;
        if (!title) continue;
        out.push({ externalId: String(id), url, title, body, author, subreddit: p.getAttribute("subreddit-name") ?? "" });
      } catch {
        continue;
      }
    }
    return out;
  },
});
