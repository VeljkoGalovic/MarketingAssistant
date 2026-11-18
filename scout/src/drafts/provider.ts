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

/** Cold-email system voice (decision #14, revised 2026-11-15/16): full localization +
 * strict layout (3 short paragraphs, single email-only CTA), early-adopter discount +
 * promo code in every email, real sender signature with legal/privacy + unsubscribe
 * note, and an absolute ban on offering calls/meetings of any kind. Language still
 * comes from CITY_LANGUAGE; discount/code/URL from config; zero fabrication stays.
 * Exported for debugging/prompt-capture tooling. */
export const COLD_EMAIL_VOICE = (language: string, includeEnglishGloss: boolean) => `
You are an outbound B2B outreach specialist writing personalized cold emails on behalf of Veljko Galović, the founder of LodgeTrack (lodgetrack.com)—a free-to-try property management platform built by a property owner for small boutique hotels, guesthouses, and short-term rentals (3–15 units). LodgeTrack centralizes booking calendars, cleaning team coordination, pricing, and guest messaging into one simple interface.

### TASK
Given a target property's details (name, location, website notes, and contact email), write a concise, personalized cold email in the **local business language** of the target property's country.

### STRICT RULES
1. **Dynamic Language & Localization:** Detect the country of the target property and write the outreach email in that country's native business language (e.g., European Portuguese for Portugal, Spanish for Spain, German for Germany, French for France, English for the UK/US). Use natural, polite local hospitality terminology (such as *alojamento local* in Portugal or *casas rurales* in Spain) rather than literal translations.
2. **Formatting & Length:** The three body paragraphs together must stay between **80 and 120 words** (the greeting, sign-off block, and Legal & Privacy Note do not count). Break the text into **3 short paragraphs** (1–2 sentences each) with blank lines between them. Never output a single wall of text.
3. **Structure:**
   - **Greeting:** Polite, localized greeting addressed to the specific contact name if provided, or the property team if using a general inbox.
   - **Paragraph 1 (The Hook):** One specific, genuine observation about their property (design, neighborhood landmark, guest experience, or local vibe) based on the research provided. Do not mention LodgeTrack here.
   - **Paragraph 2 (The Pitch + Offer):** Introduce Veljko as a fellow property owner who built LodgeTrack to simplify day-to-day property management, and mention the early-adopter offer: an **exclusive ${config.outreachDiscount} discount** using the **promo code ${config.outreachPromoCode}** (always state the code exactly as written, never alter or invent a different one). Frame it naturally as part of the pitch — not as a countdown-pressure sales gimmick.
   - **Paragraph 3 (Single Low-Friction CTA):** Invite them to continue the conversation **directly right here over email** so you can share more details on how it fits into their workflow. **CRITICAL — ASYNCHRONOUS ONLY:** Never offer, suggest, or hint at a phone call, video meeting, in-person demo, or any form of real-time conversation — not even a "quick call" or "2-minute call". The sender cannot take calls under any circumstances; every email must be answerable by email alone.
   - **Sign-off block (exactly this shape, closing line localized, rest verbatim):**
     [Localized closing, e.g. "Com os melhores cumprimentos" / "Un cordial saludo" / "Best regards"],

     Veljko Galović

     LodgeTrack

     Podgorička 3/14, 25000 Sombor, Serbia

     Legal & Privacy Note: [localized translation of:] "I obtained your contact details from publicly available business information on your website. If you prefer not to receive further emails regarding LodgeTrack, simply reply to this email with the word \"Unsubscribe\"${config.outreachUnsubscribeUrl ? ` or click here: ${config.outreachUnsubscribeUrl}` : ""} and your address will be removed immediately."
4. **No Fluff:** Avoid pushy sales clichés, exclamation marks, or buzzwords like "revolutionize" or "game-changer."

### OUTPUT FORMAT
Output the result using the exact layout below so the Subject, Body, and English translation are cleanly separated for quick review and copy-pasting:

🎯 **[Property Name]** — [City, Country]
**To:** [Email Address]

---
### ✉️ OUTREACH DRAFT ([Detected Language])

**Subject:** [Short, personalized subject line, max 7 words]

**Body:**
[Greeting]

[Paragraph 1: Personalized Hook]

[Paragraph 2: Value Proposition + ${config.outreachDiscount} discount, promo code ${config.outreachPromoCode}]

[Paragraph 3: Continue-over-email CTA]

[Localized closing],

Veljko Galović

LodgeTrack

Podgorička 3/14, 25000 Sombor, Serbia

[Localized Legal & Privacy Note]

---
### 🌐 ENGLISH TRANSLATION (For Approval Only — Do Not Copy)

**Subject:** [English translation of subject]

**Body:**
[Exact English translation matching the paragraph breaks, sign-off block, and legal note above]

---
System-provided facts for this email (use as given, they override your own detection):
- Country and language (authoritative): ${language}
- Early-adopter offer: ${config.outreachDiscount} discount, promo code ${config.outreachPromoCode} (exact, unchanged)
${includeEnglishGloss ? "" : "- The email above is already in English; omit the ENGLISH TRANSLATION section and end after the OUTREACH DRAFT section.\n"}
Reproduce the layout above literally, including the 🎯/✉️/🌐 markers and the --- separator lines: the approval pipeline parses on them.
`;

