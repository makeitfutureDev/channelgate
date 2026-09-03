// Bringing the non-Slack transports up, and keeping them connectable at runtime.
//
// Each platform gets a manager (connect/disconnect/snapshot) and registers itself in live.js, which
// is what makes `adapter.createConnector()` hand back a real connector instead of the throwing null
// one. Nothing here knows how a turn runs — that is ingest.js — and nothing in ingest.js knows how
// bytes reach a surface. The seam holds in both directions.
import { createTransportManager } from "./manager.js";
import { registerTransport } from "./live.js";
import { createIngest } from "./ingest.js";
import { requirePlatform } from "./registry.js";
import { createGoogleAuth } from "./googlechat/auth.js";
import { createChatApi } from "./googlechat/api.js";
import { createGoogleChatConnector } from "./googlechat/connector.js";
import { startGoogleChat } from "./googlechat/transport.js";
import { createTeamsAuth } from "./msteams/auth.js";
import { createTeamsApi } from "./msteams/api.js";
import { createTeamsConnector } from "./msteams/connector.js";
import { startTeams, botIdFor } from "./msteams/transport.js";

// The connector is built BEFORE the transport starts, on purpose: a Pub/Sub pull can deliver its
// first event inside start(), and an ingest that does not exist yet would drop that message. Wiring
// it up front means the very first message is answerable.
async function startGoogleChatTransport(config, log) {
  const capabilities = requirePlatform("googlechat").capabilities;
  const auth = createGoogleAuth({ serviceAccount: config.serviceAccountJson });
  const api = createChatApi({ auth });
  const connector = createGoogleChatConnector({ auth, capabilities, api, botUserId: config.botUserId, log });
  const ingest = createIngest({ connector, log });
  return startGoogleChat({
    ...config,
    capabilities,
    onMessage: ingest,
    log,
    deps: { auth, api, connector },
  });
}

async function startTeamsTransport(config, log) {
  const capabilities = requirePlatform("msteams").capabilities;
  const auth = createTeamsAuth({ clientId: config.appId, clientSecret: config.appPassword, tenantId: config.tenantId });
  const api = createTeamsApi({ auth });
  const connector = createTeamsConnector({
    auth, capabilities, api, botId: botIdFor(config.appId), tenantId: config.tenantId, log,
  });
  const ingest = createIngest({ connector, log });
  return startTeams({ ...config, capabilities, onMessage: ingest, log, deps: { auth, api, connector } });
}

export function createPlatformTransports({ log = console } = {}) {
  const googlechat = createTransportManager({ platform: "googlechat", log, start: (config) => startGoogleChatTransport(config, log) });
  const msteams = createTransportManager({ platform: "msteams", log, start: (config) => startTeamsTransport(config, log) });
  registerTransport("googlechat", googlechat);
  registerTransport("msteams", msteams);
  return { googlechat, msteams };
}

// Connect whatever is configured. Never throws: a bad Google key must not stop the daemon from
// coming up, exactly as a bad Slack token does not — the failure is captured in the manager's
// snapshot and shown on the Settings page.
export async function connectConfiguredPlatforms(transports, { log = console } = {}) {
  const { hasGoogleChatConfig, resolveGoogleChatConfig, hasTeamsConfig, resolveTeamsConfig, teamsMessagingEndpoint } =
    await import("../config/settings.js");

  if (hasGoogleChatConfig()) {
    const snapshot = await transports.googlechat.connect(resolveGoogleChatConfig());
    log.log?.(`[googlechat] ${snapshot.connected ? snapshot.detail || "connected" : `not connected — ${snapshot.error || "unknown error"}`}`);
  }
  if (hasTeamsConfig()) {
    const snapshot = await transports.msteams.connect(resolveTeamsConfig());
    log.log?.(`[msteams] ${snapshot.connected ? snapshot.detail || "connected" : `not connected — ${snapshot.error || "unknown error"}`}`);
    // Outbound-only is a real state on this surface and an easy one to miss: the bot answers
    // nothing because Azure has nowhere to deliver to, not because it is broken.
    if (snapshot.connected && !teamsMessagingEndpoint()) {
      log.warn?.("[msteams] WARNING: no public URL is set, so Azure has no endpoint to deliver messages to. Set it in Settings → Public URL and register <url>/api/teams/messages in the Azure bot.");
    }
  }
}
