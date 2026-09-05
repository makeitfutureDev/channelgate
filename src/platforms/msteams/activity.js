// Bot Framework activity → the gateway's neutral inbound record.
import { makeInbound } from "../inbound.js";

// Hosts a Teams attachment may legitimately be fetched from. The download URL arrives inside the
// activity — i.e. from the network — and is fetched by the daemon, so an unconstrained URL is an
// SSRF primitive pointed at whatever the daemon can reach (including the admin UI on localhost).
const DOWNLOAD_HOST_RE = /(^|\.)((sharepoint|sharepoint-df)\.com|svc\.ms|office\.com|officeapps\.live\.com|microsoft\.com|onedrive\.com|1drv\.ms)$/i;

export function isAllowedDownloadUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  return url.protocol === "https:" && DOWNLOAD_HOST_RE.test(url.hostname);
}

// Teams mirrors the message body as a text/html attachment on EVERY message and delivers cards as
// application/vnd.microsoft.card.*; neither is a file the user sent.
function isRealFile(contentType, contentUrl) {
  const type = String(contentType || "").toLowerCase();
  if (type.startsWith("application/vnd.microsoft.card")) return false;
  if ((type === "text/html" || type === "text/plain") && !contentUrl) return false;
  return true;
}

// `<at>Bot Name</at>` is how Teams renders a mention inside the text. It has to come out before the
// text reaches the model, or every prompt starts with the bot's own display name.
export function stripMentionTags(text) {
  return String(text || "").replace(/<at\b[^>]*>[^<]*<\/at>/gi, " ").replace(/[ \t]{2,}/g, " ").trim();
}

// A channel reply-chain is addressed as "<channelId>;messageid=<rootId>". The suffix is the thread;
// the part before it is the conversation.
export function splitConversationId(raw) {
  const value = String(raw || "");
  const at = value.indexOf(";messageid=");
  if (at === -1) return { conversationId: value, threadKey: "" };
  return { conversationId: value.slice(0, at), threadKey: value.slice(at + ";messageid=".length) };
}

const KINDS = { personal: "dm", groupchat: "group", channel: "channel" };

export function normalizeActivity(activity, { botId = "", fetchImpl = fetch } = {}) {
  if (String(activity?.type || "").toLowerCase() !== "message") return null;
  const from = activity.from || {};
  // Our own echo. Bot Service delivers the bot's own messages back on some configurations, and
  // answering one is an infinite loop with a bill attached.
  if (botId && String(from.id || "") === String(botId)) return null;

  const conversation = activity.conversation || {};
  const { conversationId, threadKey } = splitConversationId(conversation.id);
  const kind = KINDS[String(conversation.conversationType || "").toLowerCase()] || "dm";

  const mentions = (activity.entities || []).filter((e) => String(e?.type || "").toLowerCase() === "mention");
  const mentionsBot = Boolean(botId) && mentions.some((m) => String(m?.mentioned?.id || "") === String(botId));

  return makeInbound({
    platform: "msteams",
    conversationId,
    conversationName: String(conversation.name || activity.channelData?.team?.name || ""),
    kind,
    // In a channel the user's own message is the root a reply must thread under; a 1:1 or group
    // chat is flat, so nothing is carried and replies land in the chat itself.
    threadKey: threadKey || (kind === "channel" ? String(activity.id || "") : ""),
    messageId: String(activity.id || ""),
    // The Bot Framework id (`29:…`) is the one that can address a message or open a 1:1; the Entra
    // object id is the one an operator recognizes. Both are kept — `userId` is the addressable one.
    userId: String(from.id || ""),
    userName: String(from.name || ""),
    // Teams does not put an email on the `from` account; a UPN needs a roster read, which the bot
    // may not be consented for. Left empty rather than guessed.
    userEmail: "",
    text: stripMentionTags(activity.text),
    mentionsBot,
    attachments: normalizeAttachments(activity.attachments, fetchImpl),
    raw: {
      activity,
      aadObjectId: String(from.aadObjectId || ""),
      tenantId: String(conversation.tenantId || activity.channelData?.tenant?.id || ""),
      serviceUrl: String(activity.serviceUrl || ""),
      teamId: String(activity.channelData?.team?.id || ""),
    },
  });
}

function normalizeAttachments(list, fetchImpl) {
  const out = [];
  for (const att of Array.isArray(list) ? list : []) {
    const contentType = String(att?.contentType || "");
    const contentUrl = att?.contentUrl || "";
    if (!isRealFile(contentType, contentUrl)) continue;

    // The consent-free path: Teams hands 1:1 uploads to the bot with a pre-authenticated download
    // URL and the real file type. Channel files live in SharePoint and need Graph application
    // permissions we do not ask for — those arrive without downloadUrl and stay undownloadable,
    // which is exactly what `attachmentsIn: "partial"` declares.
    if (contentType === "application/vnd.microsoft.teams.file.download.info") {
      const content = att.content || {};
      const url = content.downloadUrl || content.download_url || "";
      out.push({
        name: String(att.name || "attachment"),
        contentType: String(content.fileType ? `application/${content.fileType}` : "application/octet-stream"),
        download: isAllowedDownloadUrl(url) ? () => fetchBytes(url, fetchImpl) : null,
      });
      continue;
    }
    out.push({
      name: String(att?.name || "attachment"),
      contentType: contentType || "application/octet-stream",
      download: isAllowedDownloadUrl(contentUrl) ? () => fetchBytes(contentUrl, fetchImpl) : null,
    });
  }
  return out;
}

// Hands back the Response itself, not its bytes: the attachment sink streams the body into the
// channel folder under the shared cap, so a large upload never sits in the daemon's memory.
async function fetchBytes(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Teams attachment download failed (${res.status})`);
  return res;
}
