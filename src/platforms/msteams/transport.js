// Wiring: credentials → Bot Framework API + webhook handler + connector, as one startable unit.
//
// Note the asymmetry with Google Chat: there is nothing to "start" on the inbound side. Teams pushes
// to us, so the transport's job is to hold a verified handler that the Express app can route to and
// to prove the outbound credentials work before reporting itself connected.
import { createTeamsAuth } from "./auth.js";
import { createTeamsApi, DEFAULT_SERVICE_URL } from "./api.js";
import { createTeamsConnector } from "./connector.js";
import { createTeamsWebhook } from "./webhook.js";
import { createJwksCache } from "./verify.js";

// The bot's own identity in an activity: Bot Framework prefixes the app id with the "28:" channel
// marker. Mention entities and the bot half of a new 1:1 conversation both use this form.
export const botIdFor = (appId) => (appId ? `28:${appId}` : "");

export async function startTeams({
  appId,
  appPassword,
  tenantId = "",
  serviceUrl = DEFAULT_SERVICE_URL,
  capabilities,
  onMessage,
  log = console,
  deps = {},
} = {}) {
  if (typeof onMessage !== "function") throw new TypeError("startTeams requires an onMessage handler");
  const auth = deps.auth || createTeamsAuth({ clientId: appId, clientSecret: appPassword, tenantId });
  // Same reason as the Chat side: fail at connect time with Entra's own error text rather than at
  // the first reply, hours later, in a channel.
  await auth.token();

  const api = deps.api || createTeamsApi({ auth, serviceUrl });
  const botId = botIdFor(appId);
  const connector = deps.connector || createTeamsConnector({ auth, capabilities, api, botId, tenantId, serviceUrl, log });
  const jwks = deps.jwks || createJwksCache();
  const handler = createTeamsWebhook({ appId, botId, onMessage, jwks, log });

  return {
    platform: "msteams",
    connector,
    handler,
    botId,
    detail: `bot ${appId}`,
    async stop() { /* nothing to unwind: the route asks the manager for the live handler */ },
  };
}
