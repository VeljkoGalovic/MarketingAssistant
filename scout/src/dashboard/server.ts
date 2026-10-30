/**
 * LAN web dashboard (user request 2026-10): server-rendered, zero-dependency,
 * token-gated. Binds per SCOUT_DASHBOARD_BIND (default: all LAN interfaces).
 * Access: http://<scout-box-ip>:8788 — login once with the dashboard token.
 *
 * Token source: SCOUT_DASHBOARD_TOKEN, or auto-generated on first boot and
 * written to data/dashboard-token.txt (0600) — printed once to stdout.
 *
 * Everything is read-mostly with a small set of guarded write actions
 * (skip/approve/ban/draft ops/kill switch/DNC). Same-origin POST checks.
 */
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { config, isDryMode, canPostReddit } from "../config.ts";
import {
  addEvent,
  banSubreddit,
  candidatesSince,
  countEventsSince,
  exportContactsCsv,
  expireOldDrafts,
  getCandidateById,
  getDraftById,
  getBannedSubreddits,
  getSetting,
  setCandidateStatus,
  setDraftStatus,
  setSetting,
  stats,
  type Candidate,
} from "../db.ts";
import { approveAndPrepare, postDraft, regenerateDraft, updateDraftBody, posterPaused, setPosterPaused } from "../poster.ts";
import { canaryFor, isKillOn, type CanaryStatus } from "../health.ts";
import { listWatchItems, addWatchItem, removeWatchItem } from "../db.ts";
import { lintDraft } from "../drafts/provider.ts";

const sessions = new Set<string>();
const COOKIE = "scout_dash";

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ensureToken(): string {
  if (config.dashboard.token) return config.dashboard.token;
  const file = `${config.dataDir}/dashboard-token.txt`;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const tok = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, tok + "\n", { mode: 0o600 });
  console.log(`[dashboard] first boot: dashboard token written to ${file} (mode 600)`);
  return tok;
}

