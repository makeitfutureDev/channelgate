// Earlier messages of ONE Teams conversation, read through Microsoft Graph, and the files posted
// in them. This is the "separately authorized Graph route" of the Teams parity audit: the bot's
// own Bot Framework credential cannot read history, so these reads exist only where the operator
// turned on all-message events — the same Graph application permissions (or resource-specific
// consent) and the same per-conversation subscription record. The resource read is the one that
// record holds for the conversation; nothing a model or a user types can name another chat,
// channel or team. Personal chats have no such record and no history read.
//
// A file is fetched only through the existing drive-allowlisted resolver (files.js), and only when
// the message that carries it belongs to this conversation.
const GRAPH = "https://graph.microsoft.com/v1.0";
const RESOURCE = /^\/(?:teams\/[A-Za-z0-9%._:@-]{1,200}\/channels\/[A-Za-z0-9%._:@-]{1,300}|chats\/[A-Za-z0-9%._:@-]{1,300})\/messages$/;
const MESSAGE_ID = /^\d{1,20}$/;
const PAGE = 50;
const MAX_LIMIT = 200;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const HISTORY_UNAVAILABLE = "Earlier messages of this Teams conversation can't be read: the gateway reads Teams history through Microsoft Graph, which needs Teams all-message events turned on (Settings → Microsoft Teams) and this conversation to have been seen since. Personal chats have no readable history.";
export const HISTORY_PERMISSION = "Microsoft Graph refused to read this conversation's messages. The Teams app needs the Graph permissions all-message events use (ChannelMessage.Read.All / Chat.Read.All, or the matching resource-specific consent) — an administrator grants them in Entra ID.";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Teams message bodies are HTML. Keep the words, line breaks and mention names; drop the markup.
export function teamsHtmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<attachment\b[^>]*>\s*<\/attachment>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === "#") {
        const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isInteger(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : "";
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const senderOf = from => from?.user?.displayName || (from?.application?.displayName ? `${from.application.displayName} [app]` : "") || "unknown";
const fileOf = attachment => attachment?.contentType === "reference" && attachment.name ? { name: String(attachment.name), type: "file" } : null;

export function createTeamsHistory({ auth, store, resolveFile = null, fetchImpl = fetch } = {}) {
  if (typeof auth?.token !== "function" || typeof store?.list !== "function") throw new TypeError("Teams history needs Graph authentication and the subscription store");

  async function resourceFor(conversationId) {
    const row = (await store.list()).find(item => item.conversationId === conversationId);
    const resource = row?.resource;
    if (typeof resource !== "string" || !RESOURCE.test(resource)) throw new Error(HISTORY_UNAVAILABLE);
    return { resource, channel: resource.startsWith("/teams/") };
  }

  async function get(url) {
    const res = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${await auth.token()}` } });
    if (res.status === 401 || res.status === 403) throw new Error(HISTORY_PERMISSION);
    if (res.status === 404) throw Object.assign(new Error("That message is not in this Teams conversation."), { status: 404 });
    if (!res.ok) throw new Error(`Microsoft Graph could not read this conversation (${res.status}).`);
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("Microsoft Graph returned more than the gateway reads at once.");
    return res.json();
  }

  // Follow @odata.nextLink only to Graph itself, and only until enough messages are in hand.
  async function list(url, limit) {
    const values = [];
    let next = url;
    for (let page = 0; next && values.length < limit && page < Math.ceil(MAX_LIMIT / PAGE) + 1; page++) {
      const body = await get(next);
      values.push(...(Array.isArray(body?.value) ? body.value : []));
      const link = body?.["@odata.nextLink"];
      next = typeof link === "string" && link.startsWith(`${GRAPH}/`) ? link : "";
    }
    return values;
  }

  const visible = message => message && message.messageType === "message" && !message.deletedDateTime;
  const row = (message, { thread = "" } = {}) => ({
    id: String(message.id || ""),
    thread,
    createTime: message.createdDateTime || "",
    sender: senderOf(message.from),
    text: teamsHtmlToText(message.body?.contentType === "text" ? escapeText(message.body.content) : message.body?.content),
    attachments: (message.attachments || []).map(fileOf).filter(Boolean),
  });

  async function readHistory({ conversationId, threadKey = "", limit = 30 } = {}) {
    const { resource, channel } = await resourceFor(conversationId);
    const count = Math.min(Math.max(1, Math.floor(Number(limit)) || 30), MAX_LIMIT);
    const thread = String(threadKey || "").trim();
    if (thread) {
      if (!channel) throw new Error("Only Teams channels have reply chains; omit `thread` to read this chat.");
      if (!MESSAGE_ID.test(thread)) throw new Error("That is not a Teams thread id (use one from an earlier result).");
      const root = await get(`${GRAPH}${resource}/${thread}`);
      const replies = await list(`${GRAPH}${resource}/${thread}/replies?$top=${PAGE}`, count);
      return [root, ...replies].filter(visible)
        .sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)))
        .slice(-count).map(message => row(message, { thread }));
    }
    const query = channel ? `?$top=${PAGE}` : `?$top=${PAGE}&$orderby=createdDateTime%20desc`;
    const messages = (await list(`${GRAPH}${resource}${query}`, count)).filter(visible)
      .sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime))).slice(-count);
    // A channel's top-level message is the root of its own reply chain.
    return messages.map(message => row(message, { thread: channel ? String(message.id || "") : "" }));
  }

  // The file named on one message of this conversation, as an attachment the ordinary intake can
  // save: { name, download }. The message must exist under this conversation's own resource.
  async function historyFile({ conversationId, message, thread = "", file = "" } = {}) {
    if (!resolveFile) throw new Error("Teams file downloads are off. An administrator enables them (and lists the SharePoint drives the gateway may read) in Settings → Microsoft Teams.");
    const { resource, channel } = await resourceFor(conversationId);
    const id = String(message || "").trim(), root = String(thread || "").trim();
    if (!MESSAGE_ID.test(id) || (root && !MESSAGE_ID.test(root))) throw new Error("Use a message id (and thread id) from an earlier conversation_history result.");
    if (root && !channel) throw new Error("Only Teams channels have reply chains; omit `thread` in this chat.");
    const found = await get(root && root !== id ? `${GRAPH}${resource}/${root}/replies/${id}` : `${GRAPH}${resource}/${id}`);
    if (!visible(found)) throw new Error("That message is not in this Teams conversation.");
    const files = (found.attachments || []).filter(item => item?.contentType === "reference" && item.name && item.contentUrl);
    const wanted = String(file || "").trim().toLowerCase();
    const matches = wanted ? files.filter(item => String(item.name).toLowerCase() === wanted) : files;
    if (!matches.length) throw new Error(files.length ? `That message has no file named "${file}". Its files: ${files.map(item => item.name).join(", ")}.` : "That message has no file attached.");
    if (matches.length > 1) throw new Error(`That message has several files; name one: ${matches.map(item => item.name).join(", ")}.`);
    const download = resolveFile({ contentUrl: matches[0].contentUrl });
    if (!download) throw new Error("That file is not in a SharePoint location the gateway may read. Only canonical links inside the drives an administrator allowed (Settings → Microsoft Teams) can be downloaded.");
    return { name: String(matches[0].name), contentType: "application/octet-stream", download };
  }

  return { readHistory, historyFile };
}

// A plain-text body must not be read as markup.
function escapeText(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
