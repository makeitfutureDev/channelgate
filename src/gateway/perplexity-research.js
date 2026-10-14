// Research delegation is a separate model process, not a coding engine or a tool-executing agent.
// Its persistent HOME login is only a channel-bound proxy placeholder. Settings remains the one
// home of the real subscription session; the proxy reads it live for rotation and disconnect.
import path from "node:path";
import { getPerplexityResearchConfig } from "../config/settings.js";
import { egressActive } from "../runtimes/container/egress-hook.js";
import { placeholderFor, revokeGrants } from "./egress/grants.js";
import { PERPLEXITY_MCP_COMMAND, PERPLEXITY_MCP_NAME, PERPLEXITY_RELAY_SECRET_NAME } from "./perplexity-research-contract.js";

export function perplexityResearchAvailable(target, { clean = false, config = getPerplexityResearchConfig() } = {}) {
  return !clean && config.enabled === true && Boolean(config.sessionToken)
    && target?.meta?.allowNetwork === true && Boolean(target?.meta?.channelId)
    && egressActive(target) && typeof target?.runtime?.writeHomeFile === "function";
}

export function perplexityResearchMcp(target, options = {}) {
  if (!perplexityResearchAvailable(target, options)) return {};
  return { [PERPLEXITY_MCP_NAME]: { command: PERPLEXITY_MCP_COMMAND, args: [] } };
}

export async function installPerplexityResearchLogin(target, { clean = false, config = getPerplexityResearchConfig() } = {}) {
  // Never stage a real token, including on the legacy network/host paths. Those paths have no
  // destination-bound relay, so this optional integration remains absent there.
  if (!egressActive(target) || !target?.meta?.channelId || typeof target?.runtime?.writeHomeFile !== "function") return false;
  const channelId = target.meta.channelId;
  if (!config.enabled || !config.sessionToken) {
    const revoked = revokeGrants({ scope: "relay", channelId, secretName: PERPLEXITY_RELAY_SECRET_NAME });
    if (revoked) await target.runtime.writeHomeFile(target, {
      file: path.posix.join(target.container.home, ".config/perplexity-web-mcp/token"), body: "",
    });
    return false;
  }
  // Clean/network-off runs get no MCP injection or login delivery. Do not erase a shared HOME
  // login while a different, admitted turn's research process may still be using it.
  if (!perplexityResearchAvailable(target, { clean, config })) return false;
  const placeholder = placeholderFor({ scope: "relay", channelId, secretName: PERPLEXITY_RELAY_SECRET_NAME });
  await target.runtime.writeHomeFile(target, {
    file: path.posix.join(target.container.home, ".config/perplexity-web-mcp/token"), body: `${placeholder}\n`,
  });
  return true;
}

export function perplexityResearchPreamble(target, options = {}) {
  if (!perplexityResearchAvailable(target, options)) return "";
  return "[Perplexity research delegation]\n"
    + "The perplexity-research MCP provides a subscription-backed research subagent. Use perplexity_research for public web research; select quick or deep mode and an optional model. Check perplexity_usage and perplexity_models when needed. "
    + "Send a self-contained research question and collect its answer and citations before replying. It has no local workspace, coding tools, private connectors or access to your conversation history unless you send that text. "
    + "Requests consume the shared configured Perplexity subscription quota. The bridge is unofficial. An expired login must be replaced in gateway Settings.\n[End Perplexity research delegation]\n\n";
}
