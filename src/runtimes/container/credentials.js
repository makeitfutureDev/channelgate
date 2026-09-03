// How a containerized engine gets a login.
//
// CLAUDE is never copied and never mounted. Which login the gateway uses at all is decided in ONE
// place — src/gateway/claude-login.js, whose primary source is the OPERATOR's own ~/.claude login —
// and a container receives only a RELAY of that login's current ACCESS token
// (src/gateway/claude-token-relay.js), injected as CLAUDE_CODE_OAUTH_TOKEN at exec. A copy would be
// worse than useless: Claude Code writes `.credentials.json` by RENAME and rotates the refresh
// token on every refresh, so a second copy that refreshes logs the first one out — that happened
// live on 2026-09-02, and the same mechanism silently expired the gateway's own engine-home copy.
// What we also never do is mount the daemon's Claude config dir: its `projects/`, `sessions/`,
// `tasks/` and `session-env/` are symlinks into the operator's real ~/.claude, and mounting it
// would put every transcript on the box inside a channel container.
//
// CODEX writes `auth.json` IN PLACE through that same symlink and has done so for eight days, so a
// copy would fork the refresh chain and one side would eventually lose the race. Codex therefore
// gets a FILE bind mount of the real auth file — the one deliberate exception to "mount
// directories, never single files" (plan §6), justified by the observed in-place writes. Sessions
// and history still land in the per-channel HOME volume, which is what isolates channels; only the
// sign-in is shared. `cg-init` must create /home/agent/.codex and must never rename over the
// mounted path (a rename across a bind mount fails with EBUSY / EXDEV, and would break the chain
// for every channel at once).
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexEngineHome } from "../../config/paths.js";
// The login resolver lives in src/gateway/ because it is a GATEWAY-wide fact (host runs use the
// very same login), not a container one; src/runtimes/ already reaches into src/gateway/ for the
// folder contract, and this direction never reverses.
import { gatewayClaudeCredentialsFile, hasClaudeApiKey, resolveClaudeLogin } from "../../gateway/claude-login.js";
import { CONTAINER_CLAUDE_CONFIG_DIR, CONTAINER_CODEX_AUTH_FILE, CONTAINER_CODEX_HOME, CONTAINER_HOME } from "./image-paths.js";

export const AGENT_HOME = CONTAINER_HOME;
export const CLAUDE_CONTAINER_CONFIG_DIR = CONTAINER_CLAUDE_CONFIG_DIR;
export const CODEX_CONTAINER_HOME = CONTAINER_CODEX_HOME;
export const CODEX_CONTAINER_AUTH_FILE = CONTAINER_CODEX_AUTH_FILE;
export const CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

export const CLAUDE_MISSING_MESSAGE =
  "This channel runs in a container, but the gateway has no Claude login to relay. Sign in with "
  + "`claude` on the gateway host (its ~/.claude login is what the gateway uses), or paste a "
  + "`claude setup-token` value in Settings → Container runtime, or set ANTHROPIC_API_KEY for the "
  + "daemon (a Linux service install's service.env). "
  + "(The login file itself is never copied into a container: a copy that refreshes rotates the "
  + "refresh token and logs the gateway out — that happened live on 2026-09-02.)";
export const CLAUDE_API_KEY_NOTE =
  "authenticating Claude with the gateway's own API key (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the daemon's environment)";

// The third way a containerized Claude can authenticate: the daemon's OWN API key. A Linux service
// install has no login at all — docs/OPERATIONS.md tells the operator to fill ANTHROPIC_API_KEY
// into service.env — and that key already crosses into every engine child through the reviewed
// passthrough list in src/engines/child-env.js, containers included. Precedence: a setup-token,
// then a relay of a real login, then the key; the key is what stops "no login" from meaning "no
// Claude in containers" on an install that never had one. Re-exported from the login resolver so
// the precedence lives in exactly one file.
export { hasClaudeApiKey };
export const CODEX_MISSING_MESSAGE =
  "Codex is not signed in — run `codex login` on the gateway host. Container channels share the gateway's Codex sign-in file.";
export const CLAUDE_RELAY_NOTE =
  "relaying the host user's own Claude access token (refreshed on the host before each run; the login file is never copied)";
export const CODEX_SHARED_NOTE =
  "Codex sessions are per channel, but its sign-in file is shared with the gateway and every other container channel";

function readable(file) {
  if (!file) return "";
  try {
    accessSync(file, constants.R_OK);
    return realpathSync(file);
  } catch {
    return "";
  }
}

// The gateway's OWN Claude credentials file: the one inside the synthetic HOME every host `claude`
// subprocess runs under. It is only ONE of the candidate logins (see src/gateway/claude-login.js) —
// the operator's real ~/.claude comes first — so nothing may treat it as "the" login.
export function claudeCredentialsFile() {
  return gatewayClaudeCredentialsFile();
}

// The file the relay will actually read for this run, or "" when there is no usable login at all.
// It asks the resolver rather than stat-ing the engine home, so a container settles to "relay"
// whenever the OPERATOR is signed in — which, since we stopped planting a credentials link, is the
// normal case and the engine home is usually empty.
export function resolveClaudeCredentialSource(env = process.env) {
  const login = resolveClaudeLogin({ env });
  return login.kind === "operator" || login.kind === "gateway" ? readable(login.file) : "";
}

