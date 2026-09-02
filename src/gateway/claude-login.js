// WHICH Claude login the gateway authenticates with. One resolver, consulted by the token relay
// (host AND container runs), by the container credential modes, by the engine health probe and by
// /status — so there is exactly one answer to "whose subscription is answering this turn?".
//
// The OPERATOR's own login is the primary source. The gateway runs as the same person who types
// `claude` in their shell, and that shell login is the one they actually keep alive; it lives in
// `$CLAUDE_CONFIG_DIR` (or `~/.claude`). We deliberately do NOT copy or link it: Claude Code writes
// `.credentials.json` by RENAME, so a copy that refreshes replaces the file and the two chains
// diverge — which is exactly what happened here. The gateway's synthetic engine home held a plain
// copy of a login made weeks earlier, that copy expired, and every Claude turn started failing over
// to Codex while the operator's own `claude` was perfectly signed in. Reading the operator's file
// and relaying its ACCESS token (src/gateway/claude-token-relay.js) keeps ONE chain: the daemon
// never rotates a refresh token the operator's shell does not know about.
//
// Precedence, first usable wins:
//   settings  a `claude setup-token` value an admin pasted — an explicit choice, so it wins
//   operator  <CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json — the login the operator maintains
//   gateway   <engine home>/.claude/.credentials.json — a login somebody signed the gateway in with
//   api-key   the daemon's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (Linux service installs)
//   none      nothing usable; `reason` names the remedy
// operator BEFORE gateway is the point of this module: a stale engine-home copy must never shadow
// the login the operator is keeping alive. A usable engine-home login still counts, so a host that
// was deliberately signed in there keeps working.
//
// Nothing here ever returns, logs or hashes-into-readability a token: the relay reads the token
// itself, and everything this module hands out is a path, a kind, an expiry or an opaque digest.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeEngineHome } from "../config/paths.js";
import { getContainerClaudeOauthToken } from "../config/settings.js";

// A login SESSION (the refresh-token grant) is good for a few weeks and only a new interactive
// `claude` login moves it. Warn while there is still a working day to act in.
export const CLAUDE_LOGIN_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000;

export function claudeLoginHint() {
  let user = "";
  try { user = os.userInfo().username; } catch { user = ""; }
  return `sign in with \`claude\` on the gateway host${user ? ` as ${user}` : ""} (its ~/.claude login is what the gateway uses)`;
}

// The operator's real Claude config dir — the SAME expression run-grant-artifacts.stableClaudeState()
// uses to build the engine home, so the two can never drift apart. Read from process.env rather
// than a passed-in env on purpose: WHERE the login lives is machine state, not a per-call input,
// and a caller that hands this module a narrowed environment (the container credential modes pass
// one to control CODEX_HOME) must not thereby be told the operator has no login.
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

/**
 * Parse one `.credentials.json`. Returns null when it is not there at all; otherwise a record
 * carrying only paths, expiries and a digest — never the token.
 */
export function readClaudeCredentialFile(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { file, broken: "not valid JSON", hasToken: false, accessExpiresAt: 0, expiresAt: 0, fingerprint: fingerprintOf(raw) };
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return { file, broken: "holds no claudeAiOauth login", hasToken: false, accessExpiresAt: 0, expiresAt: 0, fingerprint: fingerprintOf(raw) };
  }
  return {
    file,
    broken: "",
    hasToken: Boolean(typeof oauth.accessToken === "string" && oauth.accessToken.trim()),
    // The ACCESS token's own expiry (~8-12 h). The relay refreshes against it.
    accessExpiresAt: Number(oauth.expiresAt) || 0,
    // The SESSION's hard expiry (~3-4 weeks). Only a new interactive login moves it, so this is
    // the date an operator has to put in their calendar.
    expiresAt: Number(oauth.refreshTokenExpiresAt) || 0,
    fingerprint: fingerprintOf(raw),
  };
}

// USABLE = it parses, it carries an access token, and its login session has not hard-expired. An
// expired ACCESS token is explicitly still usable: refreshing it is exactly what the relay does.
export function claudeCredentialUsable(entry, now = Date.now()) {
  if (!entry || entry.broken || !entry.hasToken) return false;
  return !(entry.expiresAt && entry.expiresAt <= now);
}

// The two on-disk logins, in precedence order. Each carries the HOME/CLAUDE_CONFIG_DIR a refresh
// turn must run with to renew THAT chain.
export function claudeLoginCandidates() {
  const operatorDir = operatorClaudeConfigDir();
  const gatewayDir = gatewayClaudeConfigDir();
  return [
    { kind: "operator", configDir: operatorDir, home: os.homedir(), file: path.join(operatorDir, ".credentials.json") },
    { kind: "gateway", configDir: gatewayDir, home: claudeEngineHome(), file: path.join(gatewayDir, ".credentials.json") },
  ];
}

const NO_FILE = Object.freeze({ file: "", configDir: "", home: "", accessExpiresAt: 0, expiresAt: 0 });

/**
 * `env` is the DAEMON's environment and is consulted only for the API-key layer; the on-disk
 * candidates come from process.env / os.homedir() (see operatorClaudeConfigDir).
 * @returns {{kind:"settings"|"operator"|"gateway"|"api-key"|"none", file:string, configDir:string,
 *            home:string, accessExpiresAt:number, expiresAt:number, fingerprint:string,
 *            detail:string, reason:string}}
 */
export function resolveClaudeLogin({ env = process.env, now = Date.now, configured = getContainerClaudeOauthToken } = {}) {
  const fixed = String(configured?.() || "").trim();
  if (fixed) {
    return {
      ...NO_FILE, kind: "settings", fingerprint: fingerprintOf(fixed), reason: "",
      detail: "a `claude setup-token` value configured in Settings → Container runtime",
    };
  }
  const at = now();
  const rejected = [];
  for (const candidate of claudeLoginCandidates()) {
    const entry = readClaudeCredentialFile(candidate.file);
    if (!entry) { rejected.push(`${candidate.file} (absent)`); continue; }
    if (!claudeCredentialUsable(entry, at)) {
      rejected.push(`${candidate.file} (${entry.broken || (!entry.hasToken ? "no access token" : "login session expired")})`);
      continue;
    }
    return {
      kind: candidate.kind,
      file: candidate.file,
      configDir: candidate.configDir,
      home: candidate.home,
      accessExpiresAt: entry.accessExpiresAt,
      expiresAt: entry.expiresAt,
      fingerprint: entry.fingerprint,
      detail: `${candidate.kind === "operator" ? "the host user's own Claude Code login" : "a Claude login signed in to the gateway's engine home"} (${candidate.file})`,
      reason: "",
    };
  }
  const key = String(env?.ANTHROPIC_API_KEY || env?.ANTHROPIC_AUTH_TOKEN || "").trim();
  if (key) {
    return {
      ...NO_FILE, kind: "api-key", fingerprint: fingerprintOf(key), reason: "",
      detail: "the daemon's own ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN",
    };
  }
  // Name every remedy, in the same precedence the resolver just walked: the host sign-in first
  // (it is the one that needs no configuration at all), then the two configured alternatives.
  const reason = `the gateway has no usable Claude login — ${claudeLoginHint()}`
    + ", or paste a `claude setup-token` value in Settings → Container runtime, or set"
    + " ANTHROPIC_API_KEY for the daemon"
    + `${rejected.length ? ` (checked ${rejected.join(", ")})` : ""}`;
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
