import { config, canPostReddit } from "./config.ts";
import {
  addEvent,
  db,
  getBannedSubreddits,
  getSetting,
  setSetting,
  stats,
} from "./db.ts";
import { setPosterPaused } from "./poster.ts";
import { isQuietHour, hourInTimezone } from "./time.ts";

/**
 * Account health + observability (Phase 3 + §9):
 *  - Reddit: suspended-account probes, removal tracking, promo-ratio guard,
 *    removals fallback trigger (3 removals / 7 days → poster pauses)
 *  - Platform canaries for the extension (rows/session trend → green/yellow/red)
 *  - Alerts are surfaced in the heartbeat digest & Telegram failure alerts
 */

interface PostedCommentRecord {
  draftId: number;
  commentId: string;
  subreddit: string;
  postedAt: number;
}

export function recordPostedComment(draftId: number, commentId: string, subreddit: string): void {
  const list = JSON.parse(getSetting("posted_comments") ?? "[]") as PostedCommentRecord[];
  list.push({ draftId, commentId, subreddit, postedAt: Date.now() });
  setSetting("posted_comments", JSON.stringify(list.slice(-500)));
}

/** Scan recent posts (within 48h) for removal/withdrawal. Best-effort; creds optional. */
export async function scanForRemovals(): Promise<number> {
  if (!canPostReddit) return 0;
  const cutoff = Date.now() - 48 * 3600_000;
  const list = (JSON.parse(getSetting("posted_comments") ?? "[]") as PostedCommentRecord[]).filter(
    (r) => r.postedAt >= cutoff
  );
  if (!list.length) return 0;
  const ids = list.map((r) => `t1_${r.commentId}`).join(",");
  try {
    const { getUserToken } = await import("./poster.ts");
    const token = await getUserToken();
    const res = await fetch(`https://oauth.reddit.com/api/info?id=${ids}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": UA() },
    });
    if (!res.ok) return 0;
    const j = (await res.json()) as {
      data?: { children?: Array<{ data: { id: string; body?: string } }> };
    };
    const live = new Set(j.data?.children?.map((c) => c.data.id) ?? []);
    let newRemovals = 0;
    for (const r of list) {
      const stillLive = live.has(r.commentId);
      const body = j.data?.children?.find((c) => c.data.id === r.commentId)?.data.body ?? "";
      const removed = !stillLive || /^\[?(removed|deleted)\]?$/i.test(body.trim());
      if (removed && !removedAlreadyLogged(r.draftId)) {
        newRemovals++;
        addEvent("removal", `comment ${r.commentId} (draft ${r.draftId}) removed`);
        logRemoval(r.draftId);
      }
    }
    await applyFallbackTrigger();
    return newRemovals;
  } catch (e) {
    addEvent("error", `removal scan: ${String(e)}`);
    return 0;
  }
}

function removedAlreadyLogged(draftId: number): boolean {
  return (JSON.parse(getSetting("logged_removals") ?? "[]") as number[]).includes(draftId);
}

function logRemoval(draftId: number): void {
  const logged = JSON.parse(getSetting("logged_removals") ?? "[]") as number[];
  setSetting("logged_removals", JSON.stringify([...logged, draftId].slice(-500)));
  void db; // db import kept for future direct queries
}

/** Removals fallback: N removals inside window days → pause poster (PLAN §5). */
async function applyFallbackTrigger(): Promise<void> {
  const since = Date.now() - config.poster.removalWindowDays * 24 * 3600_000;
  const removals = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'removal' AND ts >= ?")
    .get(since) as { n: number };
  if (removals.n >= config.poster.removalsPerDays) {
    if (!getSetting("poster_paused")) {
      setPosterPaused(true);
      addEvent("alert", `FALLBACK: ${removals.n} removals in ${config.poster.removalWindowDays}d — poster paused, use old account`);
    }
  }
}

function UA(): string {
  return `web:LodgeTrackScout:v0.1 (by /u/${config.reddit.username || "unknown"})`;
}

/** Account suspended probe (cheap; only when creds exist). */
export async function accountSuspended(): Promise<boolean | null> {
  if (!config.reddit.username) return null;
  try {
    const res = await fetch(`https://www.reddit.com/user/${config.reddit.username}/about.json`, {
      headers: { "User-Agent": UA() },
    });
    if (res.status === 404) {
      addEvent("alert", `reddit account u/${config.reddit.username} not found/suspended`);
      return true;
    }
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { is_suspended?: boolean } };
    return j.data?.is_suspended ?? false;
  } catch {
    return null;
  }
}

// ---------------- extension platform canaries ----------------

/** Record one extraction session result from the ingest path. */
export function recordExtraction(platform: string, rows: number): void {
  const key = `canary:${platform}`;
  const state = JSON.parse(getSetting(key) ?? '{"sessions":[]}') as {
    sessions: Array<{ ts: number; rows: number }>;
  };
  state.sessions.push({ ts: Date.now(), rows });
  state.sessions = state.sessions.slice(-20);
  setSetting(key, JSON.stringify(state));
}

export type CanaryStatus = "green" | "yellow" | "red" | "n/a";

export function canaryFor(platform: string): CanaryStatus {
  const state = JSON.parse(getSetting(`canary:${platform}`) ?? "{}") as {
    sessions?: Array<{ ts: number; rows: number }>;
  };
  const sessions = (state.sessions ?? []).filter((s) => s.ts > Date.now() - 7 * 24 * 3600_000);
  if (sessions.length === 0) return "n/a";
  const last3 = sessions.slice(-3);
  if (last3.every((s) => s.rows === 0)) return "red";
  if (last3.every((s) => s.rows === 0) === false && last3.some((s) => s.rows === 0)) return "yellow";
  return "green";
}

// ---------------- heartbeat digest ----------------

export function heartbeatText(): string {
  const s = stats();
  const subs = getBannedSubreddits();
  const platforms = ["linkedin", "x", "facebook", "reddit"];
  const canaries = platforms
    .map((p) => `${p}=${canaryFor(p)}`)
    .join(" · ");
  return [
    "📡 <b>Daily heartbeat</b>",
    `candidates: ${s.total} (pending: ${s.pending ?? 0}, notified: ${s.notified ?? 0}, skipped: ${s.skipped ?? 0})`,
    `leads: ${s.leads ?? 0} · contacted: ${s.contacted ?? 0} · replied: ${s.replied ?? 0}`,
    `extraction canary: ${canaries}`,
    `banned subs: ${[...subs].join(", ") || "none"}`,
    `kill switch: ${isKillOn() ? "🔴 ON" : "🟢 off"} · poster: ${getSetting("poster_paused") === "1" ? "⏸ paused" : "▶ active"}`,
    `quiet hours: ${isQuietHour() ? "now" : "no"} (it is ${hourInTimezone()}:00 local)`,
  ].join("\n");
}

export function isKillOn(): boolean {
  return config.killSwitch || getSetting("kill_switch") === "1";
}

export function overseasKillOn(): boolean {
  return isKillOn();
}
