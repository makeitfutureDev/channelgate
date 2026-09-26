// The Codex login a CONTAINER run authenticates with — the twin of claude-token-relay.js.
//
// Which file is "the" Codex login is decided where the CLI itself looks (src/engines/codex-auth.js
// `codexAuthCandidates`): the gateway's engine home, else the operator's own `$CODEX_HOME`/~/.codex.
// Until container-secrets P4 that REAL auth.json — refresh token included — was bind-mounted
// read-write into every channel container: one channel could read the operator's refresh token,
// and every channel's sign-in was the same file. Now a container gets an ACCESS-ONLY auth.json in
// its own HOME volume, written by the daemon before each Codex run, whose access token is the
// channel's relay PLACEHOLDER in JWT shape (placeholders.js): the real token's header and payload
// (the CLI reads the claims locally — plan, account, expiry) with `cgph_r…` as the signature, and
// an EMPTY refresh token. The egress proxy swaps the whole token for the live access token on the
// OpenAI/ChatGPT hosts only (catalog-rules.js CODEX_RELAY_RULE). The container can use the login
// but cannot rotate or exfiltrate it.
//
// Spike, codex-cli 0.156.1, 2026-09-26 (TEST-PLAN.md): an access-only auth.json runs a turn; the
// CLI does not refresh on `last_refresh` age while the access token is valid (a 16-day-old
// `last_refresh` made no call to auth.openai.com); on a 401 it tries the refresh endpoint, which
// answers 400 `empty_string` for the empty refresh token — nothing can be rotated from inside. The
// JWT-shaped placeholder passes `codex login status` and a turn through the proxy (WebSocket
// included) with the swap.
//
// Refresh is therefore the DAEMON's job, done the only sanctioned way: a cheap `codex exec` turn in
// the login's own CODEX_HOME (what the operator's shell does), serialized under a keyed lock, when
// the access token has less than CODEX_RELAY_MIN_FRESH_MS left. Codex may decline to refresh a
// still-valid token, so an attempt that changed nothing backs off instead of spending a turn on
// every run.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { codexEngineHome, gatewayRoot } from "../config/paths.js";
import { codexAuthCandidates } from "../engines/codex-auth.js";
import { buildChildEnv } from "../engines/child-env.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { jwtClaimSegments } from "./egress/placeholders.js";

// The access token lives 10 days; refresh inside the last two (the CLI's own proactive window was
// 8 days after issue in the versions that had one).
export const CODEX_RELAY_MIN_FRESH_MS = 48 * 60 * 60 * 1000;
// A refresh turn that left the token unchanged is not retried for this long (the CLI renews a
// still-valid token on its own schedule), except once the token is actually expired.
export const CODEX_RELAY_RETRY_MS = 6 * 60 * 60 * 1000;
export const CODEX_RELAY_EXPIRED_RETRY_MS = 5 * 60 * 1000;
// The cheapest listed model with the lowest effort: the turn's answer is irrelevant.
export const CODEX_RELAY_REFRESH_MODEL = "gpt-5.6-luna";
// The signature segment of the container's id_token: not a placeholder (nothing swaps it) and not
// a real signature. The CLI parses the id_token's claims and never verifies it.
export const CODEX_ID_TOKEN_SIGNATURE = Buffer.from("channelgate-no-signature").toString("base64url");

