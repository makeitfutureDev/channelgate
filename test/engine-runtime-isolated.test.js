// What the ENGINES do differently when the runtime is isolated (v0.8 P1). Inside a channel
// container the OS boundary belongs to the daemon, so each engine's own sandbox is off and every
// host-shaped fact — the daemon's HOME and PATH, the toolchain launcher dir, the permission
// profiles compiled against host paths, the gateway root — is either replaced by the image's
// equivalent or left out entirely. The host path must be untouched, so each case asserts both.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

ensureTestEnv();

const { buildClaudeArgs, buildClaudeEnv, runClaude } = await import("../src/engines/claude.js");
const { buildCodexArgs, buildCodexEnv, runCodex } = await import("../src/engines/codex.js");
const { hostRuntimeTarget, CONTAINER_HOME, CONTAINER_PATH } = await import("../src/engines/runtime-target.js");
const { gatewayRoot } = await import("../src/config/paths.js");

const SOURCE = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/daemon",
  TMPDIR: "/var/folders/xy/T",
  XDG_RUNTIME_DIR: "/run/user/1001",
  SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
  LANG: "en_US.UTF-8",
};
// runCodex does async work (session lock, artifact dirs, the secret bundle) before it spawns, so
// wait for the event rather than for a fixed number of milliseconds — a loaded parallel test run
// makes any fixed sleep a flake.
async function waitUntil(predicate, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the runner");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cfgValues = (args) => args.filter((value, i) => args[i - 1] === "-c");
const cfg = (args, prefix) => cfgValues(args).find((value) => value.startsWith(prefix)) || "";
const cfgJson = (args, prefix) => JSON.parse(cfg(args, prefix).slice(prefix.length));

test("Claude env inside a container is the IMAGE's, and a channel secret still cannot displace it", () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const env = buildClaudeEnv({
    home: "/gw/run-tmp/grants-a/user-home",
    configDir: "/gw/run-tmp/grants-a/user-home/.claude",
    toolchainBinDir: "/gw/run-tmp/toolchain/bin",
    extraEnv: { SUPABASE_ACCESS_TOKEN: "sbp_live", HOME: "/tmp/hijack", PATH: "/tmp/evil", CLAUDE_CODE_OAUTH_TOKEN: "attacker" },
    target,
    oauthToken: "sk-ant-oat-gateway",
  }, SOURCE);

  assert.equal(env.HOME, CONTAINER_HOME);
  assert.equal(env.CLAUDE_CONFIG_DIR, `${CONTAINER_HOME}/.claude`);
  assert.equal(env.PATH, CONTAINER_PATH, "the daemon's PATH and launcher dir do not exist in the image");
  assert.ok(env.PATH.includes("/opt/channelgate/bin"), "…and the image's own run helpers stay resolvable by name");
  assert.ok(!env.PATH.includes("/gw/run-tmp/toolchain/bin"));
  assert.equal(env.TMPDIR, "/tmp", "the container's tmpfs, never the host's per-user temp");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-gateway", "the gateway's token, not the channel's");
  assert.equal(env.SUPABASE_ACCESS_TOKEN, "sbp_live", "the channel's own secrets still ride in");
  assert.equal(env.XDG_RUNTIME_DIR, undefined, "host locations are dropped, not carried into the image");
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.LANG, "en_US.UTF-8", "locale still crosses");

  // No token configured = no variable at all, so the CLI reports a missing credential rather than
  // authenticating as an empty string.
  assert.equal(buildClaudeEnv({ target }, SOURCE).CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("Claude env on the host is byte-for-byte what it was before the seam existed", () => {
  const withTarget = buildClaudeEnv({ home: "/gw/home", configDir: "/gw/home/.claude", toolchainBinDir: "/gw/bin", target: hostRuntimeTarget("/work") }, SOURCE);
  const without = buildClaudeEnv({ home: "/gw/home", configDir: "/gw/home/.claude", toolchainBinDir: "/gw/bin" }, SOURCE);
  assert.deepEqual(withTarget, without);
  assert.equal(without.HOME, "/gw/home");
  assert.equal(without.PATH, "/gw/bin:/usr/local/bin:/usr/bin");
  assert.equal(without.TMPDIR, "/var/folders/xy/T");
  assert.equal(without.CLAUDE_CODE_OAUTH_TOKEN, undefined, "no relayed token = no variable, so the CLI reads its own config dir as before");
});

test("a HOST run relays the gateway's login too, and a channel secret cannot displace it", () => {
  // The synthetic engine home no longer holds a credentials file (run-grant-artifacts stopped
  // planting one), so the relayed access token is what authenticates a host child
  // (src/gateway/claude-login.js). Gateway-owned, therefore applied LAST — same rule as HOME.
  const env = buildClaudeEnv({
    home: "/gw/home",
    configDir: "/gw/home/.claude",
    toolchainBinDir: "/gw/bin",
    target: hostRuntimeTarget("/work"),
    extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: "attacker", HOME: "/tmp/hijack" },
    oauthToken: "sk-ant-oat-operator",
  }, SOURCE);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-operator");
  assert.equal(env.HOME, "/gw/home");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/gw/home/.claude", "the child still keeps the gateway's own state dir");
});

test("a containerized Claude turn passes the argv it was given, and nothing host-only", async () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const pluginDir = `${target.artifactDir}/plugins/memory`;
  const settingsFile = `${target.artifactDir}/run/settings.json`;
  const pending = runClaude({
    cwd: target.cwd,
    prompt: "hello",
    sessionId: "s-1",
    isNewSession: true,
    settingsFile,
    pluginDirs: [pluginDir],
    instructionFile: `${target.cwd}/CLAUDE.md`,
    mcpConfig: `${target.artifactDir}/run/mcp.json`,
    target,
    claudeOauthToken: "sk-ant-oat-gateway",
    timeoutMs: 60_000,
  });

  const spec = rt.spawns[0];
  assert.deepEqual(spec.args, buildClaudeArgs({
    prompt: "hello",
    sessionId: "s-1",
    isNewSession: true,
    settingsFile,
    pluginDirs: [pluginDir],
    instructionFile: `${target.cwd}/CLAUDE.md`,
    mcpConfig: `${target.artifactDir}/run/mcp.json`,
    strictMcp: true,
  }), "run.js decides the per-run files; the runner passes them through unchanged");
  assert.ok(!spec.args.some((arg) => arg.startsWith(gatewayRoot())), "no daemon-root path is ever named to a containerized engine");
  assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-gateway");
  assert.equal(spec.env.PATH, CONTAINER_PATH);

  rt.children[0].stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s-1" })}\n`);
  rt.children[0].emit("close", 0, null);
  await pending;
});

