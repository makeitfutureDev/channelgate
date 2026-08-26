// Minimal ALLOWLISTED environment for every child the daemon spawns (engine subprocesses and
// background shell jobs). The channel sandbox confines the filesystem and MCP surface, but it
// cannot hide a child's own environment — `printenv` in any bash/auto channel would post whatever
// we pass straight back to Slack. The daemon's env carries real secrets (SLACK_BOT_TOKEN,
// SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, CG_APPROVAL_SECRET, ADMIN_PASSWORD), so children get
// ONLY what's below. This is the single place that decides what crosses the spawn boundary:
// it is an allowlist by construction — NEVER turn it into a denylist, because a new secret in
// process.env must be invisible to children by default, not leaked until someone remembers to
// block it. Anything a spawn site needs beyond this rides in via the explicit `extra` merge.
import os from "node:os";
import path from "node:path";

// Exact variable names that pass through. Base POSIX session vars (the engine CLIs find their
// auth/config dirs via HOME), proxy settings in both cases, and the MCP timeout knobs the
// `claude` CLI reads (server.js raises MCP_TOOL_TIMEOUT so Slack approvals can wait for a human).
const ALLOWED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  "SSH_AUTH_SOCK", // ssh-agent socket PATH (not a secret) — ssh-remote git in bash channels
  "NODE_EXTRA_CA_CERTS", // path to a PUBLIC CA bundle — corporate-TLS setups
  // Locale / freedesktop locations. Keep these exact: prefix pass-through would let a future
  // credential-shaped variable cross the engine boundary merely because of its vendor prefix.
  "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  // Engine authentication/config. These are deliberate, reviewed names — never ANTHROPIC_*,
  // OPENAI_*, CLAUDE_* or CODEX_* families wholesale.
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "CODEX_HOME",
]);

function isAllowed(name) {
  return ALLOWED_NAMES.has(name);
}

// The interactive launcher menu at ~/.claude-launcher shadows the real `claude` binary on the
// daemon's PATH. Children must resolve engines directly: a wrapper between the gateway and the
// CLI is a machine-config foot-gun — its 2026-08-06 self-detection failure exec-looped every
// run into a silent total outage. Drop that dir from every child PATH (the real CLIs live in
// their own PATH entries), regardless of trailing slashes.
const LAUNCHER_DIR = path.join(os.homedir(), ".claude-launcher");
export function sanitizePath(value = "") {
  return String(value)
    .split(path.delimiter)
    .filter((dir) => dir && path.resolve(dir) !== LAUNCHER_DIR)
    .join(path.delimiter);
}

// Build the env for one spawn. `extra` is the spawn site's deliberate additions (merged last, so
// they win over inherited values); `source` defaults to the daemon's own environment.
export function buildChildEnv(extra = {}, source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && isAllowed(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    env[name] = String(value);
  }
  if (env.PATH) env.PATH = sanitizePath(env.PATH);
  return env;
}
