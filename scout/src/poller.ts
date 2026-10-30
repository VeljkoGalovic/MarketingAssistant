import { config } from "./config.ts";
import {
  addEvent,
  countCardsToday,
  getBannedSubreddits,
  insertCandidate,
} from "./db.ts";
import { pollSubreddit } from "./reddit.ts";
import { isQuietHour } from "./time.ts";

/**
 * Poll orchestration — Phase 1. Jittered interval, dedupe via UNIQUE index,
 * cap on cards/day, quiet-hour aware notification (cards held until recap).
 */

export interface NotificationQueue {
  queueQuietCard: (c: { id: number }) => void;
}

let backoff = 0;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollOnce(notify: (candidateId: number) => Promise<void>): Promise<number> {
  const banned = getBannedSubreddits();
  let inserted = 0;
  for (const sub of config.reddit.subreddits) {
    try {
      const results = await pollSubreddit(sub, banned);
      for (const c of results) {
        const row = insertCandidate(c);
        if (row) {
          inserted++;
          if (!isQuietHour()) {
            if (countCardsToday("reddit") >= 15) {
              addEvent("poll", "card cap reached for today");
              continue;
            }
            await notify(row.id);
          }
          // quiet hour: cards stay pending; the 07:00 recap processes them
        }
      }
      addEvent("poll", `r/${sub}: ${results.length} scored, ${inserted} new`);
      await sleep(1500); // be a polite neighbor between subs
    } catch (e) {
      const err = e as { retryAfter?: number };
      if (err.retryAfter) {
        addEvent("error", `poll r/${sub}: 429, honoring ${err.retryAfter}ms`);
        await sleep(err.retryAfter);
      } else {
        backoff = Math.min(backoff + 1, 5);
        addEvent("error", `poll r/${sub}: ${String(e)} (backoff ${2 ** backoff}min)`);
        await sleep((2 ** backoff + Math.random()) * 60_000);
      }
    }
  }
  return inserted;
}

/** Forever loop; caller never awaits completion. */
export async function runPoller(
  notify: (candidateId: number) => Promise<void>,
  isKilled: () => boolean
): Promise<void> {
  for (;;) {
    const killed = isKilled();
    if (killed) {
      addEvent("poll", "kill switch: poll pausing 5min");
      await sleep(5 * 60_000);
      continue;
    }
    await pollOnce(notify);
    const baseMs = config.reddit.pollIntervalMin * 60_000;
    const jitter = baseMs * (Math.random() * 0.4 - 0.2); // ±20%
    await sleep(Math.max(30_000, baseMs + jitter));
  }
}
