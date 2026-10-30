import { config } from "../config.ts";
import { addEvent } from "../db.ts";
import { matchKb, type KbEntry } from "./kb.ts";

/**
 * Draft provider abstraction — OpenAI-compatible chain:
 *   Google AI Studio (free tier) → Groq (free tier) → Cloudflare Workers AI (free tier)
 *   → deterministic KB fallback (always local, no network).
 *
 * All three providers speak the `chat/completions` shape; only URL/auth differ.
 * Free-tier friendly: small max_tokens, single shot, no retries that spam quota
 * (one failure → fall to next provider immediately).
 */

const FOUNDER_VOICE = `You are Veljko, the founder of LodgeTrack — a property-management platform for small hotels, guest houses and vacation-rental hosts. You write Reddit/social comments that are:
- short (60–120 words), casual, human; no hype, no marketing-speak
- started as genuine answers to the person's actual problem first (help without selling)
- you may mention LodgeTrack only if it directly addresses their problem — one line, e.g. "I ran into this, which is why I ended up building LodgeTrack"
- never claim prices/features you don't know; never invent numbers
- respect platform norms: no links unless clearly useful; no "sign up" call-to-action
Return ONLY the comment text — no preamble, no quotes.`;

export interface DraftRequest {
  platform: "reddit" | "linkedin" | "x" | "facebook" | "manual";
  title: string;
  body?: string;
  authorHint?: string;
}

export interface DraftResult {
  text: string;
  provider: string;
}

/** Deterministic tone-lint — the "humanizer" idea stolen from the tools we evaluated
 * (2026-10-31): flags AI-writing tells / hype *before* a draft is shown. No model call. */
const LINT_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bgame[- ]?changer\b/i, why: "hype: game-changer" },
  { re: /\brevolutionar/i, why: "hype: revolutionary" },
  { re: /\bdisrupt\w*\b/i, why: "hype: disrupt" },
  { re: /\bseamless(ly)?\b/i, why: "AI-tell: seamless" },
  { re: /\beffortless(ly)?\b/i, why: "AI-tell: effortless" },
  { re: /\bunparallel\w*\b/i, why: "hype: unparalleled" },
  { re: /\bthe best (tool|platform|software)\b/i, why: "hype: 'the best ___'" },
  { re: /\bdeliver\w* (value|results)\b/i, why: "corporate-speak" },
  { re: /!{2,}/, why: "shouting: repeated '!'" },
  { re: /\b[A-Z]{4,}\b(?! [A-Z]{4,})/, why: "ALL-CAPS word" },
  { re: /\bI'?m (an|just an) AI\b/i, why: "never admit automation" },
  { re: /—/, why: "em-dash (classic AI tell)" },
];

export function lintDraft(text: string): string[] {
  return LINT_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.why);
}

function kbToText(entries: KbEntry[]): string {
  return entries.map((e) => `### ${e.title}\n${e.body}`).join("\n\n");
}

async function callOpenAiCompat(
  url: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm HTTP ${res.status} at ${url}`);
  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    result?: { response?: string }; // cloudflare native shape
  };
  const text = j.choices?.[0]?.message?.content ?? j.result?.response ?? "";
  const trimmed = text.trim();
  if (!trimmed) throw new Error("llm empty completion");
  return trimmed;
}

function providerUserPrompt(req: DraftRequest, kb: KbEntry[]): string {
  const kbBlock = kb.length ? `\n\nRelevant knowledge base snippets (facts you may reuse verbatim, simplified):\n${kbToText(kb)}` : "";
  const platformNote =
    req.platform === "reddit"
      ? "This is a Reddit comment — plain text, markdown allowed sparingly."
      : req.platform === "linkedin"
      ? "This is a LinkedIn comment — professional, still human."
      : req.platform === "x"
      ? "This is an X reply — keep it under 250 characters."
      : "This is a Facebook group comment — conversational.";
  return `Context: thread title: "${req.title}"
Body: "${(req.body ?? "").slice(0, 1200)}"
Author: ${req.authorHint ?? "unknown"} — ${platformNote}${kbBlock}`;
}

export async function generateDraft(req: DraftRequest): Promise<DraftResult> {
  const kb = matchKb(`${req.title} ${req.body ?? ""}`);
  const userPrompt = providerUserPrompt(req, kb);

  const chain: Array<{ name: string; run: () => Promise<string> }> = [];

  if (config.llm.google.key) {
    chain.push({
      name: `google:${config.llm.google.model}`,
      run: () =>
        callOpenAiCompat(
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
          config.llm.google.key,
          config.llm.google.model,
          FOUNDER_VOICE,
          userPrompt
        ),
    });
  }
  if (config.llm.groq.key) {
    chain.push({
      name: `groq:${config.llm.groq.model}`,
      run: () =>
        callOpenAiCompat(
          "https://api.groq.com/openai/v1/chat/completions",
          config.llm.groq.key,
          config.llm.groq.model,
          FOUNDER_VOICE,
          userPrompt
        ),
    });
  }
  if (config.llm.cloudflare.accountId && config.llm.cloudflare.apiToken) {
    chain.push({
      name: `cloudflare:${config.llm.cloudflare.model}`,
      run: () =>
        callOpenAiCompat(
          `https://api.cloudflare.com/client/v4/accounts/${config.llm.cloudflare.accountId}/ai/v1/chat/completions`,
          config.llm.cloudflare.apiToken,
          config.llm.cloudflare.model,
          FOUNDER_VOICE,
          userPrompt
        ),
    });
  }

  for (const p of chain) {
    try {
      const text = await p.run();
      return { text, provider: p.name };
    } catch (e) {
      addEvent("error", `draft provider ${p.name}: ${String(e)}`);
    }
  }

  return { text: kbFallbackDraft(req, kb), provider: "kb-fallback" };
}

/** Deterministic, no-network draft. Never invents product claims. */
export function kbFallbackDraft(req: DraftRequest, kb?: KbEntry[]): string {
  const entries = kb ?? matchKb(`${req.title} ${req.body ?? ""}`);
  const topic = req.title.replace(/\?+$/, "");
  if (entries.length) {
    const main = entries[0];
    return `Hey — ${topic.toLowerCase()} is a common pain point. Quick thoughts:\n\n${main.body
      .split("\n")
      .slice(0, 4)
      .join("\n")}\n\nI run LodgeTrack (I'm the founder — built it after dealing with this exact mess myself), so happy to answer specifics if useful.`;
  }
  return `Hey — saw your post about ${topic.toLowerCase()}. I've been through this myself and ended up building LodgeTrack for guests/houses like yours. Before recommending anything specific: what's the part that hurts most right now — calendars/pricing, cleaners, or guest messaging? Usually the fix differs a lot depending on which of those it actually is.`;
}