// Where the Codex CLI would look, in the order the gateway resolves it (mirrors
// src/engines/codex-auth.js `codexAuthCandidates`; duplicated rather than imported because
// src/runtimes/ must not depend on src/engines/ — see the import-graph rule in CLAUDE.md).
export function codexAuthCandidates(env = process.env) {
  const hostHome = String(env?.CODEX_HOME || path.join(os.homedir(), ".codex")).trim();
  const files = [];
  for (const dir of [codexEngineHome(), hostHome]) {
    if (!dir) continue;
    const file = path.join(dir, "auth.json");
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

export function resolveCodexAuthFile(env = process.env) {
  for (const candidate of codexAuthCandidates(env)) {
    const real = readable(candidate);
    if (real) return real;
  }
  return "";
}

// PURE — what prepareTarget() can know from the target alone. The Codex side is an INTENT that
// ensureUp() settles against the filesystem (settleCredentialModes below); Claude's "token" is
// decided by configuration alone, which is why it is exact here.
export function intendedCredentialModes(settings = {}) {
  return {
    // "relay" is the intent when no setup-token is configured: the daemon relays its own current
    // ACCESS token at spawn (src/gateway/claude-token-relay.js). Settled to "missing" below when
    // there is no readable gateway login at all.
    claude: settings?.hasClaudeOauthToken ? "token" : "relay",
    codex: "shared-file",
  };
}

// I/O — called by ensureUp before the container is created, so the fingerprint and the mount list
// reflect what is actually available.
export function settleCredentialModes(settings = {}, env = process.env) {
  const claudeSource = settings?.hasClaudeOauthToken ? "" : resolveClaudeCredentialSource(env);
  const codexAuthFile = resolveCodexAuthFile(env);
  return {
    modes: {
      claude: settings?.hasClaudeOauthToken ? "token" : claudeSource ? "relay" : hasClaudeApiKey(env) ? "api-key" : "missing",
      codex: codexAuthFile ? "shared-file" : "missing",
    },
    claudeSource,
    codexAuthFile,
  };
}



// The pre-spawn gate the runners call. Returns null when the engine can run, an Error naming the
// exact remedy when it cannot — never a silent failover to an engine that would also fail.
//
// It does not trust the mode alone. prepareTarget() is pure, so before ensureUp() has settled the
// target the modes are an INTENT ("copy" / "shared-file") that the filesystem may not support; a
// caller that gates earlier than expected must still get the right answer, so the two
// file-dependent modes are re-checked here. One stat, on a path that is about to be used anyway.
export function credentialError(target, engineId, env = process.env) {
  const modes = target?.container?.credentialMode || {};
  if (engineId === "claude") {
    // A setup-token, or a RELAY of the daemon's own access token — never a copy of the login file:
    // Claude Code rotates the refresh token on every refresh, so a second copy that refreshes
    // invalidates the first (a container copy logged the daemon out on 2026-09-02). An access
    // token cannot rotate anything, so relaying it keeps the daemon's chain the only chain.
    if (modes.claude === "token") return null;
    if (modes.claude === "relay" && resolveClaudeCredentialSource(env)) return null;
    // An API key is checked from the live environment, not the settled mode: it is what the
    // container will actually receive at spawn (child-env.js passthrough), and a key that appeared
    // after the target was settled must count just like a login that appeared would.
    if (hasClaudeApiKey(env)) return null;
    return new Error(CLAUDE_MISSING_MESSAGE);
  }
  if (engineId === "codex") {
    if (modes.codex === "missing") return new Error(CODEX_MISSING_MESSAGE);
    const file = target?.container?.codexAuthFile || resolveCodexAuthFile(env);
    return file ? null : new Error(CODEX_MISSING_MESSAGE);
  }
  return null;
}

export function credentialNotes(target) {
  const modes = target?.container?.credentialMode || {};
  const notes = [];
  if (modes.claude === "relay") notes.push(CLAUDE_RELAY_NOTE);
  if (modes.claude === "api-key") notes.push(CLAUDE_API_KEY_NOTE);
  if (modes.claude === "missing") notes.push(CLAUDE_MISSING_MESSAGE);
  if (modes.codex === "shared-file") notes.push(CODEX_SHARED_NOTE);
  if (modes.codex === "missing") notes.push(CODEX_MISSING_MESSAGE);
  return notes;
}

// Identity of the mounted auth file on the host side, so describe() can tell an operator when a
// container is holding an inode the host has since replaced (a `codex login` that rewrote rather
// than updated the file).
export function codexAuthIdentity(file) {
  if (!file) return null;
  try {
    const s = statSync(file);
    return { file, ino: String(s.ino), size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  } catch {
    return null;
  }
}

// The container-fixed environment every exec inherits. HOME and the two engine state dirs point
// INTO the per-channel HOME volume in every credential mode — that is what keeps transcripts,
// history and todos from leaking between channels.
export function containerEnvDefaults(target) {
  return {
    HOME: AGENT_HOME,
    CLAUDE_CONFIG_DIR: CLAUDE_CONTAINER_CONFIG_DIR,
    CODEX_HOME: CODEX_CONTAINER_HOME,
    CG_RUNTIME: "container",
    CG_CHANNEL: String(target?.slug || ""),
    CG_PLATFORM: String(target?.platform || ""),
  };
}
