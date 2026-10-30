import http from "node:http";
import { config, isDryMode } from "./config.ts";
import {
  addEvent,
  countEventsSince,
  insertCandidate,
  type NewCandidate,
} from "./db.ts";
import { scoreText } from "./keywords.ts";
import { recordExtraction } from "./health.ts";
import { notifyCandidateCard } from "./telegram.ts";

/**
 * /ingest — the extension's landing endpoint (PLAN §7/§12 Phase 4).
 * Token-authed, bound to localhost/LAN/Tailscale by SCOUT_INGEST_BIND,
 * per-token hourly quota, 429 with rate_limited:<seconds> code
 * (mirrors LodgeTrack's auth-guard pattern).
 *
 * Payload (array of rows, from the extension's batcher):
 *   { platform: "linkedin"|"x"|"facebook"|"reddit",
 *     items: [{ externalId, url, title, body, author, subgroup? }] }
 *
 * Empty/invalid token → bind is still local-only by default, but the endpoint
 * refuses to accept rows without the configured token (defense in depth).
 */

interface IngestItem {
  externalId?: string;
  id?: string;
  url: string;
  title: string;
  body?: string;
  author?: string;
  subreddit?: string;
  subgroup?: string;
}

interface IngestPayload {
  platform?: string;
  items?: IngestItem[];
}

export function startIngestServer(): void {
  if (!config.ingest.enabled) {
    addEvent("boot", "ingest disabled by env");
    return;
  }
  if (!config.ingest.token) {
    addEvent("boot", "ingest has no SCOUT_INGEST_TOKEN — refusing to open a port");
    return;
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/healthz/")) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/ingest")) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${config.ingest.token}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // hourly per-token quota → 429 rate_limited:<seconds> (LodgeTrack pattern)
    const inWindow = countEventsSince("ingest", Date.now() - 3600_000);
    if (inWindow >= config.ingest.maxPerHour) {
      const retrySeconds = 3600 - Math.floor((Date.now() % 3600_000) / 1000);
      res.writeHead(429, { "Retry-After": String(retrySeconds) });
      res.end(JSON.stringify({ error: `rate_limited:${retrySeconds}` }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as IngestPayload;
        const n = handleIngestPayload(payload);
        addEvent("ingest", `${n} rows from ${payload.platform ?? "unknown"}`);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, accepted: n }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });

  server.listen(config.ingest.port, config.ingest.bind, () => {
    addEvent("boot", `ingest listening on ${config.ingest.bind}:${config.ingest.port}`);
  });
}

/** Returns number of new candidates accepted. */
function handleIngestPayload(payload: IngestPayload): number {
  const platform = (payload.platform ?? "").toLowerCase();
  if (!platform || !Array.isArray(payload.items)) return 0;
  recordExtraction(platform, payload.items.length);

  let accepted = 0;
  for (const item of payload.items) {
    if (!item.url || !item.title) continue;
    const externalId = item.externalId ?? item.id ?? canonical(item.url).slice(0, 250);
    const { matched, score } = scoreText(item.title, item.body ?? "");
    const candidate: NewCandidate = {
      source: `extension:${platform}`,
      external_id: externalId,
      url: item.url,
      title: item.title,
      body: item.body ?? "",
      author: item.author ?? "",
      subreddit: item.subreddit ?? item.subgroup ?? null,
      matched_keywords: matched.join(","),
      score,
    };
    const inserted = insertCandidate(candidate);
    if (inserted) {
      accepted++;
      void notifyCandidateCard(inserted);
    }
  }
  void isDryMode; // behavior identical: notifyCandidateCard handles dry internally
  return accepted;
}

function canonical(u: string): string {
  try {
    const url = new URL(u);
    return `${url.host.toLowerCase()}${url.pathname}`;
  } catch {
    return u;
  }
}
