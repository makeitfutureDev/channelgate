// The IMAGE's own facts, in one place. containers/Containerfile bakes these paths in, the backend
// puts them on every RuntimeTarget, and the engine runners read them from the target rather than
// hard-coding a second copy — so the image stays the single source of truth and a path can only
// ever be changed here plus in the Containerfile that mirrors it.

// The image spec version this checkout expects. `containers/versions.json` carries the same value
// (it is what `npm run build:image` tags and bakes into the `cg.image.version` label), and a test
// pins the two together. The daemon COMPARES it at boot: an image built from an older spec still
// runs, but the operator is told to rebuild rather than left wondering why a channel is missing
// this build's toolchain.
export const IMAGE_SPEC_VERSION = "1.3.0";

export const CONTAINER_HOME = "/home/agent";
// Where a channel's OWN installs land, in precedence order, ahead of the image's root-owned
// toolchain: npm -g (NPM_CONFIG_PREFIX), then pip --user / pipx / uv / curl installers
// (~/.local/bin), then anything the agent drops in ~/bin, then the language-runtime bin dirs
// (cargo/bun/deno/go) that only exist once the agent installs that runtime. Every one of them is
// inside the per-channel HOME volume, which is exactly why an installed CLI stays installed.
export const CONTAINER_PATH = "/home/agent/.npm-global/bin:/home/agent/.local/bin:/home/agent/bin:/opt/channelgate/bin:/usr/local/bin:/usr/bin:/bin:/home/agent/.cargo/bin:/home/agent/.bun/bin:/home/agent/.deno/bin:/home/agent/go/bin";
export const CONTAINER_LOCAL_BIN = "/home/agent/.local/bin";
export const CONTAINER_USER_BIN = "/home/agent/bin";
export const CONTAINER_TMPDIR = "/tmp";
export const CONTAINER_CLAUDE_CONFIG_DIR = "/home/agent/.claude";
export const CONTAINER_CODEX_HOME = "/home/agent/.codex";
export const CONTAINER_CODEX_AUTH_FILE = "/home/agent/.codex/auth.json";
export const CONTAINER_NPM_PREFIX = "/home/agent/.npm-global";
export const CONTAINER_BUNDLE_ROOT = "/opt/channelgate";
// Browser automation lives under /opt, root-owned and shared by every channel, rather than in the
// per-channel HOME volume — one copy instead of ~400 MB each, and a channel cannot swap the
// browser it is driven by. CONTAINER_CHROMIUM is a STABLE symlink the build points at whatever
// executable the pinned Playwright resolved: the chromium revision changes with the Playwright
// version, so nothing outside the Containerfile may name a revision.
export const CONTAINER_BROWSERS_DIR = "/opt/channelgate/browsers";
export const CONTAINER_CHROMIUM = "/opt/channelgate/browsers/bin/chromium";
export const CONTAINER_BIN_DIR = "/opt/channelgate/bin";
export const CONTAINER_SOCKET_DIR = "/run/channelgate";
export const CONTAINER_SOCKET_FILE = "/run/channelgate/mcp.sock";

// Where the engine finds each daemon-side helper INSIDE the image. The host backend answers the
// same question with this checkout's script paths; no caller composes a path itself.
//
// These are `node <script>` rather than bare executables ON PURPOSE: Codex reaches the gateway MCP
// through `secret-env-bridge`, which re-execs `process.execPath <script>`, so a shell shim would
// fail there. The human-facing /opt/channelgate/bin/cg-mcp-bridge shim still exists for a person
// who exec'd into a container by hand.
export const CONTAINER_MCP_BRIDGE = "/opt/channelgate/bin/cg-mcp-bridge.mjs";
export const IMAGE_HELPERS = Object.freeze({
  "gateway-mcp": Object.freeze({ command: "node", args: Object.freeze([CONTAINER_MCP_BRIDGE]) }),
  "secret-env-bridge": Object.freeze({ command: "node", args: Object.freeze(["/opt/channelgate/mcp/secret-env-bridge.js"]) }),
  // Composio SDK mode is a SECOND service on the same daemon socket, not a separate process — so
  // the helper resolves to the same bridge, and src/mcp/composio-sdk-bridge.js (whose import
  // closure drags in settings.js and the database layer) never ships in the image at all.
  "composio-sdk-bridge": Object.freeze({ command: "node", args: Object.freeze([CONTAINER_MCP_BRIDGE]) }),
  "stop-subagents-hook": Object.freeze({ command: "node", args: Object.freeze(["/opt/channelgate/gateway/hooks/stop-subagents.mjs"]) }),
  // Not the raw binary: the broker reads the 0600 secret bundle and only then execs the pinned
  // mcp-remote (which is installed globally in the image AND resolvable from the bundle's
  // node_modules, which is how the broker finds dist/proxy.js).
  "mcp-remote": Object.freeze({ command: "node", args: Object.freeze(["/opt/channelgate/mcp/remote-secret-bridge.js"]) }),
});

// The paths a runner reads off `target.container` when it needs to compose an in-container path.
export function containerImagePaths() {
  return {
    home: CONTAINER_HOME,
    path: CONTAINER_PATH,
    tmpDir: CONTAINER_TMPDIR,
    claudeConfigDir: CONTAINER_CLAUDE_CONFIG_DIR,
    codexHome: CONTAINER_CODEX_HOME,
    npmPrefix: CONTAINER_NPM_PREFIX,
    bundleRoot: CONTAINER_BUNDLE_ROOT,
    socketDir: CONTAINER_SOCKET_DIR,
  };
}
