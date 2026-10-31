/**
 * Telegram control center (Phases 1–4, PLAN §3/§5/§7):
 *   • candidate cards (Reddit: approve→draft→post; extension/manual: draft→copy)
 *   • forward-link flow: paste any thread URL → immediate founder-voice draft
 *   • draft messages: [Post] [Regenerate] [Discard]; reply "/edit <text>" to revise
 *   • commands: /start /stop (kill switch) /health /queue /watch (add|list|rm)
 *   • quiet hours: cards held; morning recap 07:00; daily digest 09:00
 *   • only the configured chat id is ever served; long-poll Bot API
 */
import { config, isDryMode, canPostReddit } from "./config.ts";
import {
  addEvent,
  banSubreddit,
  candidatesSince,
  countExtensionRowsSince,
  createDraft,
  getBannedSubreddits,
  getCandidateById,
  getDraftByMessageId,
  getDraftById,
  getSetting,
  insertCandidate,
  listWatchItems,
  addWatchItem,
  removeWatchItem,
  setCandidateStatus,
  setDraftMessageId,
  setSetting,
  stats,
  setDraftStatus,
  type Candidate,
} from "./db.ts";
import { fetchThreadByUrl } from "./reddit.ts";
import {
  approveAndPrepare,
  postDraft,
  regenerateDraft,
  updateDraftBody,
  canPostToSub,
  posterPaused,
} from "./poster.ts";
import { generateDraft, lintDraft } from "./drafts/provider.ts";
import { isKillOn } from "./health.ts";
import { isQuietHour } from "./time.ts";

const API = () => `https://api.telegram.org/bot${config.telegram.botToken}`;

/** Chat id resolution: DB binding (first-contact auto-bind) beats the env value. */
function chatTarget(): string {
  return getSetting("telegram_chat_id") || config.telegram.chatId || "";
}

/** Auto-bind: the FIRST private-chat message from the founder bonds this chat forever. */
export async function maybeBindChat(
  chat: { id: number; type?: string; username?: string } | undefined
): Promise<boolean> {
  if (!chat || chat.type !== "private") return false;
  if (getSetting("telegram_chat_id") || config.telegram.chatId) return false;
  setSetting("telegram_chat_id", String(chat.id));
  addEvent("bind", `telegram chat ${chat.id} (@${chat.username ?? "?"}) bound on first contact`);
  await sendText(
    `🔗 <b>Bound to this chat.</b> Cards start flowing here (quiet hours ${config.quiet.startHour}:00–${config.quiet.endHour}:00, morning recap after). Use /health anytime.` );
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function tg<T>(method: string, payload: unknown): Promise<T> {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
  return j.result as T;
}

// ---------------- text builders ----------------

export function candidateCardText(c: Candidate): string {
  return [
    `🆕 <b>${escapeHtml(c.title)}</b>`,
    `${c.subreddit ? `r/${c.subreddit} · ` : ""}u/${c.author || "?"} · score <b>${c.score}</b>`,
    `source: ${c.source}`,
    c.matched_keywords ? `matched: ${escapeHtml(c.matched_keywords)}` : "",
    c.body ? `\n<i>${escapeHtml(c.body.slice(0, 400))}</i>` : "",
    `\n${escapeHtml(c.url)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function draftText(d: { id: number; channel: string; provider: string | null; body: string; expires_at: number }): string {
  const exp = new Date(d.expires_at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const lint = lintDraft(d.body);
  const lintLine = lint.length
    ? `⚠️ <b>tone-lint:</b> ${escapeHtml(lint.join("; "))}\n`
    : "";
  return [
    `✍️ <b>Draft #${d.id}</b> · ${d.channel} · via ${d.provider ?? "?"} · expires ${exp}`,
    "",
    lintLine,
    `<pre>${escapeHtml(d.body)}</pre>`,
    "",
    "reply <code>/edit &lt;text&gt;</code> to this message to revise.",
  ].join("\n");
}

// ---------------- sending ----------------

async function sendMessage(payload: Record<string, unknown>): Promise<number | null> {
  if (isDryMode) return null;
  const msg = (await tg<any>("sendMessage", {
    chat_id: chatTarget(),
    text: payload.text ?? "",
    parse_mode: payload.parse_mode ?? "HTML",
    disable_web_page_preview: true,
    ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
  })) as { message_id: number };
  return msg.message_id;
  return msg.message_id;
}

export function isRedditSource(source: string): boolean {
  return source === "reddit" || source.startsWith("manual:reddit");
}

export async function notifyCandidateCard(c: Candidate): Promise<void> {
  // kill switch or quiet hours → hold as pending (recap/digest handles surfacing)
  if (isKillOn() || isQuietHour()) {
    addEvent("notify", `held candidate ${c.id} (kill=${isKillOn()} quiet=${isQuietHour()})`);
    return;
  }
  try {
    const draftButtons = isRedditSource(c.source)
      ? [{ text: "✅ Approve & draft", callback_data: `approve:${c.id}` }]
      : [{ text: "✍️ Draft for me", callback_data: `approve:${c.id}` }];
    const messageId = await sendMessage({
      chat_id: chatTarget(),
      text: candidateCardText(c),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            ...draftButtons,
            { text: "⏭ Skip", callback_data: `skip:${c.id}` },
            { text: "🚫 Ban sub", callback_data: `bansub:${c.id}:${c.subreddit ?? ""}` },
          ],
          [{ text: "🔗 Open the post", url: c.url }],
        ],
      },
    });
    if (messageId) setCandidateStatus(c.id, "notified");
    addEvent("notify", `candidate ${c.id}`);
  } catch (e) {
    addEvent("error", `card ${c.id}: ${String(e)}`);
  }
}

