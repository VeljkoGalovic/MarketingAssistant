import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config, dataFile } from "./config.ts";

export const db = new Database(dataFile("scout.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS entities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,               -- person | org
  name          TEXT NOT NULL,
  domain_canon  TEXT,
  email_canon   TEXT,
  phone_canon   TEXT,
  city          TEXT,
  source        TEXT NOT NULL DEFAULT 'osm', -- osm | extension:<platform> | manual
  external_id   TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id    INTEGER NOT NULL REFERENCES entities(id),
  channel      TEXT NOT NULL,                -- email | reddit | linkedin | x | facebook
  state        TEXT NOT NULL DEFAULT 'new',  -- new|enriched|contactable|contacted|replied|qualified|declined|do_not_contact
  note         TEXT,
  contacted_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,               -- reddit | manual:<platform> | extension:<platform>
  external_id   TEXT NOT NULL,               -- t3_xxx / canon url
  url_canon     TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  author        TEXT,
  subreddit     TEXT,
  entity_id     INTEGER REFERENCES entities(id),
  matched_keywords TEXT NOT NULL DEFAULT '',
  score         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending|notified|skipped|approved|posted|posted_removed|expired
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  INTEGER REFERENCES candidates(id),
  channel       TEXT NOT NULL,               -- reddit | linkedin | x | facebook | manual
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'drafted',
                -- drafted|edited|approved|sent|expired|rejected|regenerating
  provider      TEXT,
  message_id    INTEGER,                     -- telegram message carrying this draft
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,                  -- subreddit | group | search | city
  value      TEXT NOT NULL,                  -- text or JSON blob (e.g. city bbox)
  added_by   TEXT NOT NULL DEFAULT 'system',
  created_at INTEGER NOT NULL,
  UNIQUE(kind, value)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT NOT NULL,   -- poll|notify|skip|bansub|error|recap|digest|draft|approve|post|alert|ingest|lead
  detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_candidates_status ON candidates(status, created_at);
CREATE INDEX IF NOT EXISTS ix_drafts_status ON drafts(status, expires_at);
CREATE INDEX IF NOT EXISTS ix_contacts_entity ON contacts(entity_id);
`);

// ---- additive migrations (SQLite has no ADD COLUMN IF NOT EXISTS) ----
function ensureColumn(table: string, col: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// decision #14: lead lane columns on the existing CRM (no parallel leads table)
ensureColumn("entities", "category", "category TEXT");          // osm tourism tag
ensureColumn("entities", "country", "country TEXT");            // resolved from city
ensureColumn("entities", "research_note", "research_note TEXT");// LLM 2-liner, no fabrication
ensureColumn("entities", "email_source", "email_source TEXT");  // osm | crawler | manual
ensureColumn("entities", "email_validated", "email_validated INTEGER DEFAULT 0");
ensureColumn("entities", "first_contacted_at", "first_contacted_at INTEGER");
ensureColumn("entities", "last_contacted_at", "last_contacted_at INTEGER");
ensureColumn("entities", "last_surfaced_at", "last_surfaced_at INTEGER"); // recap round-robin cursor
ensureColumn("drafts", "subject", "subject TEXT");              // cold emails carry subject
db.exec("CREATE INDEX IF NOT EXISTS ix_entities_email_valid ON entities(email_canon, email_validated);");

const now = () => Date.now();

// ---------------- candidates ----------------

export interface Candidate {
  id: number;
  source: string;
  external_id: string;
  url_canon: string;
  url: string;
  title: string;
  body: string;
  author: string | null;
  subreddit: string | null;
  entity_id: number | null;
  matched_keywords: string;
  score: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface NewCandidate {
  source: string;
  external_id: string;
  url: string;
  title: string;
  body: string;
  author: string;
  subreddit: string | null;
  matched_keywords: string;
  score: number;
}

/** Canonicalize a URL for dedupe: strip tracking params, lowercase host. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.host = u.host.toLowerCase();
    const drop = [];
    for (const p of u.searchParams.keys()) {
      if (p === "fbclid" || p === "si" || p.startsWith("utm_")) drop.push(p);
    }
    for (const p of drop) u.searchParams.delete(p);
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

const insertCandidateStmt = db.prepare(`
  INSERT INTO candidates
    (source, external_id, url_canon, url, title, body, author, subreddit,
     matched_keywords, score, status, created_at, updated_at)
  VALUES
    (@source, @external_id, @url_canon, @url, @title, @body, @author, @subreddit,
     @matched_keywords, @score, 'pending', @now, @now)
  RETURNING *
`);

export function insertCandidate(c: NewCandidate): Candidate | null {
  const urlCanon = canonicalizeUrl(c.url);
  const dup = db
    .prepare("SELECT 1 FROM candidates WHERE source = ? AND external_id = ?")
    .get(c.source, c.external_id);
  if (dup) return null;
  return (insertCandidateStmt.get({
    ...c,
    url_canon: urlCanon,
    now: now(),
  }) ?? null) as Candidate | null;
}

export function getCandidateById(id: number): Candidate | undefined {
  return db.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as Candidate | undefined;
}

export function setCandidateStatus(id: number, status: string): void {
  db.prepare("UPDATE candidates SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    now(),
    id
  );
  addEvent(`status:${status}`, `candidate ${id}`);
}

export function candidatesSince(sinceMs: number): Candidate[] {
  return db
    .prepare(
      "SELECT * FROM candidates WHERE created_at >= ? ORDER BY score DESC, created_at ASC"
    )
    .all(sinceMs) as Candidate[];
}

/** Rows the extension captured since a timestamp (nudge + canary inputs). */
export function countExtensionRowsSince(sinceMs: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM candidates WHERE source LIKE 'extension:%' AND created_at >= ?"
      )
      .get(sinceMs) as { n: number }
  ).n;
}

// ---------------- drafts ----------------

export interface Draft {
  id: number;
  candidate_id: number | null;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  provider: string | null;
  message_id: number | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

const insertDraftStmt = db.prepare(`
  INSERT INTO drafts (candidate_id, channel, subject, body, status, provider, expires_at, created_at, updated_at)
  VALUES (@candidate_id, @channel, @subject, @body, @status, @provider, @expires_at, @now, @now)
  RETURNING *
`);

/** subject only used by the email lane (channel='email'). */
export function createDraft(
  candidateId: number | null,
  channel: string,
  body: string,
  provider: string,
  subject: string | null = null
): Draft {
  const expiresAt = now() + config.drafts.expireHours * 3600_000;
  return (insertDraftStmt.get({
    candidate_id: candidateId,
    channel,
    subject,
    body,
    status: "drafted",
    provider,
    expires_at: expiresAt,
    now: now(),
  }) ?? null) as unknown as Draft;
}

/** Email-lane draft helper (drafts row carries subject + provider; entity link travels in callbacks). */
export function createEmailDraft(entityId: number, subject: string, body: string, provider: string): Draft {
  const d = createDraft(null, "email", body, provider, subject);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`draft:${d.id}:entity`, String(entityId));
  return d;
}

export function emailDraftEntity(draftId: number): number | null {
  const v = getSetting(`draft:${draftId}:entity`);
  return v ? Number(v) : null;
}

export function getDraftById(id: number): Draft | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Draft | undefined;
}

export function getDraftByMessageId(messageId: number): Draft | undefined {
  return db
    .prepare("SELECT * FROM drafts WHERE message_id = ? ORDER BY id DESC LIMIT 1")
    .get(messageId) as Draft | undefined;
}

export function setDraftStatus(id: number, status: string): void {
  db.prepare("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
}

export function setDraftMessageId(id: number, messageId: number): void {
  db.prepare("UPDATE drafts SET message_id = ? WHERE id = ?").run(messageId, id);
}

/** Expire stale drafts + mark their candidates expired too. */
export function expireOldDrafts(): number {
  const stale = db
    .prepare(
      "SELECT id, candidate_id FROM drafts WHERE status IN ('drafted','edited','approved') AND expires_at < ?"
    )
    .all(now()) as Array<{ id: number; candidate_id: number | null }>;
  for (const d of stale) {
    setDraftStatus(d.id, "expired");
    if (d.candidate_id) setCandidateStatus(d.candidate_id, "expired");
  }
  return stale.length;
}

// ---------------- caps (per-platform, per-day) ----------------

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** How many drafts were issued today for a platform family. */

export function countDraftsToday(channels: string[]): number {
  const n = channels
    .map((c) => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM drafts WHERE channel = ? AND created_at >= ?`
        )
        .get(c, startOfToday()) as { n: number };
      return row.n;
    })
    .reduce((a, b) => a + b, 0);
  return n;
}

