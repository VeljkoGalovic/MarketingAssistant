# LodgeTrack Growth — Scope & Implementation Plan (v2)

> Single source of truth. Every open gap raised in review is resolved here with a decision.
> Status decisions below override anything in chat history. Code exists only for Phase 1 scaffold files and is disposable until formally built here.

---

## 1. Goal & success metric

**Business goal:** take marketing off the founder's plate; find leads and convert them to signups.

**Concrete 3-month target (user-adopted):** **$100/month recurring revenue from LodgeTrack** driven by this system.

- Honest read: reasonable starter target, not too small — it forces the full funnel to work (source → draft → contact → reply → signup → paid) without demanding scale. Treat as **calibrating**, not final: we will track input metrics weekly and re-baseline at day 30.
- Funnel proxies we instrument (per week): new leads found / enriched / contacted / replied / signed up / paid. Weekly Telegram digest carries these 6 numbers.
- Month-3 checkpoint: if pipeline input metrics are healthy but revenue lags, the fix is conversion (product/pricing), not marketing scope.

**Anti-goal:** never blast volume. Founder voice, human-approved, per-platform caps only (there is no global cap — see §5).

---

## 2. Platform policy matrix (final)

| Platform | Discovery | Drafting | Publishing | Caps (per-platform, per-day) |
|---|---|---|---|---|
| **Reddit** | Server poller (24/7, JSON/OAuth) | LLM/KB, founder voice | **Automated** comment-only, behind Telegram approval (OAuth script app, old account) | ≤2 comments per subreddit/day |
| **LinkedIn** | MV3 extension (user session) **+ blind build** (no validation-gate) | LLM/KB | Assisted — draft copied, user posts | ≤5 drafts/day |
| **X** | MV3 extension (user session); session-CLI poller is a *documented option*, not built | LLM/KB | Assisted | ≤5 drafts/day |
| **Facebook** | MV3 extension (user session, joined groups) | LLM/KB | Assisted | ≤5 drafts/day |
| **Email** | Lead-finder (OSM) + enrichment | Outreach copy via LLM | LodgeTrack entity via warmed domain; **IMAP inbound parsing** feeds CRM | ≤20 first-touch emails/day (warm-up grows this) |
| **Instagram** | Out of scope v1 (DM automation = ban cluster; revisit only with real business case) | — | — | — |
| **YouTube** | **Dropped** — not a channel for us | — | — | — |

**No global daily cap.** Each platform self-limits; the system total is bounded by the sum of per-platform caps.

**LinkedIn decision (user):** build the adapter **blind** — no Insight Social validation gate. Insight Social stays optional as a parallel sanity-check tool if the user ever wants to compare hit rates.

**X decision (user flagged the gap):** the earlier options (x-cli session-cookie poller, paid starter-API monitor) were deliberately deprioritized, not dropped: X is ranked below LinkedIn and the extension already covers read-from-own-session cheaply. If X proves valuable in practice, the CLI poller gets its own spike — recorded here so it isn't a silent decision.

---

## 3. Decision log — resolution of every raised gap

| # | Gap raised | Resolution |
|---|---|---|
| 1 | Gmail absent | **In scope, inbound only.** Cold outreach sends from the warmed outreach domain (LodgeTrack entity). Replies are parsed by IMAP polling of that mailbox (free, no Gmail API, no personal-account automation): reply detected → Telegram notification + CRM state update (`contacted → replied`). |
| 2 | "Minimal input" not designed | **Accepted as Telegram-centric (user decision).** Reviewing cards in Telegram IS the interface. Optional future: digest-only / high-confidence auto-approve mode once scoring quality is measured — noted as Phase 8 tuning knob, not built now. |
| 3 | Account health Reddit-only | **Account health is all-platform.** Reddit: removal tracking, shadowban probe, promo-ratio guard, removals-fallback trigger. Extension platforms: extraction canary (rows/session), restriction alerts, manual-check prompts. See §6. |
| 4 | Extension runbook unspecified | Defined in §7 — daily 10–15 min routine, health indicators, "adapter alive" definitions. |
| 5 | FB group discovery prerequisite | **User task, done manually before Phase 5:** user joins relevant host/B&B/vacation-rental groups with the secondary account. Scout keeps a `watchlist` of target groups in settings so extraction covers them. |
| 6 | Dedupe across entity types | Full model in §8: `entities` (canonicalized people/orgs) + `contacts` (channel-scoped) + `candidates`. Canonicalization rules + thread↔lead linking rules specified. |
| 7 | No observability | §9: daily heartbeat digest, zero-yield canaries, failure alerts to Telegram, error-event thresholds. |
| 8 | No extension test strategy | §10: fixture-HTML regression tests, disposable-account bring-up, never test selectors on primary LinkedIn/FB accounts. |
| 9 | X underdesigned | Resolved above in §2 (documented deliberate deprioritization). |
| 10 | Kill switch posting-only | **Full kill switch:** Telegram `/stop` stops pollers, pausing `/ingest`, drafts, posting, digests. `/start` resumes. `SCOUT_DISABLED=1` env remains the boot-level master. State persists in DB (survives restarts). |
| 11 | Forward-link flow underspecified | Spec'd in §7.1 — the highest-frequency interaction, designed properly. |

