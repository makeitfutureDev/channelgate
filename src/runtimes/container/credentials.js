// Engine state belongs to the channel HOME volume. No host authentication file is mounted.
import { daemonTimeZone } from "../../util/timezone.js";
import { gatewayClaudeCredentialsFile, hasClaudeApiKey } from "../../gateway/claude-login.js";
import { CONTAINER_CLAUDE_CONFIG_DIR, CONTAINER_CODEX_AUTH_FILE, CONTAINER_CODEX_HOME, CONTAINER_HOME } from "./image-paths.js";

export const AGENT_HOME = CONTAINER_HOME;
export const CLAUDE_CONTAINER_CONFIG_DIR = CONTAINER_CLAUDE_CONFIG_DIR;
export const CODEX_CONTAINER_HOME = CONTAINER_CODEX_HOME;
export const CODEX_CONTAINER_AUTH_FILE = CONTAINER_CODEX_AUTH_FILE;
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export { hasClaudeApiKey };
export const claudeCredentialsFile = gatewayClaudeCredentialsFile;
export const CLAUDE_MISSING_MESSAGE = "Claude requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the daemon service environment. Host subscription logins and setup-token values are not relayed.";
export const CLAUDE_API_KEY_NOTE = "Claude uses the daemon's service API credential; host subscription credentials are never relayed";
export const CODEX_MISSING_MESSAGE = "Set OPENAI_API_KEY or CODEX_API_KEY for the daemon, or authenticate the Codex CLI independently inside this channel's container.";
export const CODEX_CONTAINER_NOTE = "Codex authentication and sessions belong to this channel's container; no host auth.json is mounted";

export function hasCodexApiKey(env = process.env) {
  return Boolean(String(env?.CODEX_API_KEY || env?.OPENAI_API_KEY || "").trim());
}
export function intendedCredentialModes() {
  return { claude: "service-api", codex: "container-login" };
}
export function settleCredentialModes(_settings = {}, env = process.env) {
  return { modes: {
    claude: hasClaudeApiKey(env) ? "api-key" : "missing",
    codex: hasCodexApiKey(env) ? "api-key" : "container-login",
  }, claudeSource: "", codexAuthFile: "" };
}
export function credentialError(_target, engineId, env = process.env) {
  if (engineId === "claude" && !hasClaudeApiKey(env)) return new Error(CLAUDE_MISSING_MESSAGE);
  // The native Codex CLI validates its own container-owned login. The host cannot infer that
  // channel's state from the operator's auth file; an absent API key is not evidence of logout.
  return null;
}
export function credentialNotes(target) {
  const mode = target?.container?.credentialMode?.claude;
  return [mode === "api-key" ? CLAUDE_API_KEY_NOTE : CLAUDE_MISSING_MESSAGE, CODEX_CONTAINER_NOTE];
}

// The container-fixed environment every exec inherits. HOME and the two engine state dirs point
// INTO the per-channel HOME volume in every credential mode — that is what keeps transcripts,
// history and todos from leaking between channels.
//
// TZ is the DAEMON's zone, not the image's. The image is built on Etc/UTC while the daemon matches
// cron schedules against its own local clock, so without this an agent reading `date` inside the
// container answered "09:15 UTC" for a schedule that fires 09:15 in the daemon's zone. It rides in
// both places a container gets an environment — create (`-e TZ=…`, for anything not exec'd) and
// every exec's env-file — so the engines and the daemon read the same wall clock. Empty when the
// platform has no zone data, and then simply not passed (the image's UTC stands).
export function containerEnvDefaults(target) {
  return {
    HOME: AGENT_HOME,
    CLAUDE_CONFIG_DIR: CLAUDE_CONTAINER_CONFIG_DIR,
    CODEX_HOME: CODEX_CONTAINER_HOME,
    TZ: daemonTimeZone(),
    CG_RUNTIME: "container",
    CG_CHANNEL: String(target?.slug || ""),
    CG_PLATFORM: String(target?.platform || ""),
  };
}
