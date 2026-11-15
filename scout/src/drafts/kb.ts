import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { addEvent } from "../db.ts";

/**
 * Knowledge base: founder's canonical answers (user seeds 20–30 short markdown
 * files into kb/). Each file: title line + body. Drafts pull the best-matching
 * entries by keyword overlap and stitch them into a founder-voice comment.
 */

export interface KbEntry {
  file: string;
  title: string;
  keywords: string[];
  body: string;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

const STOP = new Set([
  "this","that","with","your","have","from","what","when","will","them","then","there",
  "about","would","could","should","been","were","more","very","just","like","also",
  "into","over","than","some","such","only","here","most","even","much","make","made",
]);

let cache: KbEntry[] | null = null;

export function loadKb(): KbEntry[] {
  if (cache) return cache;
  const entries: KbEntry[] = [];
  try {
    if (!fs.existsSync(config.kb.dir)) return [];
    for (const f of fs.readdirSync(config.kb.dir)) {
      if (!f.endsWith(".md")) continue;
      const raw = fs.readFileSync(path.join(config.kb.dir, f), "utf8");
      const firstLine = raw.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? f;
      const body = raw.split("\n").slice(1).join("\n").trim();
      entries.push({
        file: f,
        title: firstLine,
        keywords: tokenize(`${firstLine} ${body}`),
        body,
      });
    }
  } catch (e) {
    addEvent("error", `kb load: ${String(e)}`);
  }
  cache = entries;
  return entries;
}

export function matchKb(text: string, limit = 2): KbEntry[] {
  const tokens = new Set(tokenize(text));
  const scored = loadKb().map((e) => {
    let overlap = 0;
    for (const k of e.keywords) if (tokens.has(k)) overlap++;
    return { e, overlap };
  });
  return scored
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map((s) => s.e);
}