test("Codex env inside a container points at the image's HOME, CODEX_HOME and tmpfs", () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const env = buildCodexEnv({
    tmpDir: "/gw/tmp/run-abc",
    home: "/gw/run-tmp/grants-a/user-home",
    codexHome: "/gw/engine-state/codex/home",
    toolchainBinDir: "/gw/run-tmp/toolchain/bin",
    extraEnv: { VERCEL_TOKEN: "vt_live", CODEX_HOME: "/tmp/hijack" },
    target,
  }, SOURCE);

  assert.equal(env.HOME, CONTAINER_HOME);
  assert.equal(env.CODEX_HOME, `${CONTAINER_HOME}/.codex`);
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(env.PATH, CONTAINER_PATH);
  assert.equal(env.VERCEL_TOKEN, "vt_live");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");

  const host = buildCodexEnv({ tmpDir: "/gw/tmp/run-abc", home: "/gw/home", codexHome: "/gw/home/.codex" }, SOURCE);
  assert.equal(host.HOME, "/gw/home");
  assert.equal(host.CODEX_HOME, "/gw/home/.codex");
  assert.equal(host.TMPDIR, "/gw/tmp/run-abc", "the host path is untouched by the seam");
});

test("Codex in a container states a sandbox MODE and compiles no host permission profile", () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const base = { prompt: "go", sessionId: "t-1", cwd: target.cwd, outFile: "/gw/out.txt", clean: true, target };

  const read = buildCodexArgs({ ...base, isNewSession: true, writable: false });
  assert.equal(read[read.indexOf("--sandbox") + 1], "read-only");
  const write = buildCodexArgs({ ...base, isNewSession: true, writable: true });
  assert.equal(write[write.indexOf("--sandbox") + 1], "danger-full-access");
  const admin = buildCodexArgs({ ...base, isNewSession: true, writable: true, dangerouslySkip: true });
  assert.ok(admin.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!admin.includes("--sandbox"));

  // `codex exec resume` has no -s/--sandbox: the same policy is stated as its config twin.
  const resumed = buildCodexArgs({ ...base, isNewSession: false, writable: true });
  assert.ok(!resumed.includes("--sandbox"), "a flag the resume subcommand rejects would exit 2");
  assert.equal(cfg(resumed, "sandbox_mode="), `sandbox_mode="danger-full-access"`);

  for (const args of [read, write, resumed]) {
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(!cfgValues(args).some((value) => value.startsWith("default_permissions=")), "no permission profile inside a container");
    assert.ok(!cfgValues(args).some((value) => value.startsWith("permissions.")), "no filesystem rules compiled against host paths");
    assert.ok(!cfgValues(args).some((value) => value.startsWith("features.network_proxy")), "egress is the container's network mode");
    assert.ok(!cfgValues(args).some((value) => value.startsWith("sqlite_home=")), "the host state dir does not exist in the image");
  }
  // approval policy is per MODE, unchanged by the runtime
  assert.equal(cfg(read, "approval_policy="), `approval_policy="never"`);
  const auto = buildCodexArgs({ ...base, isNewSession: true, writable: true, autoApprove: true, clean: false, secretBundlePath: "/art/run/bundle.json", gatewayCapability: "cap" });
  assert.equal(cfg(auto, "approval_policy="), `approval_policy="on-request"`);
});