/** Count cards sent today for candidate sources matching a prefix (reddit | manual:x ...). */
export function countCardsToday(sourcePrefix: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM candidates
       WHERE source = ? OR source LIKE ? AND created_at >= ?`
    )
    .get(sourcePrefix, `${sourcePrefix}:%`, startOfToday()) as { n: number };
  return row.n;
}

/** Reddit posts today for a given subreddit (approved/posted). */
export function countRedditPostsToday(sub: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM candidates
       WHERE source = 'reddit' AND subreddit = ? AND status IN ('approved','posted')
       AND created_at >= ?`
    )
    .get(sub, startOfToday()) as { n: number };
  return row.n;
}

// ---------------- entities / contacts (CRM §8) ----------------

export interface Entity {
  id: number;
  kind: string;
  name: string;
  domain_canon: string | null;
  email_canon: string | null;
  phone_canon: string | null;
  city: string | null;
  source: string;
  external_id: string | null;
  category: string | null;
  country: string | null;
  research_note: string | null;
  email_source: string | null;
  email_validated: number;
  first_contacted_at: number | null;
  last_contacted_at: number | null;
  created_at: number;
}

export function canonicalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const [local, domain] = e.split("@");
  if (!local || !domain) return e;
  const freemail = /@(gmail|googlemail|yahoo|hotmail|outlook|icloud|aol)\./.test(`@${domain}`);
  const localPart = freemail ? local.replace(/\+.*$/, "") : local;
  return `${localPart}@${domain}`;
}

