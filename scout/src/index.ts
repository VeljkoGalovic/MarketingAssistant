/**
 * LodgeTrack Scout — daemon entry (PLAN §12).
 *
 * All loops are kill-switch aware and degrade gracefully in dry mode
 * (no Telegram token) and dormant mode (no Reddit/LLM/email creds).
 */
import net from "node:net";
// NOTE 2026-10-31: node/undici Happy-Eyeballs (autoSelectFamily) wedges this box's
// egress — IPv4 attempts ETIMEDOUT inside fetch while raw sockets connect fine,
// producing the "fetch failed" flaps seen on Telegram/Google. Disabling globally.
net.setDefaultAutoSelectFamily(false);
import { config, isDryMode, canPostReddit } from "./config.ts";
import { addEvent, expireOldDrafts, pruneOldBodies } from "./db.ts";
import { isKillOn } from "./health.ts";
import { runPoller } from "./poller.ts";
import { notifyCandidateCard, runTelegramLoop, maybeNudgeIfNoCapture, sendDigest, sendRecap } from "./telegram.ts";
import { recordPostedComment, scanForRemovals, accountSuspended } from "./health.ts";
import { startIngestServer } from "./ingest.ts";
import { startDashboardServer } from "./dashboard/server.ts";
import { sweepCities } from "./leadfinder/overpass.ts";
import { getSetting, setSetting } from "./db.ts";
import { hourInTimezone } from "./time.ts";

const boot = () => {
  addEvent(
    "boot",
    `scout up (dry=${isDryMode} postable=${canPostReddit} leadfinder=${config.leadfinder.enabled})`
  );
  console.log(
    `[scout] boot — dry=${isDryMode ? "YES (no Telegram token: DB-only)" : "no"} · postable=${canPostReddit ? "yes" : "dormant (no Reddit creds)"} · leadfinder=${config.leadfinder.enabled ? "on" : "off"}`
  );
};

// ---- scheduler: recap 07:00, digest 09:00, sweeps weekly (all local-time aware) ----

function startDailyTicker(): void {
  setInterval(async () => {
    try {
      if (isKillOn()) return;
      const h = hourInTimezone();
      if (isDryMode) return;

      if (h === config.quiet.recapHour && lastRunDay("last_recap") !== todayKey()) {
        await sendRecap();
      }
      if (h === config.quiet.digestHour && lastRunDay("last_digest") !== todayKey()) {
        setSetting("last_digest", todayKey());
        await sendDigest();
      }
      const nudgeHour = config.quiet.nudgeHour;
      if (h === nudgeHour && lastRunDay("last_nudge") !== todayKey()) {
        setSetting("last_nudge", String(Date.now()));
        await maybeNudgeIfNoCapture();
      }
    } catch (e) {
      addEvent("error", `ticker: ${String(e)}`);
    }
  }, 60_000);
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function lastRunDay(key: string): string {
  const raw = getSetting(key);
  if (!raw) return "";
  return new Date(Number(raw)).toISOString().slice(0, 10);
}

// ---- background maintenance ----

function startMaintenance(): void {
  // draft expiry every 30min; body pruning daily; removal scan hourly; suspension probe 6h
  setInterval(() => {
    try {
      const n = expireOldDrafts();
      if (n) addEvent("expire", `${n} drafts expired (48h)`);
    } catch (e) {
      addEvent("error", `expire: ${String(e)}`);
    }
  }, 30 * 60_000);

  setInterval(() => {
    try {
      pruneOldBodies();
    } catch {}
  }, 24 * 3600_000);

  setInterval(async () => {
    try {
      if (isKillOn() || !canPostReddit) return;
      const n = await scanForRemovals();
      if (n > 0) {
        // removals recorded; fallback trigger logic lives in health.ts
        console.log(`[scout] removals detected: ${n}`);
      }
      await accountSuspended();
    } catch (e) {
      addEvent("error", `removal scan: ${String(e)}`);
    }
  }, 3600_000);
}

// ---- lead-finder weekly ticker ----

function startLeadfinder(): void {
  if (!config.leadfinder.enabled) {
    console.log("[scout] leadfinder disabled (SCOUT_LEADFINDER_ENABLED=1 to enable)");
    return;
  }
  const runIfDue = async () => {
    if (isKillOn()) return;
    const intervalMs = config.leadfinder.intervalDays * 24 * 3600_000;
    const last = Number(getSetting("last_sweep") ?? "0");
    if (Date.now() - last >= intervalMs) {
      setSetting("last_sweep", String(Date.now()));
      try {
        await sweepCities();
      } catch (e) {
        addEvent("error", `leadfinder: ${String(e)}`);
      }
    }
  };
  setInterval(runIfDue, 3600_000);
  void runIfDue();
}

// ---- SIGINT: leave DB cleanly ----

process.on("SIGINT", () => {
  addEvent("boot", "SIGINT: shutting down");
  process.exit(0);
});

boot();
startDailyTicker();
startMaintenance();
startIngestServer();
startDashboardServer();
startLeadfinder();

// main poll loop (own stack: never awaited)
void runPoller(async (cid) => {
  const { getCandidateById } = await import("./db.ts");
  const c = getCandidateById(cid);
  if (c) await notifyCandidateCard(c);
}, isKillOn);

if (!isDryMode) {
  void runTelegramLoop();
} else {
  console.log("[scout] dry mode: Telegram loop skipped (set SCOUT_TELEGRAM_BOT_TOKEN + chat id to activate)");
}

// re-export for tests/scripts
export { recordPostedComment };
