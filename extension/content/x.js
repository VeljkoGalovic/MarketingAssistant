/** X adapter (assisted-manual lane; PLAN §2). Extracts tweets from timelines/search. */
window.__registerAdapter({
  platform: "x",
  containerSelector: "main",
  extractPosts(root) {
    const out = [];
    const tweets = root.querySelectorAll("article[data-testid='tweet']");
    for (const tw of tweets) {
      try {
        const textEl = tw.querySelector("[data-testid='tweetText']");
        const body = textEl?.textContent?.trim().slice(0, 600) ?? "";
        if (!body) continue;
        const timeEl = tw.querySelector("time");
        const linkEl = timeEl?.parentElement?.getAttribute("href");
        const url = linkEl ? `https://x.com${linkEl}` : location.href.split("?")[0];
        const externalId = linkEl?.split("/status/")[1] ?? textEl.textContent.slice(0, 60);
        const authorEl = tw.querySelector("[data-testid='User-Name']");
        const author = authorEl?.textContent?.trim().slice(0, 60) ?? "";
        out.push({ externalId: String(externalId), url, title: body.split("\n")[0].slice(0, 150), body, author, subgroup: location.pathname.startsWith("/search") ? location.search.slice(3) : "" });
      } catch {
        continue;
      }
    }
    return out;
  },
});
