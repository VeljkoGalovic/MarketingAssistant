import { config } from "./config.ts";
import type { NewCandidate } from "./db.ts";
import { scoreText } from "./keywords.ts";

const USER_AGENT = `web:LodgeTrackScout:v0.1 (by /u/${config.reddit.username})`;

interface RedditListingChild {
  kind: string; // t3 = post, t1 = comment
  data: {
    id: string;
    title?: string;
    selftext?: string;
    author?: string;
    subreddit?: string;
    over_18?: boolean;
    stickied?: boolean;
    archived?: boolean;
    locked?: boolean;
    permalink?: string;
  };
}

// ---- OAuth (script app) token management ----
// Public JSON needs no auth; OAuth is more reliable and required for posting later.
// Build around accounts: if creds are absent we silently fall back to public JSON.

let token: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  if (!config.reddit.clientId || !config.reddit.clientSecret) return null;
  if (token && token.expiresAt > Date.now() + 60_000) return token.accessToken;

  const basic = Buffer.from(`${config.reddit.clientId}:${config.reddit.clientSecret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`reddit token: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return token.accessToken;
}

interface FetchedPost {
  externalId: string;
  url: string;
  title: string;
  body: string;
  author: string;
  subreddit: string;
}

async function fetchSubredditNew(sub: string, searchQuery: string): Promise<FetchedPost[]> {
  const accessToken = await getAccessToken().catch(() => null);
  const base = accessToken
    ? "https://oauth.reddit.com"
    : "https://www.reddit.com";
  const authHeaders: Record<string, string> = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : {};
  const path = searchQuery
    ? `/r/${sub}/search?q=${encodeURIComponent(searchQuery)}&restrict_sr=1&sort=new&t=day&limit=50`
    : `/r/${sub}/new?limit=100`;
  const suffix = accessToken ? "" : ".json";

  const res = await fetch(`${base}${path}${suffix}&raw_json=1`, {
    headers: { "User-Agent": USER_AGENT, ...authHeaders },
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? 60);
    throw Object.assign(new Error(`reddit 429 for r/${sub}`), { retryAfter: retry * 1000 });
  }
  if (!res.ok) throw new Error(`reddit HTTP ${res.status} for r/${sub}`);
  const j = (await res.json()) as { data: { children: RedditListingChild[] } };

  return j.data.children
    .filter((c) => c.kind === "t3")
    .filter((c) => !c.data.over_18 && !c.data.stickied && !c.data.archived && !c.data.locked)
    .map((c) => ({
      externalId: `t3_${c.data.id}`,
      url: `https://www.reddit.com${c.data.permalink ?? ""}`,
      title: c.data.title ?? "",
      body: c.data.selftext ?? "",
      author: c.data.author ?? "[deleted]",
      subreddit: c.data.subreddit ?? sub,
    }));
}

export interface ScoredCandidate extends NewCandidate {
  id?: number;
}

/** Fetch a single thread by permalink — powers the forward-to-bot draft flow. */
export async function fetchThreadByUrl(url: string): Promise<{
  externalId: string;
  title: string;
  selftext: string;
  author: string;
  subreddit: string;
  permalink: string;
} | null> {
  const m = url.match(/\/comments\/([a-z0-9]+)/i);
  if (!m) return null;
  const accessToken = await getAccessToken().catch(() => null);
  const base = accessToken ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const suffix = accessToken ? "" : ".json";
  const res = await fetch(`${base}/comments/${m[1]}${suffix}?raw_json=1`, {
    headers: { "User-Agent": USER_AGENT, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  });
  if (!res.ok) throw new Error(`reddit thread HTTP ${res.status}`);
  const j = (await res.json()) as Array<{ data: { children: RedditListingChild[] } }>;
  const post = j?.[0]?.data?.children?.find((c) => c.kind === "t3")?.data;
  if (!post) return null;
  return {
    externalId: `t3_${post.id}`,
    title: post.title ?? "",
    selftext: post.selftext ?? "",
    author: post.author ?? "[deleted]",
    subreddit: post.subreddit ?? "",
    permalink: `https://www.reddit.com${post.permalink ?? ""}`,
  };
}


/** Poll one subreddit and return scored, non-duplicate candidates. */
export async function pollSubreddit(
  sub: string,
  banned: Set<string>
): Promise<ScoredCandidate[]> {
  if (banned.has(sub.toLowerCase())) return [];
  const posts = await fetchSubredditNew(sub, config.reddit.searchQuery);
  const out: ScoredCandidate[] = [];
  for (const p of posts) {
    const { score, matched } = scoreText(p.title, p.body);
    if (score < config.reddit.scoreThreshold) continue;
    out.push({
      source: "reddit",
      external_id: p.externalId,
      url: p.url,
      title: p.title,
      body: p.body.slice(0, 2000),
      author: p.author,
      subreddit: p.subreddit,
      matched_keywords: matched.join(","),
      score,
    });
  }
  return out;
}
