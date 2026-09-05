// The Google Chat REST surface the connector needs, and nothing else.
//
// Every resource name that reaches a URL path is validated against the documented character set
// first. These names arrive from an inbound event — i.e. from outside — and `spaces/${name}` with
// an unvalidated `name` is a path-traversal primitive against our own API client (Hermes learned
// the same lesson on the Teams side; their conversation-id regex is the direct precedent).
import { setTimeout as delay } from "node:timers/promises";

const BASE = "https://chat.googleapis.com/v1";
// Chat caps a message at 4096 characters. The formatter chunks well below this; the cap here is the
// last line of defence for text the formatter never saw (an edit payload, a raw notice).
export const MAX_CHAT_TEXT = 4000;

const SPACE_RE = /^spaces\/[A-Za-z0-9_-]+$/;
const MESSAGE_RE = /^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/;
const THREAD_RE = /^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/;
const USER_RE = /^users\/[A-Za-z0-9_-]+$/;

export const isSpaceName = (v) => SPACE_RE.test(String(v || ""));
export const isMessageName = (v) => MESSAGE_RE.test(String(v || ""));
export const isThreadName = (v) => THREAD_RE.test(String(v || ""));
export const isUserName = (v) => USER_RE.test(String(v || ""));

function requireName(value, test, what) {
  const name = String(value || "");
  if (!test(name)) throw new Error(`Google Chat ${what} is not a valid resource name`);
  return name;
}

// Retry only what is actually transient. A 403 means the app was removed from the space or its
// permissions were revoked — retrying that three times just delays the truthful error.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createChatApi({ auth, fetchImpl = fetch, sleep = delay, attempts = 3, baseDelayMs = 500 } = {}) {
  if (!auth?.token) throw new TypeError("createChatApi requires a Google auth provider");

  async function call(path, { method = "GET", query = null, body = null, raw = false } = {}) {
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));

    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const token = await auth.token();
      const res = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // `raw` hands back the Response itself (its body still unread) so an attachment can stream
      // into the channel folder under the shared cap instead of being buffered here.
      if (res.ok) return raw ? res : await res.json().catch(() => ({}));

      const text = await res.text().catch(() => "");
      const err = new Error(`Google Chat ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      // A 401 on a call means the cached token died early (key rotated/revoked). Drop it and let the
      // next attempt re-mint — if the key is genuinely gone the retry fails the same way and the
      // error surfaces honestly.
      if (res.status === 401) auth.reset?.();
      if (!RETRYABLE.has(res.status) && res.status !== 401) throw err;
      lastErr = err;
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
    throw lastErr;
  }

  return {
    // `threadName` present ⇒ we MUST also send messageReplyOption. Without it Chat silently ignores
    // the thread and starts a new one ("Default. Starts a new thread. Using this option ignores any
    // thread ID"), which reads as a bot that cannot follow a conversation.
    async createMessage(space, { text, threadName = "", cardsV2 = null } = {}) {
      const parent = requireName(space, isSpaceName, "space");
      const body = { text: String(text ?? "").slice(0, MAX_CHAT_TEXT) };
      if (cardsV2) body.cardsV2 = cardsV2;
      const query = {};
      if (threadName) {
        body.thread = { name: requireName(threadName, isThreadName, "thread") };
        // FALLBACK_TO_NEW_THREAD rather than OR_FAIL: a thread can legitimately disappear, and a
        // delivered answer in a new thread beats a dropped one.
        query.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
      }
      const res = await call(`${parent}/messages`, { method: "POST", query, body });
      return { messageId: res?.name || "", threadName: res?.thread?.name || "" };
    },

    // patch, not delete+create: Chat leaves a "Message deleted by its author" tombstone behind every
    // delete, so an edit-polling progress renderer built on delete would spray the space with them.
    // `thread` is immutable and must never appear in a patch body.
    async patchMessage(messageName, { text, cardsV2 = null } = {}) {
      const name = requireName(messageName, isMessageName, "message");
      const body = {};
      const mask = [];
      if (text != null) { body.text = String(text).slice(0, MAX_CHAT_TEXT); mask.push("text"); }
      if (cardsV2) { body.cardsV2 = cardsV2; mask.push("cardsV2"); }
      if (!mask.length) return { messageId: name };
      const res = await call(name, { method: "PATCH", query: { updateMask: mask.join(",") }, body });
      return { messageId: res?.name || name };
    },

    async deleteMessage(messageName) {
      await call(requireName(messageName, isMessageName, "message"), { method: "DELETE" });
    },

    async getSpace(space) {
      return call(requireName(space, isSpaceName, "space"));
    },

    // The 1:1 space with a user, created on first use. `name` is the user's Chat resource name
    // (users/123…), which is why the inbound normalizer keeps it alongside the email.
    async findDirectMessage(userName) {
      const name = requireName(userName, isUserName, "user");
      const res = await call("spaces:findDirectMessage", { query: { name } });
      return res?.name || "";
    },

    // Human members of a space, for @-mention resolution. Bots are skipped: an outbound mention of
    // another app is never what the model meant.
    async listMembers(space, { pageSize = 100 } = {}) {
      const parent = requireName(space, isSpaceName, "space");
      const out = [];
      let pageToken = "";
      do {
        const res = await call(`${parent}/members`, { query: { pageSize, pageToken: pageToken || null } });
        for (const m of res?.memberships || []) {
          const member = m?.member || {};
          if (member.type === "BOT") continue;
          if (member.name && member.displayName) out.push({ id: member.name, name: member.displayName, email: member.email || "" });
        }
        pageToken = res?.nextPageToken || "";
      } while (pageToken && out.length < 1000);
      return out;
    },

    // Inbound attachment bytes. Only the bot path (attachmentDataRef.resourceName → media.download)
    // is implemented: `downloadUri` is minted for USER OAuth tokens and answers 401 to a service
    // account, and a Drive-picker share without a resourceName needs a Drive scope we deliberately
    // do not request. Both degrade to "attachment skipped" rather than a broken download.
    async downloadAttachment(resourceName) {
      const name = String(resourceName || "");
      // Media resource names are opaque and DO legitimately contain "/" and ".", so the character
      // class alone is not enough: "../../" is spelled entirely in allowed characters. A dot-dot
      // segment or a leading slash is a traversal attempt, not a resource name.
      if (!/^[A-Za-z0-9_\-./+=]+$/.test(name) || name.startsWith("/") || name.split("/").includes("..")) {
        throw new Error("Google Chat attachment resource name is not valid");
      }
      return call(`media/${name}`, { query: { alt: "media" }, raw: true });
    },
  };
}
