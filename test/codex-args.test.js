// `codex exec` argv and child env, as built for the ONLY place Codex runs any more: a channel
// container. The container is the confinement boundary, so there is no permission profile compiled
// against host paths, no network proxy allow-list and no host state dir in the argv — Codex's own
// sandbox is reduced to a MODE (read-only as defence in depth, full access otherwise), and every
// helper it launches is the image's baked bundle.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { ensureTestEnv, tempDir } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

const scratch = ensureTestEnv();
const { buildCodexArgs, buildCodexEnv, createCodexProgressState, headerHelperPath, headerHelperSource, progressFromCodexEvent } = await import("../src/engines/codex.js");
const { CONTAINER_HOME, CONTAINER_PATH, localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { workspaceRoot } = await import("../src/config/paths.js");
const { allowedFsRoot } = await import("../src/web/security.js");

// One isolated target for the whole file: the real resolver's shape (cwd, artifact dir) with the
// image's helper table behind it (test/fixtures/fake-runtime-backend.js).
const target = createFakeRuntime().target();

function argsFor(overrides = {}) {
  return buildCodexArgs({
    prompt: "check schedules",
    sessionId: "thread-1",
    isNewSession: true,
    cwd: target.cwd,
    outFile: `${target.artifactDir}/tmp/out.txt`,
    gatewayFsRoot: allowedFsRoot(),
    gatewayWorkspaceRoot: workspaceRoot(),
    target,
    ...overrides,
  });
}

const cfgValues = (args) => args.filter((value, i) => args[i - 1] === "-c");

// Non-Full confinement contract inside a container: Codex's own sandbox is stated as a MODE only.
// Never a permission profile (those were compiled against host paths that do not exist in the
// image), never a network-proxy rule (egress is the container's), never a host state dir, and
// never the daemon's runtime root anywhere in the argv — a container is deliberately denied it.
function assertConfined(args) {
  assert.ok(args.includes("--ignore-user-config"), "a personal config in the container HOME must not broaden the run");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!cfgValues(args).some((value) => value.startsWith("default_permissions=")), "no permission profile inside a container");
  assert.ok(!cfgValues(args).some((value) => value.startsWith("permissions.")), "no filesystem or network rules compiled against host paths");
  assert.ok(!cfgValues(args).some((value) => value.startsWith("features.network_proxy")), "egress is the container's network, not a Codex proxy");
  assert.ok(!cfgValues(args).some((value) => value.startsWith("sqlite_home=")), "the host state dir does not exist in the image");
  assert.ok(!args.some((arg) => arg.includes(scratch)), "the daemon runtime root must never be named to a containerized engine");
}

test("writable Codex runs state the full-access sandbox mode, with no host permission profile", () => {
  const args = argsFor({ writable: true, clean: false });

  assert.ok(args.includes(`approval_policy="never"`));
  assertConfined(args);
  assert.equal(args[args.indexOf("--sandbox") + 1], "danger-full-access");
  assert.ok(!args.some((arg) => arg.startsWith("sandbox_mode=")), "a fresh run states the mode with the flag, not its config twin");
});