/** Send a draft message for a candidate; links draft.message_id for /edit. */
async function sendDraftMessage(candidateId: number): Promise<void> {
  const c = getCandidateById(candidateId);
  if (!c) {
    await sendText("Candidate no longer exists.");
    return;
  }
  const gate = approveAndPrepareAndReturn(c);
  const prepared = await gate;
  if (!prepared.ok || !prepared.draft) {
    await sendText(`⚠️ Cannot approve: ${prepared.reason ?? "unknown"}`);
    return;
  }
  const isReddit = isRedditSource(c.source);
  const manualNote = !isReddit
    ? "\n<i>Posting is manual: copy the draft into the app.</i>"
    : canPostReddit
    ? ""
    : "\n<i><b>Reddit Plan B (no API app):</b> copy this draft and post it as your own comment in the thread.</i>";
  const messageId = await sendMessage({
    chat_id: chatTarget(),
    text:
      draftText(prepared.draft) +
      manualNote,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          ...(isReddit && canPostReddit
            ? [{ text: "📲 Post to Reddit", callback_data: `post:${prepared.draft.id}` }]
            : []),
          { text: "🔁 Regenerate", callback_data: `regen:${prepared.draft.id}` },
          { text: "✖️ Discard", callback_data: `discard:${prepared.draft.id}` },
        ],
        [{ text: "🔗 Open the post", url: c.url }],
      ],
    },
  });
  if (messageId) setDraftMessageId(prepared.draft.id, messageId);
}

async function approveAndPrepareAndReturn(c: Candidate) {
  return approveAndPrepare(c);
}

function channelOfSource(source: string): string {
  const m = source.match(/(?:manual|extension):(linkedin|x|facebook|reddit)/);
  return m?.[1] ?? "manual";
}

