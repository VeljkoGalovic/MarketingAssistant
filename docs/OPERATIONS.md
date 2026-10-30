# LodgeTrack Growth — Operations

Conventions deliberately mirror LodgeTrack's `deploy/vps/README.md`: env discipline
(0600 root-owned `.env`, trailing newline), systemd services, manual deploys with
health checks. Secrets never live in the repo and never reach chat.

## Deploy to veljkoserver (after MVP, first time)

```bash
# on the laptop
git push origin main
# on the box
mkdir -p /opt/lodgetrack-scout && cd /opt/lodgetrack-scout
git clone <repo-url> .   # then keep repo under /opt/lodgetrack-scout/scout
cp .env.example /opt/lodgetrack-scout/.env && chmod 600 /opt/lodgetrack-scout/.env
# edit /opt/lodgetrack-scout/.env — fill: bot token, chat id, ingest token, LLM keys
cp scout/deploy/lodgetrack-scout.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now lodgetrack-scout
journalctl -u lodgetrack-scout -f    # watch boot
```

Deploys after that: `cd /opt/lodgetrack-scout && git pull && systemctl restart lodgetrack-scout`.
No tags/CI for the scout — it shares nothing with the LodgeTrack release pipeline.

## Environment discipline

- File owner: root, mode 600. Trailing newline required (same rule as LodgeTrack).
- `SCOUT_TIMEZONE` drives quiet hours AND recap/digest wall-clock — keep it Europe/Belgrade
  unless the box timezone changes.
- `SCOUT_DISABLED=1` is the boot-level master kill switch; Telegram `/stop` sets the same
  flag at runtime (stored in DB, survives restarts).

## LAN Web Dashboard

The scout serves a browser dashboard (token-gated, server-rendered, zero deps):

- **Default:** `http://<scout-box-ip>:8788` — reachable from any device on the LAN/Tailscale.
- **Token:** `SCOUT_DASHBOARD_TOKEN`, or auto-generated at first boot into
  `data/dashboard-token.txt` (mode 0600) — printed to the log once:
  `journalctl -u lodgetrack-scout | grep dashboard`.
- **Pages:** Queue (filter by status/source; Draft/Skip/Ban-straight-from-the-table),
  Drafts (edit in-place, Regenerate, Post — Reddit only; other platforms show the
  copy-paste draft), Leads (+CSV export, DNC hard-block), Health (stats, extraction
  canary green/yellow/red, guards, LLM provider in use), Events, Settings (effective
  caps from .env, watchlist editor), and the kill-switch toggle in the header.
- **Same-origin policy:** all writes require a dashboard session cookie + same-origin
  POST. All actions also work — identically — through Telegram.

## Daily/Weekly operator runbook (from PLAN §7)

- **Morning (done by 08:00):** open Telegram — recap (07:00) + digest (09:00). Review held cards,
  approve/discuss. 10–15 min LinkedIn session with the extension (feed + 2–3 saved searches +
  target groups). Optionally 5 min X search pass.
- **Red canary in digest** (`platform=red`): 3 consecutive zero-row sessions → do the 1-minute
  manual login check for that platform (account restricted? DOM changed?). Do NOT debug
  selectors on the primary LinkedIn account.
- **Weekly (5 min):** join 1–2 new communities worth watching; `/watch add <kind> <value>`
  (kinds: `subreddit`, `group`, `search`, `city`); glance at removal counter.

## Testing discipline (PLAN §10)

- Selector changes → run against `extension/fixtures/` snapshots offline first.
- New platform adapters → disposable account first; primary accounts only after 3 clean runs.
- Reddit posting → user-nominated test sub before real subs.
- LLM provider swaps → diff drafts against KB fallback on the 10 saved candidates.

## Backups & hygiene

- Nightly: `scout/scripts/backup.sh` (cron 03:15) — SQLite `.backup`, 14-day retention.
- Draft expiry: handled in-daemon every 30 min (48h TTL).
- Bodily pruning: `pruneOldBodies()` daily (raw text >90d truncated; dedupe keys stay).

## Token rotation SOP

1. @BotFather → `/token` → regenerate.
2. Update `SCOUT_TELEGRAM_BOT_TOKEN` in `/opt/lodgetrack-scout/.env` (keep trailing newline).
3. `systemctl restart lodgetrack-scout`; from your chat send `/start`.

## Anti-invariants (never break)

- Extension performs ZERO writes on any platform.
- Drafts expire unapproved after 48h.
- Per-platform caps only. No global cap. Never raise caps to "catch up".
- The scout never touches LodgeTrack prod data (no DIRECT_URL, no prod DB access).
