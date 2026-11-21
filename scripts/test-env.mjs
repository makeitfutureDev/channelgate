// The environment the regression suite runs in. `npm test` is also run by the live updater, whose
// process inherits the SERVING daemon's configuration: real Slack tokens, the public URL, license
// payloads, the approval secret, the listening port. Tests that build their own settings then saw
// a configured deployment instead of their fixture (a fake Slack manager was asked to connect, a
// passkey origin came from GATEWAY_PUBLIC_URL), so an update failed on the host while the same
// commit passed everywhere else. Strip the deployment's own configuration; keep the operating
// system environment and the switches that deliberately steer tests (live containers, browsers,
// screenshots). Dependency-free so the runner can import it before anything opens a database.

// Whole namespaces the daemon is configured through.
const DEPLOYMENT_PREFIXES = [
  "CHANNELGATE_", "CLAUDE_GATEWAY_", "GATEWAY_", "SLACK_", "GOOGLE_CHAT_", "TEAMS_",
  "COMPOSIO_", "SUPABASE_", "HUBSPOT_", "GEMINI_", "OPENAI_", "ANTHROPIC_", "WHISPER_",
];
// Single settings the daemon reads by name (src/config/settings.js ENV_MAP and the runtime knobs).
const DEPLOYMENT_NAMES = new Set([
  "PORT", "ADMIN_PASSWORD", "COMMAND_TIMEOUT", "MCP_TOOL_TIMEOUT", "SESSION_KEEPALIVE",
  "MAX_CONCURRENT_RUNS", "RESERVED_INTERACTIVE_RUNS", "WARM_POOL_MAX", "ERROR_DIAGNOSIS_CHANNEL",
]);
// CG_* is the daemon's own namespace (approval secret, run capability, update owner token, trust
// proxy …); only these test-control switches survive.
const KEEP_CG = /^CG_(LIVE_|BROWSER_|UI_SCREENSHOTS$|[A-Z_]*SCREENSHOT)/;

export function isDeploymentVariable(name) {
  const key = String(name || "");
  if (key.startsWith("CG_")) return !KEEP_CG.test(key);
  return DEPLOYMENT_NAMES.has(key) || DEPLOYMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function testEnvironment(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isDeploymentVariable(key)) out[key] = value;
  }
  return out;
}