export async function sendText(text: string): Promise<void> {
  if (isDryMode) {
    addEvent("dry-send", text.slice(0, 120));
    return;
  }
  await tg("sendMessage", {
    chat_id: chatTarget(),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ---------------- recap / digest ----------------

export async function sendRecap(): Promise<void> {
  const since = lastRunBoundary("last_recap", config.quiet.recapHour);
  const overnight = candidatesSince(since).filter((c) => c.status === "pending");
  const n = overnight.length;
  const top = overnight
    .slice(0, 3)
    .map((c) => `• <a href="${escapeHtml(c.url)}">${escapeHtml(c.title)}</a> (${c.score})`)
    .join("\n");
  await sendText([
    `🌅 <b>Morning recap</b> — ${n} new match${n === 1 ? "" : "es"} overnight.`,
    top || "Nothing new while you slept.",
    n > 3 ? `\n…${n - 3} more held (use /queue).` : "",
  ]
    .filter(Boolean)
    .join("\n"));
  for (const c of overnight) setCandidateStatus(c.id, "notified");
  addEvent("recap", `${n} overnight items surfaced`);
  setSetting("last_recap", String(Date.now()));
}

export async function sendDigest(): Promise<void> {
  const { heartbeatText } = await import("./health.ts");
  await sendText(heartbeatText());
  addEvent("digest", "daily digest sent");
}

/** Fires at most once a day: gentle ping when the extension captured nothing
 * for 24h (Telegram reminder replaces any "remember to browse" chore). */
export async function maybeNudgeIfNoCapture(): Promise<void> {
  if (isKillOn() || isDryMode) return;
  const n = countExtensionRowsSince(Date.now() - 24 * 3600_000);
  if (n > 0) {
    addEvent("notify", `nudge window checked: ${n} extension rows in 24h, silent`);
    return;
  }
  await sendText(
    "📭 Nothing captured from the extension in the last 24 hours. A five-minute lap over your saved searches (secondary account) keeps the draft queue fed. This fires at most once a day."
  );
  addEvent("notify", "nudge sent (0 extension rows in 24h)");
}

function lastRunBoundary(key: string, hour: number): number {
  const nowD = new Date();
  const todayRun = new Date(nowD);
  todayRun.setHours(hour, 0, 0, 0);
  const last = Number(getSetting(key) ?? "0");
  // return start boundary: last processed run or yesterday's same-hour run
  if (last >= todayRun.getTime()) return todayRun.getTime();
  const yesterdayRun = new Date(todayRun.getTime() - 24 * 3600_000);
  return todayRun.getTime() > nowD.getTime() ? yesterdayRun.getTime() : todayRun.getTime();
}

// ---------------- command handling ----------------

interface TgCallback {
  id: string;
  data: string;
  message?: { chat: { id: number }; message_id: number };
}
interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    message_id: number;
    reply_to_message?: { message_id: number };
  };
  callback_query?: TgCallback;
}

async function handleUpdate(u: TgUpdate): Promise<void> {
  if (isDryMode) return;
  // first-contact auto-bind (private chats only) — PLAN §11 binding flow
  if (u.message) await maybeBindChat(u.message.chat as never);
  const target = chatTarget();
  const chatId =
    u.message?.chat.id ?? u.callback_query?.message?.chat?.id ?? -1;
  if (!target || String(chatId) !== target) return;

  if (u.callback_query) {
    await handleCallback(u.callback_query);
    return;
  }

  const text = u.message?.text?.trim() ?? "";
  if (!text) return;

  // draft edit via reply: "/edit <new text>"
  if (text.startsWith("/edit ")) {
    const replyId = u.message?.reply_to_message?.message_id;
    const draft = replyId ? getDraftByMessageId(replyId) : undefined;
    if (!draft) {
      await sendText("Reply /edit to a draft message to revise it.");
      return;
    }
    const body = text.slice(6).trim();
    updateDraftBody(draft.id, body, "manual-edit");
    await sendText(`✏️ Draft #${draft.id} updated.`);
    return;
  }

  if (text.startsWith("/stop")) {
    setSetting("kill_switch", "1");
    addEvent("killswitch", "ON via Telegram");
    await sendText("🔴 <b>Kill switch ON.</b> Pollers, /ingest, drafts and posting all paused. /start to resume.");
  } else if (text.startsWith("/start")) {
    setSetting("kill_switch", "0");
    addEvent("killswitch", "OFF via Telegram");
    await sendText("🟢 <b>Scout active.</b> Pollers running, cards flowing. Use /health anytime.");
  } else if (text.startsWith("/health")) {
    const s = stats();
    await sendText(
      [
        "❤️ <b>Scout health</b>",
        `candidates: ${s.total} (pending: ${s.pending ?? 0}, posted: ${s.posted ?? 0})`,
        `leads: ${s.leads ?? 0} · contacted: ${s.contacted ?? 0} · replied: ${s.replied ?? 0}`,
        `banned subs: ${[...getBannedSubreddits()].join(", ") || "none"}`,
        `kill switch: ${isKillOn() ? "🔴 ON" : "🟢 off"} · poster: ${posterPaused() ? "⏸ paused" : "▶ active"}`,
      ].join("\n")
    );
  } else if (text.startsWith("/queue")) {
    const dayAgo = Date.now() - 24 * 3600_000;
    const fresh = candidatesSince(dayAgo).filter((c) => c.status === "pending");
    await sendText(
      fresh.length
        ? ["📬 <b>Queue</b>, oldest first:", ...fresh.slice(0, 15).map((c) => `- [${escapeHtml(c.title)}](${escapeHtml(c.url)})`)].join("\n\n")
        : "Queue is empty."
    );
  } else if (text.startsWith("/watch add ")) {
    const [kind, ...rest] = text.slice(11).split(" ");
    addWatchItem(kind, rest.join(" "));
    await sendText(`👁 watching ${kind}: ${escapeHtml(rest.join(" "))}`);
  } else if (text.startsWith("/watch list")) {
    const items = listWatchItems();
    await sendText(items.length ? items.map((i) => `#${i.id} ${i.kind}: ${escapeHtml(i.value)}`).join("\n") : "Watchlist empty.");
  } else if (text.startsWith("/watch rm ")) {
    const id = Number(text.slice(10).trim());
    if (Number.isFinite(id) && id > 0) {
      removeWatchItem(id);
      await sendText("Removed.");
    } else await sendText("Usage: /watch rm <id>");
  } else if (text.startsWith("/draft ")) {
    await handleForwardLink(text.slice(7).trim());
  } else if (text.startsWith("/drafttext ")) {
    // for login-walled platforms: "/drafttext <title> | <body>"
    const [rawTitle, ...rest] = text.slice(11).split("|");
    await sendAssistedDraft(rawTitle.trim(), rest.join("|").trim(), "manual");
  } else if (/https?:\/\//.test(text)) {
    await handleForwardLink(text);
  }
}

async function handleCallback(cq: TgCallback): Promise<void> {
  const [action, arg] = (cq.data ?? "").split(":");
  const msgId = cq.message?.message_id;
  try {
    if (action === "skip") {
      setCandidateStatus(Number(arg), "skipped");
      addEvent("skip", arg);
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Skipped" });
      if (msgId) await editTo(msgId, "⏭ Skipped.");
    } else if (action === "bansub") {
      // callback_data = bansub:<candidateId>:<subreddit>
      const idx = cq.data?.indexOf(":") ?? -1;
      const rest = idx >= 0 ? (cq.data ?? "").slice(idx + 1) : "";
      const sep = rest.indexOf(":");
      const cid = sep >= 0 ? Number(rest.slice(0, sep)) : Number.NaN;
      const sub = sep >= 0 ? rest.slice(sep + 1) : "";
      if (Number.isFinite(cid) && cid > 0) setCandidateStatus(cid, "skipped");
      if (sub) {
        banSubreddit(sub);
        addEvent("bansub", sub);
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: `Banned r/${sub}` });
        if (msgId) await editTo(msgId, `🚫 r/${escapeHtml(sub)} banned.`);
      } else {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "No sub on this card" });
      }
    } else if (action === "approve") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Drafting..." });
      if (msgId) await editTo(msgId, "✍️ Approved — drafting…");
      await sendDraftMessage(Number(arg));
    } else if (action === "post") {
      const result = await postDraft(Number(arg));
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: result.ok ? "Posted ✅" : `Failed: ${result.reason ?? "?"}`,
      });
      if (msgId) {
        await editTo(
          msgId,
          result.ok ? `📲 <b>Posted.</b> (comment ${result.commentId}) — watch for removals in the next digest.` : `⚠️ Post failed: ${escapeHtml(result.reason ?? "")}\n\n${draftText(getDraftById(Number(arg))!)}`
        );
      }
    } else if (action === "regen") {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Regenerating…" });
      const updated = await regenerateDraft(Number(arg));
      if (updated && msgId) {
        await editDraftMessage(msgId, updated);
      }
    } else if (action === "discard") {
      setDraftStatus(Number(arg), "rejected");
      const draft = getDraftById(Number(arg));
      if (draft?.candidate_id) setCandidateStatus(draft.candidate_id, "skipped");
      addEvent("skip", `draft ${arg} discarded`);
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Discarded" });
      if (msgId) await editTo(msgId, "✖️ Draft discarded.");
    }
  } catch (e) {
    addEvent("error", `callback ${cq.data}: ${String(e)}`);
    try {
      await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Error, check logs" });
    } catch {}
  }
}

