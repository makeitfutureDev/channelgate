// The ChatConnector contract — the one home for per-PLATFORM facts, exactly as
// `src/engines/contract.js` is the one home for per-ENGINE facts.
//
// Why this exists: the gateway's reply modes are not universal. Slack streams tokens natively and
// renders Block Kit; Google Chat has no streaming API and a 1 write/sec-per-space edit quota;
// Teams has no tables, no headings, and no ephemeral messages. Every one of those differences used
// to be an implicit assumption baked into `src/slack/`. A platform is added by adding a descriptor
// here plus a connector — never by adding another `platform === "slack"` branch.
//
// Fail-closed is the rule: an unknown capability key is a validation error (so a typo can't read as
// "unsupported and therefore silently skipped"), and every capability a descriptor omits defaults
// to the LEAST capable value, not the most.

// The closed set of capability keys, each with its default (= least capable) value and the values
// a non-boolean key may take. Adding a key here is the only way to add a capability.
export const CAPABILITY_SPEC = Object.freeze({
  // ── Delivery ──────────────────────────────────────────────────────────────
  // Native token-by-token streaming into a live message (Slack `chatStream`). When false the
  // connector must fall back to the edit-polling streamer, throttled by `editsPerSecond`.
  nativeStreaming: { default: false },
  // Can an already-posted message be patched? Without this there is no progress rendering at all —
  // the turn posts once, at the end.
  messageEdit: { default: false },
  // Edit budget per conversation per second. The streamer coalesces to this rate. 0 = no edits.
  editsPerSecond: { default: 0, type: "number" },
  // How replies attach to a conversation:
  //   "native"    — real threads addressable by id (Slack ts, Chat thread.name, Teams reply chain)
  //   "root-only" — flat conversation; every reply is a new top-level message
  threading: { default: "root-only", values: ["native", "root-only"] },
  // Threads exist in SOME conversation kinds only (Google Chat: threaded spaces yes, DMs no;
  // Teams: channels yes, 1:1 and group chats no). The connector reports per-conversation via
  // `supportsThreads(conversation)`; this flag says the platform is mixed at all.
  mixedThreading: { default: false },
  ephemeral: { default: false },
  deleteMessage: { default: false },
  reactions: { default: false },
  reactionTriggers: { default: false },
  maxMessageChars: { default: 4_000, type: "number" },

  // ── Formatting ────────────────────────────────────────────────────────────
  // Which outbound formatter the connector uses. "mrkdwn" is Slack's dialect; "standard" is real
  // Markdown (Google Chat since Aug 2026); "subset" is Teams' narrow bot subset.
  markdown: { default: "subset", values: ["mrkdwn", "standard", "subset"] },
  markdownTables: { default: false },
  markdownHeadings: { default: false },
  markdownImages: { default: false },
  // Teams renders lists on desktop only — true here means "renders everywhere we care about".
  markdownLists: { default: false },
  blockQuotes: { default: false },
  // The platform's rich-layout primitive, for surfaces we re-author per platform (approvals, the
  // file explorer, the model wizard). "none" means those degrade to plain text replies.
  richCards: { default: "none", values: ["none", "block-kit", "cards-v2", "adaptive-cards"] },
  buttons: { default: false },
  // Modal dialogs. Google Chat's Pub/Sub connection mode explicitly cannot open dialogs, which is
  // why this is separate from `buttons` (card clicks DO arrive on the topic).
  modals: { default: false },

  // ── Native artifacts (these gate MCP tool registration) ───────────────────
  nativeTables: { default: false },
  nativeCharts: { default: false },
  lists: { default: false },
  canvases: { default: false },
  fileUpload: { default: false },
  snippets: { default: false },

  // ── Inbound ───────────────────────────────────────────────────────────────
  // "full"    — every attachment is downloadable with the bot's own credential
  // "partial" — some kinds need extra grants (Chat: Drive-shared files; Teams: channel files)
  // "none"    — no attachment ingest
  attachmentsIn: { default: "none", values: ["full", "partial", "none"] },
  // Does the platform deliver un-mentioned channel messages at all? Slack does; Teams needs the
  // RSC `ChannelMessage.Read.Group` grant, Chat only delivers what the app is @-mentioned in
  // (outside DMs). Gating logic must not assume it can see everything.
  seesUnmentionedMessages: { default: false },

  // ── Mentions ──────────────────────────────────────────────────────────────
  mentionSyntax: { default: "none", values: ["none", "slack", "gchat", "teams"] },
  mentionByEmail: { default: false },
  // @channel / @here style broadcasts. A SECURITY-relevant capability: the outbound formatter must
  // defang model-authored broadcast sequences on every platform that has them.
  broadcast: { default: false },

  // ── Proactive (scheduler, follow-ups, nudges, background continuations) ────
  proactivePost: { default: false },
  proactiveDm: { default: false },
});

const CAPABILITY_KEYS = Object.freeze(Object.keys(CAPABILITY_SPEC));

// Descriptor fields every adapter must declare. `status` is deliberately required: a scaffolded
// platform must announce itself as one rather than look GA because its descriptor is complete.
// `folderName` is the on-disk name for this surface: channel work folders live in
// <workspace root>/<folderName>/<slug> and per-channel metadata in
// <runtime root>/channels/<folderName>/<slug>. It is a FACT of the adapter for the same reason
// the capabilities are — adding a surface must never mean adding a `platform === "slack"` switch
// in src/config/paths.js. It is deliberately NOT the adapter id: the folders are what an operator
// browses, so "teams"/"google-chat" beat "msteams"/"googlechat".
const REQUIRED_MANIFEST = ["id", "label", "transport", "status", "conversationKinds", "folderName"];
const REQUIRED_METHODS = ["formatOutbound", "createConnector", "health"];
export const PLATFORM_STATUSES = Object.freeze(["ga", "beta", "preview", "scaffold"]);

