# MarketingAssistant

Marketing automation platform for [LodgeTrack](https://lodgetrack.com): Reddit-first lead
scouting, browser-local multi-platform scraping (MV3 extension), free-LLM drafting, and
Telegram approvals — 100% free stack, human-in-the-loop.

```
Extension (browser, read-only) ──► scout /ingest ─┐
Reddit JSON poller (24/7, server) ────────────────┼─► candidate store (SQLite)
Lead-finder (OSM Overpass, later) ────────────────┘        │
                                                          ▼
                                               draft engine (free LLM API)
                                                          │
                                                          ▼
                                          Telegram control center (approve)
                                                          │
                                                          ▼
                                        Reddit poster (OAuth, guarded) — v1
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
- [ ] P7 — email lane (LodgeTrack as entity)
- [ ] P8 — tuning/metrics

> Build status: Phases 0–6 code-complete and
> dormant — env-gated (dry mode without Telegram, no posting without Reddit creds,
> leadfinder off by default). Phase 7 email lane = contacts/CSV-export + suppression
> in place; outbound send integration deferred until the outreach domain + mailbox
> exist. Phase 8 scales after first live data.

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
- **Quiet hours 23:00–07:00** — buzz suppresses overnight, one morning recap at 07:00.
- **Free stack only.** No paid APIs. LLM = Google AI Studio free tier w/ Groq/Cloudflare fallback.
- **One dedupe/suppression ledger across all channels** (180-day re-contact block, later CRM).
- **Secrets live in a 0600 env file on the box — never in the repo, never in chat.**
