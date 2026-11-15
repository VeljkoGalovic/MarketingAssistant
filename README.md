# MarketingAssistant

Marketing automation platform for [LodgeTrack](https://lodgetrack.com): Reddit-first lead
scouting, browser-local multi-platform scraping (MV3 extension), free-LLM drafting, and
Telegram approvals — 100% free stack, human-in-the-loop.

```
Extension (browser, read-only) ──► scout /ingest ─┐
Reddit JSON poller (24/7, server) ────────────────┼─► candidate store (SQLite)
Lead-finder (OSM Overpass, daily sweep) ──────────┘        │
                                                          ▼
                                    draft engine (free LLM API) — social
                                              + cold-email lanes (P7, live)
                                                          │
                                                          ▼
                                          Telegram control center (approve)
                                                          │
                                                          ▼
                          Reddit: auto-post (OAuth, guarded) or assisted paste (decision #12)
                          Email: copy → your mail app (never auto-send)
```

## Layout

| Path | What |
|---|---|
| `scout/` | Node/TypeScript daemon: pollers, dedupe, Telegram bot, drafts, CRM (later phases) |
| `extension/` | MV3 browser extension (Phase 4+): browser-local scraping, read-only, feeds `/ingest` |
| `docs/` | Operations & deployment docs (mirrors LodgeTrack `deploy/vps` conventions) |

## Status / phases

- [x] Design locked (see PLAN.md)
- [ ] **P1 — scout core: Reddit poller + scoring + Telegram feed (this scaffold)**
- [ ] P2 — drafting (free LLM abstraction + knowledge base)
- [ ] P3 — Reddit posting w/ guardrails + account health
- [ ] P4 — extension scaffold + `/ingest` + Reddit mirror adapter
- [ ] P5 — extension adapters: X → LinkedIn → Facebook
- [ ] P6 — lead-finder (OSM) + CRM + stats
- [ ] P7 — email lane (LodgeTrack as entity) — **draft-on-demand live**; IMAP inbound reply parsing pending
- [ ] P8 — tuning/metrics

> Build status: Phases 0–6 code-complete and
> dormant — env-gated (dry mode without Telegram, no posting without Reddit creds,
> leadfinder off by default). **The email lane is live in production** on the scout box
> (`veljkoserver` via Tailscale `100.112.79.18`, `/opt/lodgetrack-scout/scout`, systemd
> `lodgetrack-scout.service`): lead-finder → research → draft-on-demand cold emails in the
> venue's local language, each carrying the early-adopter offer (20% discount + promo code,
> env-configurable), the real founder signature (Veljko Galović · LodgeTrack · Sombor,
> Serbia), a localized legal & privacy / unsubscribe note, and a strictly email-only CTA —
> PLAN decisions #15/#16. Sending stays manual (copy → your mail app, never auto-send).
> Still pending: IMAP inbound reply parsing → CRM state changes. Note: this local checkout
> is behind the deployed tree — the email-lane code exists only on the server (sync pending).

## Quick start

```bash
cd scout
npm install
cp ../.env.example .env      # fill in when you have the artifacts
npm run dev                  # tsx watch
npm start                    # plain tsx
```

No credentials? It runs in **dry mode**: pollers and scoring still work, results land in
SQLite only — no Telegram without a token, no OAuth without Reddit creds.

## Invariants (do not break)

- **Read-only scraping.** The extension never performs a write action (like/DM/post).
- **Nothing publishes without Telegram approval.** Drafts expire after 48h.
- **Cold emails are strictly asynchronous.** No call/meeting/demo offers ever — every email must be answerable by email alone (PLAN decision #16). Sends are manual; no auto-send.
- **Every cold email carries the full signature block** (Veljko Galović · LodgeTrack · Podgorička 3/14, 25000 Sombor, Serbia) and the localized legal & privacy / unsubscribe note, plus the stated early-adopter offer with the promo code verbatim.
- **Quiet hours 23:00–07:00** — buzz suppresses overnight, one morning recap at 07:00.
- **Free stack only.** No paid APIs. LLM = Google AI Studio free tier w/ Groq/Cloudflare fallback.
- **One dedupe/suppression ledger across all channels** (180-day re-contact block, later CRM).
- **Secrets live in a 0600 env file on the box — never in the repo, never in chat.**
