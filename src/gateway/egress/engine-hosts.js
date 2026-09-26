// The endpoints an ENGINE needs to answer a turn, reachable through the egress proxy even when the
// channel's Allow network switch is off. "Network off" means the agent's tools do not reach the
// internet — not that the model itself goes silent.
//
// Deliberately small and exact: an OAuth host or a telemetry host that is missing here fails that
// one call visibly (the proxy answers 403 with the reason), which is how a gap is found; a
// wildcard here would quietly widen every off-network channel.
export const ENGINE_HOSTS = Object.freeze({
  claude: Object.freeze(["api.anthropic.com", "claude.ai", "statsig.anthropic.com"]),
  codex: Object.freeze(["api.openai.com", "chatgpt.com", "auth.openai.com"]),
});

// The union for the given engines (default: every engine). The proxy's policy uses the union: which
// harness answers the next request is a per-thread fact the socket cannot see, and every host here
// is an engine API the gateway itself authenticates.
export function engineHostsFor(engines = Object.keys(ENGINE_HOSTS)) {
  const out = new Set();
  for (const engine of engines) for (const host of ENGINE_HOSTS[engine] || []) out.add(host);
  return [...out];
}

// The hostname of an http(s) URL, or "" (for the Qwen endpoints and remote MCP URLs).
export function hostOfUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["https:", "http:"].includes(url.protocol) ? url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1") : "";
  } catch {
    return "";
  }
}
