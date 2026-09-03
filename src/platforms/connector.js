// The ChatConnector interface — the one way the daemon posts, edits, and deletes messages.
//
// Today nine gateway modules (active-runs, api-runs, background, scheduler, followups, nudges,
// diagnosis, shutdown, transcribe) reach for a raw Slack `client` and call
// `chat.postMessage({ thread_ts })` directly. That is fine while there is exactly one surface and
// impossible the moment there are three: `thread_ts` is not a thing on Google Chat, and Teams has
// no ephemeral messages at all. Every one of those call sites goes through a connector instead, and
// the connector is the only place that knows a platform's wire format.
//
// A connector is deliberately SMALL. It does not own gating, authorization, sessions, or the run
// pipeline — those are platform-neutral and stay in gateway/. It owns exactly the mechanics of
// getting bytes onto a surface and back off it.

const REQUIRED_METHODS = ["post", "edit", "remove", "openDm", "threadFor", "supportsThreads", "directory"];

export function validateConnector(connector) {
  if (!connector || typeof connector !== "object") throw new TypeError("ChatConnector must be an object");
  if (!connector.platform) throw new TypeError("ChatConnector must declare its platform id");
  if (!connector.capabilities) throw new TypeError(`ChatConnector ${connector.platform} must carry its capability descriptor`);
  for (const method of REQUIRED_METHODS) {
    if (typeof connector[method] !== "function") throw new TypeError(`ChatConnector ${connector.platform} missing ${method}()`);
  }
  return connector;
}

// The connector every not-yet-connected platform gets. Reads answer honestly ("nothing here"),
// writes throw with a message that names the platform — a silent no-op write would look like a
// delivered answer to the scheduler and to the follow-up tracker, which is the failure mode this
// whole seam exists to prevent.
export function createNullConnector(platform, capabilities, reason = "not connected") {
  const fail = (what) => {
    throw new Error(`${platform} connector cannot ${what}: ${reason}`);
  };
  return validateConnector({
    platform,
    capabilities,
    ready: () => false,
    reason,
    async post() { return fail("post"); },
    async edit() { return fail("edit"); },
    async remove() { return fail("delete"); },
    async openDm() { return fail("open a DM"); },
    threadFor: () => null,
    supportsThreads: () => false,
    async directory() { return { map: new Map(), maxWords: 1 }; },
  });
}

// Post a full answer, splitting it at the platform's cap. `formatted` is whatever the platform's
// `formatOutbound` returned ({ text, chunks: [{ text, mentions }] }). Returns the ids of every
// message posted, so a caller that needs to edit or delete its own output can find it again.
export async function postFormatted(connector, { conversationId, threadKey, formatted, footer = "", buttons = null } = {}) {
  const chunks = formatted?.chunks?.length ? formatted.chunks : [{ text: "_(no output)_", mentions: [] }];
  const posted = [];
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    posted.push(await connector.post({
      conversationId,
      threadKey,
      text: chunk.text,
      mentions: chunk.mentions || [],
      // Footer and buttons ride the LAST chunk only — repeating run stats under every part of a
      // split answer is noise, and repeated buttons would fire the same action several times.
      ...(last && footer ? { footer } : {}),
      ...(last && buttons ? { buttons } : {}),
    }));
  }
  return posted;
}