// The payload claims of a JWT, or null.
function jwtPayload(jwt) {
  const segments = jwtClaimSegments(jwt);
  if (!segments) return null;
  try {
    return JSON.parse(Buffer.from(segments.payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// WHICH Codex login a container run relays: the first readable candidate the CLI would use.
// → { kind: "chatgpt"|"api-key"|"none", file, home, reason }. `home` is the CODEX_HOME the refresh
// turn runs in (the candidate's own directory, never a resolved symlink target's).
export function resolveCodexLogin({ env = process.env, candidates = null, readFileImpl = readFileSync } = {}) {
  const files = candidates || codexAuthCandidates({ codexHome: codexEngineHome(), env });
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileImpl(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return { kind: "none", file, home: path.dirname(file), reason: `the gateway's Codex login at ${file} could not be read` };
    }
    const access = typeof parsed?.tokens?.access_token === "string" ? parsed.tokens.access_token.trim() : "";
    if (access && jwtClaimSegments(access)) return { kind: "chatgpt", file, home: path.dirname(file), reason: "" };
    if (typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) {
      return { kind: "api-key", file, home: path.dirname(file), reason: "" };
    }
    return { kind: "none", file, home: path.dirname(file), reason: `${file} holds no ChatGPT sign-in — run \`codex login\` on the gateway host` };
  }
  return { kind: "none", file: "", home: "", reason: "Codex is not signed in on the gateway host — run `codex login` there" };
}

// The current ACCESS token and the facts the container's file needs. Never the refresh token.
export function readDaemonCodexAccessToken(login = resolveCodexLogin(), { readFileImpl = readFileSync } = {}) {
  const file = typeof login === "string" ? login : login?.file || "";
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileImpl(file, "utf8"));
    const tokens = parsed?.tokens || {};
    const token = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
    const claims = jwtPayload(token);
    if (!token || !claims) return null;
    const auth = claims["https://api.openai.com/auth"] || {};
    return {
      token,
      idToken: typeof tokens.id_token === "string" ? tokens.id_token.trim() : "",
      accountId: String(tokens.account_id || auth.chatgpt_account_id || ""),
      authMode: String(parsed.auth_mode || "chatgpt"),
      expiresAt: Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : 0,
      planType: String(auth.chatgpt_plan_type || ""),
    };
  } catch {
    return null;
  }
}

// One cheap turn in the login's own CODEX_HOME. Its answer is irrelevant; the side effect — the CLI
// refreshing and persisting a fresh pair in THAT auth.json — is the point. Ephemeral (no session
// files), the operator's config.toml ignored (no MCP servers, no profiles), read-only sandbox.
export async function refreshDaemonCodexToken({ login = resolveCodexLogin(), spawnImpl = spawn, timeoutMs = 120_000, log = console } = {}) {
  const codexHome = login?.home || "";
  if (!codexHome) {
    log?.warn?.("[codex-relay] no resolved Codex login to refresh");
    return;
  }
  // Scratch cwd under the gateway root, never the login's own directory.
  const cwd = path.join(gatewayRoot(), "tmp", "codex-relay");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(
        "codex",
        ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-m", CODEX_RELAY_REFRESH_MODEL,
          "-c", 'model_reasoning_effort="low"', "-s", "read-only", "Reply with exactly OK"],
        { cwd, env: buildChildEnv({ HOME: path.dirname(codexHome), CODEX_HOME: codexHome }), stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (e) {
      log?.warn?.(`[codex-relay] host refresh turn could not start: ${e?.message || e}`);
      return resolve();
    }
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) log?.warn?.(`[codex-relay] host refresh turn exited ${code}: ${stderr.trim().slice(-240).replace(/eyJ[A-Za-z0-9_.-]{20,}/g, "<jwt>")}`);
      resolve();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      log?.warn?.(`[codex-relay] host refresh turn failed: ${e?.message || e}`);
      resolve();
    });
  });
}

const lastAttempt = new Map(); // login file → { at, expiresAt }

export function __resetCodexRelayState() {
  lastAttempt.clear();
}

/**
 * @returns {Promise<{token: string, source: "chatgpt"|"api-key"|"none", expiresAt: number,
 *   idToken?: string, accountId?: string, authMode?: string, planType?: string, error?: string, login: object}>}
 * An empty token means there is nothing to relay, and `error` says why. Source "api-key" is an
 * API-key login, which this relay does not carry (the container keeps the shared file for it).
 */
export async function resolveContainerCodexToken({
  now = Date.now,
  minFreshMs = CODEX_RELAY_MIN_FRESH_MS,
  retryMs = CODEX_RELAY_RETRY_MS,
  expiredRetryMs = CODEX_RELAY_EXPIRED_RETRY_MS,
  refresh = refreshDaemonCodexToken,
  read = readDaemonCodexAccessToken,
  resolveLogin = resolveCodexLogin,
  env = process.env,
} = {}) {
  const login = resolveLogin({ env });
  if (login.kind === "api-key") return { token: "", source: "api-key", expiresAt: 0, error: `${login.file} holds an API key, not a ChatGPT sign-in`, login };
  if (login.kind !== "chatgpt") return { token: "", source: "none", expiresAt: 0, error: login.reason, login };
  let current = read(login);
  if (!current) return { token: "", source: "none", expiresAt: 0, error: `the gateway's Codex login at ${login.file} could not be read`, login };
  const stale = (entry) => Boolean(entry?.expiresAt) && entry.expiresAt - now() < minFreshMs;
  const due = (entry) => {
    const last = lastAttempt.get(login.file);
    if (!last || last.expiresAt !== entry.expiresAt) return true;
    return now() - last.at >= (entry.expiresAt <= now() ? expiredRetryMs : retryMs);
  };
  if (stale(current) && due(current)) {
    const release = await acquireKeyedLock("codex-relay", "refresh");
    try {
      current = read(login) || current;
      if (stale(current) && due(current)) {
        lastAttempt.set(login.file, { at: now(), expiresAt: current.expiresAt });
        await refresh({ login });
        current = read(login) || current;
      }
    } finally {
      release();
    }
  }
  if (current.expiresAt && current.expiresAt <= now()) {
    return { token: "", source: "chatgpt", expiresAt: current.expiresAt, error: "the gateway's Codex access token is expired and the refresh turn did not renew it (check the host's `codex login` and usage limits)", login };
  }
  return { ...current, source: "chatgpt", login };
}

// The container's auth.json: the relay PLACEHOLDER as the access token (already JWT-shaped), the
// real id_token's claims with a non-signature, the account id, an EMPTY refresh token, and
// `last_refresh` = now so the CLI never considers the file due for a refresh of its own.
export function renderContainerCodexAuth({ accessToken, idToken = "", accountId = "", now = Date.now } = {}) {
  const id = jwtClaimSegments(idToken);
  return `${JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: id ? `${id.header}.${id.payload}.${CODEX_ID_TOKEN_SIGNATURE}` : "",
      access_token: String(accessToken || ""),
      refresh_token: "",
      account_id: String(accountId || ""),
    },
    last_refresh: new Date(now()).toISOString(),
  }, null, 2)}\n`;
}
