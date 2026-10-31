import fs from "node:fs";
import path from "node:path";

const envPath = process.env.SCOUT_ENV_FILE ?? path.resolve(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

function str(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}
function int(key: string, fallback: number): number {
  const n = Number.parseInt(str(key), 10);
  return Number.isFinite(n) ? n : fallback;
}
function bool(key: string): boolean {
  const v = str(key).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export const config = {
  telegram: {
    botToken: str("SCOUT_TELEGRAM_BOT_TOKEN"),
    chatId: str("SCOUT_TELEGRAM_CHAT_ID"),
  },
  reddit: {
    clientId: str("SCOUT_REDDIT_CLIENT_ID"),
    clientSecret: str("SCOUT_REDDIT_CLIENT_SECRET"),
    username: str("SCOUT_REDDIT_USERNAME"),
    /** Script-app password grant — only needed for Phase 3 posting. */
    password: str("SCOUT_REDDIT_PASSWORD"),
    subreddits: str(
      "SCOUT_SUBREDDITS",
      "AirBnB_Hosts,vacationrentals,propertymanagement,Innkeeping"
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    pollIntervalMin: int("SCOUT_POLL_INTERVAL_MIN", 10),
    scoreThreshold: int("SCOUT_SCORE_THRESHOLD", 4),
    searchQuery: str("SCOUT_SEARCH_QUERY", "software OR tool OR app OR pms OR spreadsheet"),
  },
  /** Per-platform caps ONLY — there is deliberately no global cap. */
  caps: {
    redditPerSubDay: int("SCOUT_CAP_REDDIT_PER_SUB_DAY", 2),
    draftsLinkedInDay: int("SCOUT_CAP_DRAFTS_LINKEDIN_DAY", 5),
    draftsXDay: int("SCOUT_CAP_DRAFTS_X_DAY", 5),
    draftsFBDay: int("SCOUT_CAP_DRAFTS_FB_DAY", 5),
    emailFirstTouchDay: int("SCOUT_CAP_EMAIL_FIRST_TOUCH_DAY", 20),
  },
  quiet: {
    timezone: str("SCOUT_TIMEZONE", "Europe/Belgrade"),
    startHour: int("SCOUT_QUIET_START", 23),
    endHour: int("SCOUT_QUIET_END", 7),
    recapHour: int("SCOUT_RECAP_HOUR", 7),
    digestHour: int("SCOUT_DIGEST_HOUR", 9),
    nudgeHour: int("SCOUT_NUDGE_HOUR", 20),
  },
  drafts: {
    expireHours: int("SCOUT_DRAFT_EXPIRE_HOURS", 48),
  },
  llm: {
    /** which to prefer: google | groq | cloudflare (fallback chain, then KB) */
    provider: str("SCOUT_LLM_PROVIDER", "google"),
    google: {
      key: str("SCOUT_LLM_GOOGLE_KEY"),
      model: str("SCOUT_LLM_GOOGLE_MODEL", "gemini-3.8-flash"),
    },
    groq: {
      key: str("SCOUT_LLM_GROQ_KEY"),
      model: str("SCOUT_LLM_GROQ_MODEL", "llama-3.3-70b-versatile"),
    },
    cloudflare: {
      accountId: str("SCOUT_LLM_CF_ACCOUNT_ID"),
      apiToken: str("SCOUT_LLM_CF_API_TOKEN"),
      model: str("SCOUT_LLM_CF_MODEL", "@cf/meta/llama-3.1-8b-instruct"),
    },
  },
  kb: {
    dir: path.resolve(str("SCOUT_KB_DIR", path.join(process.cwd(), "kb"))),
  },
  ingest: {
    enabled: !bool("SCOUT_INGEST_DISABLED"),
    port: int("SCOUT_INGEST_PORT", 8787),
    bind: str("SCOUT_INGEST_BIND", "127.0.0.1"),
    token: str("SCOUT_INGEST_TOKEN"),
    maxPerHour: int("SCOUT_INGEST_MAX_PER_HOUR", 600),
  },
  dashboard: {
    port: int("SCOUT_DASHBOARD_PORT", 8788),
    bind: str("SCOUT_DASHBOARD_BIND", "0.0.0.0"),
    /** empty → auto-generated, written to data/dashboard-token.txt (0600) */
    token: str("SCOUT_DASHBOARD_TOKEN"),
    disabled: bool("SCOUT_DASHBOARD_DISABLED"),
  },
  poster: {
    removalsPerDays: int("SCOUT_REMOVAL_TRIGGER", 3),
    removalWindowDays: int("SCOUT_REMOVAL_WINDOW_DAYS", 7),
  },
  leadfinder: {
    enabled: bool("SCOUT_LEADFINDER_ENABLED"),
    intervalDays: int("SCOUT_LEADFINDER_INTERVAL_DAYS", 7),
    cities: str(
      "SCOUT_LEADFINDER_CITIES",
      "Lisbon, Barcelona, Amsterdam, Zagreb, Split"
    ),
    maxPerRun: int("SCOUT_LEADFINDER_MAX_PER_RUN", 50),
  },
  killSwitch: bool("SCOUT_DISABLED"),
  dataDir: path.resolve(str("SCOUT_DATA_DIR", path.join(process.cwd(), "data"))),
} as const;

/** Dry mode: no Telegram token → pollers/score runs still happen, DB only, no sends. */
export const isDryMode = !config.telegram.botToken;
/** Postable mode: enough Reddit creds to actually comment. */
export const canPostReddit = !!(config.reddit.clientId && config.reddit.clientSecret && config.reddit.username && config.reddit.password);

export function dataFile(name: string): string {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return path.join(config.dataDir, name);
}