async function editTo(messageId: number, text: string): Promise<void> {
  try {
    await tg("editMessageText", {
      chat_id: chatTarget(),
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    addEvent("error", `edit ${messageId}: ${String(e)}`);
  }
}

async function editDraftMessage(messageId: number, draft: { id: number; channel: string; provider: string | null; body: string; expires_at: number }): Promise<void> {
  await editTo(messageId, draftText(draft));
}

// ---------------- forward-link flow (§7.1) ----------------

async function handleForwardLink(url: string): Promise<void> {
  const m = url.match(/https?:\/\/[^\s]+/);
  const link = m?.[0];
  if (!link) {
    await sendText("No URL found — paste the URL or use /drafttext <title> | <text>.");
    return;
  }
  if (/reddit\.com/.test(link)) {
    try {
      const thread = await fetchThreadByUrl(link);
      if (!thread) {
        await sendText("Couldn't load that Reddit thread.");
        return;
      }
      const cand = insertCandidate({
        source: "manual:reddit",
        external_id: thread.externalId,
        url: thread.permalink,
        title: thread.title,
        body: thread.selftext,
        author: thread.author,
        subreddit: thread.subreddit,
        ...{ matched_keywords: "", score: 0 },
      });
      if (!cand) {
        await sendText("Already in the pipeline (deduped).");
        return;
      }
      await sendDraftMessage(cand.id);
      addEvent("draft", `forward-link candidate ${cand.id}`);
      return;
    } catch (e) {
      await sendText(`Error fetching thread: ${escapeHtml(String(e))}`);
      return;
    }
  }
  // assisted platforms: need user-pasted text (login-walled)
  await sendText(
    "That's an assisted platform (LinkedIn/X/FB).\nTwo options:\n1. paste the post text: <code>/drafttext &lt;title&gt; | &lt;body&gt;</code>\n2. if you have the extension installed, it picks threads up by itself."
  );
}

async function sendAssistedDraft(title: string, body: string, platform: string): Promise<void> {
  if (!title) {
    await sendText("Usage: /drafttext <title> | <body>");
    return;
  }
  const channel = channelOfSource(platform) ?? "manual";
  const result = await generateDraft({
    platform: channel as "linkedin" | "x" | "facebook" | "manual",
    title,
    body,
  });
  const draft = createDraft(null, channel, result.text, result.provider);
  await sendMessage({
    chat_id: chatTarget(),
    text:
      draftText({ ...draft, channel, provider: result.provider }) +
      "\n<i>Posting is manual: copy into the app.</i>",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔁 Regenerate", callback_data: `regen:${draft.id}` },
          { text: "✖️ Discard", callback_data: `discard:${draft.id}` },
        ],
      ],
    },
  });
  addEvent("draft", `assisted draft (platform=${platform})`);
}

// ------ suppressed helper kept for card-cap logic balance ------
export function redditCapHint(sub: string): string {
  const gate = canPostToSub(sub);
  return gate.ok ? "" : ` (${gate.reason})`;
}

// ---------------- long poll loop ----------------

export async function runTelegramLoop(): Promise<void> {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg<TgUpdate[]>("getUpdates", {
        offset: offset + 1,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id);
        await handleUpdate(u).catch((e) => addEvent("error", `handleUpdate: ${String(e)}`));
      }
    } catch (e) {
      addEvent("error", `telegram loop: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}