**User corrections applied:** minimal-input mode = Telegram interaction is fine; user joins FB groups manually; YouTube dropped; GDPR treated as non-factor (private system) — one hygiene line kept in §11 (retention pruning) purely as DB hygiene, not compliance.

---

## 4. Cities — lead-finder (final list)

User additions: New York, Miami, Paris, Madrid. Ruling:

- **Paris: dropped.** France's CNIL is among the most aggressive enforcement authorities in the EU and is known for policing scraping/cold-outreach specifically. Not worth it as one city among many.
- **Madrid: kept.** Spain's AEPD is a mainstream EU regulator — no reputation for the scraping/enforcement aggression that motivated the original exclusion. Barcelona stays too. If any friction signal ever appears, Madrid is first to drop.
- Honest note (for the record): GDPR applies EU-wide; the practical differentiator is enforcement aggression, and our low-volume, founder-voice, per-entity approach is about as low-risk as outreach gets anywhere.

**Final list (13):** Lisbon, Barcelona, Madrid, Amsterdam, Prague, Budapest, Zagreb, Split, Athens, Vienna, Nashville, **New York, Miami**.

Wave A (start): Lisbon, Barcelona, Amsterdam, Zagreb, Split — EU OSM coverage is densest there.
Wave B: Madrid, Prague, Budapest, Athens, Vienna. Wave C (US): Nashville, New York, Miami (Places-API fallback likely needed for US coverage gaps).

---

## 5. Guardrails (final numbers)

| Guardrail | Value |
|---|---|
| Comments per subreddit (Reddit) | ≤2/day |
| Draft cards per platform | ≤5/day (LinkedIn/X/FB) |
| First-touch emails | ≤20/day during warm-up, grows with domain reputation |
| Draft expiry | 48h unapproved → expires, logged |
| Quiet hours | 23:00–07:00 (Europe/Belgrade) — no buzz, **morning recap at 07:00** with overnight count + top 3 |
| Removals fallback trigger | **3 removed comments within 7 days** on the active Reddit account → posting automatically pauses and drafts route through the old account pending user confirmation |
| Kill switch | Telegram `/stop` = total stop of everything; `/start` = resume; `SCOUT_DISABLED` env = boot master |
| Extension writes | Zero. Read-only extraction forever. |

---

## 6. Account health (all platforms)

**Reddit (automated lane):**
- Before every approved post: account suspended check (`/user/about.json`), recent karma delta logging.
- After every post: removal/withdrawal tracking; comment removal within 24h increments the removal counter.
- Removals-fallback: counter from §5 → pause + route to old account.
- Promo-ratio guard: if >1 in 4 recent comments on an account mentions LodgeTrack, drafting inserts softer, value-first comments until ratio recovers.

**Extension platforms (LinkedIn first, blind build):**
- Warm-up for the secondary account (user does this manually): 2 weeks of normal human use — join groups, light manual activity — **before** any scraping sessions run.
- Extraction canary: each platform tracks rows-captured per session. **3 consecutive sessions with 0 rows on a platform that historically yields → Telegram alert** "LinkedIn extraction silent: account restricted or DOM changed — do a 1-minute manual login check." This kills the silent-breakage failure mode.
- 401/session-expired detection where detectable (login page redirect) → immediate alert.

---

## 7. Extension daily runbook (the thing that was unspecified)