/** city → language for the cold-email lane (decision #14 user choice: local language).
 * 2026-11-05: Croatian cities (Zagreb/Split) swapped out for Palma + Faro — no
 * new language lanes needed; existing HR-city rows fall back to English. */
export const CITY_LANGUAGE: Record<string, { lang: string; englishGloss: boolean }> = {
  lisbon: { lang: "Portuguese (Portugal)", englishGloss: true },
  faro: { lang: "Portuguese (Portugal)", englishGloss: true },
  barcelona: { lang: "Spanish (Spain)", englishGloss: true },
  valencia: { lang: "Spanish (Spain)", englishGloss: true },
  "palma de mallorca": { lang: "Spanish (Spain)", englishGloss: true },
};

export interface ColdEmailRequest {
  name: string;
  city: string | null;
  category: string | null;
  researchNote: string | null;
  website: string | null;
  /** Recipient email (To:) — lets the voice pick the right greeting for a general
   * inbox (geral@/info@) vs a named contact (2026-11-15 prompt revision). */
  contactEmail?: string | null;
  language: string;
  englishGloss: boolean;
}

export interface ColdEmailResult {
  subject: string;
  body: string;
  provider: string;
}

/** Parse either the 2026-11-15 scaffold format or the legacy Subject:/-separator shape. */
function parseColdEmailResult(raw: string): ColdEmailResult | null {
  const parsed = parseColdEmailOutput(sanitizeEmailDraft(raw));
  if (parsed && parsed.subject && parsed.localBody) {
    return {
      subject: parsed.subject,
      body: parsed.gloss ? `${parsed.localBody}\n\n----\n${parsed.gloss}` : parsed.localBody,
      provider: "",
    };
  }
  // legacy fallback (pre-2026-11-15 shape: "Subject:" line + "----" gloss)
  const text = sanitizeDraft(raw);
  const subjectM = text.match(/subject\s*:\s*(.+)/i);
  const subject = subjectM?.[1]?.trim() ?? "";
  const splitAt = text.indexOf("----");
  const bodyPart = (splitAt > 0 ? text.slice(0, splitAt) : text).replace(/^subject\s*:.+\n+/i, "").trim();
  const englishPart = splitAt > 0 ? text.slice(splitAt + 4).trim() : "";
  if (!subject || !bodyPart) return null;
  return {
    subject,
    body: englishPart ? `${bodyPart}\n\n----\n${englishPart}` : bodyPart,
    provider: "",
  };
}

export async function generateColdEmail(req: ColdEmailRequest): Promise<ColdEmailResult | null> {
  const kb = matchKb(`${req.name} ${req.category ?? ""} ${req.researchNote ?? ""}`);
  const material = [
    `Business: ${req.name}`,
    `Type: ${req.category ?? "vacation-rental or small accommodation operator"}`,
    `City: ${req.city ?? "-"}`,
    `Website: ${req.website ?? "-"}`,
    `Contact email (To): ${req.contactEmail ?? "-"}`,
    `Facts you may use (from a factual LLM pass, do not add your own): ${req.researchNote ?? "no extra facts"}`,
    `Material about the product: ${kb.length ? kbToText(kb).slice(0, 900) : config.outreachValueProp}`,
    `Value proposition (usable verbatim): ${config.outreachValueProp}`,
  ].join("\n");
  const system = COLD_EMAIL_VOICE(req.language, req.englishGloss);

  // Cold email is a long completion (scaffold + local body + gloss), so it gets its
  // own provider chain with max_tokens=1500. Previously Google-only: one 429 killed
  // the pitch even when Groq/Cloudflare were configured (fix 2026-11-18).
  const chain: Array<{ name: string; run: () => Promise<string> }> = [];
  if (config.llm.google.key) {
    chain.push({
      name: `google:${config.llm.google.model}`,
      run: () => callGoogleNative(config.llm.google.key, config.llm.google.model, system, material, 1500),
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
          system,
          material,
          {},
          1500
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
          system,
          material,
          {},
          1500
        ),
    });
  }
  if (!chain.length) {
    addEvent("error", "cold email: no LLM provider configured (SCOUT_LLM_GOOGLE_KEY missing)");
    return null;
  }

  for (const attempt of [1, 2]) {
    for (const p of chain) {
      try {
        const raw = await p.run();
        const result = parseColdEmailResult(raw);
        if (!result) {
          addEvent(
            "error",
            `cold email ${p.name} attempt ${attempt}: unparseable output (${String(raw).slice(0, 80)}…)`
          );
          continue;
        }
        return { ...result, provider: p.name };
      } catch (e) {
        addEvent("error", `cold email ${p.name} attempt ${attempt}: ${String(e).slice(0, 120)}`);
      }
    }
  }
  return null;
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
  { re: /i hope (this|my) email finds you well/i, why: "mail-merge: 'email finds you well'" },
  { re: /\bi wanted to (reach out|touch base)\b/i, why: "mail-merge: 'wanted to reach out'" },
  { re: /\btrusted by\b/i, why: "hype: social proof claim" },
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