test("read-only Codex runs keep Codex's own read-only sandbox as defence in depth inside the container", () => {
  const args = argsFor({ writable: false, clean: false });

  assertConfined(args);
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

// Codex's DEFAULT sandbox mechanism is bubblewrap, which cannot start under the container's
// `--cap-drop ALL` + no-new-privileges ("bwrap: Unexpected capabilities but not setuid") and fails
// every command — read mode included, which made Read channels answer nothing at all. Landlock is
// the mechanism that works under those caps, so every run that states a sandbox mode also states
// the mechanism that can enforce it.
test("a stated sandbox mode also states the mechanism that works inside the container", () => {
  for (const options of [{ writable: false }, { writable: true }, { writable: false, isNewSession: false }, { writable: true, isNewSession: false }]) {
    const args = argsFor({ ...options, clean: false });
    assert.ok(cfgValues(args).includes("features.use_legacy_landlock=true"),
      `bubblewrap cannot start in the container: ${JSON.stringify(options)} must pick Landlock`);
  }
});

test("the admin bypass has no sandbox, so it never picks a sandbox mechanism", () => {
  for (const isNewSession of [true, false]) {
    const args = argsFor({ dangerouslySkip: true, writable: true, isNewSession });
    assert.ok(!cfgValues(args).some((value) => value.startsWith("features.use_legacy_landlock")),
      "a bypassed run has no sandbox for a mechanism to enforce");
  }
});

test("explicit admin bypass drops Codex's own sandbox entirely — the container is still the boundary", () => {
  const adminArgs = argsFor({ dangerouslySkip: true, writable: true });
  assert.ok(adminArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!adminArgs.includes("--sandbox"));
  assert.ok(!adminArgs.includes("--ignore-user-config"));
  assert.ok(!adminArgs.some((arg) => arg.startsWith("sandbox_mode=")));
  assert.ok(!adminArgs.some((arg) => arg.startsWith("permissions.")));
});

test("the network switch is validated but compiles to nothing in argv — egress is the container's", () => {
  for (const networkMode of ["off", "on"]) {
    for (const options of [{ writable: false }, { writable: true }, { writable: true, isNewSession: false }, { writable: true, clean: true }]) {
      const args = argsFor({ ...options, networkMode });
      if (!options.clean) assertConfined(args);
      assert.ok(!cfgValues(args).some((value) => value.startsWith("features.network_proxy")), `${networkMode}: no proxy feature`);
      assert.ok(!args.some((arg) => /domains|allow_local_binding|network_proxy/.test(arg)), `${networkMode}: no allow-list of any kind`);
    }
  }
  // The host-sandbox tiers are gone with the host sandbox: an old caller that still names one is
  // refused rather than silently mapped to "on".
  assert.throws(() => argsFor({ networkMode: "approved" }), /Unknown Codex network mode/);
  assert.throws(() => argsFor({ networkMode: "unrestricted" }), /Unknown Codex network mode/);
});

test("Codex has no host path any more: no target, or the daemon's own local spawner, is refused before any argv exists", () => {
  assert.throws(() => argsFor({ target: null }), /Codex runs only inside a channel container/);
  assert.throws(() => argsFor({ target: localRuntimeTarget(target.cwd) }), /Codex runs only inside a channel container/);
  assert.throws(() => buildCodexEnv({}, { PATH: "/usr/bin" }), /Codex runs only inside a channel container/);
  assert.throws(() => buildCodexEnv({ target: localRuntimeTarget("/work") }, { PATH: "/usr/bin" }), /Codex runs only inside a channel container/);
});

test("autonomous Codex runs use auto-review instead of invisible approval cancellation", () => {
  const args = argsFor({ writable: true, clean: false, autoApprove: true });

  assert.ok(args.includes(`approval_policy="on-request"`));
  assert.ok(args.includes(`approvals_reviewer="auto_review"`));
  assert.ok(!args.includes(`approval_policy="never"`));
});

test("Codex resume states the same sandbox mode through its config twin", () => {
  const args = argsFor({ isNewSession: false, writable: true, clean: false });

  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "thread-1"]);
  assert.ok(!args.includes("-C"), "`exec resume` dropped -C; the spawn cwd stands in for it");
  assert.ok(args.includes(`approval_policy="never"`));
  assertConfined(args);
  // `exec resume` has no -s/--sandbox: a flag it rejects would exit 2 before the turn starts.
  assert.ok(!args.includes("--sandbox"));
  assert.ok(args.includes(`sandbox_mode="danger-full-access"`));
  const readResume = argsFor({ isNewSession: false, writable: false, clean: false });
  assert.ok(readResume.includes(`sandbox_mode="read-only"`));
});

test("Codex runs pass reasoning effort as a config override", () => {
  const args = argsFor({ effort: "high" });

  assert.ok(args.includes("-c"));
  assert.ok(args.includes(`model_reasoning_effort="high"`));
});

test("Codex resume passes reasoning effort as a config override", () => {
  const args = argsFor({ isNewSession: false, effort: "xhigh" });

  assert.ok(args.includes(`model_reasoning_effort="xhigh"`));
});

