// Tier-1 Slack reads via the workspace BOT token — deliberately scoped to ONE channel id by the
// caller (the current conversation's channel). Safe without per-user login because the requesting
// user is, by definition, a member of the channel they're talking in, and the bot is too — so this
// exposes nothing the user couldn't already scroll to. NEVER call these with an arbitrary channel
// id from the model; the gateway tool pins the id to CG_CHANNEL_ID. Cross-channel/workspace search
// is the per-user (xoxp) path instead — see oauth.js + the injected Slack hosted MCP.
import { resolveSlackConfig } from "../config/settings.js";
import { appendSlackTables } from "./block-content.js";
import { collectSlackFiles } from "./attachments.js";

const API = "https://slack.com/api";

function botToken() {
  return resolveSlackConfig().botToken || "";
}

async function callForm(method, params) {
  const token = botToken();
  if (!token) throw new Error("Slack bot token isn't configured — an admin must set it in the gateway Settings (admin UI).");
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(friendly(method, data.error));
  return data;
}

function friendly(method, error) {
  const map = {
    not_in_channel: "the bot isn't in this channel — add it here first.",
    channel_not_found: "channel not found.",
    missing_scope: "the bot is missing a history scope for this channel type.",
  };
  return map[error] || `Slack ${method} failed: ${error || "unknown error"}`;
}

// Process-lifetime cache of user id → display name (users.info is cheap but repeats add up).
const nameCache = new Map();
async function resolveNames(ids) {
  const miss = [...new Set(ids)].filter((id) => id && !nameCache.has(id));
  await Promise.all(
    miss.map(async (id) => {
      try {
        const d = await callForm("users.info", { user: id });
        const u = d.user || {};
        nameCache.set(id, u.profile?.display_name || u.real_name || u.name || id);
      } catch {
        nameCache.set(id, id);
      }
    })
  );
  return (id) => nameCache.get(id) || id;
}

export function shapeMessages(messages, nameOf) {
  return messages.map((m) => ({
    ts: m.ts,
    user: m.user || m.bot_id || "",
    name: m.user ? nameOf(m.user) : m.username || "bot",
    text: appendSlackTables(m.text || "", m),
    threadTs: m.thread_ts || "",
    replyCount: m.reply_count || 0,
    files: collectSlackFiles(m).map((file) => ({
      id: file.id ? String(file.id) : "",
      name: file.name ? String(file.name) : "",
      mimetype: file.mimetype ? String(file.mimetype) : "",
      size: Number.isFinite(file.size) && file.size >= 0 ? file.size : null,
    })),
  }));
}

// Recent top-level messages in ONE channel (most recent first from Slack; returned oldest→newest).
export async function channelHistory(channelId, limit = 30) {
  const data = await callForm("conversations.history", { channel: channelId, limit: Math.min(Math.max(limit, 1), 100) });
  const msgs = data.messages || [];
  const nameOf = await resolveNames(msgs.map((m) => m.user));
  return shapeMessages(msgs, nameOf).reverse();
}

// All replies in a thread within ONE channel (chronological).
export async function threadReplies(channelId, threadTs, limit = 50) {
  const data = await callForm("conversations.replies", { channel: channelId, ts: threadTs, limit: Math.min(Math.max(limit, 1), 200) });
  const msgs = data.messages || [];
  const nameOf = await resolveNames(msgs.map((m) => m.user));
  return shapeMessages(msgs, nameOf);
}