export function canonicalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
}

const insertEntityStmt = db.prepare(`
  INSERT INTO entities (kind, name, domain_canon, email_canon, phone_canon, city, source, external_id, created_at)
  VALUES (@kind, @name, @domain_canon, @email_canon, @phone_canon, @city, @source, @external_id, @now)
  ON CONFLICT(source, external_id) DO UPDATE SET
    name = excluded.name,
    domain_canon = COALESCE(excluded.domain_canon, entities.domain_canon),
    email_canon = COALESCE(excluded.email_canon, entities.email_canon),
    phone_canon = COALESCE(excluded.phone_canon, entities.phone_canon)
  RETURNING id
`);

export function upsertEntity(e: {
  kind: string;
  name: string;
  domain_canon?: string | null;
  email_canon?: string | null;
  phone_canon?: string | null;
  city?: string | null;
  source: string;
  external_id: string;
}): number {
  const row = insertEntityStmt.get({
    ...e,
    domain_canon: e.domain_canon ?? null,
    email_canon: e.email_canon ?? null,
    phone_canon: e.phone_canon ?? null,
    city: e.city ?? null,
    now: now(),
  }) as { id: number } | undefined;
  return row!.id;
}

/** Find an entity by email or domain — used for thread↔lead linking. */
export function findEntityByCanon(
  email?: string | null,
  domain?: string | null
): Entity | undefined {
  if (email) {
    const hit = db
      .prepare("SELECT * FROM entities WHERE email_canon = ?")
      .get(canonicalizeEmail(email)) as Entity | undefined;
    if (hit) return hit;
  }
  if (domain) {
    const hit = db
      .prepare("SELECT * FROM entities WHERE domain_canon = ?")
      .get(canonicalizeDomain(domain)) as Entity | undefined;
    if (hit) return hit;
  }
  return undefined;
}

/** Find an OSM-sourced entity by its external id ("osmType/osmId"). */
export function findEntityByOsmId(externalId: string): Entity | undefined {
  return db
    .prepare("SELECT * FROM entities WHERE source = 'osm' AND external_id = ?")
    .get(externalId) as Entity | undefined;
}

export interface Contact {
  id: number;
  entity_id: number;
  channel: string;
  state: string;
  note: string | null;
  contacted_at: number | null;
  created_at: number;
  updated_at: number;
}

