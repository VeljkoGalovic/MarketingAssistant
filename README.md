# MarketingAssistant — LodgeTrack Growth Scout

Marketing automation for [LodgeTrack](https://lodgetrack.com): it finds prospects, drafts
outreach in a human founder voice, and asks for approval before anything goes out —
on a **100% free stack** (OSM + Reddit public JSON + free-tier LLM APIs) with a
**human-in-the-loop** guarantee.

Three lanes run off one daemon (`scout/`):

| Lane | Discovery | Drafting | Publishing |
|---|---|---|---|
| **Reddit/social** | Server-side Reddit JSON poller + MV3 browser extension (read-only capture of LinkedIn/X/Facebook) | Founder-voice comments (LLM + knowledge base, tone-linted) | Reddit: auto-post behind Telegram approval, else assisted paste; others: copy-paste |
| **Email (B2B cold outreach)** | OSM Overpass sweeps of target cities → website crawl → DNS MX verification | Cold emails in the **venue's local language**, early-adopter offer, real signature, legal/unsubscribe note | **Manual always** — copy into your own mail app; the system never sends |
| **Control & CRM** | — | — | Telegram bot (approvals, lead funnel, drafts) + LAN web dashboard; SQLite is the single CRM brain |

```
Extension (browser, read-only) ──► scout /ingest ─┐
Reddit JSON poller (24/7, server) ────────────────┼─► candidate store (SQLite)
Lead-finder (OSM Overpass, daily sweep) ──────────┘        │
                                                          ▼
                                    draft engine (free LLM API) — social
                                              + cold-email lanes
                                                          │
                                                          ▼
                                          Telegram control center (approve)
                                                          │
                        Reddit: auto-post (OAuth, guarded) or assisted paste
                        Email: copy → your mail app (never auto-send)
```

## Repo layout

| Path | What |
|---|---|
| `scout/` | Node/TypeScript daemon: pollers, dedupe, LLM drafting (`src/drafts/`), lead-finder (`src/leadfinder/`), Telegram bot, LAN dashboard, CRM (`src/db.ts`) |
| `scout/kb/` | Founder-voice knowledge base (markdown seeds the LLM prompts) |
| `extension/` | MV3 browser extension: read-only scraping of LinkedIn/X/Facebook, feeds `/ingest` |
| `docs/` | Operations runbook (`OPERATIONS.md`: deploy, env discipline, backups, token rotation) |
| `PLAN.md` | **Single source of truth for decisions** — scope, guardrail numbers, decision log #1–16, what's done vs pending |

## Production deployment

Lives on **`veljkoserver`** (Linux, reachable over Tailscale at `100.112.79.18`, LAN
`192.168.0.32`), deployed at `/opt/lodgetrack-scout/`, run by systemd as
`lodgetrack-scout.service` (`scout/deploy/lodgetrack-scout.service`).

- **Runtime layout on the box:** code = `/opt/lodgetrack-scout/scout/` (a git working tree),
  secrets = `/opt/lodgetrack-scout/.env` (root-owned, 0600, never in git),
  state = `/opt/lodgetrack-scout/data/` (SQLite), crawler binary = `/opt/lodgetrack-scout/bin/`.
- **Git flow (since 2026-11-16):** the canonical remote is a bare repo **on the box**:
  `root@100.112.79.18:/opt/git/marketingassistant.git`. Code on your PC, then:

  ```bash
  git push box main            # from the PC (remote "box" = the bare repo)
  ssh root@100.112.79.18
  cd /opt/lodgetrack-scout && git pull && systemctl restart lodgetrack-scout
  ```

  The box's checkout is production — change it only via `git pull` (plus the ignored
  `.env` / `data/` / `bin/`, which live outside version control by design).
- The GitHub remote (`origin`) mirrors the same history.

## Configuration (env, all optional → dry mode)

Key variables in `/opt/lodgetrack-scout/.env` (see `.env.example` for the full list):

- **Control:** `SCOUT_TELEGRAM_BOT_TOKEN`, `SCOUT_TELEGRAM_CHAT_ID`, `SCOUT_DASHBOARD_TOKEN`,
  `SCOUT_INGEST_TOKEN`; kill switch via Telegram `/stop` or `SCOUT_DISABLED=1`.
- **LLM chain (free tiers):** `SCOUT_GOOGLE_KEY` → Groq → Cloudflare → deterministic KB fallback.
- **Caps/guardrails:** per-platform draft caps, `SCOUT_CAP_EMAIL_FIRST_TOUCH_DAY` (default 20),
  quiet hours 23:00–07:00 Europe/Belgrade, 48h draft expiry, 180-day re-contact suppression.
- **Lead-finder:** `SCOUT_LEADFINDER_ENABLED`, `SCOUT_LEADFINDER_CITIES` (default: Lisbon,
  Barcelona, Valencia, Palma de Mallorca, Faro), `SCOUT_LEADS_DAILY_SURFACED` (default 10/day).
- **Cold-email voice:** `SCOUT_OUTREACH_VALUE_PROP`, `SCOUT_OUTREACH_DISCOUNT` (default 20%),
  `SCOUT_OUTREACH_PROMO_CODE`, `SCOUT_OUTREACH_UNSUBSCRIBE_URL` (optional click-here link).
  Local language per city comes from `CITY_LANGUAGE` in `scout/src/drafts/provider.ts`.

## Operating it (the 15 min/day)

**Telegram** (bound chat only): `/health`, `/queue`, `/leads`, `/lead <id>`, `/draft <url>`,
`/drafttext <title> | <body>`, `/watch add|list|rm`, reply `/edit <text>` on a draft,
`/start`–`/stop` kill switch. Free-text chat is ignored by design — it's a control center,
not a chatbot. Morning recap 07:00, digest 09:00; lead recap surfaces funnel-ready leads with
one-tap "✍️ Pitch" drafting.

**Dashboard:** `http://<box-ip>:8788` (LAN/Tailscale), token login — Queue, Drafts (edit/regen/
copy + mailto assist), Lead funnel, Health (canaries, guards), Events, Settings.

## Guardrails (do not break)

- **Read-only scraping** — the extension never writes (like/DM/post).
- **Nothing publishes without Telegram approval**; drafts expire after 48h.
- **No auto-send, ever** — emails are copied into your mail client by you.
- **Cold emails are strictly asynchronous** — no call/meeting/demo offers, ever
  (PLAN decision #16); every email carries the signature block, localized legal &
  privacy note with unsubscribe, and the promo code verbatim.
- **Per-platform caps only** — never a global cap, never raised to "catch up".
- **Free stack only**; the scout never touches LodgeTrack production data.
- **Secrets stay out of git and chat** — 0600 env file on the box.

## Development

```bash
cd scout
npm install
cp ../.env.example .env      # empty creds → dry mode: everything runs, nothing notifies/posts
npm run dev                  # tsx watch
npm start
```

Testing discipline (details in `docs/OPERATIONS.md`): selector changes run offline against
`extension/fixtures/` snapshots; new platform adapters go through disposable accounts first;
LLM provider changes diff against deterministic KB-fallback drafts.

## Status

Phase 0–6 built and running (social lane partly dormant — Reddit poller throttled, extension
capture on demand). **Email lane live in production** (draft-on-demand, decisions #15/#16);
still pending: IMAP inbound reply parsing → automatic CRM state changes. Current open items
and full decision history: **PLAN.md**.
