# LodgeTrack Growth — MV3 Extension

Browser-local, read-only discovery harness (PLAN §7). Runs under your own logged-in
session; no cloud scraping, no cookie handoff, no datacenter IP, no writes — ever.

## Install (dev)

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Open the popup → set **Scout endpoint** (e.g. `http://127.0.0.1:8787` or the box's
   Tailscale IP) + **ingest token** (from the scout `.env`).
3. Drive normal usage: browse the LinkedIn feed / saved searches / group pages with
   the extension active. Matches batch locally (IndexedDB, deduped) and flush to
   `/ingest` every ≤1 minute.

## Adapters (per-platform files)

| File | Platform | Notes |
|---|---|---|
| `content/linkedin.js` | LinkedIn | feed + search + group posts; role=article fallback |
| `content/x.js` | X | timeline + search tweets |
| `content/facebook.js` | FB groups | joined-groups feed only |
| `content/reddit.js` | Reddit | mirror lane; server poller stays primary |

When a platform ships a DOM change, fix the selector rules in that file only
(selector rot is per-adapter by design). Validate offline against `fixtures/`
snapshots; never debug on the primary LinkedIn/FB account (PLAN §10).

## Invariants

- **Extraction only.** The extension never performs any write action
  (like/DM/repost/comment). If code would do so — stop and revert node.
- Keyword filter runs **before** storage: only matches are kept or sent.
- Walls: login/session expired ⇒ 0 rows ⇒ scout canary turns red ⇒ 1-minute
  manual check by the user (that's the whole failure model).