test("Codex MCP entries in a container are composed from the runtime's helper commands", () => {
  const rt = createFakeRuntime();
  const target = rt.target();
  const bundle = `${target.artifactDir}/run/bundle.json`;
  const args = buildCodexArgs({
    prompt: "go",
    sessionId: "t-1",
    isNewSession: true,
    cwd: target.cwd,
    outFile: `${target.artifactDir}/tmp/out.txt`,
    writable: true,
    secretBundlePath: bundle,
    gatewayCapability: "signed-cap",
    gatewayFsRoot: "/gw",
    gatewayWorkspaceRoot: "/work",
    progressReport: true,
    composioUserEndpoint: { url: "https://composio.example/mcp", headers: { "x-consumer-api-key": "k1" } },
    composioUserToken: "k1",
    composioEndpoint: { mode: "sdk", url: "https://backend.composio.dev/api/v3/tool_router/x/mcp" },
    target,
  });

  assert.equal(cfg(args, "mcp_servers.gateway.command="), `mcp_servers.gateway.command="/usr/local/bin/node"`);
  assert.deepEqual(cfgJson(args, "mcp_servers.gateway.args="), [
    "/opt/channelgate/mcp/secret-env-bridge.js",
    bundle,
    "gatewayCapability",
    "CG_GATEWAY_CAPABILITY",
    "/opt/channelgate/bin/cg-mcp-bridge.js",
  ], "the image's baked bundle, never a path in this checkout");

  // The four env keys the MCP server reads — and nothing that names the host.
  assert.equal(cfg(args, `mcp_servers.gateway.env.CG_ENGINE=`), `mcp_servers.gateway.env.CG_ENGINE="codex"`);
  assert.equal(cfg(args, `mcp_servers.gateway.env.CG_PROGRESS_REPORT=`), `mcp_servers.gateway.env.CG_PROGRESS_REPORT="1"`);
  for (const key of ["CG_FS_ROOT", "CG_WORKSPACE_DIR", "CHANNELGATE_DIR", "PATH"]) {
    assert.equal(cfg(args, `mcp_servers.gateway.env.${key}=`), "", `${key} must not reach a container`);
  }

  // The header-bearing remote bridge and the Composio SDK bridge are the image's too.
  assert.equal(cfg(args, "mcp_servers.composio-user.command="), `mcp_servers.composio-user.command="/usr/local/bin/node"`);
  assert.deepEqual(cfgJson(args, "mcp_servers.composio-user.args="), [
    "/opt/channelgate/mcp/remote-secret-bridge.js",
    bundle,
    "composioUserToken",
    "https://composio.example/mcp",
    "x-consumer-api-key",
    "",
  ]);
  assert.deepEqual(cfgJson(args, "mcp_servers.composio-agent.args="), [
    "/opt/channelgate/mcp/composio-sdk-bridge.js",
    "https://backend.composio.dev/api/v3/tool_router/x/mcp",
  ]);
  assert.equal(cfg(args, "mcp_servers.composio-agent.env.CHANNELGATE_DIR="), "", "the daemon root is never mounted");
  assert.ok(!args.some((arg) => arg.includes(gatewayRoot())), "no daemon-root path anywhere in the argv");
});

