// Per-channel browser daemon isolation. A browser MCP server (agent-browser) is spawned by the
// engine CLI, i.e. OUTSIDE the folder sandbox, and it keeps a daemon alive across turns. These
// tests pin the one thing that keeps two channels from sharing one logged-in browser.
// Run with: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_NAMESPACE_ENV, browserNamespaceFor, browserSpawnEnv } from "../src/gateway/browser-env.js";
import { buildClaudeEnv } from "../src/engines/claude.js";
import { buildCodexEnv } from "../src/engines/codex.js";
import { isReservedEnvName, safeSpawnEnv } from "../src/config/channel-env.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

// Codex only ever runs inside a channel container, so its env builder needs a container-shaped
// target (the fixture is pure: no CLI, no settings). Claude's builder also serves the daemon's own
// local turns and takes none.
const container = createFakeRuntime().target();

const SOURCE = { PATH: "/usr/bin", HOME: "/home/x" };

test("a channel's namespace is stable and carries its platform", () => {
  const ns = browserNamespaceFor({ platform: "slack", slug: "gateway-slack" });
  assert.equal(ns, "cg-slack-gateway-slack");
  assert.equal(browserNamespaceFor({ platform: "slack", slug: "gateway-slack" }), ns, "stable across turns");
});

test("different channels never share a namespace, even across platforms", () => {
  const seen = new Set([
    browserNamespaceFor({ platform: "slack", slug: "alpha" }),
    browserNamespaceFor({ platform: "slack", slug: "beta" }),
    browserNamespaceFor({ platform: "teams", slug: "alpha" }),
    browserNamespaceFor({ platform: "google-chat", slug: "alpha" }),
  ]);
  assert.equal(seen.size, 4);
});

test("an unknown or missing platform resolves to Slack, like every other stored record", () => {
  assert.equal(browserNamespaceFor({ slug: "alpha" }), "cg-slack-alpha");
  assert.equal(browserNamespaceFor({ platform: "", slug: "alpha" }), "cg-slack-alpha");
});

test("the namespace is shell/socket safe and bounded", () => {
  const ns = browserNamespaceFor({ platform: "SLACK", slug: "Ops & Deploys/../x" });
  assert.match(ns, /^[a-z0-9-]+$/);
  assert.ok(ns.length <= 64);
  assert.equal(browserNamespaceFor({ platform: "slack", slug: "z".repeat(200) }).length, 64);
});

test("a caller with no channel identity still never lands in the host user's default namespace", () => {
  // The default namespace is shared with any agent-browser the operator runs by hand.
  assert.equal(browserSpawnEnv({ slug: "" })[BROWSER_NAMESPACE_ENV], "cg-unidentified");
  assert.equal(browserSpawnEnv({})[BROWSER_NAMESPACE_ENV], "cg-unidentified");
  assert.equal(browserNamespaceFor(), "cg-unidentified", "called with nothing at all");
  for (const slug of ["", "   ", "///", "!!!"]) {
    assert.notEqual(browserSpawnEnv({ slug })[BROWSER_NAMESPACE_ENV], undefined, `slug ${JSON.stringify(slug)} must still be namespaced`);
  }
});

test("no namespace asked for, none invented", () => {
  // Non-channel spawn sites (smoke runs, memory review) run strict-MCP with no browser at all.
  assert.deepEqual(browserSpawnEnv(""), {});
  assert.equal(buildClaudeEnv({ home: "/h" }, SOURCE)[BROWSER_NAMESPACE_ENV], undefined);
  assert.equal(buildCodexEnv({ target: container }, SOURCE)[BROWSER_NAMESPACE_ENV], undefined);
});

test("both engine env builders carry the namespace into the child", () => {
  const ns = browserNamespaceFor({ platform: "slack", slug: "gateway-slack" });
  assert.equal(buildClaudeEnv({ home: "/h", configDir: "/c", browserNamespace: ns }, SOURCE)[BROWSER_NAMESPACE_ENV], ns);
  assert.equal(buildCodexEnv({ browserNamespace: ns, target: container }, SOURCE)[BROWSER_NAMESPACE_ENV], ns);
});

test("a channel secret cannot name the browser namespace — stripped on write AND at the spawn", () => {
  assert.equal(isReservedEnvName("AGENT_BROWSER_NAMESPACE"), true);
  assert.equal(isReservedEnvName("AGENT_BROWSER_EXECUTABLE_PATH"), true, "chooses the binary in an unsandboxed child");
  assert.equal(isReservedEnvName("AGENT_BROWSER_ARGS"), true);
  assert.deepEqual(safeSpawnEnv({ AGENT_BROWSER_NAMESPACE: "cg-slack-other-channel" }), {});

  // Belt and braces: even a hand-edited store that got one past validation loses to the gateway,
  // because the gateway-owned group is merged last.
  const mine = browserNamespaceFor({ platform: "slack", slug: "mine" });
  const hostile = { AGENT_BROWSER_NAMESPACE: browserNamespaceFor({ platform: "slack", slug: "theirs" }) };
  assert.equal(buildClaudeEnv({ extraEnv: hostile, browserNamespace: mine }, SOURCE)[BROWSER_NAMESPACE_ENV], mine);
  assert.equal(buildCodexEnv({ extraEnv: hostile, browserNamespace: mine, target: container }, SOURCE)[BROWSER_NAMESPACE_ENV], mine);
});