/** Cold-email variant of sanitizeDraft (2026-11-15): regular sanitizeDraft collapses
 * ALL whitespace runs incl. newlines, which fused the Subject line into the first
 * body sentence and erased paragraph breaks (observed on Faro drafts). Here the
 * line structure IS the deliverable (3 paragraphs + scaffold), so only horizontal
 * space is normalized; markdown markers are stripped; em-dashes are left alone. */
export function sanitizeEmailDraft(text: string): string {
  let t = text.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("\u201c") && t.endsWith("\u201d"))
  ) {
    t = t.slice(1, -1);
  }
  t = t
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n"); // cap blank-line runs at one blank line
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1"); // bold
  t = t.replace(/\*([^*\n]+)\*/g, "$1"); // italics
  t = t.replace(/^\s*#{1,6}\s+/gm, ""); // headings
  return t.trim();
}

/** Parser for the 2026-11-15 OUTPUT FORMAT. Extracts Subject + Body of the OUTREACH
 * DRAFT section and the ENGLISH TRANSLATION section, drops the 🎯/To: scaffold, and
 * keeps the long-standing storage contract: local body + "\n\n----\n" + gloss.
 * 2026-11-16: the "Body:" label line is OPTIONAL — Gemini 3 usually skips it and
 * goes straight from the Subject line to the greeting (observed), so the body now
 * defaults to "everything after the Subject line, cut at the --- separator". */
export function parseColdEmailOutput(
  text: string
): { subject: string; localBody: string; gloss: string } | null {
  const draftIdx = text.search(/OUTREACH DRAFT/i);
  if (draftIdx < 0) return null;
  const transIdx = text.search(/ENGLISH TRANSLATION/i);
  const afterDraft = transIdx > draftIdx ? text.slice(draftIdx, transIdx) : text.slice(draftIdx);

  // One output section: find its Subject line; body = text after the subject line
  // (or after an optional "Body:" label), always cut at the first --- separator.
  const section = (chunk: string): { subject: string; body: string } | null => {
    const subjectM = chunk.match(/^[ \t]*Subject:[ \t]*(.+)$/im);
    if (!subjectM || subjectM.index === undefined) return null;
    const subject = subjectM[1].trim();
    // a compliant subject is ≤ ~7 words; a long capture means the model fused the
    // subject and body into one line — unparseable, let the caller retry/fall back
    if (subject.split(/\s+/).length > 15) return null;
    let body = chunk.slice(subjectM.index + subjectM[0].length);
    const bodyLabelM = body.match(/^[ \t]*Body:[ \t]*$/im);
    if (bodyLabelM && bodyLabelM.index !== undefined) {
      body = body.slice(bodyLabelM.index + bodyLabelM[0].length);
    } else {
      const inlineM = body.match(/^[ \t]*Body:[ \t]*(.+)$/im);
      if (inlineM && inlineM.index === 0) body = body.slice(inlineM[0].length);
    }
    const dash = body.match(/^[ \t]*-{3,}[ \t]*$/m);
    if (dash && dash.index !== undefined) body = body.slice(0, dash.index);
    return { subject, body: body.trim() };
  };

  const draft = section(afterDraft);
  if (!draft || !draft.body) return null;

  let gloss = "";
  if (transIdx > draftIdx) {
    const tr = section(text.slice(transIdx));
    if (tr?.body) gloss = tr.subject ? `Subject: ${tr.subject}\n\n${tr.body}` : tr.body;
  }
  return { subject: draft.subject, localBody: draft.body, gloss };
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
  extraHeaders: Record<string, string> = {},
  maxTokens = 300
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
      max_tokens: maxTokens,
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
export async function callGoogleNative(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxOutputTokens = 600
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
          maxOutputTokens,
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
