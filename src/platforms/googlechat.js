// Google Chat platform adapter.
//
// Connectivity model (why this is the cheaper second surface): a Chat app configured with a Cloud
// Pub/Sub connection has Google publish interaction events to our topic, and the daemon consumes
// them through a PULL subscription — outbound-only, explicitly documented for apps behind a
// firewall. That matches our Socket Mode posture exactly, so no inbound endpoint and no tunnel.
// Replies go out through the Chat REST API.
//
// Documented losses in Pub/Sub mode, encoded in the capabilities below: NO dialogs (modals) and no
// synchronous card updates. Card BUTTON clicks do arrive on the topic, so `buttons` stays true.
//
// Streaming: there is no streaming API. Progress rendering must be the edit-polling streamer,
// coalesced to the `spaces.messages.patch` quota of 1 write/sec per space (shared with every other
// app in that space) — hence editsPerSecond: 1 and nativeStreaming: false.
import { validatePlatformAdapter } from "./contract.js";
import { createNullConnector } from "./connector.js";
import { liveConnector, transportSnapshot } from "./live.js";
import { formatChatOutbound, MAX_CHAT_MESSAGE_CHARS } from "./format/gchat.js";
import { normalizeName } from "../slack/directory.js";

export const googleChatAdapter = validatePlatformAdapter({
  id: "googlechat",
  label: "Google Chat",
  // Chat space names already look like "spaces/AAAA…", but the prefix is what keeps the channel
  // index unambiguous when three platforms share one table.
  idPrefix: "gchat:",
  folderName: "google-chat",
  transport: "pubsub-pull",
  // preview, not ga: the transport is implemented and tested against fakes, but it has not yet run
  // against a live Google Workspace tenant. Claiming ga before that is how a surface ships broken.
  status: "preview",
  // `space` = a named/threaded space, `groupChat` = an unnamed multi-person chat, `dm` = 1:1.
  // spaceThreadingState is what distinguishes threaded spaces from flat ones at runtime.
  conversationKinds: ["space", "groupChat", "dm"],
  capabilities: {
    nativeStreaming: false,
    messageEdit: true,
    editsPerSecond: 1, // spaces.messages.patch quota, per space, shared across all apps in it
    threading: "native",
    // Threaded spaces have real threads; DMs and group chats are flat. The connector answers
    // per-conversation from spaceThreadingState — the session key is space+thread there, space
    // alone here.
    mixedThreading: true,
    ephemeral: false,
    deleteMessage: true,
    reactions: true,
    maxMessageChars: MAX_CHAT_MESSAGE_CHARS,
    markdown: "standard",
    // Standard Markdown went GA 2026-08-07 (`markup_syntax`), but tables and headings still do not
    // render in a plain message — only in Cards v2. Both are degraded by the formatter.
    markdownTables: false,
    markdownHeadings: false,
    markdownImages: false,
    markdownLists: true,
    blockQuotes: true,
    richCards: "cards-v2",
    buttons: true,
    modals: false, // explicitly unavailable in the Pub/Sub connection mode
    nativeTables: false,
    nativeCharts: false,
    lists: false,
    canvases: false,
    fileUpload: true,
    snippets: false,
    // media.download covers app-uploaded attachments; Drive-SHARED files need a Drive grant the bot
    // may not have, so ingest degrades gracefully rather than claiming full coverage.
    attachmentsIn: "partial",
    // Outside DMs a Chat app only receives messages it is @-mentioned in.
    seesUnmentionedMessages: false,
    mentionSyntax: "gchat",
    mentionByEmail: true, // <chat-user data-email="…"> in Markdown mode
    broadcast: true, // <users/all>
    proactivePost: true,
    proactiveDm: true, // spaces.findDirectMessage / spaces.setup
  },
  // Reference files that describe capabilities this surface does not have. Shipping them would
  // teach the agent to reach for tools that are not registered here.
  guideDrop: ["references/tables.md", "references/charts.md", "references/canvases.md"],
  formatOutbound(markdown, { directory = null, capabilities = this?.capabilities } = {}) {
    return formatChatOutbound(markdown, { capabilities: capabilities || googleChatAdapter.capabilities, directory, normalizeName });
  },
  // A LIVE connector when the transport is connected, and one that throws on every write when it is
  // not. Never a silent no-op: the scheduler and the follow-up tracker both treat a returned post as
  // delivered, so a quiet failure here reads as an answer the user never saw.
  createConnector() {
    return liveConnector("googlechat") || createNullConnector(
      "googlechat",
      googleChatAdapter.capabilities,
      "the Google Chat transport is not connected (service-account key + Pub/Sub subscription in Settings)",
    );
  },
  normalizeName,
  // Settings are imported lazily, inside the async health call. A static import would put the whole
  // config + database stack on the other side of a cycle (settings → paths → platform registry →
  // this adapter), which is a heavy and fragile thing for a module that is otherwise a pure
  // descriptor.
  health: async () => {
    const snapshot = transportSnapshot("googlechat");
    if (snapshot?.connected) return { ready: true, detail: snapshot.detail || "connected" };
    if (snapshot?.error) return { ready: false, detail: snapshot.error };
    const { hasGoogleChatConfig } = await import("../config/settings.js");
    if (!hasGoogleChatConfig()) return { ready: false, detail: "not configured" };
    return { ready: false, detail: "configured, not connected" };
  },
});
