// Per-channel browser isolation for CDP browser MCP servers (`agent-browser`, and anything else
// that keys a long-lived browser daemon on a namespace).
//
// A browser MCP server is spawned by the ENGINE CLI, which puts it OUTSIDE the folder sandbox —
// which is exactly why Chrome can run there at all: the Bash sandbox denies socket(AF_UNIX) at the
// syscall level and Chromium's Mojo IPC needs it. The price of being outside is that nothing else
// confines it. `agent-browser` keys its daemon — control socket, live tabs, cookies, restore
// state — on a NAMESPACE that defaults to a single shared value per OS user, and that daemon
// deliberately outlives the turn (~1h idle) so the next turn is fast. Without a per-channel
// namespace, every channel on one gateway would therefore drive the SAME browser, and channel B's
// first snapshot would return the page channel A left logged in. Confinement is the product, so
// the namespace is derived from the channel's own folder identity: stable across the turns of one
// channel, distinct across channels.
//
// Gateway-owned, never a channel secret. It is merged AFTER the channel's own environment (see
// buildClaudeEnv / buildCodexEnv, where `extra` otherwise wins over everything inherited) and the
// whole `AGENT_BROWSER_` prefix is reserved on write — a channel that could name its own namespace
// could name another channel's, and one that could set AGENT_BROWSER_EXECUTABLE_PATH / _ARGS /
// _INIT_SCRIPTS would be choosing what runs in that unsandboxed process.
export const BROWSER_NAMESPACE_ENV = "AGENT_BROWSER_NAMESPACE";

const MAX_NAMESPACE_LENGTH = 64;
// Every call site has a channel slug (run.js and background.js both carry `entry.slug`). This
// exists so that a caller which somehow has none still cannot fall back to the OS user's DEFAULT
// namespace — that one is shared with any `agent-browser` the operator runs by hand on the host.
const UNIDENTIFIED = "cg-unidentified";

function slugPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// `{ platform, slug }` → the browser daemon namespace for that channel.
export function browserNamespaceFor({ platform = "", slug = "" } = {}) {
  const channel = slugPart(slug);
  if (!channel) return UNIDENTIFIED;
  // An unknown/missing platform is Slack's, exactly as it is for a channel's folder and
  // capabilities: every record written before multi-platform support is a Slack record.
  const surface = slugPart(platform) || "slack";
  return `cg-${surface}-${channel}`.slice(0, MAX_NAMESPACE_LENGTH);
}

// The spawn-site form: an env fragment to merge into a child's environment. Takes either a
// prepared namespace string or the `{ platform, slug }` identity.
export function browserSpawnEnv(identity) {
  const namespace = typeof identity === "string" ? identity : browserNamespaceFor(identity);
  return namespace ? { [BROWSER_NAMESPACE_ENV]: namespace } : {};
}