export function upsertContact(entityId: number, channel: string, state: string, note?: string): void {
  const existing = db
    .prepare("SELECT * FROM contacts WHERE entity_id = ? AND channel = ?")
    .get(entityId, channel) as Contact | undefined;
  if (existing) {
    db.prepare(
      "UPDATE contacts SET state = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?"
    ).run(state, note ?? null, now(), existing.id);
  } else {
    db.prepare(
      "INSERT INTO contacts (entity_id, channel, state, note, contacted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    ).run(entityId, channel, state, note ?? null, state === "contacted" ? now() : null, now(), now());
  }
  addEvent("contact", `${entityId} ${channel} -> ${state}`);
}

// ---------------- lead lane (decision #14) ----------------

/** The email-funnel states over the letter codes in contacts.state:
 *  new|enriched|contactable → queued; sent → responded|bounced|not_interested|bought|skip */
export const LEAD_READY_STATES = "('new', 'enriched', 'contactable')";

export interface LeadReady {
  entity_id: number;
  name: string;
  email: string;
  city: string | null;
  country: string | null;
  category: string | null;
  research_note: string | null;
  created_at: number;
}

/** Leads surfaced in the morning recap: MX-validated, not contacted, suppression-aware.
 *  Stream fairness (fix 2026-11-16): order by last_surfaced_at ASC so the recap rotates
 *  through the WHOLE ready pool instead of pinning on whichever city was swept last. */
export function leadsReady(limit: number): LeadReady[] {
  return db
    .prepare(
      `SELECT e.id AS entity_id, e.name, e.email_canon AS email, e.city, e.country,
              e.category, e.research_note, e.created_at
       FROM entities e
       WHERE e.email_canon IS NOT NULL AND e.email_validated = 1
         AND (e.last_contacted_at IS NULL OR e.last_contacted_at > ?)
         AND EXISTS (SELECT 1 FROM contacts c WHERE c.entity_id = e.id AND c.channel='email' AND c.state IN ${LEAD_READY_STATES})
         AND NOT EXISTS (SELECT 1 FROM contacts c2 WHERE c2.entity_id = e.id AND c2.channel='email' AND
              c2.state IN ('sent','responded','bounced','not_interested','declined','do_not_contact'))
       ORDER BY COALESCE(e.last_surfaced_at, 0) ASC, e.created_at DESC LIMIT ?`
    )
    .all(now() - 180 * 24 * 3600_000, limit) as LeadReady[];
}

/** Stamp leads as surfaced by the recap (drives the round-robin cursor above). */
export function markLeadsSurfaced(entityIds: number[]): void {
  if (!entityIds.length) return;
  const stmt = db.prepare("UPDATE entities SET last_surfaced_at = ? WHERE id = ?");
  const ts = now();
  for (const id of entityIds) stmt.run(ts, id);
}

export interface LeadRow {
  entity_id: number;
  name: string;
  email: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  research_note: string | null;
  phone: string | null;
  domain: string | null;
  state: string | null;
}

export function getLead(entityId: number): LeadRow | undefined {
  return db
    .prepare(
      `SELECT e.id AS entity_id, e.name, e.email_canon AS email, e.city, e.country, e.category,
              e.research_note, e.phone_canon AS phone, e.domain_canon AS domain,
              (SELECT c.state FROM contacts c WHERE c.entity_id = e.id AND c.channel = 'email'
                 ORDER BY c.updated_at DESC LIMIT 1) AS state
       FROM entities e WHERE e.id = ?`
    )
    .get(entityId) as LeadRow | undefined;
}

/** Funnel transition; `sent` stamps first/last contact (that's the outreach moment). */
export function setLeadStatus(
  entityId: number,
  state: "sent" | "responded" | "bounced" | "not_interested" | "bought" | "contactable" | "skip",
  note?: string
): void {
  const ts = now();
  upsertContact(entityId, "email", state, note);
  if (state === "sent") {
    db.prepare(
      "UPDATE entities SET first_contacted_at = COALESCE(first_contacted_at, ?), last_contacted_at = ? WHERE id = ?"
    ).run(ts, ts, entityId);
  }
  addEvent("lead", `entity ${entityId} → ${state}`);
}

export function setEntityResearch(
  entityId: number,
  category: string,
  country: string,
  researchNote: string,
  emailSource: string,
  validated: boolean
): void {
  db.prepare(
    "UPDATE entities SET category = ?, country = ?, research_note = ?, email_source = ?, email_validated = ? WHERE id = ?"
  ).run(category, country, researchNote, emailSource, validated ? 1 : 0, entityId);
}

/** Caps: how many email first-touches happened since timestamp. */
export function countEmailTouchesSince(sinceMs: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM entities WHERE first_contacted_at >= ?")
      .get(sinceMs) as { n: number }
  ).n;
}

