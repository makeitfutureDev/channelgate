// The Claude credential a run — host OR container — authenticates with.
//
// WHICH login is used is decided in one place (src/gateway/claude-login.js): a configured
// `claude setup-token`, else the OPERATOR's own `~/.claude` login, else a login signed in to the
// gateway's engine home, else the daemon's API key. This module turns that decision into the thing
// a subprocess can use: a current ACCESS token, handed over as CLAUDE_CODE_OAUTH_TOKEN.
//
// Why a relay and never a copy of the credentials file: Claude Code rotates the refresh token on
// every refresh, so a second copy that refreshes invalidates the first. A container copy logged the
// daemon out live on 2026-09-02, and the engine home's own stale copy (planted as a symlink, then
// replaced by Claude Code's rename-on-refresh) is what made the daemon's Claude look logged out
// while the operator's shell was signed in. An ACCESS token carries no refresh token: the child can
// use it but cannot rotate anything, so the operator's chain stays the only chain. The price is
// that an access token lives ~8 h — so before handing one out with less than RELAY_MIN_FRESH_MS
// left, the daemon refreshes it the only sanctioned way: a cheap turn in THAT login's own config
// dir, which is exactly what the operator's own shell does. Serialized, so concurrent runs trigger
// one refresh.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getContainerClaudeOauthToken } from "../config/settings.js";
import { gatewayRoot } from "../config/paths.js";
import { hasClaudeApiKey, resolveClaudeLogin } from "./claude-login.js";
import { buildChildEnv } from "../engines/child-env.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";

export const RELAY_MIN_FRESH_MS = 30 * 60 * 1000;
// The cheapest model that still exercises a real authenticated turn (≈ $0.001).
export const RELAY_REFRESH_MODEL = "claude-haiku-4-5-20251001";

// `source` is the resolved login (src/gateway/claude-login.js) or, for callers that already know
// the path, the credentials file itself.
export function readDaemonClaudeAccessToken(source = resolveClaudeLogin()) {
  const file = typeof source === "string" ? source : source?.file || "";
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const oauth = parsed?.claudeAiOauth || {};
    if (!oauth.accessToken) return null;
    return { token: String(oauth.accessToken), expiresAt: Number(oauth.expiresAt) || 0 };
  } catch {
    return null;
  }
}

// One turn with the RESOLVED login's own HOME + CLAUDE_CONFIG_DIR. Its ANSWER is irrelevant; the
// side effect — Claude Code refreshing and persisting a fresh pair in THAT credentials file — is
// the point. Running it in the operator's own config dir is the only way to renew the operator's
// session, and it is byte-for-byte what their own shell does.
export async function refreshDaemonClaudeToken({ source = resolveClaudeLogin(), spawnImpl = spawn, timeoutMs = 120_000, log = console } = {}) {
  const home = source?.home || "";
  const configDir = source?.configDir || "";
  if (!home || !configDir) {
    log?.warn?.("[claude-relay] no resolved Claude login to refresh");
    return;
  }
  // Scratch cwd under the gateway root, never the login's own directory: the turn must not be able
  // to touch anything beside the credential it is renewing.
  const cwd = path.join(gatewayRoot(), "tmp", "claude-relay");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        "claude",
        ["-p", "Reply with exactly OK", "--max-turns", "1", "--model", RELAY_REFRESH_MODEL, "--output-format", "json", "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config"],
        { cwd, env: buildChildEnv({ HOME: home, CLAUDE_CONFIG_DIR: configDir }), stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      log?.warn?.(`[claude-relay] host refresh turn could not start: ${e?.message || e}`);
      return resolve();
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) log?.warn?.(`[claude-relay] host refresh turn exited ${code}: ${stderr.trim().slice(0, 240)}`);
      resolve();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      log?.warn?.(`[claude-relay] host refresh turn failed: ${e?.message || e}`);
      resolve();
    });
  });
}

/**
 * @returns {Promise<{token: string, source: "settings"|"operator"|"gateway"|"api-key"|"none",
 *                    expiresAt: number, error?: string, login?: object}>}
 * `source` is the LOGIN KIND that answered (src/gateway/claude-login.js). An empty `token` with
 * source "api-key" means the run authenticates with the daemon's own ANTHROPIC_API_KEY (already in
 * the child env via src/engines/child-env.js) and needs no token at all. An empty `token` with any
 * other source means there is nothing to relay, and `error` is the operator-facing reason — a
 * CONTAINER run fails closed on it, a host run logs it and lets the engine speak for itself.
 */
export async function resolveContainerClaudeToken({
  now = Date.now,
  minFreshMs = RELAY_MIN_FRESH_MS,
  refresh = refreshDaemonClaudeToken,
  read = readDaemonClaudeAccessToken,
  resolveLogin = resolveClaudeLogin,
  configured = getContainerClaudeOauthToken,
  env = process.env,
} = {}) {
  const login = resolveLogin({ env, now, configured });
  if (login.kind === "settings") {
    return { token: String(configured() || "").trim(), source: "settings", expiresAt: 0, login };
  }
  // The daemon's own API key is the fallback for every "no usable login" outcome below — a Linux
  // service install never has a login, only the key (docs/OPERATIONS.md).
  const keyed = hasClaudeApiKey(env) ? { token: "", source: "api-key", expiresAt: 0, login } : null;
  if (login.kind === "api-key") return keyed || { token: "", source: "none", expiresAt: 0, error: login.reason, login };
  if (login.kind === "none") return keyed || { token: "", source: "none", expiresAt: 0, error: login.reason, login };

  let current = read(login);
  if (!current) return keyed || { token: "", source: login.kind, expiresAt: 0, error: `the gateway's Claude login at ${login.file} could not be read`, login };
  const stale = (entry) => Boolean(entry?.expiresAt) && entry.expiresAt - now() < minFreshMs;
  if (stale(current)) {
    const release = await acquireKeyedLock("claude-relay", "refresh");
    try {
      current = read(login);
      if (stale(current)) {
        await refresh({ source: login });
        current = read(login);
      }
    } finally {
      release();
    }
  }
  if (!current?.token) return keyed || { token: "", source: login.kind, expiresAt: 0, error: "the gateway's Claude login could not be read after a refresh", login };
  if (current.expiresAt && current.expiresAt <= now()) {
    return keyed || { token: "", source: login.kind, expiresAt: current.expiresAt, error: "the gateway's Claude access token is expired and the refresh turn did not renew it (check the host's Claude sign-in and usage limits)", login };
  }
  return { token: current.token, source: login.kind, expiresAt: current.expiresAt, login };
}

// What the warm pool must key on so a refreshed token retires a warm process that is still holding
// the old one. Deliberately the SOURCE and its expiry, never the token text: a fingerprint is
// compared, stored in a pool key and carried around, and token material has no business there.
export function claudeTokenFingerprint(relay) {
  if (!relay) return "";
  // A file-backed login is identified by its path + the expiry of the token handed out (a refresh
  // moves the expiry, which is exactly when a warm process must be retired). A tokenless source
  // (setup-token, API key) has no file, so its opaque digest stands in — a rotated setup-token
  // must retire warm processes too.
  const where = relay.login?.file || relay.login?.fingerprint || "";
  return `${relay.source || ""}|${where}|${relay.expiresAt || 0}`;
}