**Morning routine (user, ~10–15 min, weekdays):**
1. Open LinkedIn: home feed + the 2–3 saved searches + target group pages (watchlist). Scroll naturally 5–10 min with the extension active. Badge shows rows captured.
2. Optionally X: one search pass, 5 min.
3. Extension batches matches → POST to scout `/ingest` (background, token-authed). No manual export.

**"Is it working?" indicators (scout side, surfaced in Telegram digest):**
- Green: platform yielded ≥1 row in last 3 sessions
- Yellow: 0 rows in 1–2 sessions (could be a quiet day)
- Red: 0 rows in 3 consecutive sessions → §6 alert

**Weekly (user, 5 min):** glance at the watchlist/groups; join 1–2 new communities worth covering; update scout watchlist via Telegram command `/watch add <url>`.

### 7.1 Forward-link flow (the daily driver)

User finds a thread while manually scrolling → shares/copies the URL to the bot chat (Telegram share sheet or paste — both work; any message containing a link triggers it):

1. Bot detects platform from the URL and canonicalizes it (dedupe key).
2. Bot fetches content: Reddit → server-side JSON (always works); X/LinkedIn/FB public → attempt server-side HTML fetch (og-tags); login-walled → bot replies "paste the thread text and it'll draft" (later: extension copy-button passes full text).
3. Bot generates a founder-voice draft (LLM w/ KB fallback) and replies in-thread with the draft text + buttons **[Regenerate] [Discard]**.
4. Posting is manual for these platforms (user pastes into the app) — except Reddit links, which enter the standard approval→auto-post queue.
5. Dedupe: the URL is recorded as `source = manual:<platform>`; a later extension match of the same URL is suppressed instead of double-notifying.

---

## 8. Data model (canonicalization + cross-entity dedupe)

```
entities(id, kind[person|org|thread_author], name, domain_canon, email_canon, phone_canon,
         created_at)                      -- canonical identity record
contacts(id, entity_id, channel, state[new|replied|qualified|declined|do_not_contact],
         contacted_at, note)              -- channel-scoped contact ledger
candidates(id, source, external_id, url_canon, title, body, author, subreddit,
           entity_id NULLABLE, linked_lead_id NULLABLE, matched_keywords, score,
           status[pending|notified|skipped|approved|posted|posted_removed|expired],
           created_at, updated_at)
drafts(id, candidate_id, channel, body, status[drafted|edited|approved|sent|expired|rejected],
       provider, expires_at, created_at, updated_at)
watchlist(id, kind[subreddit|group|search|city], value, added_by, created_at)
settings(key, value)                      -- kill switch, banned subs, watchlist JSON, counters
events(id, ts, kind, detail)              -- poll / notify / skip / error / alert / recap / post
```

**Canonicalization rules:**
- Email: lowercase; strip dots/plus-tags only for freemail domains; business domains keep dots.
- Domain: strip scheme/www/path, lowercase, punycode-normalize → registrable domain.
- Phone: digits-only, strip leading country-code variance, keep raw alongside.
- URL/thread: strip tracking params (`utm_*`, `fbclid`, etc.), lowercase host.
- CANONICAL CONTACT KEY = (entity_id) — never the raw string; the entity table owns the mapping from raw → canonical via the rules above.

**Thread ↔ lead linking rule:** when a candidate's author domain/name fuzzy-matches an existing entity (email domain hit, or org-name similarity ≥ threshold), `entity_id` links them. Cross-channel suppression: a lead already `contacted` via email makes same-entity social candidates **soft-blocked** (manual-confirm before drafting); social comment does *not* count as "contacted" for email purposes — channel ledgers stay independent, with 180-day re-contact blocking per channel.

---

## 9. Observability

- **Daily heartbeat digest** (09:00 local): candidates/polls/errors counts, per-platform extraction health (green/yellow/red from §7), kill-switch state.
- **Failure alerts:** poller errors 3× consecutively → alert; any platform canary red → alert; `/ingest` 0 rows for 48h while previously active → prompt.
- **Logging standard:** one-line structured events to SQLite `events` + stdout; errors always carry context (which module, which sub/platform).
- Zero-yield canary compares against each sub's historical fetched volume (a tiny sub yielding 0 posts ≠ broken).

---

## 10. Testing strategy

