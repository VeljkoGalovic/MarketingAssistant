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
| 12 | Reddit developer-app approval wall (2026-10-31) | **Fork B selected:** no OAuth script app for now. Reddit publishing moves to **assisted-manual paste** (same as LinkedIn/X/FB); polling runs on **RSS** (Reddit's documented feeds) + public JSON — no API keys, no approval, no policy surface. Automated posting auto-awakens only if an honestly-described free-tier app is ever approved (keep Fork A as an option). |
| 13 | External tool evaluation: pendpost / Postiz / Mixpost / adauto (2026-10-31) | **Not adopted as the backbone** — they are publishing layers (schedule/brand-page/post-30+-networks), not community-reply scouts, and the v1 core is discovery + assisted-manual paste, where they add nothing. **Phase 8 outcome:** when own-page publishing automation arrives, re-evaluate **Postiz** (mature agents CLI/MCP, native company pages) vs **pendpost** (approval-gate-first; verify humanizer/circuit-breaker claims then) — feeding them is cheap because approved drafts are just data. Verified: pendpost ✔, Postiz ✔, Mixpost ✔ (MCP in self-host Pro), adauto ✔ (PyPI); AutoBot-AI/CommunityGrowthSkill & BuyerSpotter claims unverified. **Idea adopted today:** deterministic tone-lint ("humanizer") added to the draft pipeline. Optional future head: MCP adapter on the scout so external agents could drive it. |

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

## 14. Execution plan — "15 min/day" operating model (2026-10-31 evening)

Operator commit: ~15 min/day on marketing. Everything else must be automatic or get cut.

### Already live (verified this evening)
- Reddit server lane: RSS/JSON poller runs unattended (4 seeded subs); Reddit edge currently
  throttles our IP (429/403 bursts) — poller backoffs correctly; treat as best-effort lane.
- Telegram control center: bound to chat, quiet hours active, cards + recap 07:00 + digest 09:00.
- Ingest: LAN-wide 0.0.0.0:8787, healthz 200 from laptop; extension host perms shipped.
- Tone-lint ("humanizer") on all drafts (Telegram cards + dashboard).
- Kill switch, per-platform caps, dedupe, CRM canonicalization — running.

### Morning block 1 — finish bring-up (user + agent, ~30 min)
1. Popup Save&Test → confirm "✅ Scout reachable".
2. First capture session (15-min loop rehearsal): 5 min LinkedIn secondary-account lap
   (saved search + one host group) + quick Reddit sanity pass.
3. Verify rows land: dashboard Queue shows extension:* rows; canary green.
4. If LinkedIn rows = 0 while relevant content was browsed → fixture-based selector tuning.

### Morning block 2 — friction-killers (agent, ~1 h, no typing required from you)
5. Draft card: "Open candidate" URL button → tap Draft, tap Open, long-press copy, paste.
6. Session nudge: if zero extension rows captured by 20:00 local, one gentle Telegram ping.
   Not a nag — fires once, only when the day produced nothing to work with.
7. Dashboard drafts: Copy-to-clipboard button (desktop paste-lane convenience).

### Morning block 3 — volume expansion (agent, needs your go once)
8. Enable OSM lead-finder (SCOUT_LEADFINDER_ENABLED=1) + first city sweep → unattended
   discovery into CRM; host-name + city seeded from decision list.
9. Watchlist growth: /watch add as you notice subreddits/groups worth covering.

### Verification block (same day, low effort)
10. Confirm 07:00 recap + 09:00 digest arrive to the bound chat.
11. Token rotation (Telegram bot + Google AI key both transited chat) → BotFather /revoke +
    new key into .env, redeploy. Do AFTER the pipeline is proven.

### Next sprints (gated on real usage data, not on time)
- Removal/reply scanner (OAuth-only; keep dormant until a Reddit app is ever approved).
- Email outbound lane — blocked until a warmed outreach domain exists (never Gmail automation).
- Phase 8 own-page publishing eval: Postiz (mature, company pages) vs pendpost (approval-gate)
  — decision #13. Not before pipeline proves yield.
- Metrics to watch weekly: candidates/week, draft-approve rate, paste-through rate, replies.
  North star: $100/mo recurring within 3 months (tracked in CRM stages).

### Operating loop (the 15 min)
- 07:00 recap lands → tap Draft on the best 2–3 candidates while coffee cools (~5 min).
- One 5–8 min LinkedIn lap on the secondary account (saved searches + one group) with the
  extension loaded — capture is passive; approve/answer cards as they arrive (~10 min).
- Done. Reddit discovery, drafting, reminders, CRM, nudges: all automatic.

## 15. Decision log (continued)

| # | Decision | Resolution |
|---|---|---|
| 14 | Lead Research & Email Outreach Lane (2026-11-02) | **Adopted with modifications.** Pipeline: daily OSM sweep (1 city/day rotating, NOT weekly batch) → polite crawl (kevincobain2000/email_extractor Go binary, -depth=1 -sleep, replaces/augments in-process enrichWebsite) → DNS MX gate via **Node built-in `dns.promises.resolveMx()`** (dnsrobot/hackertarget/rapid-email-verifier REJECTED: external deps we don't need / unknown hosted services) → research note (Gemini, category+city+machine-readable site signals, zero fabrication) → **draft-on-demand** (lead recap card "✍️ Pitch", not batch-generation) → Telegram card [Copy subject]/[Copy body] + email as plain text (Telegram inline URL buttons reject `mailto:` — dashboard Drafts row carries the real "Open mail app (mailto:)" button). **User choices:** drafts in the **local language** of the venue (Lisbon→PT, Barcelona→ES, Valencia→ES, Zagreb/Split→HR) with English gloss shown beneath; **Amsterdam swapped for Valencia** (NL is opt-in-strict for B2B email). **Status funnel** on `contacts.state`: `new → enriched → sent → responded / bounced / not_interested / bought / skip` — dashboard Pipeline board per column with conversion feed into the $100/mo metric. **Pacing budget:** 10 leads/day surfaced (`SCOUT_LEADS_DAILY_SURFACED`); excess leads stay queued as `enriched` and surface on later days. **Guardrails inherited:** 20/day first-touch cap, no auto-send ever (mailto = assist in your mail client), 48 h draft expiry, `/stop` kills the whole lane, 180-day domain hold on skip/bounce/no-email. **Retry rule:** crawler no-email + MX fail → `skip`, no re-probe for 180 days. Data model = **columns on existing entities/contacts** (no parallel leads table) to keep one CRM brain. |

### Decision #14 — pre-build verification results (2026-11-02)
- `email_extractor-linux-amd64` v3.4 (7.3 MB) downloaded to `/opt/lodgetrack-scout/bin/`, runs clean on the box,
  honors `-depth/-sleep/-timeout/-limit-urls` (our politeness model). Stays outside `scout/` so rsyncs never clobber it.
- Telegram inline URL buttons: **`mailto:` → HTTP 400 `BUTTON_URL_INVALID` (live-tested).** https buttons work.
  Confirmed build shape: Telegram card = [Copy subject]/[Copy body] + recipient as long-press text;
  Dashboard Drafts row carries the real "Open mail app (mailto:)" button (phone browser prefills the compose window).
- Box reachable via LAN-ssh only when the laptop is home; Tailscale `100.112.79.18` is the reliable path — keep
  both SSH routes in the ops runbook (`OPERATIONS.md`).