function normalizeCapabilities(id, declared) {
  const caps = {};
  for (const [key, value] of Object.entries(declared || {})) {
    if (!Object.hasOwn(CAPABILITY_SPEC, key)) {
      throw new TypeError(`PlatformAdapter ${id} declares unknown capability "${key}"`);
    }
    const spec = CAPABILITY_SPEC[key];
    if (spec.values && !spec.values.includes(value)) {
      throw new TypeError(`PlatformAdapter ${id} capability "${key}" must be one of ${spec.values.join("|")}`);
    }
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`PlatformAdapter ${id} capability "${key}" must be a non-negative finite number`);
    }
    if (!spec.values && !spec.type && typeof value !== "boolean") {
      throw new TypeError(`PlatformAdapter ${id} capability "${key}" must be a boolean`);
    }
    caps[key] = value;
  }
  // Anything not declared falls to the least-capable default — never to Slack's behaviour.
  for (const key of CAPABILITY_KEYS) if (!Object.hasOwn(caps, key)) caps[key] = CAPABILITY_SPEC[key].default;
  return Object.freeze(caps);
}

export function validatePlatformAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("PlatformAdapter must be an object");
  for (const field of REQUIRED_MANIFEST) {
    if (!adapter[field]) throw new TypeError(`PlatformAdapter missing ${field}`);
  }
  // `idPrefix` must be declared but MAY be empty: the empty prefix is the reserved namespace for
  // the platform whose ids predate namespacing (Slack). Exactly one adapter may claim it, which
  // createPlatformRegistry enforces.
  if (typeof adapter.idPrefix !== "string") throw new TypeError(`PlatformAdapter ${adapter.id} must declare idPrefix (may be "")`);
  if (adapter.idPrefix && !/^[a-z0-9]+:$/.test(adapter.idPrefix)) {
    throw new TypeError(`PlatformAdapter ${adapter.id} idPrefix must look like "name:"`);
  }
  // The folder name is joined under the workspace/runtime roots, so it must be ONE safe path
  // component — a separator or a dot-name would let a descriptor escape the root it names.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.folderName)) {
    throw new TypeError(`PlatformAdapter ${adapter.id} folderName must be a lowercase single path component`);
  }
  if (!PLATFORM_STATUSES.includes(adapter.status)) {
    throw new TypeError(`PlatformAdapter ${adapter.id} has unknown status "${adapter.status}"`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") throw new TypeError(`PlatformAdapter ${adapter.id} missing ${method}()`);
  }
  if (!Array.isArray(adapter.conversationKinds) || !adapter.conversationKinds.length) {
    throw new TypeError(`PlatformAdapter ${adapter.id} must declare at least one conversation kind`);
  }
  const capabilities = normalizeCapabilities(adapter.id, adapter.capabilities);

  // Internal consistency — each of these combinations would silently produce a broken reply mode.
  if (capabilities.nativeStreaming && !capabilities.messageEdit) {
    throw new TypeError(`PlatformAdapter ${adapter.id}: nativeStreaming requires messageEdit`);
  }
  if (capabilities.messageEdit && capabilities.editsPerSecond <= 0) {
    throw new TypeError(`PlatformAdapter ${adapter.id}: messageEdit requires a positive editsPerSecond budget`);
  }
  if (capabilities.modals && !capabilities.buttons) {
    throw new TypeError(`PlatformAdapter ${adapter.id}: modals require buttons`);
  }
  if ((capabilities.buttons || capabilities.modals) && capabilities.richCards === "none") {
    throw new TypeError(`PlatformAdapter ${adapter.id}: interactive surfaces require a richCards primitive`);
  }
  if (capabilities.mixedThreading && capabilities.threading !== "native") {
    throw new TypeError(`PlatformAdapter ${adapter.id}: mixedThreading only makes sense with native threading`);
  }

  return Object.freeze({ ...adapter, capabilities, guideDrop: Object.freeze([...(adapter.guideDrop || [])]) });
}

export function createPlatformRegistry(adapters) {
  const map = new Map();
  for (const raw of adapters || []) {
    const adapter = validatePlatformAdapter(raw);
    if (map.has(adapter.id)) throw new TypeError(`Duplicate PlatformAdapter id: ${adapter.id}`);
    for (const other of map.values()) {
      if (other.idPrefix === adapter.idPrefix) {
        throw new TypeError(`PlatformAdapters ${other.id} and ${adapter.id} share the id prefix "${adapter.idPrefix}"`);
      }
      // No prefix-of-a-prefix check is needed: the enforced "name:" shape ends every prefix with a
      // colon, and a colon cannot appear inside one, so two DISTINCT prefixes can never be prefixes
      // of one another ("pro:" is not a prefix of "probe:"). Uniqueness above is therefore
      // sufficient to make parseConversationId unambiguous — and that parse decides which gated
      // folder a conversation resolves to.
    }
    map.set(adapter.id, adapter);
  }
  return Object.freeze({
    ids: Object.freeze([...map.keys()]),
    get: (id) => map.get(String(id || "")) || null,
    require(id) {
      const adapter = map.get(String(id || ""));
      if (!adapter) throw new Error(`Unknown or unavailable chat platform: ${id || "(missing)"}`);
      return adapter;
    },
    // The UI manifest is data, never executable adapter behaviour. Filter by VALUE instead of a
    // hand-maintained method-name list: adapters may carry optional helpers (normalizeName today,
    // another runtime hook tomorrow), and structuredClone correctly rejects any function we miss.
    manifests: () => [...map.values()].map((adapter) => structuredClone(Object.fromEntries(
      Object.entries(adapter).filter(([, value]) => typeof value !== "function"),
    ))),
  });
}