test("Codex state lives in the container's own HOME: no host state dir or skills override is ever named", () => {
  // The daemon still knows the channel's host-side rollout dir for USAGE accounting, and passes it
  // through as codexStateDir — it must never reach the argv, where it would name a host path the
  // image does not have.
  const codexStateDir = "/var/lib/containers/storage/volumes/cg-home/_data/.codex";
  for (const args of [
    argsFor({ codexStateDir }),
    argsFor({ isNewSession: false, codexStateDir }),
  ]) {
    assert.ok(!args.some((arg) => arg.startsWith("sqlite_home=")));
    assert.ok(!args.some((arg) => arg.startsWith("skills.config=")));
    assert.ok(!args.some((arg) => arg.includes(codexStateDir)));
  }
  const env = buildCodexEnv({ target }, { HOME: "/host-home", PATH: "/usr/bin" });
  assert.equal(env.HOME, CONTAINER_HOME);
  assert.equal(env.CODEX_HOME, `${CONTAINER_HOME}/.codex`);
  assert.equal(env.PATH, CONTAINER_PATH);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("clean Codex runs keep the sandbox mode while dropping every MCP injection", () => {
  const args = argsFor({ writable: true, clean: true, progressReport: true });

  assertConfined(args);
  assert.equal(args[args.indexOf("--sandbox") + 1], "danger-full-access");
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.gateway.")));
  assert.ok(args.includes(`apps._default.enabled=false`));

  const cleanRead = argsFor({ writable: false, clean: true });
  assertConfined(cleanRead);
  assert.equal(cleanRead[cleanRead.indexOf("--sandbox") + 1], "read-only");
});

test("Codex runs allow only selected runtime app families and servers", () => {
  const args = argsFor({
    codexMcpPolicy: {
      apps: ["asdk_app_boost"],
      servers: [
        { name: "browser", enabled: false },
        { name: "local-docs", enabled: true, definition: { transport: "stdio", command: "node", args: ["docs-server.js"] } },
      ],
    },
  });

  assert.ok(args.includes(`apps._default.enabled=false`));
  // Bare keys, never quoted: a `-c` dotted path takes its segments literally, so `apps."x"` and
  // `mcp_servers."x"` address a table named `"x"` rather than the x the catalog meant.
  assert.ok(args.includes(`apps.asdk_app_boost.enabled=true`));
  assert.ok(!args.some((arg) => arg.startsWith("apps.boost_space.")));
  assert.ok(!args.some((arg) => /^(apps|mcp_servers)\."/.test(arg)), "no quoted key path is ever emitted");
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.codex_apps.")));
  // An UNSELECTED server is simply absent. See the disabled-server test below for why.
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.browser.")));
  assert.ok(args.includes(`mcp_servers.local-docs.enabled=true`));
  assert.ok(args.includes(`mcp_servers.local-docs.command="node"`));
  assert.ok(args.includes(`mcp_servers.local-docs.args=["docs-server.js"]`));
});

test("selected optional MCP transports get the remote startup budget without granting other servers", () => {
  const codexMcpPolicy = { servers: [
    { name: "slow-http", enabled: true, definition: { transport: "http", url: "https://example.com/mcp" } },
    { name: "slow-stdio", enabled: true, definition: { transport: "stdio", command: "node", args: ["mcp.js"] } },
    { name: "ungranted", enabled: false },
  ] };
  for (const isNewSession of [true, false]) {
    const args = argsFor({ codexMcpPolicy, isNewSession });
    for (const name of ["slow-http", "slow-stdio"]) {
      assert.ok(args.includes(`mcp_servers.${name}.startup_timeout_sec=120`));
      assert.ok(!args.some((value) => value.startsWith(`mcp_servers.${name}.tool_timeout_sec=`)));
    }
    assert.ok(!args.some((value) => value.startsWith("mcp_servers.ungranted.")));
    assert.ok(!argsFor({ codexMcpPolicy, isNewSession, clean: true }).some((value) => /^mcp_servers.slow-/.test(value)));
  }
});

test("Codex runs disable optional runtime apps when no family is selected", () => {
  const args = argsFor({
    codexMcpPolicy: {
      apps: [],
      servers: [{ name: "local-docs", enabled: false }],
    },
  });

  assert.ok(args.includes(`apps._default.enabled=false`));
  assert.ok(!args.some((arg) => /^apps\..+\.enabled=true$/.test(arg)));
  // An unselected server must produce NO override. `mcp_servers.<name>.enabled=false` would DEFINE
  // a table whose only key is `enabled` — the run's CODEX_HOME has no config.toml for it to merge
  // onto — and an entry with neither `command` nor `url` has no transport, so Codex refuses the
  // whole config ("invalid transport") and every run on that host dies before it starts.
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.local-docs.")));
  assert.ok(!args.some((arg) => /^mcp_servers\.[^.]+\.enabled=false$/.test(arg)), "no transport-less entry");
});

test("a host server the channel never selected cannot break config loading (2026-08-25)", () => {
  // Live failure on the Linux gateway: `codex app-server` discovery lists every server that host's
  // own Codex install knows about, so a hand-added `composio_global` entered the catalog. The
  // channel had not selected it, and the emitted `mcp_servers."composio_global".enabled=false` was
  // both mis-keyed and transport-less — Codex answered
  //   Error loading config.toml: invalid transport · in `mcp_servers."composio_global"`
  // and EVERY run on that box died before it started. Nothing about the name is emitted now.
  for (const dangerouslySkip of [false, true]) {
    const args = argsFor({
      dangerouslySkip,
      codexMcpPolicy: { apps: [], servers: [{ name: "composio_global", enabled: false }] },
    });
    assert.ok(!args.some((arg) => arg.includes("composio_global")), `admin=${dangerouslySkip}`);
  }
});

test("an unselected server whose name Codex config cannot address is skipped, not mangled", () => {
  // A non-bare name cannot ride in a `-c` dotted path at all. Unselected, it is simply dropped;
  // selected, it is refused loudly rather than written to a key nobody reads.
  const args = argsFor({ codexMcpPolicy: { apps: [], servers: [{ name: "weird name!", enabled: false }] } });
  assert.ok(!args.some((arg) => arg.includes("weird name")));
  assert.throws(() => argsFor({
    codexMcpPolicy: {
      apps: [],
      servers: [{ name: "weird name!", enabled: true, definition: { transport: "stdio", command: "node", args: [] } }],
    },
  }), /cannot address/);
});

test("clean Codex runs override selected optional MCP policy", () => {
  const args = argsFor({
    clean: true,
    codexMcpPolicy: {
      apps: ["github"],
      servers: [{ name: "local-docs", enabled: true }],
    },
  });

  assert.ok(args.includes(`apps._default.enabled=false`));
  assert.ok(!args.some((arg) => arg.startsWith("apps.github.")));
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.local-docs.")));
});

test("Codex gateway MCP tools are always approved by Codex, and the entry names no host path", () => {
  const args = argsFor({ clean: false });

  assert.ok(args.includes(`mcp_servers.gateway.default_tools_approval_mode="approve"`));
  assert.ok(args.includes(`mcp_servers.gateway.env.CG_ENGINE="codex"`));
  // The gateway control plane is reached over the daemon socket from inside the container; the
  // daemon's filesystem and workspace roots are host facts that must never cross into it.
  for (const key of ["CG_FS_ROOT", "CG_WORKSPACE_DIR", "CHANNELGATE_DIR", "PATH"]) {
    assert.ok(!args.some((arg) => arg.startsWith(`mcp_servers.gateway.env.${key}=`)), `${key} must not reach a container`);
  }
});

test("Codex gateway MCP exposes progress report only for opted-in foreground runs", () => {
  const foreground = argsFor({ progressReport: true });
  const hidden = argsFor({ progressReport: false });
  const defaulted = argsFor();

  assert.ok(foreground.includes(`mcp_servers.gateway.env.CG_PROGRESS_REPORT="1"`));
  assert.ok(!hidden.some((arg) => arg.startsWith("mcp_servers.gateway.env.CG_PROGRESS_REPORT=")));
  assert.ok(!defaulted.some((arg) => arg.startsWith("mcp_servers.gateway.env.CG_PROGRESS_REPORT=")));
});

test("Codex runs inject personal and shared Composio MCPs outside clean mode", () => {
  const userToken = "ck_user_secret";
  const sharedToken = "ck_shared_secret";
  const bundle = `${target.artifactDir}/run/codex-secrets.json`;
  const headerHelpers = [];
  const args = argsFor({ composioUserToken: userToken, composioToken: sharedToken, secretBundlePath: bundle, headerHelpers });
  const joined = args.join("\n");

  // Codex dials both identities itself over its native streamable-HTTP transport. The old
  // `mcp-remote` stdio bridge cost ~2.4s to answer tools/list and lost the race against a resumed
  // turn's much shorter MCP startup window — the warm turn saw no Composio family at all.
  assert.ok(args.includes(`mcp_servers.composio-user.url="https://connect.composio.dev/mcp"`));
  assert.ok(args.includes(`mcp_servers.composio-agent.url="https://connect.composio.dev/mcp"`));
  assert.doesNotMatch(joined, /remote-secret-bridge\.js|mcp-remote/, "no stdio bridge stands between Codex and a remote MCP any more");
  assert.ok(!args.some((arg) => /^mcp_servers\.composio-(user|agent)\.command=/.test(arg)), "an http server has no command");

  // The credential still comes from the 0600 bundle, resolved by the run's own headers helper.
  assert.ok(args.includes(`mcp_servers.composio-user.http_headers_helper=${JSON.stringify(headerHelperPath(bundle, "composio-user"))}`));
  assert.ok(args.includes(`mcp_servers.composio-agent.http_headers_helper=${JSON.stringify(headerHelperPath(bundle, "composio-agent"))}`));
  assert.ok(args.includes(`mcp_servers.composio-user.default_tools_approval_mode="approve"`));
  assert.ok(args.includes(`mcp_servers.composio-agent.default_tools_approval_mode="approve"`));
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.composio.")), "the bare legacy name is never emitted");
  assert.doesNotMatch(joined, new RegExp(`${userToken}|${sharedToken}`));

  assert.deepEqual(headerHelpers.map((spec) => [spec.secretName, spec.headerName, spec.prefix]), [
    ["composioUserToken", "x-consumer-api-key", ""],
    ["composioToken", "x-consumer-api-key", ""],
  ]);

  const cleanArgs = argsFor({ clean: true, composioUserToken: userToken, composioToken: sharedToken });
  assert.ok(!cleanArgs.some((arg) => arg.startsWith("mcp_servers.composio-user.")));
  assert.ok(!cleanArgs.some((arg) => arg.startsWith("mcp_servers.composio-agent.")));
});

// WB-10. `codex exec resume` honours `-c mcp_servers.*` exactly like a fresh `exec`, so the two
// argvs must describe the SAME servers — anything a resume drops here is a tool family the second
// turn of a thread silently loses.
test("a resumed Codex run configures exactly the MCP servers a fresh one does", () => {
  const shared = {
    composioUserToken: "ck_user_secret",
    composioToken: "ck_shared_secret",
    toolboxToken: "tb_secret",
    makeToolboxUrl: "https://eu1.make.com/mcp/server/abc",
    makeToolboxKey: "make_secret",
    gatewayCapability: "signed-capability",
    secretBundlePath: `${target.artifactDir}/run/codex-secrets.json`,
    writable: true,
  };
  const mcpOverrides = (args) => cfgValues(args).filter((value) => value.startsWith("mcp_servers.")).sort();

  const fresh = argsFor({ ...shared, isNewSession: true });
  const resumed = argsFor({ ...shared, isNewSession: false, sessionId: "thread-1" });

  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "thread-1"]);
  assert.deepEqual(mcpOverrides(resumed), mcpOverrides(fresh));
  for (const name of ["gateway", "composio-user", "composio-agent", "makeitfuture-toolbox", "make-toolbox"]) {
    assert.ok(mcpOverrides(resumed).some((value) => value.startsWith(`mcp_servers.${name}.`)), `${name} is missing from the resumed run`);
  }
});

// The generated helper is the only thing that ever touches the credential, and it must read it
// from the bundle — not from an argument or an environment variable Codex would persist into
// `.codex/shell_snapshots/*.sh`.
test("the per-run headers helper resolves its credential from the run bundle alone", async () => {
  const dir = tempDir("cg-codex-headers-");
  try {
    const bundlePath = path.join(dir, "cg-codex-secrets-1.json");
    await writeFile(bundlePath, JSON.stringify({ toolboxToken: "tb-super-secret" }), { mode: 0o600 });
    const helperPath = headerHelperPath(bundlePath, "makeitfuture-toolbox");
    const source = headerHelperSource({ secretName: "toolboxToken", headerName: "Authorization", prefix: "Bearer ", bundlePath });
    await writeFile(helperPath, source, { mode: 0o700 });

    assert.doesNotMatch(source, /tb-super-secret/, "the helper script carries no credential of its own");
    assert.match(helperPath, /\.cjs$/, "written outside any package, so the extension fixes the module system");

    const ok = spawnSync(process.execPath, [helperPath], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { Authorization: "Bearer tb-super-secret" });

    // A cleaned-up (or never written) bundle must fail the server, not emit an empty header.
    await rm(bundlePath, { force: true });
    const gone = spawnSync(process.execPath, [helperPath], { encoding: "utf8" });
    assert.equal(gone.status, 2);
    assert.match(gone.stderr, /credential is unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex bridges SDK sessions without putting the organization key on argv", () => {
  const args = argsFor({
    composioUserEndpoint: {
      mode: "sdk",
      url: "https://app.composio.dev/tool_router/v3/trs_user/mcp",
    },
    composioEndpoint: {
      mode: "sdk",
      url: "https://app.composio.dev/tool_router/v3/trs_channel/mcp",
    },
  });
  const joined = args.join("\n");

  assert.match(joined, /mcp_servers\.composio-user\.command=/);
  assert.match(joined, /mcp_servers\.composio-agent\.command=/);
  assert.match(joined, /composio-sdk-bridge\.js/);
  assert.match(joined, /trs_user/);
  assert.match(joined, /trs_channel/);
  assert.doesNotMatch(joined, /sdk-super-secret|x-api-key/i);
});

test("Codex injects a Make toolbox through a bearer environment variable hidden from shell commands", () => {
  const key = "make-secret-key";
  const args = argsFor({
    makeToolboxUrl: "https://eu1.make.celonis.com/mcp/server/abc-123",
    makeToolboxKey: key,
    secretBundlePath: `${target.artifactDir}/run/codex-secrets.json`,
  });
  const joined = args.join("\n");
  const env = buildCodexEnv({ target }, {});

  assert.ok(args.includes(`mcp_servers.make-toolbox.url="https://eu1.make.celonis.com/mcp/server/abc-123"`));
  assert.match(joined, /make-toolbox\.headers\.cjs/);
  assert.ok(args.includes(`mcp_servers.make-toolbox.default_tools_approval_mode="approve"`));
  assert.equal(env.CG_MAKE_TOOLBOX_KEY, undefined);
  assert.doesNotMatch(joined, new RegExp(key));

  const incomplete = argsFor({ makeToolboxUrl: "https://eu2.make.com/mcp/server/abc" });
  const clean = argsFor({
    clean: true,
    makeToolboxUrl: "https://eu2.make.com/mcp/server/abc",
    makeToolboxKey: key,
  });
  assert.ok(!incomplete.some((arg) => arg.startsWith("mcp_servers.make-toolbox.")));
  assert.ok(!clean.some((arg) => arg.startsWith("mcp_servers.make-toolbox.")));
  assert.equal(buildCodexEnv({ target }, {}).CG_MAKE_TOOLBOX_KEY, undefined);
});

test("every connector secret stays out of Codex argv and child env", () => {
  const secrets = {
    gatewayCapability: "signed-gateway-capability-secret",
    composioUserToken: "user-super-secret",
    composioToken: "shared-super-secret",
    toolboxToken: "toolbox-super-secret",
    makeToolboxKey: "make-super-secret",
  };
  const args = argsFor({
    ...secrets,
    makeToolboxUrl: "https://eu1.make.com/mcp/server/abc",
    secretBundlePath: `${target.artifactDir}/run/codex-secrets.json`,
  });
  const argv = args.join("\n");
  const env = buildCodexEnv({ target }, {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "engine-auth-only",
    CG_MAKE_TOOLBOX_KEY: secrets.makeToolboxKey,
    CG_GATEWAY_CAPABILITY: secrets.gatewayCapability,
  });

  for (const secret of Object.values(secrets)) {
    assert.doesNotMatch(argv, new RegExp(secret));
    assert.ok(!Object.values(env).includes(secret));
  }
  assert.equal(env.OPENAI_API_KEY, "engine-auth-only");
  assert.match(argv, /secret-env-bridge\.js/);
  assert.match(argv, /gatewayCapability/);
  // Every remote MCP names a headers helper instead of a header value.
  assert.match(argv, /composio-user\.headers\.cjs/);
  assert.match(argv, /makeitfuture-toolbox\.headers\.cjs/);
});

test("full-access Codex runs keep the deliberate bypass and no sandbox mode", () => {
  const args = argsFor({ dangerouslySkip: true, writable: true, clean: false, autoApprove: true });

  assert.ok(args.includes(`approval_policy="never"`));
  assert.ok(!args.includes(`approvals_reviewer="auto_review"`));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("--ignore-user-config"));
  assert.ok(!args.includes("--sandbox"));
  assert.ok(!args.some((arg) => arg.startsWith("default_permissions=")));
  assert.ok(!args.some((arg) => arg.startsWith("permissions.")));
});

test("Codex child env points TMPDIR, HOME and PATH at the image, never at the host's layout", () => {
  const source = { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/var/folders/host", XDG_RUNTIME_DIR: "/run/user/1001", LANG: "C" };
  const env = buildCodexEnv({ target }, source);

  assert.equal(env.TMPDIR, "/tmp", "the container's tmpfs, never the host's per-user temp");
  assert.equal(env.HOME, CONTAINER_HOME);
  assert.equal(env.PATH, CONTAINER_PATH);
  assert.equal(env.XDG_RUNTIME_DIR, undefined, "host locations are dropped, not carried into the image");
  assert.equal(env.LANG, "C", "locale still crosses");
});

test("Codex image attachments do not consume the prompt positional", () => {
  const prompt = "inspect this screenshot";
  const image = "/tmp/uploads/screen.png";
  const args = argsFor({ prompt, attachments: [image, "/tmp/uploads/readme.txt"] });

  assert.equal(args.filter((arg) => arg === "-i").length, 1);
  assert.equal(args[args.indexOf("-i") + 1], image);
  assert.ok(args.includes(prompt));
  assert.ok(args.indexOf(prompt) < args.indexOf("-i"));
  assert.equal(args.at(-1), image);
});

test("Codex JSONL mcp item events map to Slack tool progress events", () => {
  const progress = progressFromCodexEvent({
    type: "item.started",
    item: { id: "item_0", type: "mcp_tool_call", server: "gateway", tool: "create_schedule" },
  });

  assert.deepEqual(progress, { event: { kind: "tool_use", id: "item_0", name: "mcp__gateway__create_schedule" } });
  assert.deepEqual(
    progressFromCodexEvent({
      type: "item.completed",
      item: { id: "item_0", type: "mcp_tool_call", server: "gateway", tool: "create_schedule", status: "completed" },
    }),
    { event: { kind: "tool_result", id: "item_0", name: "mcp__gateway__create_schedule", status: "completed" } },
  );
});

test("Codex JSONL progress report accepts object arguments before generic MCP mapping", () => {
  const progress = progressFromCodexEvent({
    type: "item.started",
    item: {
      type: "mcp_tool_call",
      server: "gateway",
      tool: "report_progress",
      arguments: {
        title: "Prepare launch",
        steps: [{ id: "verify", title: "Verify release", status: "in_progress" }],
      },
    },
  });

  assert.deepEqual(progress, {
    event: {
      kind: "report_progress",
      title: "Prepare launch",
      steps: [{
        id: "verify",
        title: "Verify release",
        status: "in_progress",
        details: "",
        output: "",
        sources: [],
      }],
    },
  });
});

test("Codex JSONL progress report accepts JSON-string arguments", () => {
  const progress = progressFromCodexEvent({
    type: "item.started",
    item: {
      type: "mcp_tool_call",
      tool: "mcp__gateway__report_progress",
      arguments: JSON.stringify({
        title: "Prepare launch",
        steps: [{ id: "ship", title: "Ship release", status: "complete" }],
      }),
    },
  });

  assert.equal(progress.event.kind, "report_progress");
  assert.equal(progress.event.steps[0].id, "ship");
  assert.equal(progress.event.steps[0].status, "complete");
});

test("Codex JSONL suppresses invalid recognized progress report", () => {
  const progress = progressFromCodexEvent({
    type: "item.started",
    item: {
      type: "mcp_tool_call",
      server: "gateway",
      tool: "report_progress",
      arguments: JSON.stringify({ title: "No valid steps", steps: [] }),
    },
  });

  assert.equal(progress, null);
});

// ── Subagents ────────────────────────────────────────────────────────────────────────────────
// The fixtures below are verbatim JSONL lines from a real multi-agent Codex turn (CLI 0.152.0,
// multi_agent_version v2) in which two children — sandbox_reviewer and connector_reviewer — really
// ran, and the Slack card showed no sign of them. Only the spawn message (an encrypted blob) is
// shortened. Codex reports the same turn in three different shapes, and a build/mode decides which
// of them a stream carries, so the mapping has to read all three.
const SPAWN_CALL = {
  timestamp: "2026-09-05T22:45:33.149Z",
  type: "response_item",
  payload: {
    type: "function_call",
    id: "fc_0ddf2b06675e57d7016a9c9b8b437c87d28c08f501c51ec75d",
    name: "spawn_agent",
    namespace: "collaboration",
    arguments: "{\"task_name\":\"sandbox_reviewer\",\"fork_turns\":\"all\",\"message\":\"gAAAAABqnJuNTot2Kqv_ov5C2WetE7sT5T1V…\"}",
    call_id: "call_Un4efzD5prFaiBCep2k0oT41",
  },
};
const SUBAGENT_STARTED = {
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: "01a073bf-51d7-7130-8934-b5b1c41d2087",
    item: {
      type: "SubAgentActivity",
      id: "call_Un4efzD5prFaiBCep2k0oT41",
      kind: "started",
      agent_thread_id: "01a073bf-9f63-7401-bf3b-f100fe66bdb2",
      agent_path: "/root/sandbox_reviewer",
    },
  },
};
const SUBAGENT_COMPLETED = {
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: "01a073bf-51d7-7130-8934-b5b1c41d2087",
    item: {
      type: "SubAgentActivity",
      id: "subagent-completed-01a073bf-9f7d-7c01-be48-2fec93f6ed6e",
      kind: "completed",
      agent_thread_id: "01a073bf-9f63-7401-bf3b-f100fe66bdb2",
      agent_path: "/root/sandbox_reviewer",
    },
  },
};
const WAIT_ITEM = {
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: {
      type: "CollabAgentToolCall",
      id: "call_kydoSEJQUvezRkCHeuBaK3Ks",
      tool: "wait",
      status: "completed",
      sender_thread_id: "01a073bf-51d7-7130-8934-b5b1c41d2087",
      receiver_thread_ids: [],
      receiver_agents: [],
      agents_states: {},
    },
  },
};

test("Codex spawn call opens a subagent row named after the task, never its encrypted message", () => {
  const progress = progressFromCodexEvent(SPAWN_CALL);

  assert.deepEqual(progress, {
    event: {
      kind: "agent_activity",
      id: "call_Un4efzD5prFaiBCep2k0oT41",
      engine: "codex",
      name: "sandbox_reviewer",
      status: "running",
    },
  });
});

test("Codex subagent activity keys the row on the child thread and aliases the spawning call", () => {
  const started = progressFromCodexEvent(SUBAGENT_STARTED).event;
  assert.equal(started.kind, "agent_activity");
  assert.equal(started.id, "01a073bf-9f63-7401-bf3b-f100fe66bdb2");
  assert.equal(started.name, "sandbox_reviewer");
  assert.equal(started.status, "running");
  // The alias is what merges this row with the one the spawn call opened.
  assert.ok(started.aliasIds.includes("call_Un4efzD5prFaiBCep2k0oT41"));

  const completed = progressFromCodexEvent(SUBAGENT_COMPLETED).event;
  assert.equal(completed.id, "01a073bf-9f63-7401-bf3b-f100fe66bdb2");
  assert.equal(completed.status, "completed");
});

test("Codex raw sub_agent_activity payloads normalize to the same row contract", () => {
  // The bare event payload (snake_case) and its camelCase twin, as older/alternate streams send it.
  const snake = progressFromCodexEvent({
    type: "event",
    payload: { type: "sub_agent_activity", kind: "completed", agent_thread_id: "thread-A", agent_path: "/root/sandbox_reviewer" },
  }).event;
  assert.deepEqual(snake, {
    kind: "agent_activity",
    id: "thread-A",
    engine: "codex",
    name: "sandbox_reviewer",
    status: "completed",
    aliasIds: ["thread-A"],
  });

  const camel = progressFromCodexEvent({
    type: "event",
    payload: { type: "subAgentActivity", kind: "started", agentThreadId: "thread-B", agentPath: "/root/connector_reviewer" },
  }).event;
  assert.equal(camel.id, "thread-B");
  assert.equal(camel.name, "connector_reviewer");
  assert.equal(camel.status, "running");
});

test("Codex wait items with no child state still render the coordination step", () => {
  // multi-agent v2 sends `wait` items with empty receivers and empty agents_states: mapping them
  // to nothing is what left the card blank while two children worked.
  assert.deepEqual(progressFromCodexEvent(WAIT_ITEM), {
    event: { kind: "tool_result", id: "call_kydoSEJQUvezRkCHeuBaK3Ks", name: "wait_agent", status: "completed" },
  });
  assert.deepEqual(
    progressFromCodexEvent({ type: "item.started", item: { type: "collab_tool_call", id: "wait-1", tool: "wait", status: "in_progress", agents_states: {} } }),
    { event: { kind: "tool_use", id: "wait-1", name: "wait_agent" } },
  );
});

test("Codex collab items that DO carry child state still drive per-child rows", () => {
  // The `agents_states` path (multi-agent v1 and every version's stateful items) is unchanged.
  const spawn = progressFromCodexEvent({
    type: "item.completed",
    item: {
      type: "collab_tool_call",
      id: "call-spawn",
      tool: "spawn_agent",
      status: "completed",
      receiver_thread_ids: ["thread-a"],
      agents_states: { "thread-a": { status: "running" } },
      prompt: "Review the sandbox boundary",
    },
  });
  assert.equal(spawn.event.kind, "agent_activity");
  assert.equal(spawn.event.id, "call-spawn");
  assert.deepEqual(spawn.event.aliasIds, ["thread-a"]);
  assert.equal(spawn.event.description, "Review the sandbox boundary");
  assert.equal(spawn.event.status, "running");

  const wait = progressFromCodexEvent({
    type: "item.completed",
    item: {
      type: "collab_tool_call",
      id: "call-wait",
      tool: "wait",
      status: "completed",
      agents_states: { "thread-a": { status: "completed" }, "thread-b": { status: "errored", message: "child crashed" } },
    },
  });
  assert.equal(wait.events.length, 2);
  assert.deepEqual(wait.events[0], { kind: "agent_activity", id: "thread-a", engine: "codex", status: "completed" });
  assert.equal(wait.events[1].id, "thread-b");
  assert.equal(wait.events[1].status, "failed");
  assert.equal(wait.events[1].description, "child crashed");
});

test("Codex receiver agents name their OWN row, never every row in the item", () => {
  const wait = progressFromCodexEvent({
    type: "item.started",
    item: {
      type: "collab_tool_call",
      id: "call-wait",
      tool: "wait",
      status: "in_progress",
      receiver_thread_ids: ["thread-a", "thread-b"],
      receiver_agents: [
        { thread_id: "thread-a", agent_nickname: "sandbox_reviewer" },
        { thread_id: "thread-b", agent_nickname: "connector_reviewer" },
      ],
      agents_states: {},
    },
  });

  assert.equal(wait.events.length, 2);
  assert.equal(wait.events[0].id, "thread-a");
  assert.equal(wait.events[0].name, "sandbox_reviewer");
  assert.equal(wait.events[1].id, "thread-b");
  assert.equal(wait.events[1].name, "connector_reviewer");
});

test("Codex answer segments are separated by a blank line, deltas inside one item are not", () => {
  const state = createCodexProgressState();
  const first = progressFromCodexEvent({
    type: "item.completed",
    item: { id: "item_3", type: "agent_message", text: "Each channel runs in its own container, which isolates conversations." },
  }, state);
  const second = progressFromCodexEvent({
    type: "item.completed",
    item: { id: "item_7", type: "agent_message", text: "ChannelGate isolates each Slack channel in its own folder." },
  }, state);

  assert.equal(first.delta, "Each channel runs in its own container, which isolates conversations.");
  assert.equal(second.delta, "\n\nChannelGate isolates each Slack channel in its own folder.");
  assert.match(`${first.delta}${second.delta}`, /conversations\.\n\nChannelGate/);

  // A segment that already ends its own paragraph is not padded twice, and a streamed item's own
  // deltas stay glued together — the break marks a boundary, it does not reformat prose.
  const streaming = createCodexProgressState();
  assert.equal(progressFromCodexEvent({ type: "agent_message_delta", item: { id: "item_1" }, delta: { text: "Half a " } }, streaming).delta, "Half a ");
  assert.equal(progressFromCodexEvent({ type: "agent_message_delta", item: { id: "item_1" }, delta: { text: "sentence.\n" } }, streaming).delta, "sentence.\n");
  assert.equal(progressFromCodexEvent({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Next segment." } }, streaming).delta, "\nNext segment.");
});

test("Codex event mapping without a progress state leaves the text untouched", () => {
  // Callers that map one event in isolation (tests, tooling) must see no injected whitespace.
  const mapped = progressFromCodexEvent({ type: "item.completed", item: { id: "item_9", type: "agent_message", text: "Answer." } });
  assert.deepEqual(mapped, { delta: "Answer." });
});


test("personal skill catalogs supplement fresh/resumed prompts, replace old grants, and disappear in clean mode", () => {
  const personalSkills = [{ name: "private-proof", description: "Synthetic private instructions", path: "/artifact/run/skills/private-proof/SKILL.md" }];
  for (const isNewSession of [true, false]) {
    const args = argsFor({ prompt: "Use private-proof", isNewSession, personalSkills });
    const prompt = args.find((value) => value.includes("[Current personal skill grants"));
    assert.ok(prompt);
    assert.match(prompt, /supplement your native repository and system skills/);
    assert.match(prompt, /read its SKILL.md/);
    assert.match(prompt, /earlier personal catalogs and paths have expired/);
    assert.ok(prompt.includes(JSON.stringify(personalSkills)));
    assert.ok(prompt.endsWith("Use private-proof"));
  }
  const revoked = argsFor({ prompt: "Next turn", personalSkills: [], isNewSession: false }).join("\n");
  assert.match(revoked, /earlier personal catalogs and paths have expired/);
  assert.ok(!revoked.includes("private-proof"));
  const clean = argsFor({ prompt: "Raw clean prompt", personalSkills, clean: true });
  assert.ok(clean.includes("Raw clean prompt"));
  assert.ok(!clean.join("\n").includes("private-proof"));
});


test("plugin skill catalogs replace grants independently on fresh, resumed, and clean turns", () => {
  const pluginSkills = [{ name: "approved-package:proof", description: "Package instructions", path: "/artifact/plugins/package/skills/proof/SKILL.md" }];
  const personalSkills = [{ name: "private-proof", path: "/artifact/personal/SKILL.md" }];
  for (const isNewSession of [true, false]) {
    const args = argsFor({ prompt: "Use package proof", isNewSession, pluginSkills, personalSkills });
    const prompt = args.at(-1);
    assert.match(prompt, /Current approved plugin skills/);
    assert.match(prompt, /earlier plugin catalogs and paths have expired/);
    assert.ok(prompt.includes(JSON.stringify(pluginSkills)));
    assert.ok(prompt.includes(JSON.stringify(personalSkills)));
    assert.ok(prompt.endsWith("Use package proof"));
    for (const overrides of [{ pluginSkills: [] }, { clean: true }]) {
      const revoked = argsFor({ prompt: "Next turn", isNewSession, pluginSkills, ...overrides }).at(-1);
      assert.match(revoked, /earlier plugin catalogs and paths have expired/);
      assert.match(revoked, /empty catalog means no plugin skills are available/);
      assert.ok(revoked.includes("\n[]\n"));
      assert.ok(!revoked.includes("approved-package"));
      assert.ok(!revoked.includes("/artifact/plugins"));
    }
  }
});