- **Selector fixtures:** on each adapter bring-up, the real page HTML (saved from the user's session) is committed as a local fixture; selector tests run offline against fixtures. DOM changes → fix rule → green against fixture before touching the real site.
- **Disposable accounts:** any new platform adapter is first exercised against a disposable account. The primary LinkedIn/FB accounts only run adapters after 3 consecutive clean fixture-test iterations.
- **Reddit:** scraping tests hit public JSON (no account at risk); posting tests start in a controlled small sub the user nominates.
- **LLM drafts:** golden-input set (10 saved candidates) with KB fallback drafts as deterministic baseline to diff provider changes against.

---

## 11. Ops hygiene

- **Backups:** nightly `sqlite3 .backup` to `backups/`, keep 14 days; weekly copy off the box (rclone target namespaced later).
- **Retention pruning:** raw `body` text older than 90 days is truncated (dedupe keys, titles, ids, states retained) — spreadsheet bloat control, pure hygiene.
- **Bot token SOP:** token lives in 0600 env file only; if compromised → BotFather `/revoke`, update env, restart service. Bot state (kill switch, settings) lives in DB → survives restarts; `/start` rebinds chat if needed.
- **Rate limiting:** poller honors `Retry-After`, exponential backoff (2^n minutes, 60-min cap) + ±20% jitter, ≥2s between subs. `/ingest`: token-authed, LAN/Tailscale-bound, 600 req/h per token, `429 rate_limited:<seconds>` (mirrors LodgeTrack's pattern).

---

## 12. Implementation phases

Existing scaffold files (config/db/keywords/time/reddit/telegram skeleton) get aligned to this plan during Phase 1 — nothing else built until the user green-lights each phase.

| Phase | Ships | User tasks | Done when |
|---|---|---|---|
| **0 — Config & dry-run skeleton** | Env schema finalized (all credentials optional→run in **dry mode**); kill-switch semantics; systemd unit ready for the box | None | `npm run typecheck` clean; dry-mode run writes candidates to SQLite |
| **1 — Scout core** | Reddit poller (JSON w/ OAuth-optional), scoring/dedupe, SQLite stores, Telegram cards + Skip/Ban, quiet-hours recap, heartbeat, full kill switch | BotFather token (at the end) | A dry week passes without a single false-positive card |
| **2 — Draft engine** | Provider abstraction (Google AI Studio → Groq/Cloudflare → KB fallback); founder-voice KB seeded; Telegram edit/approve; **forward-link flow (§7.1)** | 20–30 seed answers whenever | Forward any Reddit URL → usable draft in-thread |
| **3 — Reddit posting** | Approve→comment via OAuth; caps; 48h expiry; removal tracking; promo-ratio guard; removals-fallback trigger | Nominates test sub; provides OAuth creds | First approved comment live; removals counter visible |
| **4 — Extension scaffold + LinkedIn** | MV3 skeleton, **LinkedIn adapter (blind build)** + Reddit mirror, fixtures+tests, `/ingest` (LAN+token), in-extension keyword filter, IndexedDB, popup | Creates/uploads secondary LinkedIn account; 2-week warm-up; joins FB+LinkedIn groups | LinkedIn rows flow into the same Telegram queue via `/ingest` |
| **5 — Extension platforms** | X adapter, FB adapter; runbook baked into digest | Adds target FB groups to watchlist | All adapter platforms green in heartbeat |
| **6 — Lead-finder + CRM** | OSM Overpass sweeps (Wave A cities) → enrichment → `entities`/`contacts` CRM → Telegram lead cards + weekly funnel digest | Nothing (cities locked in §4) | First enriched lead batch in Telegram |
| **7 — Email lane** | Warm-domain outbound (LodgeTrack entity), suppression shared, IMAP inbound parsing → CRM + alerts | Provides outreach domain + mailbox creds | First reply lands as CRM state change |
| **8 — Tuning** | Keyword tuning from stats, digest-only mode toggle (optional, §3-2), re-baseline against $100 MRR target | Reviews 30/60/90 report | Funnel dashboard + decision point |

Credential/user artifacts all arrive "at the end" (user instruction): every phase ships with dry-mode/mock behavior until the token/secret lands in the 0600 env file.

---

## 13. Open items (none blocking Phase 0–1)

- Test subreddit nomination (Phase 3 user task)
- Seed KB answers (Phase 2 user task, whenever ready)
- Postgres `DIRECT_URL` stays unused — scout never touches LodgeTrack prod DB (unchanged invariant)
