/**
 * Per-lead factual research note (decision #14): ONE cheap Gemini call that
 * turns machine-readable signals (OSM category, city, homepage existence,
 * role-inbox presence) into a 1–2 sentence note the cold-email writer may use.
 * Zero fabrication: the model is told it may ONLY restate what's given — a
 * made-up feature review is worse than no note at all.
 */

import { config } from "../config.ts";
import { addEvent } from "../db.ts";
import { callGoogleNative } from "./provider.ts";

export interface ResearchInput {
  name: string;
  city: string;
  category: string;
  website: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
}

const SYSTEM = `You write ONE factual sentence (max 30 words) describing a small accommodation business for a sales research note.
Only use facts given. NEVER invent amenities, reviews, prices, rankings or history. If the signals are thin, say only what is known:
what kind of place it is, in which city, and whether it lists a website/contact role inbox.
No adjectives of praise, no speculation, no markdown. Output the sentence only.`;

export async function generateResearchNote(inp: ResearchInput): Promise<string | null> {
  const key = config.llm.google.key;
  if (!key) return null;
  const facts = [
    `Name: ${inp.name}`,
    `City: ${inp.city}`,
    `Accommodation type (OSM tag): ${inp.category}`,
    `Homepage listed: ${inp.website ? "yes" : "no"}`,
    `Email reachable: ${inp.hasEmail ? "role inbox found" : "none"}`,
    `Phone listed: ${inp.hasPhone ? "yes" : "no"}`,
  ].join("\n");
  try {
    const out = await callGoogleNative(key, config.llm.google.model, SYSTEM, facts);
    // belt & braces: strip any model scaffolding and length-cap
    const clean = out.replace(/^["']|["']$/g, "").split("\n")[0].trim();
    return clean ? clean.slice(0, 280) : null;
  } catch (e) {
    addEvent("error", `research note ${inp.name.slice(0, 40)}: ${String(e).slice(0, 90)}`);
    return null;
  }
}
