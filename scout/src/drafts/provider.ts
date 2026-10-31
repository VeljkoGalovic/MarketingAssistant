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
Hard style bans:
- NEVER restate or paraphrase the person's question, and NEVER open by classifying it ("that's a common pain point", "great question", "totally understandable"). Start straight inside the answer: one concrete detail, your own experience, or a plain fact.
- NEVER use markdown: no bold, no asterisks, no headings, no bullet lists. Flowing sentences only, like you'd type to a friend.
- NEVER use em-dashes or long parentheses cliffs; ordinary commas and periods.
- NEVER end with filler ("hope this helps", "let me know if you have questions").
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
  { re: /\*\*[^*\n]{2,60}\*\*/, why: "markdown: bold markup" },
  { re: /\bpain point\b/i, why: "AI-tell: 'pain point'" },
  { re: /\bgreat (question|post|point|topic)\b/i, why: "AI-tell: validation opener" },
  { re: /\btotally understand(able)?\b/i, why: "AI-tell: empty reassurance" },
  { re: /\bhope this helps\b/i, why: "AI-tell: filler closer" },
  { re: /^\s*(great|awesome|good)\s+(one|one here)\b/i, why: "AI-tell: hollow opener" },
];

/** Mechanical pre-polish runs BEFORE lint: fixes what can be fixed without
 * regenerating. Bold/heading markup stripped, em/en dashes → commas, quotes
 * removed, whitespace collapsed. */
export function sanitizeDraft(text: string): string {
  let t = text.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("\u201c") && t.endsWith("\u201d"))
  ) {
    t = t.slice(1, -1);
  }
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1"); // bold
  t = t.replace(/\*([^*\n]+)\*/g, "$1"); // italics
  t = t.replace(/^\s*#{1,6}\s+/gm, ""); // headings
  t = t.replace(/[—–]/g, ",");
  t = t.replace(/,(\s*,)+/g, ",");
  t = t.replace(/\s{2,}/g, " ");
  return t.trim();
}

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
    signal: AbortSignal.timeout(45_000),
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

/** Google's OpenAI-compat path 404s on the AQ.-format keys (verified 2026-10-31),
 * so we speak the native generateContent shape. thinkingBudget:0 — 3.x thinks by
 * default and eats the output budget mid-sentence (observed 2026-10-31). */
async function callGoogleNative(
  apiKey: string,
  model: string,
  system: string,
  user: string
): Promise<string> {
  const call = async (): Promise<Response> =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 600,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

  let res = await call();
  if (res.status === 503 || res.status === 429) {
    await new Promise((r) => setTimeout(r, 2_500)); // fast-fail overload → one cheap retry
    res = await call();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`google HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const j = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text =
    j.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? "";
  if (!text) throw new Error("google empty completion");
  return text;
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

  const chain: Array<{ name: string; run: (system: string, user: string) => Promise<string> }> = [];

  if (config.llm.google.key) {
    chain.push({
      name: `google:${config.llm.google.model}`,
      run: (system, user) => {
        // capacity flakes on hot models (3.8-flash 503/timeouts 2026-10-31): configured
        // model first, then hardcoded same-family fallbacks, first success wins.
        const models = [config.llm.google.model, "gemini-3.1-flash-lite", "gemini-3-flash-preview"];
        let lastErr: unknown;
        for (const m of new Set(models)) {
          try {
            return callGoogleNative(config.llm.google.key, m, system, user);
          } catch (e) {
            lastErr = e;
            addEvent("error", `draft google model ${m}: ${String(e).slice(0, 120)}`);
          }
        }
        throw lastErr;
      },
    });
  }
  if (config.llm.groq.key) {
    chain.push({
      name: `groq:${config.llm.groq.model}`,
      run: (system, user) =>
        callOpenAiCompat("https://api.groq.com/openai/v1/chat/completions", config.llm.groq.key, config.llm.groq.model, system, user),
    });
  }
  if (config.llm.cloudflare.accountId && config.llm.cloudflare.apiToken) {
    chain.push({
      name: `cloudflare:${config.llm.cloudflare.model}`,
      run: (system, user) =>
        callOpenAiCompat(
          `https://api.cloudflare.com/client/v4/accounts/${config.llm.cloudflare.accountId}/ai/v1/chat/completions`,
          config.llm.cloudflare.apiToken,
          config.llm.cloudflare.model,
          system,
          user
        ),
    });
  }

  for (const p of chain) {
    try {
      const text = sanitizeDraft(await p.run(FOUNDER_VOICE, userPrompt));
      let lint = lintDraft(text);
      let final = text;
      // one rewrite pass if tells survived the prompt (2026-10-31: recap drafts had them)
      if (lint.length) {
        try {
          const rewritten = sanitizeDraft(
            await p.run(
              FOUNDER_VOICE,
              `${userPrompt}\n\nThis is a REWRITE pass. Previous attempt: "${text}". Fix exactly these issues: ${lint.join("; ")}. Also: never restate the asker's question as an opener, start inside the actual answer. Return ONLY the fixed comment text.`
            )
          );
          const lint2 = lintDraft(rewritten);
          if (rewritten && lint2.length < lint.length) {
            final = rewritten;
            lint = lint2;
          }
        } catch {
          /* rewrite optional */
        }
      }
      if (lint.length) {
        addEvent("draft", `lint survives on ${p.name}: ${lint.join("; ")}`);
      }
      return { text: final, provider: p.name };
    } catch (e) {
      addEvent("error", `draft provider ${p.name}: ${String(e)}`);
    }
  }

  return { text: sanitizeDraft(kbFallbackDraft(req, kb)), provider: "kb-fallback" };
}

/** Deterministic, no-network draft. Never invents product claims. */
export function kbFallbackDraft(req: DraftRequest, kb?: KbEntry[]): string {
  const entries = kb ?? matchKb(`${req.title} ${req.body ?? ""}`);
  const topic = req.title.replace(/\?+$/, "");
  if (entries.length) {
    const main = entries[0];
    return `${topic.toLowerCase()} is the part most small hosts get burned on before they find a system. From what I've built for exactly this: ${main.body
      .split("\n")
      .slice(0, 3)
      .join(" ")
      .slice(0, 420)}
I run LodgeTrack, built it after living this myself, so if anything is unclear, feel free to ask.`;
  }
  return `I run LodgeTrack; this specific thing is what pushed me to build it in the first place. Before I recommend anything too specific: which part hurts the most right now? Calendars and pricing, cleaners, or guest messaging? The fix usually looks really different depending on which of those it actually is`;
}
