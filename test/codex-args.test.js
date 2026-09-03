// `codex exec` argv and child env, as built for the ONLY place Codex runs any more: a channel
// container. The container is the confinement boundary, so there is no permission profile compiled
// against host paths, no network proxy allow-list and no host state dir in the argv — Codex's own
// sandbox is reduced to a MODE (read-only as defence in depth, full access otherwise), and every
// helper it launches is the image's baked bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
import { createFakeRuntime } from "./fixtures/fake-runtime-backend.js";

const scratch = ensureTestEnv();
const { buildCodexArgs, buildCodexEnv, progressFromCodexEvent } = await import("../src/engines/codex.js");
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
  const args = argsFor({ composioUserToken: userToken, composioToken: sharedToken, secretBundlePath: `${target.artifactDir}/run/codex-secrets.json` });
  const joined = args.join("\n");

  assert.match(joined, /mcp_servers\.composio-user\.command=/);
  assert.match(joined, /remote-secret-bridge\.js/);
  assert.match(joined, /codex-secrets\.json/);
  assert.ok(args.includes(`mcp_servers.composio-user.default_tools_approval_mode="approve"`));

  assert.match(joined, /mcp_servers\.composio-agent\.command=/);
  assert.ok(args.includes(`mcp_servers.composio-agent.default_tools_approval_mode="approve"`));
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.composio.")), "the bare legacy name is never emitted");
  assert.doesNotMatch(joined, new RegExp(`${userToken}|${sharedToken}`));

  const cleanArgs = argsFor({ clean: true, composioUserToken: userToken, composioToken: sharedToken });
  assert.ok(!cleanArgs.some((arg) => arg.startsWith("mcp_servers.composio-user.")));
  assert.ok(!cleanArgs.some((arg) => arg.startsWith("mcp_servers.composio-agent.")));
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

  assert.match(joined, /remote-secret-bridge\.js/);
  assert.match(joined, /makeToolboxKey/);
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
    skillsToken: "skills-super-secret",
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
