// Service authentication for gateway Claude runs. No host subscription credential is opened.
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { claudeEngineHome } from "../config/paths.js";

// A login SESSION (the refresh-token grant) is good for a few weeks and only a new interactive
// `claude` login moves it. Warn while there is still a working day to act in.
export const CLAUDE_LOGIN_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

export function claudeLoginHint() {
  return "set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the daemon service environment";
}

// Legacy path helpers used only by migration and test fixtures; authentication never opens them.
export function operatorClaudeConfigDir() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

// The gateway's OWN Claude config dir: the synthetic HOME every host `claude` child runs under.
export function gatewayClaudeConfigDir() {
  return path.join(claudeEngineHome(), ".claude");
}
export function gatewayClaudeCredentialsFile() {
  return path.join(gatewayClaudeConfigDir(), ".credentials.json");
}

// The daemon's own API key. A Linux service install has no login at all — docs/OPERATIONS.md tells
// the operator to fill ANTHROPIC_API_KEY into service.env — and that key already crosses into every
// engine child through the reviewed passthrough list in src/engines/child-env.js.
export function hasClaudeApiKey(env = process.env) {
  return Boolean(String(env?.ANTHROPIC_API_KEY || env?.ANTHROPIC_AUTH_TOKEN || "").trim());
}

// An opaque marker for "this exact credential". Callers only ever COMPARE two of them ("has the
// credential changed since the one that failed?"), never interpret one. A content hash is the
// honest answer: a sign-in and every successful refresh rewrite the file, while a grant revoked
// server-side leaves the bytes untouched.
function fingerprintOf(raw) {
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
}

const NO_FILE = Object.freeze({ file: "", configDir: "", home: "", accessExpiresAt: 0, expiresAt: 0 });

// Subscription credentials are deliberately never read, refreshed, or relayed by the gateway.
// Provider policy for third-party products requires API/provider authentication. A stored legacy
// setup-token remains inert until the operator removes it; it cannot change this selection.
export function resolveClaudeLogin({ env = process.env } = {}) {
  const key = String(env?.ANTHROPIC_AUTH_TOKEN || env?.ANTHROPIC_API_KEY || "").trim();
  if (key) return {
    ...NO_FILE, kind: "api-key", fingerprint: fingerprintOf(key), reason: "",
    detail: "the daemon's service API credential (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)",
  };
  const reason = `Claude requires a service API credential — ${claudeLoginHint()}. Host subscription logins and setup-token values are not relayed.`;
  return { ...NO_FILE, kind: "none", fingerprint: "", detail: reason, reason };
}

// One line for a boot log, a health payload or /status. Names the source and the date the login
// itself dies — never a token, never a digest.
export function claudeLoginSummary(login = resolveClaudeLogin()) {
  const where = login.kind === "operator" ? ` (${login.configDir})` : login.kind === "gateway" ? " (gateway engine home)" : "";
  const expiry = login.expiresAt ? `, session expires ${new Date(login.expiresAt).toISOString().slice(0, 10)}` : "";
  return `${login.kind}${where}${expiry}`;
}

/**
 * The status/health view. Deliberately a narrow projection: kind, where it came from, and the two
 * expiries. No token material of any kind.
 */
export function describeClaudeLogin(login = resolveClaudeLogin()) {
  return {
    kind: login.kind,
    file: login.file,
    configDir: login.configDir,
    expiresAt: login.expiresAt,
    accessExpiresAt: login.accessExpiresAt,
    detail: login.detail,
    summary: claudeLoginSummary(login),
  };
}

// "" unless the ACTIVE login's session dies within the warning window — a setup-token and an API
// key never expire on their own, and a login already dead is reported by the resolver as "none".
export function claudeLoginExpiryWarning(login = resolveClaudeLogin(), { now = Date.now, windowMs = CLAUDE_LOGIN_EXPIRY_WARNING_MS } = {}) {
  if (!login?.expiresAt) return "";
  const left = login.expiresAt - now();
  if (left > windowMs) return "";
  const when = new Date(login.expiresAt).toISOString().replace("T", " ").slice(0, 16);
  if (left <= 0) return `the Claude login the gateway uses (${login.kind}) EXPIRED at ${when} UTC — ${claudeLoginHint()}`;
  const hours = Math.round(left / 3_600_000);
  return `the Claude login the gateway uses (${login.kind}) expires in ${hours}h (${when} UTC) — ${claudeLoginHint()}`;
}

// The host branch fails OPEN (the engine's own error is better than ours, and the runner already
// classifies it into the cross-engine failover), so the only way an operator learns about a missing
// login before turns start dying is a log line. Throttled, because it would otherwise print on
// every turn of every channel.
const MISSING_WARN_INTERVAL_MS = 60 * 60 * 1000;
let lastMissingWarnAt = 0;
export function warnClaudeLoginMissing(reason, { log = console, now = Date.now, intervalMs = MISSING_WARN_INTERVAL_MS } = {}) {
  const at = now();
  if (at - lastMissingWarnAt < intervalMs) return false;
  lastMissingWarnAt = at;
  log?.warn?.(`[claude-login] WARNING: ${reason}`);
  return true;
}
export function resetClaudeLoginWarnings() { lastMissingWarnAt = 0; }
