# LodgeTrack Growth — MV3 Extension

Browser-local, read-only discovery harness (PLAN §7). Runs under your own logged-in
session; no cloud scraping, no cookie handoff, no datacenter IP, no writes — ever.

## Install

**Chrome/Chromium/Brave (persistent):** `chrome://extensions` → Developer mode → **Load unpacked** → this folder. It stays installed until removed.

**Firefox (temporary, dev-mode only):** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `extension/manifest.json`. No separate Firefox manifest needed — the single manifest carries both background keys (`service_worker` for Chrome, `scripts` for Firefox; each browser ignores the other's key). Firefox temporary add-ons are removed on browser restart — re-load after restarting Firefox; for a persistent install use Chrome.

## Setup (once, from the popup)

1. Open the popup → set **Scout endpoint** (e.g. `http://192.168.0.32:8787` — LAN or Tailscale IP of the box) + **ingest token** (`SCOUT_INGEST_TOKEN` in `/opt/lodgetrack-scout/.env` on the box).
2. Status line should read "✅ Scout reachable — batches will flow."
3. Drive normal usage: browse the LinkedIn feed / saved searches / group pages with the extension active. Matches batch locally (IndexedDB, deduped) and flush to `/ingest` every ≤1 minute. The popup's pause button stops capture for the current site (state persists per platform).

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
