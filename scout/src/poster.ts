import { config, canPostReddit } from "./config.ts";
import {
  addEvent,
  countRedditPostsToday,
  createDraft,
  db,
  getCandidateById,
  getDraftById,
  setCandidateStatus,
  setDraftStatus,
  type Candidate,
  type Draft,
} from "./db.ts";
import { generateDraft } from "./drafts/provider.ts";

/**
 * Reddit poster (Phase 3): guarded, capped, reversible.
 * NOTE: posting is dormant until SCOUT_REDDIT_* credentials land in .env —
 * every public function safely no-ops with a clear reason.
 */

interface TokenState {
  accessToken: string;
  expiresAt: number;
}
let userToken: TokenState | null = null;

const UA = `web:LodgeTrackScout:v0.1 (by /u/${config.reddit.username || "unknown"})`;

export async function getUserToken(): Promise<string> {
  if (userToken && userToken.expiresAt > Date.now() + 60_000) return userToken.accessToken;
  if (!canPostReddit) throw new Error("posting disabled: missing Reddit credentials");
  const basic = Buffer.from(
    `${config.reddit.clientId}:${config.reddit.clientSecret}`
  ).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: config.reddit.username,
      password: config.reddit.password,
    }),
  });
  if (!res.ok) throw new Error(`reddit oauth: HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  userToken = { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return userToken.accessToken;
}

/** Hard cap check: ≤N posts per subreddit per day (enforced at approve time). */
export function canPostToSub(sub: string): { ok: boolean; reason?: string } {
  if (!canPostReddit) return { ok: false, reason: "no Reddit credentials (dry mode)" };
  if (config.killSwitch) return { ok: false, reason: "kill switch is ON" };
  const used = countRedditPostsToday(sub);
  if (used >= config.caps.redditPerSubDay) {
    return {
      ok: false,
      reason: `cap reached: ${used}/${config.caps.redditPerSubDay} posts today in r/${sub}`,
    };
  }
  return { ok: true };
}

async function rawComment(thingId: string, text: string): Promise<{ commentId: string }> {
  const token = await getUserToken();
  const res = await fetch("https://oauth.reddit.com/api/comment", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({ thing_id: thingId, text, api_type: "json" }),
  });
  if (!res.ok) throw new Error(`reddit comment: HTTP ${res.status}`);
  const j = (await res.json()) as {
    json?: { errors?: unknown[]; data?: { things?: Array<{ data: { id: string } }> } };
  };
  const commentId = j.json?.data?.things?.[0]?.data?.id;
  if (!commentId)
    throw new Error(`reddit comment rejected: ${JSON.stringify(j.json?.errors ?? j)}`);
  return { commentId };
}

function findExistingDraft(candidateId: number): Draft | undefined {
  return db
    .prepare(
      "SELECT * FROM drafts WHERE candidate_id = ? AND status IN ('drafted','edited','approved') ORDER BY id DESC LIMIT 1"
    )
    .get(candidateId) as Draft | undefined;
}

function sourcePlatform(source: string): "reddit" | "linkedin" | "x" | "facebook" | "manual" {
  if (source === "reddit") return "reddit";
  if (source.includes("linkedin")) return "linkedin";
  if (source.includes(":x") || source.includes("manual:x")) return "x";
  if (source.includes("facebook")) return "facebook";
  return "manual";
}

/** Prepare an approved candidate: generate (or reuse) a founder-voice draft.
 * Drafting must ALWAYS work (dry mode included) — the post-time gate in
 * postDraft() is what enforces caps/creds/kill-switch. */
export async function approveAndPrepare(
  c: Candidate
): Promise<{ ok: boolean; draft?: Draft; reason?: string }> {
  const existing = findExistingDraft(c.id);
  if (existing) return { ok: true, draft: existing };

  const result = await generateDraft({
    platform: sourcePlatform(c.source),
    title: c.title,
    body: c.body,
    authorHint: c.author ?? undefined,
  });
  const draft = createDraft(c.id, "reddit", result.text, result.provider);
  setCandidateStatus(c.id, "approved");
  addEvent("draft", `candidate ${c.id} drafted via ${result.provider}`);
  return { ok: true, draft };
}

export function updateDraftBody(draftId: number, body: string, provider = "manual"): void {
  db.prepare(
    "UPDATE drafts SET body = ?, provider = ?, status = 'edited', updated_at = ? WHERE id = ?"
  ).run(body, provider, Date.now(), draftId);
}

export async function regenerateDraft(draftId: number): Promise<Draft | undefined> {
  const draft = getDraftById(draftId);
  if (!draft) return undefined;
  const candidate = draft.candidate_id ? getCandidateById(draft.candidate_id) : undefined;
  const result = await generateDraft({
    platform: sourcePlatform(candidate?.source ?? "reddit"),
    title: candidate?.title ?? "fresh draft",
    body: candidate?.body ?? "",
    authorHint: candidate?.author ?? undefined,
  });
  updateDraftBody(draftId, result.text, result.provider);
  addEvent("draft", `regenerated ${draftId} via ${result.provider}`);
  return getDraftById(draftId);
}

/** Execute an approved draft → actual Reddit comment. Dormant without creds. */
export async function postDraft(
  draftId: number
): Promise<{ ok: boolean; commentId?: string; reason?: string }> {
  const draft = getDraftById(draftId);
  if (!draft) return { ok: false, reason: "draft not found" };
  if (draft.expires_at < Date.now()) {
    setDraftStatus(draftId, "expired");
    return { ok: false, reason: "draft expired (48h)" };
  }
  if (!draft.candidate_id) return { ok: false, reason: "draft has no candidate" };

  const candidate = getCandidateById(draft.candidate_id);
  if (!candidate) return { ok: false, reason: "candidate missing" };

  if (posterPaused()) return { ok: false, reason: "poster paused (removals trigger)" };
  const gate = canPostToSub(candidate.subreddit ?? "");
  if (!gate.ok) return { ok: false, reason: gate.reason };

  try {
    const { commentId } = await rawComment(candidate.external_id, draft.body);
    setDraftStatus(draftId, "sent");
    setCandidateStatus(candidate.id, "posted");
    addEvent("post", `${candidate.id} -> ${commentId} in r/${candidate.subreddit}`);
    return { ok: true, commentId };
  } catch (e) {
    addEvent("error", `post ${draftId}: ${String(e)}`);
    return { ok: false, reason: String(e) };
  }
}

// ---------------- removals fallback trigger ----------------

export function posterPaused(): boolean {
  return (db
    .prepare("SELECT value FROM settings WHERE key = 'poster_paused'")
    .get() as { value: string } | undefined)?.value === "1";
}

export function setPosterPaused(paused: boolean): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('poster_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(paused ? "1" : "0");
}
