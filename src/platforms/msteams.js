// Microsoft Teams platform adapter.
//
// Connectivity model (why this is the heavier surface): every supported Teams bot path delivers
// messages as inbound HTTPS POSTs from Azure Bot Service to a registered public endpoint — there is
// no Socket Mode equivalent. Keeping the daemon outbound-only means an Azure Relay Hybrid
// Connection: the daemon holds an outbound websocket to *.servicebus.windows.net and the Relay
// tunnels Bot Service's POSTs down it. SENDING is always outbound, so only receiving needs the
// Relay. That listener is the one genuinely uncertain piece and gets a proof-of-concept first.
//
// Formatting is the biggest UX conversion cost on this platform: no tables, no headings, no inline
// images, and lists render on desktop only. All four are degraded by the formatter; anything that
// must be visually rich becomes an Adaptive Card.
import { validatePlatformAdapter } from "./contract.js";
import { createNullConnector } from "./connector.js";
import { liveConnector, transportSnapshot } from "./live.js";
import { formatTeamsOutbound, MAX_TEAMS_MESSAGE_CHARS } from "./format/teams.js";
import { normalizeName } from "../slack/directory.js";

export const teamsAdapter = validatePlatformAdapter({
  id: "msteams",
  label: "Microsoft Teams",
  idPrefix: "teams:",
  folderName: "teams",
  // The shipped transport is the documented Bot Framework one: Azure Bot Service POSTs activities to
  // a public HTTPS endpoint, which the daemon already terminates for the admin UI and the run API.
  // An Azure Relay Hybrid Connection would remove the public-URL requirement and swaps in FRONT of
  // the same handler — it stays on the roadmap rather than blocking the surface.
  transport: "bot-framework",
  status: "beta",
  conversationKinds: ["channel", "groupChat", "personal"],
  capabilities: {
    // Native token streaming DOES exist on Teams, but only in 1:1 chats, at 1 req/sec, with a
    // 2-minute cap — unusable as the gateway's general progress surface (our turns routinely run
    // longer than two minutes). Declared false; the edit-polling streamer is the real path.
    nativeStreaming: false,
    messageEdit: true,
    // 7 ops/sec and 1800/hour per thread. 1/sec keeps a long run inside the hourly budget too:
    // 7/sec would exhaust 1800 in four minutes.
    editsPerSecond: 1,
    threading: "native",
    // Channel reply-threads map onto our thread model; 1:1 and group chats are flat.
    mixedThreading: true,
    ephemeral: false,
    deleteMessage: true,
    reactions: true,
    reactionTriggers: true,
    maxMessageChars: MAX_TEAMS_MESSAGE_CHARS,
    markdown: "subset",
    markdownTables: false,
    markdownHeadings: false,
    markdownImages: false,
    markdownLists: false, // desktop-only rendering — degrade so mobile readers see the structure
    blockQuotes: false,
    richCards: "adaptive-cards",
    buttons: true,
    modals: true, // task modules
    nativeTables: false,
    nativeCharts: false,
    lists: false,
    canvases: false,
    fileUpload: true,
    snippets: false,
    // 1:1 chats hand us a pre-authenticated download URL (trivial); channel files live in
    // SharePoint/OneDrive and need Graph application permissions with tenant admin consent.
    attachmentsIn: "partial",
    // Bots in channels receive only @-mentioned messages unless granted RSC
    // ChannelMessage.Read.Group.
    seesUnmentionedMessages: false,
    mentionSyntax: "teams",
    mentionByEmail: true, // mention by UPN/email or Entra object id
    broadcast: true,
    proactivePost: true,
    proactiveDm: true, // stored conversation references; 1:1 by Entra object id
  },
  guideDrop: ["references/tables.md", "references/charts.md", "references/canvases.md"],
  formatOutbound(markdown, { directory = null, capabilities = this?.capabilities } = {}) {
    return formatTeamsOutbound(markdown, { capabilities: capabilities || teamsAdapter.capabilities, directory, normalizeName });
  },
  createConnector() {
    return liveConnector("msteams") || createNullConnector(
      "msteams",
      teamsAdapter.capabilities,
      "the Teams transport is not connected (Azure bot app id + client secret in Settings)",
    );
  },
  normalizeName,
  // Lazy settings import for the same reason as the Google Chat adapter: no static cycle from a
  // descriptor into the config/database stack.
  health: async () => {
    const snapshot = transportSnapshot("msteams");
    const { hasTeamsConfig, teamsMessagingEndpoint } = await import("../config/settings.js");
    if (snapshot?.connected) {
      // Outbound can be perfectly healthy while inbound is impossible: without a public URL there is
      // no messaging endpoint to register in Azure, so the bot can talk but never hears anything.
      return teamsMessagingEndpoint()
        ? { ready: true, detail: snapshot.detail || "connected" }
        : { ready: false, detail: "connected for sending, but no public URL is set — Teams cannot deliver messages to this daemon" };
    }
    if (snapshot?.error) return { ready: false, detail: snapshot.error };
    if (!hasTeamsConfig()) return { ready: false, detail: "not configured" };
    return { ready: false, detail: "configured, not connected" };
  },
});