const page = (title: string, nav: string, body: string, msg = "") => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · LodgeTrack Scout</title><style>
body{font:14px/1.5 system-ui;color:#0f172a;margin:0;background:#f8fafc}
header{background:#0f172a;color:#fff;padding:10px 18px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header a{color:#cbd5e1;text-decoration:none;padding:4px 8px;border-radius:6px}
header a.on,header a:hover{background:#1e293b;color:#fff}
.pill{font-size:12px;padding:2px 10px;border-radius:99px}
main{max-width:1100px;margin:24px auto;padding:0 16px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgb(0 0 0/.08)}
th,td{padding:9px 10px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
th{background:#f1f5f9;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#475569}
form.inline{display:inline}
button{cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:4px 10px;font-size:12px}
button.primary{background:#0f766e;color:#fff;border-color:#0f766e}
button.danger{background:#b91c1c;color:#fff;border-color:#b91c1c;color:#fff}
.card{background:#fff;border-radius:10px;padding:16px 20px;box-shadow:0 1px 3px rgb(0 0 0/.08);margin-bottom:16px}
.msg{background:#dcfce7;border:1px solid #16a34a;border-radius:8px;padding:8px 12px;margin-bottom:12px}
.draft{white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin:6px 0}
.tag{font-size:11px;background:#e2e8f0;border-radius:99px;padding:1px 8px;color:#475569}
input,select,textarea{padding:6px;border:1px solid #cbd5e1;border-radius:6px;font:13px system-ui}
.badge-green{background:#dcfce7;color:#166534}.badge-yellow{background:#fef9c3;color:#854d0e}
.badge-red{background:#fee2e2;color:#991b1b}.badge-na{background:#e2e8f0;color:#475569}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
.stat{background:#fff;border-radius:10px;padding:12px 16px;box-shadow:0 1px 3px rgb(0 0 0/.08)}
.stat b{font-size:22px;display:block}
.muted{color:#64748b;font-size:12px}
</style></head><body>
<header>
  <strong>LodgeTrack Scout</strong>
  <a href="/queue">Queue</a><a href="/drafts">Drafts</a><a href="/leads">Leads</a>
  <a href="/health">Health</a><a href="/events">Events</a><a href="/settings">Settings</a>
  <span style="margin-left:auto">${nav}</span>
</header>
<main>
${msg ? `<div class="msg">${msg}</div>` : ""}
${body}
</main></body></html>`;

function navActions(): string {
  const kill = isKillOn();
  const killBtn = kill
    ? `<form class="inline" method="post" action="/kill"><input type="hidden" name="on" value="0"><button class="primary">🟢 Resume</button></form>`
    : `<form class="inline" method="post" action="/kill"><input type="hidden" name="on" value="1"><button class="danger">🔴 Kill switch</button></form>`;
  return `<span class="pill ${kill ? "badge-red" : "badge-green"}">${kill ? "KILLED" : "active"}</span> ${killBtn}
    <form class="inline" method="post" action="/logout"><button>Logout</button></form>`;
}

function statusChip(c: Candidate): string {
  const color = c.status === "pending" ? "badge-na" : c.status === "notified" ? "badge-yellow" : c.status.startsWith("posted") ? "badge-green" : "badge-na";
  return `<span class="tag ${color}">${esc(c.status)}</span>`;
}

// ---------- view bodies ----------

function queuePage(rows: Candidate[]): string {
  return `<div class="card">
  <h3 style="margin:0 0 10px">Candidates (${rows.length})</h3>
  <table><tr><th>When</th><th>Score</th><th>Title</th><th>Source</th><th>Matched</th><th>Status</th><th>Actions</th></tr>
  ${rows
    .map(
      (c) => `<tr>
      <td class="muted">${new Date(c.created_at).toISOString().slice(5, 16).replace("T", " ")}</td>
      <td><b>${c.score}</b></td>
      <td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title.slice(0, 70))}</a>${c.subreddit ? `<div class="muted">r/${esc(c.subreddit)} · u/${esc(c.author)}</div>` : ""}</td>
      <td class="muted">${esc(c.source)}</td>
      <td class="muted">${esc(c.matched_keywords.slice(0, 60))}</td>
      <td>${statusChip(c)}</td>
      <td>
        ${c.status === "pending" || c.status === "notified" ? `
        <form class="inline" method="post" action="/action/approve"><input type="hidden" name="id" value="${c.id}"><input type="hidden" name="src" value="queue"><button class="primary">✍️ Draft</button></form>
        <form class="inline" method="post" action="/action/skip"><input type="hidden" name="id" value="${c.id}"><input type="hidden" name="src" value="queue"><button>⏭ Skip</button></form>
        ${c.subreddit ? `<form class="inline" method="post" action="/action/ban"><input type="hidden" name="sub" value="${esc(c.subreddit)}"><input type="hidden" name="id" value="${c.id}"><input type="hidden" name="src" value="queue"><button>🚫 Ban r/${esc(c.subreddit)}</button></form>` : ""}` : ""}
      </td></tr>`
    )
    .join("")}
  ${rows.length ? "" : "<tr><td colspan=7 class='muted'>No candidates yet. Pollers run every ~10 min once Reddit is reachable.</td></tr>"}
  </table></div>`;
}

function draftsPage(rows: Array<Record<string, unknown>>): string {
  return `<div class="card"><h3 style="margin:0 0 10px">Drafts (${rows.length}) — 48h expiry</h3>
  <table><tr><th>ID</th><th>Channel</th><th>Body</th><th>Provider</th><th>Status</th><th>Expires</th><th>Actions</th></tr>
  ${rows
    .map(
      (d) => `<tr><td class="muted">#${d.id}</td>
      <td><span class="tag">${esc(String(d.channel))}</span></td>
      <td class="draft">${esc(String(d.body))}${lintDraft(String(d.body)).length ? `<div class="warn">⚠️ tone-lint: ${esc(lintDraft(String(d.body)).join("; "))}</div>` : ""}</td>
      <td class="muted">${esc(String(d.provider ?? ""))}</td>
      <td><span class="tag">${esc(String(d.status))}</span></td>
      <td class="muted">${new Date(Number(d.expires_at)).toISOString().slice(5, 16).replace("T", " ")}</td>
      <td>
        <form class="inline" method="post" action="/draft/regen"><input type="hidden" name="id" value="${d.id}"><input type="hidden" name="src" value="drafts"><button>🔁 Regen</button></form>
        ${d.channel === "reddit" && (d.status === "drafted" || d.status === "edited" || d.status === "approved") ?
          (canPostReddit
            ? `<form class="inline" method="post" action="/draft/post"><input type="hidden" name="id" value="${d.id}"><input type="hidden" name="src" value="drafts"><button class="primary">📲 Post</button></form>`
            : `<span class="tag">📋 copy → paste as your comment (Plan B)</span>`)
          : ""}
        ${d.status !== "sent" && d.status !== "rejected" ? `<form class="inline" method="post" action="/draft/discard"><input type="hidden" name="id" value="${d.id}"><input type="hidden" name="src" value="drafts"><button>✖️</button></form>` : ""}
      </td></tr>
      <tr><td colspan="7">
      <form method="post" action="/draft/edit" class="inline" style="width:100%">
        <input type="hidden" name="id" value="${d.id}"><input type="hidden" name="src" value="drafts">
        <textarea name="body" style="width:95%" rows="2">${esc(String(d.body))}</textarea>
        <button>✏️ Save edit</button></form></td></tr>`
    )
    .join("")}
  ${rows.length ? "" : "<tr><td colspan=7 class='muted'>No drafts. Draft from the Queue.</td></tr>"}
  </table></div>`;
}

function leadsPage(rows: Array<Record<string, unknown>>): string {
  return `<div class="card"><h3 style="margin:0 0 10px">Leads (${rows.length})</h3>
  <a href="/leads.csv"><button>⬇️ Export CSV</button></a>
  <table style="margin-top:10px"><tr><th>Name</th><th>City</th><th>Email</th><th>Domain</th><th>Phone</th><th>State</th><th></th></tr>
  ${rows
    .map(
      (l) => `<tr><td>${esc(String(l.name))}</td><td class="muted">${esc(String(l.city ?? ""))}</td>
      <td>${esc(String(l.email ?? ""))}</td><td class="muted">${esc(String(l.domain ?? ""))}</td>
      <td class="muted">${esc(String(l.phone ?? ""))}</td>
      <td><span class="tag">${esc(String(l.state ?? "org-only"))}</span></td>
      <td><form class="inline" method="post" action="/lead/dnc"><input type="hidden" name="entity" value="${l.entity_id}"><button class="danger">DNC</button></form></td></tr>`
    )
    .join("")}
  ${rows.length ? "" : "<tr><td colspan=7 class='muted'>Lead-finder runs weekly once SCOUT_LEADFINDER_ENABLED=1.</td></tr>"}
  </table></div>`;
}

function healthPage(msg: string): string {
  const s = stats();
  const platforms = ["linkedin", "x", "facebook", "reddit"] as const;
  const chip = (v: CanaryStatus) => `<span class="tag badge-${v === "n/a" ? "na" : v}">${v}</span>`;
  const removals7d = countEventsSince("removal", Date.now() - 7 * 24 * 3600_000);
  return `<div class="grid">
  <div class="stat">Candidates<b>${s.total}</b></div>
  <div class="stat">Pending<b>${s.pending ?? 0}</b></div>
  <div class="stat">Posted<b>${s.posted ?? 0}</b></div>
  <div class="stat">Leads<b>${s.leads ?? 0}</b></div>
  <div class="stat">Contacted<b>${s.contacted ?? 0}</b></div>
  <div class="stat">Replied<b>${s.replied ?? 0}</b></div>
  </div>
  <div class="card"><h3 style="margin:0 0 10px">Extraction canary (extension)</h3>
  <table><tr><th>Platform</th><th>Status</th><th class="muted">meaning</th></tr>
  ${platforms
    .map(
      (p) =>
        `<tr><td>${p}</td><td>${chip(canaryFor(p))}</td><td class="muted">${p === "reddit" ? "server poller lane" : "extension rows/session"}</td></tr>`
    )
    .join("")}
  </table>
  <div class="muted" style="margin-top:8px">red = 3 consecutive zero-row sessions → do the 1-minute manual login check</div></div>
  <div class="card"><h3 style="margin:0 0 10px">Guards</h3>
  <ul>
    <li>Reddit posting: ${canPostReddit ? (posterPaused() ? "⏸ PAUSED (removals trigger)" : "▶ armed") : "Plan B — assisted-manual paste (no Reddit developer app; decision 2026-10-31)"} · removals 7d: ${removals7d}</li>
    <li>Kill switch: ${isKillOn() ? "🔴 ON" : "🟢 off"}</li>
    <li>Telegram: ${isDryMode ? "❌ not configured (dry mode)" : "✅ connected"}</li>
    <li>LLM: ${config.llm.google.key ? "Google AI Studio" : config.llm.groq.key ? "Groq" : config.llm.cloudflare.accountId ? "Cloudflare" : "KB fallback (deterministic)"}</li>
    <li>Draft expiry sweep: <form class="inline" method="post" action="/expire"><button>Run now</button></form></li>
  </ul>${msg ? `<div class="msg">${msg}</div>` : ""}</div>`;
}

function settingsPage(): string {
  const caps = config.caps;
  return `<div class="card"><h3 style="margin:0 0 10px">Effective configuration (from .env — edit file + restart)</h3>
  <table><tr><th>Key</th><th>Value</th></tr>
  ${[
    ["Caps — reddit/sub/day", caps.redditPerSubDay],
    ["Caps — drafts LinkedIn/day", caps.draftsLinkedInDay],
    ["Caps — drafts X/day", caps.draftsXDay],
    ["Caps — drafts FB/day", caps.draftsFBDay],
    ["Caps — email first-touch/day", caps.emailFirstTouchDay],
    ["Score threshold", config.reddit.scoreThreshold],
    ["Poll interval (min)", config.reddit.pollIntervalMin],
    ["Quiet hours", `${config.quiet.startHour}:00–${config.quiet.endHour}:00 (${config.quiet.timezone})`],
    ["Recap / digest hours", `${config.quiet.recapHour}:00 / ${config.quiet.digestHour}:00`],
    ["Draft expiry (h)", config.drafts.expireHours],
    ["Subreddits", config.reddit.subreddits.join(", ")],
    ["Banned subreddits", [...getBannedSubreddits()].join(", ") || "none"],
    ["Leadfinder", config.leadfinder.enabled ? `on, every ${config.leadfinder.intervalDays}d, cities: ${config.leadfinder.cities}` : "off"],
    ["Removals trigger", `${config.poster.removalsPerDays} in ${config.poster.removalWindowDays}d → poster pause`],
    ["Ingest", config.ingest.enabled ? `${config.ingest.bind}:${config.ingest.port}` : "disabled"],
  ]
    .map(([k, v]) => `<tr><td>${esc(String(k))}</td><td>${esc(String(v))}</td></tr>`)
    .join("")}
  </table></div>
  <div class="card"><h3 style="margin:0 0 10px">Watchlist (Telegram /watch mirrors this)</h3>
  <form method="post" action="/action/watch" class="inline">
    <input name="kind" placeholder="kind (subreddit|group|search|city)" required>
    <input name="value" placeholder="value" required>
    <button>Add</button></form>
  <table style="margin-top:10px"><tr><th>Kind</th><th>Value</th><th></th></tr>
  ${listWatchItems()
    .map((w) => `<tr><td>${esc(w.kind)}</td><td>${esc(w.value)}</td><td><form class="inline" method="post" action="/action/watch-rm"><input type="hidden" name="id" value="${w.id}"><button>Remove</button></form></td></tr>`)
    .join("")}
  </table></div>`;
}

// ---------- server ----------

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(data)) out[k] = v;
      resolve(out);
    });
  });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function startDashboardServer(): void {
  if (config.dashboard.disabled) {
    addEvent("boot", "dashboard disabled by env");
    return;
  }
  const TOKEN = ensureToken();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "lan"}`);
    const path = url.pathname;
    const cookies = parseCookies(req);
    const authed = cookies[COOKIE] && sessions.has(cookies[COOKIE]);
    const host = req.headers.host ?? "";
    const origin = req.headers.origin ?? "";
    const sameOrigin =
      !origin || (() => {
        try {
          return new URL(origin).host === host;
        } catch {
          return false;
        }
      })();

    // ---- login ----
    if (path === "/login" || (path === "/" && !authed)) {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (safeEqual(body.token ?? "", TOKEN)) {
          const sid = crypto.randomBytes(24).toString("hex");
          sessions.add(sid);
          res.setHeader("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`);
          res.writeHead(302, { Location: "/queue" });
          res.end();
          addEvent("dashboard", "login");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(page("Login", "", `<div class="card"><h3>Login</h3><form method="post" action="/login">
          <input type="password" name="token" placeholder="dashboard token" autofocus><button>Sign in</button></form>
          <p class="muted">Token: data/dashboard-token.txt on the box, or SCOUT_DASHBOARD_TOKEN in .env.</p></div>`));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Login", "", `<div class="card"><h3>LodgeTrack Scout — sign in</h3>
        <form method="post" action="/login"><input type="password" name="token" placeholder="dashboard token" autofocus>
        <button>Sign in</button></form>
        <p class="muted">LAN-only service. Token lives in data/dashboard-token.txt (or SCOUT_DASHBOARD_TOKEN in .env).</p></div>`));
      return;
    }

    if (path === "/logout") {
      if (cookies[COOKIE]) sessions.delete(cookies[COOKIE]);
      res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Max-Age=0; Path=/`);
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    if (!authed) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    // CSRF: same-origin POSTs only
    if (req.method === "POST" && !sameOrigin) {
      res.writeHead(403);
      res.end("cross-origin POST blocked");
      return;
    }

    const redirect = (loc: string, msg?: string) => {
      if (msg) {
        const sep = loc.includes("?") ? "&" : "?";
        res.writeHead(302, { Location: `${loc}${sep}msg=${encodeURIComponent(msg)}` });
      } else res.writeHead(302, { Location: loc });
      res.end();
    };

    // ---- write actions ----
    if (req.method === "POST") {
      const body = await readBody(req);
      const back = (body.src ?? "/queue").startsWith("/") ? body.src ?? "/queue" : "/" + body.src;
      try {
        switch (path) {
          case "/kill": {
            setSetting("kill_switch", body.on === "1" ? "1" : "0");
            addEvent("killswitch", `dashboard /kill on=${body.on}`);
            redirect("/queue", `Kill switch ${body.on === "1" ? "ON — everything paused" : "OFF — resumed"}`);
            return;
          }
          case "/expire": {
            const n = expireOldDrafts();
            redirect("/health", `${n} stale drafts expired`);
            return;
          }
          case "/action/skip": {
            setCandidateStatus(Number(body.id), "skipped");
            redirect(back, `Candidate #${body.id} skipped`);
            return;
          }
          case "/action/ban": {
            banSubreddit(body.sub ?? "");
            if (body.id) setCandidateStatus(Number(body.id), "skipped");
            redirect(back, `r/${body.sub} banned`);
            return;
          }
          case "/action/approve": {
            const c = getCandidateById(Number(body.id));
            if (!c) {
              redirect(back, "Candidate missing");
              return;
            }
            const prepared = await approveAndPrepare(c);
            redirect(back, prepared.ok ? `Draft #${prepared.draft?.id} ready in Drafts` : `⚠ ${prepared.reason ?? "failed"}`);
            return;
          }
          case "/draft/post": {
            const result = await postDraft(Number(body.id));
            redirect(back, result.ok ? `Posted ✅ comment ${result.commentId}` : `⚠ ${result.reason ?? "failed"}`);
            return;
          }
          case "/draft/regen": {
            await regenerateDraft(Number(body.id));
            redirect(back, "Draft regenerated");
            return;
          }
          case "/draft/discard": {
            const d = getDraftById(Number(body.id));
            setDraftStatus(Number(body.id), "rejected");
            if (d?.candidate_id) setCandidateStatus(d.candidate_id, "skipped");
            redirect(back, "Draft discarded");
            return;
          }
          case "/draft/edit": {
            updateDraftBody(Number(body.id), (body.body ?? "").slice(0, 4000), "dashboard-edit");
            redirect(back, "Draft saved");
            return;
          }
          case "/lead/dnc": {
            const { upsertContact } = await import("../db.ts");
            upsertContact(Number(body.entity), "email", "do_not_contact", "dashboard DNC");
            redirect("/leads", "Marked do-not-contact (hard block)");
            return;
          }
          case "/action/watch": {
            addWatchItem(body.kind ?? "subreddit", body.value ?? "");
            redirect("/settings", "Watchlist updated");
            return;
          }
          case "/action/watch-rm": {
            removeWatchItem(Number(body.id));
            redirect("/settings", "Removed");
            return;
          }
          case "/poster/pause": {
            setPosterPaused(body.paused === "1");
            redirect("/health", body.paused === "1" ? "Poster paused" : "Poster active");
            return;
          }
        }
        res.writeHead(404);
        res.end();
      } catch (e) {
        redirect(back, `Error: ${String(e).slice(0, 140)}`);
      }
      return;
    }

    // ---- reads ----
    const msg = url.searchParams.get("msg") ?? "";
    const active = (p: string) => (path === p ? 'class="on"' : "");
    if (path === "/") {
      res.writeHead(302, { Location: "/queue" });
      res.end();
      return;
    }
    if (path === "/queue") {
      const status = url.searchParams.get("status") ?? "";
      const src = url.searchParams.get("source") ?? "";
      const day = Date.now() - 14 * 24 * 3600_000;
      let rows = candidatesSince(day).filter((c) => c.status !== "expired");
      if (status) rows = rows.filter((c) => c.status === status);
      if (src) rows = rows.filter((c) => c.source.startsWith(src));
      const filterForm = `<div class="card" style="padding:10px 16px">
        <form method="get" action="/queue" class="inline">
          status <select name="status">${["", "pending", "notified", "approved", "posted", "posted_removed", "skipped"].map((s) => `<option ${status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
          source <select name="source">${["", "reddit", "extension:", "manual:"].map((s) => `<option ${src === s ? "selected" : ""}>${s}</option>`).join("")}</select>
          <button>Filter</button></form></div>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Queue", navActions(), filterForm + queuePage(rows), esc(msg)));
      return;
    }
    if (path === "/drafts") {
      const { db } = await import("../db.ts");
      const rows = db
        .prepare("SELECT * FROM drafts ORDER BY id DESC LIMIT 50")
        .all() as Array<Record<string, unknown>>;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Drafts", navActions(),
        `<div class="muted card" style="padding:8px 16px">Reddit posts flow automatically after <b>📲 Post</b> (cap + guards apply). LinkedIn/X/FB drafts are copy-paste — the Telegram thread shows the same text.</div>` + draftsPage(rows), esc(msg)));
      return;
    }
    if (path === "/leads") {
      const { db } = await import("../db.ts");
      const rows = db
        .prepare(
          `SELECT e.id AS entity_id, e.name, e.city, e.email_canon AS email, e.domain_canon AS domain,
                  e.phone_canon AS phone, MAX(CASE WHEN c.state IS NOT NULL THEN c.state END) AS state
           FROM entities e LEFT JOIN contacts c ON c.entity_id = e.id
           GROUP BY e.id ORDER BY e.id DESC LIMIT 200`
        )
        .all() as Array<Record<string, unknown>>;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Leads", navActions(), leadsPage(rows), esc(msg)));
      return;
    }
    if (path === "/leads.csv") {
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="lodgetrack-leads.csv"' });
      res.end(exportContactsCsv());
      return;
    }
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Health", navActions(), healthPage(esc(msg))));
      return;
    }
    if (path === "/events") {
      const { db } = await import("../db.ts");
      const rows = db
        .prepare("SELECT ts, kind, detail FROM events ORDER BY id DESC LIMIT 120")
        .all() as Array<{ ts: number; kind: string; detail: string }>;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        page(
          "Events",
          navActions(),
          `<div class="card"><h3 style="margin:0 0 10px">Recent events</h3><table><tr><th>When</th><th>Kind</th><th>Detail</th></tr>${rows
            .map((r) => `<tr><td class="muted">${new Date(r.ts).toISOString().slice(5, 19).replace("T", " ")}</td><td><span class="tag">${esc(r.kind)}</span></td><td>${esc(r.detail)}</td></tr>`)
            .join("")}</table></div>`
        )
      );
      return;
    }
    if (path === "/settings") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Settings", navActions(), settingsPage(), esc(msg)));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/html" });
    res.end(page("404", "", "<div class='card'>Not found.</div>"));
  });

  server.on("error", (e) => {
    addEvent("error", `dashboard: ${String(e)}`);
    console.error(`[dashboard] server error: ${String(e)}`);
  });
  server.listen(config.dashboard.port, config.dashboard.bind, () => {
    addEvent("boot", `dashboard on http://${config.dashboard.bind}:${config.dashboard.port}`);
    console.log(
      `[dashboard] serving on http://${config.dashboard.bind}:${config.dashboard.port} (login with the dashboard token)`
    );
  });
}