/** Hard block: contacted/replied/declined on this channel within 180 days. */
export function isContactBlocked(entityId: number, channel: string): boolean {
  const since = now() - 180 * 24 * 3600_000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM contacts
       WHERE entity_id = ? AND channel = ? AND state != 'do_not_contact'
       AND COALESCE(contacted_at, created_at) >= ?`
    )
    .get(entityId, channel, since) as { n: number };
  if (row.n > 0) return true;
  const dnc = db
    .prepare(
      "SELECT COUNT(*) AS n FROM contacts WHERE entity_id = ? AND state IN ('do_not_contact')"
    )
    .get(entityId) as { n: number };
  return dnc.n > 0;
}

export function exportContactsCsv(): string {
  const rows = db
    .prepare(
      `SELECT e.name, e.city, e.email_canon, e.domain_canon, e.phone_canon, c.channel, c.state
       FROM entities e LEFT JOIN contacts c ON c.entity_id = e.id ORDER BY e.id`
    )
    .all() as Array<Record<string, string | null>>;
  const esc = (v: string | null) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const header = "name,city,email,domain,phone,channel,state";
  return [header, ...rows.map((r) => [r.name, r.city, r.email_canon, r.domain_canon, r.phone_canon, r.channel, r.state].map(esc).join(","))].join("\n");
}

// ---------------- watchlist ----------------

export function addWatchItem(kind: string, value: string, addedBy = "user"): void {
  db.prepare(
    "INSERT INTO watchlist (kind, value, added_by, created_at) VALUES (?,?,?,?) ON CONFLICT(kind, value) DO NOTHING"
  ).run(kind, value, addedBy, now());
}

export function listWatchItems(kind?: string): Array<{ id: number; kind: string; value: string }> {
  if (kind) {
    return db.prepare("SELECT id, kind, value FROM watchlist WHERE kind = ?").all(kind) as Array<{ id: number; kind: string; value: string }>;
  }
  return db.prepare("SELECT id, kind, value FROM watchlist").all() as Array<{ id: number; kind: string; value: string }>;
}

export function removeWatchItem(id: number): void {
  db.prepare("DELETE FROM watchlist WHERE id = ?").run(id);
}

// ---------------- settings ----------------

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

const BANNED_KEY = "banned_subreddits";

export function getBannedSubreddits(): Set<string> {
  return new Set(
    (getSetting(BANNED_KEY) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function banSubreddit(sub: string): void {
  const banned = getBannedSubreddits();
  banned.add(sub.trim().toLowerCase());
  setSetting(BANNED_KEY, [...banned].join(","));
}

// ---------------- events / stats ----------------

export function addEvent(kind: string, detail: string): void {
  db.prepare("INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)").run(now(), kind, detail);
}

export function countEventsSince(kind: string, sinceMs: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ?")
      .get(kind, sinceMs) as { n: number }
  ).n;
}

export function stats(): Record<string, number> {
  const counts = db
    .prepare("SELECT status, COUNT(*) AS n FROM candidates GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const out: Record<string, number> = { total: 0 };
  for (const row of counts) {
    out[row.status] = row.n;
    out.total += row.n;
  }
  const leads = db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
  out.leads = leads.n;
  const contacted = db
    .prepare("SELECT COUNT(*) AS n FROM contacts WHERE state = 'contacted'")
    .get() as { n: number };
  out.contacted = contacted.n;
  const replied = db
    .prepare("SELECT COUNT(*) AS n FROM contacts WHERE state = 'replied'")
    .get() as { n: number };
  out.replied = replied.n;
  return out;
}

// ---------------- hygiene ----------------

/** Truncate raw bodies older than 90 days — dedupe keys/titles/states retained. */
export function pruneOldBodies(): void {
  const cutoff = now() - 90 * 24 * 3600_000;
  db.prepare(
    "UPDATE candidates SET body = '' WHERE created_at < ? AND length(body) > 0"
  ).run(cutoff);
}