test("Codex MCP entries on the host still resolve to this checkout, run by this node", () => {
  const args = buildCodexArgs({
    prompt: "go",
    sessionId: "t-1",
    isNewSession: true,
    cwd: "/work",
    outFile: "/gw/out.txt",
    secretBundlePath: "/gw/run-tmp/bundle.json",
    gatewayCapability: "signed-cap",
    gatewayFsRoot: "/gw",
    gatewayWorkspaceRoot: "/work",
  });
  assert.equal(cfg(args, "mcp_servers.gateway.command="), `mcp_servers.gateway.command=${JSON.stringify(process.execPath)}`);
  const gatewayArgs = cfgJson(args, "mcp_servers.gateway.args=");
  assert.match(gatewayArgs[0], /src[/\\]mcp[/\\]secret-env-bridge\.js$/);
  assert.equal(gatewayArgs[1], "/gw/run-tmp/bundle.json");
  assert.deepEqual(gatewayArgs.slice(2, 4), ["gatewayCapability", "CG_GATEWAY_CAPABILITY"]);
  assert.match(gatewayArgs[4], /src[/\\]mcp[/\\]gateway-server\.js$/);
  assert.equal(cfg(args, "mcp_servers.gateway.env.CG_FS_ROOT="), `mcp_servers.gateway.env.CG_FS_ROOT="/gw"`);
});

test("a containerized Codex turn writes its answer file and secret bundle into the mounted artifact dir", async (t) => {
  const rt = createFakeRuntime();
  const artifactDir = tempDir("cg-artifacts-");
  t.after(() => rmSync(artifactDir, { recursive: true, force: true }));
  const target = rt.target({ artifactDir });
  const pending = runCodex({
    cwd: artifactDir,
    prompt: "go",
    sessionId: "",
    isNewSession: true,
    writable: true,
    gatewayCapability: "signed-cap",
    target,
    artifactDir,
    timeoutMs: 60_000,
  });
  await waitUntil(() => rt.spawns.length === 1);

  const spec = rt.spawns[0];
  const outFile = spec.args[spec.args.indexOf("-o") + 1];
  assert.ok(outFile.startsWith(path.join(artifactDir, "tmp")), `-o must live in the mounted artifact dir, got ${outFile}`);
  const bundle = cfgJson(spec.args, "mcp_servers.gateway.args=")[1];
  assert.ok(bundle.startsWith(path.join(artifactDir, "run")), `the secret bundle must be readable inside the container, got ${bundle}`);
  assert.ok(!spec.args.some((arg) => arg.startsWith(gatewayRoot())), "nothing under the daemon root is named to the engine");
  assert.equal(spec.env.HOME, CONTAINER_HOME);

  writeFileSync(outFile, "container answer\n");
  rt.children[0].emit("close", 0, null);
  const result = await pending;
  assert.equal(result.content, "container answer");
  assert.equal(readdirSync(path.join(artifactDir, "run")).length, 0, "the bundle is deleted once the turn ends");
});

test("a container whose Codex credential is unusable fails closed, before anything is spawned", async () => {
  // The backend owns the container's codex home, so IT answers the sign-in question — the host
  // auth file the daemon reads says nothing about what is mounted in the container. Either shape
  // of answer is accepted: the container backend returns an Error, a simpler one a sentence.
  for (const credentialError of [
    new Error("Codex is not signed in inside this channel's container: no auth.json to seed"),
    "Codex is not signed in inside this channel's container: no auth.json to seed",
  ]) {
    const rt = createFakeRuntime({ credentialError });
    const target = rt.target();
    await assert.rejects(
      runCodex({ cwd: target.cwd, prompt: "go", sessionId: "", isNewSession: true, target, artifactDir: target.artifactDir, timeoutMs: 5_000 }),
      (error) => {
        assert.match(error.message, /^Codex is not signed in inside this channel's container/, "the backend's own sentence, not a stringified Error");
        assert.equal(error.details.providerKind, "authentication");
        assert.equal(error.details.replaySafe, true, "nothing ran, so the turn may fail over to the other harness");
        return true;
      },
    );
    assert.equal(rt.spawns.length, 0, "the gate is pre-spawn");
  }
});
