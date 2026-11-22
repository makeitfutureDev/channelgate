// conversation_history: read earlier messages of THIS conversation on a non-Slack surface whose
// live connector can (Google Chat, and Teams through Graph; Slack keeps slack_channel_history / slack_thread_replies).
// Hard-scoped like the Slack reads: the conversation is the signed run context's, never an
// argument, and a thread argument must belong to it. Safe without a per-user login for the same
// reason as Slack's: the requester is a member here and the app is too, so it exposes nothing they
// could not already scroll to — and an app-authenticated read never returns private messages.
import { z } from "zod";
import { platformOfConversation } from "../../platforms/ids.js";
import { liveConnector } from "../../platforms/live.js";
import { platformOr } from "../../platforms/registry.js";
import { saveInboundAttachments } from "../../platforms/attachments.js";

const MAX_TEXT = 2_000;

// A run's thread key is its SESSION key: a background agent appends `::agent-<id>`, a schedule
// uses a synthetic key. Only the real thread part may reach the platform, or nothing.
export function currentThreadFor(connector, threadKey) {
  const base = String(threadKey || "").split("::")[0];
  return connector?.threadFor?.(base) || "";
}

// `messageIds` names the message under each file, for surfaces whose files are fetched by message.
export function formatHistoryRows(rows, { showThreads = false, messageIds = false } = {}) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
  return rows.map((m) => {
    const when = m.createTime ? new Date(m.createTime).toISOString().replace("T", " ").slice(0, 16) : "";
    let body = String(m.text || "");
    if (body.length > MAX_TEXT) body = `${body.slice(0, MAX_TEXT)}… [${body.length - MAX_TEXT} more characters]`;
    const files = (m.attachments || []).map((a) => `[file: ${clean(a.name) || "unnamed"}${a.type ? ` · ${clean(a.type)}` : ""}]`);
    const thread = showThreads && m.thread ? ` (thread ${m.thread})` : "";
    const message = messageIds && files.length && m.id ? ` (message ${clean(m.id)}${m.thread && m.thread !== m.id ? `, thread ${clean(m.thread)}` : ""})` : "";
    return `[${when}] ${clean(m.sender)}: ${body}${files.length ? `\n${files.join("\n")}${message}` : ""}${thread}`;
  }).join("\n");
}

export function register(server, ctx) {
  const { channelId, text } = ctx;
  const platform = platformOfConversation(channelId);
  if (!platform || platform === "slack") return;
  const connector = liveConnector(platform);
  if (typeof connector?.readHistory !== "function") return;
  const label = platformOr(platform).label;

  server.registerTool(
    "conversation_history",
    {
      description:
        `Read earlier messages of THIS ${label} conversation (the one you're replying in). You only receive ` +
        "the messages addressed to you, so when you are mentioned in the middle of a thread, or asked to " +
        "'catch up' / 'summarize this', read the history first. `thread`: \"current\" for the thread you're " +
        "replying in, a thread name from an earlier result, or omit it for the whole conversation. `limit` " +
        "defaults to 30 (max 200). Returns messages oldest→newest with author, time, file names and, for the " +
        "whole conversation, each message's thread. This conversation only; private messages are never included.",
      inputSchema: {
        thread: z.string().optional().describe('"current", a thread name, or omit for the whole conversation.'),
        limit: z.number().optional(),
      },
    },
    async ({ thread, limit }) => {
      try {
        if (ctx.requireChannelAccess && !await ctx.requireChannelAccess()) return text("You are no longer allowed to use this conversation.");
        const live = liveConnector(platform);
        if (typeof live?.readHistory !== "function" || live.ready?.() === false) return text(`${label} is not connected right now; try again later.`);
        let threadKey = "";
        if (thread === "current") {
          threadKey = currentThreadFor(live, ctx.threadKey);
          if (!threadKey) return text("This reply is not in a thread; omit `thread` to read the conversation.");
        } else if (thread) {
          threadKey = String(thread).trim();
        }
        const rows = await live.readHistory({ conversationId: channelId, threadKey, limit: limit || 30 });
        if (!rows.length) return text(threadKey ? "No messages in that thread." : "No recent messages in this conversation.");
        return text(formatHistoryRows(rows, { showThreads: !threadKey, messageIds: typeof live.historyFile === "function" }));
      } catch (error) {
        return text(`Couldn't read this conversation: ${String(error?.message || "failed").replace(/\s+/g, " ").trim()}`);
      }
    },
  );

  // A file posted on an earlier message (before you were mentioned, or on another message of the
  // thread) never reached a run. Fetch it by its message, from THIS conversation only, into the
  // current thread's uploads/ folder through the same bounded, no-follow writer as intake.
  if (typeof connector.historyFile !== "function") return;
  server.registerTool(
    "conversation_download_file",
    {
      description:
        `Download a file that was posted on an earlier message of THIS ${label} conversation into this thread's ` +
        "uploads/ folder and return its local path. Pass the `message` id shown under the file in a " +
        "conversation_history result, the `thread` id shown there when the message is a reply, and the `file` " +
        "name when the message has several. This conversation only; files outside the SharePoint drives the " +
        "administrator allowed are refused.",
      inputSchema: {
        message: z.string().describe("The message id from conversation_history."),
        thread: z.string().optional().describe("The thread id shown with a reply's file, if any."),
        file: z.string().optional().describe("The file name, when the message has several files."),
      },
    },
    async ({ message, thread, file }) => {
      try {
        if (ctx.requireChannelAccess && !await ctx.requireChannelAccess()) return text("You are no longer allowed to use this conversation.");
        const live = liveConnector(platform);
        if (typeof live?.historyFile !== "function" || live.ready?.() === false) return text(`${label} is not connected right now; try again later.`);
        if (!ctx.slug) return text("No conversation folder here.");
        const found = await live.historyFile({ conversationId: channelId, message, thread: thread || "", file: file || "" });
        const meta = await ctx.loadMeta?.();
        const saved = await saveInboundAttachments({ platform, threadKey: String(ctx.threadKey || "").split("::")[0], attachments: [found] },
          { slug: ctx.slug, meta: meta || {} });
        if (!saved.paths.length) {
          return text(`Couldn't download ${saved.skipped[0] || found.name}. Do NOT pretend to have seen it — tell the user this reason verbatim.`);
        }
        return text(`Downloaded: ${saved.paths[0]}. Read it with your Read tool (images render visually).`);
      } catch (error) {
        return text(`Couldn't download that file: ${String(error?.message || "failed").replace(/\s+/g, " ").trim()}`);
      }
    },
  );
}
