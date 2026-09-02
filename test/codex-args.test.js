import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { assertCodexNetworkProxySupported, buildCodexArgs, buildCodexEnv, codexFeatureListHasNetworkProxy, progressFromCodexEvent } = await import("../src/engines/codex.js");
const { workspaceRoot } = await import("../src/config/paths.js");
const { allowedFsRoot } = await import("../src/web/security.js");
const { HOST_IDENTITY_PATHS } = await import("../src/gateway/host-sensitive-paths.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argsFor(overrides = {}) {
  return buildCodexArgs({
    prompt: "check schedules",
    sessionId: "thread-1",
    isNewSession: true,
    cwd: "/tmp/channel",
    outFile: "/tmp/out.txt",
    gatewayFsRoot: allowedFsRoot(),
    gatewayWorkspaceRoot: workspaceRoot(),
    ...overrides,
  });
}

// Read-only toolchain/config grants both profiles carry so git/node/python still launch on a
// stock macOS + Homebrew host (":minimal" excludes developer toolchains); credential stores
// (~/.ssh, ~/.config/gh, ~/.npmrc) stay denied.
const TOOLCHAIN_READS = `"/Library/Developer" = "read", "/opt/homebrew" = "read", "/usr/local" = "read"`;
const HOST_IDENTITY_DENIES = HOST_IDENTITY_PATHS.map((entry) => `, "${entry}" = "deny"`).join("");

// Non-Full confinement contract: permission profiles only, never the legacy sandbox flags
// (a legacy key anywhere in the config stack silently wins over profiles), and never a
// filesystem grant on the gateway runtime root.
function assertConfined(args) {
  assert.ok(args.includes("--ignore-user-config"), "host user config must not broaden the run");
  assert.ok(!args.includes("-s"), "legacy --sandbox flag must never combine with profiles");
  assert.ok(!args.some((arg) => arg.startsWith("sandbox_mode=")), "legacy sandbox_mode must never combine with profiles");
  assert.ok(!args.some((arg) => arg.startsWith("sandbox_workspace_write.")), "legacy workspace-write keys must never combine with profiles");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  // The gateway root may ride in MCP env (CHANNELGATE_DIR) — it must never appear in a
  // sandbox/permission grant.
  assert.ok(!args.some((arg) => arg.startsWith("permissions.") && arg.includes(scratch)), "gateway runtime root must not appear in any filesystem grant");
}

test("writable Codex runs use the gateway-workspace permission profile with no runtime-root grant", () => {
  const args = argsFor({ writable: true, clean: false });

  assert.ok(args.includes(`approval_policy="never"`));
  assertConfined(args);
  assert.ok(args.includes(`default_permissions="gateway-workspace"`));
  assert.ok(args.includes(`permissions.gateway-workspace.extends=":read-only"`));
  assert.ok(args.includes(`permissions.gateway-workspace.filesystem={ ":root" = "deny", ":minimal" = "read"${HOST_IDENTITY_DENIES}, ${TOOLCHAIN_READS}, ":tmpdir" = "write", ":slash_tmp" = "deny", ":workspace_roots" = { "." = "write", ".git" = "read", ".codex" = "read" } }`));
  assert.ok(args.includes(`features.network_proxy.enabled=false`));
  assert.ok(args.includes(`permissions.gateway-workspace.network={ enabled = false }`));
});

test("read-only Codex runs use the gateway-readonly permission profile with no temp write grant", () => {
  const args = argsFor({ writable: false, clean: false });

  assertConfined(args);
  assert.ok(args.includes(`default_permissions="gateway-readonly"`));
  assert.ok(args.includes(`permissions.gateway-readonly.extends=":read-only"`));
  assert.ok(args.includes(`permissions.gateway-readonly.filesystem={ ":root" = "deny", ":minimal" = "read"${HOST_IDENTITY_DENIES}, ${TOOLCHAIN_READS}, ":tmpdir" = "deny", ":slash_tmp" = "deny", ":workspace_roots" = { "." = "read" } }`));
  assert.ok(args.includes(`features.network_proxy.enabled=false`));
  assert.ok(args.includes(`permissions.gateway-readonly.network={ enabled = false }`));
});

test("confined Codex profiles deny host identity while explicit admin bypass omits the profile", () => {
  for (const writable of [false, true]) {
    const args = argsFor({ writable });
    const profile = writable ? "gateway-workspace" : "gateway-readonly";
    const filesystem = args.find((arg) => arg.startsWith(`permissions.${profile}.filesystem=`));
    for (const hostPath of HOST_IDENTITY_PATHS) {
      assert.ok(filesystem.includes(`"${hostPath}" = "deny"`), `${hostPath} must be denied`);
    }
  }

  const adminArgs = argsFor({ dangerouslySkip: true, networkMode: "unrestricted" });
  assert.ok(adminArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!adminArgs.some((arg) => arg.startsWith("permissions.gateway-")));
});

test("restricted Codex runs can read only their standalone runtime under home", () => {
  const release = path.join(scratch, "host-home", ".codex", "packages", "standalone", "releases", "0.150.1-linux");
  const executable = path.join(release, "bin", "codex");
  const link = path.join(scratch, "host-home", ".local", "bin", "codex");
  mkdirSync(path.dirname(executable), { recursive: true });
  mkdirSync(path.dirname(link), { recursive: true });
  writeFileSync(executable, "binary");
  symlinkSync(executable, link);

  const args = argsFor({ codexExecutablePath: link });
  const filesystem = args.find((arg) => arg.startsWith("permissions.gateway-readonly.filesystem="));
  assert.ok(filesystem.includes(`"${link}" = "read"`));
  assert.ok(filesystem.includes(`"${release}" = "read"`));
  assert.ok(!filesystem.includes(`${path.join(scratch, "host-home", ".codex")} = "read"`));
});

test("restricted Codex runs can read reviewed Linux per-user toolchains", () => {
  const paths = [
    "/home/tby/.local/node",
    "/home/tby/.local/bin/vercel",
    "/home/tby/.local/lib/node_modules/vercel",
  ];

  for (const writable of [false, true]) {
    const args = argsFor({ writable, toolchainPaths: paths });
    const profile = writable ? "gateway-workspace" : "gateway-readonly";
    const filesystem = args.find((arg) => arg.startsWith(`permissions.${profile}.filesystem=`));
    for (const toolchainPath of paths) {
      assert.match(filesystem, new RegExp(`${toolchainPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*= \\"read\\"`));
    }
  }
});

test("Codex puts the run-private reviewed launcher directory first on PATH", () => {
  const env = buildCodexEnv({ toolchainBinDir: "/run/private/bin" }, { PATH: "/usr/bin", LANG: "C" });
  assert.equal(env.PATH, `/run/private/bin${path.delimiter}/usr/bin`);
});

test("restricted Codex runs enforce approved domains with the network proxy", () => {
  const domains = ["github.com", "*.githubusercontent.com"];
  const args = argsFor({ writable: true, networkMode: "approved", networkDomains: domains, clean: false });

  assertConfined(args);
  assert.ok(args.includes(`features.network_proxy.enabled=true`));
  assert.ok(args.includes(`permissions.gateway-workspace.network={ enabled = true, domains = { "github.com" = "allow", "*.githubusercontent.com" = "allow" }, allow_local_binding = false, dangerously_allow_non_loopback_proxy = false, dangerously_allow_all_unix_sockets = false }`));
  assert.ok(!args.some((arg) => arg.includes('"*" = "allow"')));
});

test("approved domains apply equally to read-only, resumed, and clean Codex runs", () => {
  for (const options of [
    { writable: false },
    { writable: true, isNewSession: false },
    { writable: true, clean: true },
  ]) {
    const args = argsFor({ ...options, networkMode: "approved", networkDomains: ["api.github.com"] });
    const profile = options.writable ? "gateway-workspace" : "gateway-readonly";
    assertConfined(args);
    assert.ok(args.includes(`features.network_proxy.enabled=true`));
    assert.ok(args.includes(`permissions.${profile}.network={ enabled = true, domains = { "api.github.com" = "allow" }, allow_local_binding = false, dangerously_allow_non_loopback_proxy = false, dangerously_allow_all_unix_sockets = false }`));
  }
});

test("approved Codex networking fails closed on an empty or unsafe allowlist", () => {
  assert.throws(() => argsFor({ networkMode: "approved", networkDomains: [] }), /at least one approved/i);
  assert.throws(() => argsFor({ networkMode: "approved", networkDomains: ["*"] }), /unsafe network domain/i);
  assert.throws(() => argsFor({ networkMode: "unrestricted" }), /foreground-admin/i);
});

test("Codex feature inventory detects network_proxy compatibility", () => {
  assert.equal(codexFeatureListHasNetworkProxy("network_proxy experimental false\n"), true);
  assert.equal(codexFeatureListHasNetworkProxy("network_proxy stable true\n"), true);
  assert.equal(codexFeatureListHasNetworkProxy("other_feature stable true\n"), false);
  assert.doesNotThrow(() => assertCodexNetworkProxySupported({ execImpl: () => "network_proxy experimental false\n", useCache: false }));
  assert.throws(
    () => assertCodexNetworkProxySupported({ execImpl: () => "other_feature stable true\n", useCache: false }),
    /requires a CLI with the network_proxy feature; refusing to broaden egress/i,
  );
  assert.throws(
    () => assertCodexNetworkProxySupported({ execImpl: () => { throw new Error("old CLI"); }, useCache: false }),
    /requires a CLI with the network_proxy feature/i,
  );
});

test("approved networking grants only explicit Git/GitHub credential paths", () => {
  const paths = ["/gateway/home/.gitconfig", "/gateway/home/.config/git", "/gateway/home/.config/gh"];
  const approved = argsFor({ writable: true, networkMode: "approved", networkDomains: ["github.com"], credentialPaths: paths });
  const approvedFs = approved.find((arg) => arg.startsWith("permissions.gateway-workspace.filesystem="));
  for (const credentialPath of paths) assert.match(approvedFs, new RegExp(`${credentialPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*read`));

  const off = argsFor({ writable: true, credentialPaths: paths });
  const offFs = off.find((arg) => arg.startsWith("permissions.gateway-workspace.filesystem="));
  for (const credentialPath of paths) assert.doesNotMatch(offFs, new RegExp(credentialPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("autonomous Codex runs use auto-review instead of invisible approval cancellation", () => {
  const args = argsFor({ writable: true, clean: false, autoApprove: true });

  assert.ok(args.includes(`approval_policy="on-request"`));
  assert.ok(args.includes(`approvals_reviewer="auto_review"`));
  assert.ok(!args.includes(`approval_policy="never"`));
});

test("Codex resume carries the same permission profile as a fresh run", () => {
  const args = argsFor({ isNewSession: false, writable: true, clean: false });

  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "thread-1"]);
  assert.ok(!args.includes("-C"));
  assert.ok(args.includes(`approval_policy="never"`));
  assertConfined(args);
  assert.ok(args.includes(`default_permissions="gateway-workspace"`));
  assert.ok(args.some((arg) => arg.startsWith("permissions.gateway-workspace.filesystem=")));
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

test("fresh, resumed, and fallback Codex launches preserve shared state under an isolated CODEX_HOME", () => {
  const codexStateDir = "/Users/gateway/.codex";
  for (const args of [
    argsFor({ codexStateDir }),
    argsFor({ isNewSession: false, codexStateDir }),
  ]) {
    assert.ok(args.includes(`sqlite_home=${JSON.stringify(codexStateDir)}`));
    assert.ok(!args.some((arg) => arg.startsWith("skills.config=")));
  }
  const env = buildCodexEnv({ home: "/gateway/run-tmp/grants-a/user-home", codexHome: "/gateway/run-tmp/grants-a/user-home/.codex" }, { HOME: "/host-home" });
  assert.equal(env.HOME, "/gateway/run-tmp/grants-a/user-home");
  assert.equal(env.CODEX_HOME, "/gateway/run-tmp/grants-a/user-home/.codex");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("Codex grants read access to skill support assets but not the sibling auth/session state", () => {
  const skills = "/gateway-private/grants-a/user-home/.codex/skills";
  const args = argsFor({ writable: false, skillSupportDir: skills });
  const profile = args.find((arg) => arg.startsWith("permissions.gateway-readonly.filesystem="));
  assert.match(profile, new RegExp(`${skills.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*= \\"read\\"`));
  assert.doesNotMatch(profile, /auth\.json|sessions/);
});

test("clean Codex runs keep the restricted profile while dropping every MCP injection", () => {
  const args = argsFor({ writable: true, clean: true, progressReport: true });

  assertConfined(args);
  assert.ok(args.includes(`default_permissions="gateway-workspace"`));
  assert.ok(!args.some((arg) => arg.startsWith("mcp_servers.gateway.")));
  assert.ok(args.includes(`apps._default.enabled=false`));

  const cleanRead = argsFor({ writable: false, clean: true });
  assertConfined(cleanRead);
  assert.ok(cleanRead.includes(`default_permissions="gateway-readonly"`));
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

test("Codex gateway MCP tools are always approved by Codex when gateway MCP is injected", () => {
  const args = argsFor({ clean: false });

  assert.ok(args.includes(`mcp_servers.gateway.default_tools_approval_mode="approve"`));
  assert.ok(args.includes(`mcp_servers.gateway.env.CG_ENGINE="codex"`));
  assert.ok(args.includes(`mcp_servers.gateway.env.CG_FS_ROOT=${JSON.stringify(allowedFsRoot())}`));
  assert.ok(args.includes(`mcp_servers.gateway.env.CG_WORKSPACE_DIR=${JSON.stringify(workspaceRoot())}`));
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
  const args = argsFor({ composioUserToken: userToken, composioToken: sharedToken, secretBundlePath: "/gateway/run/codex-secrets.json" });
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
    secretBundlePath: "/gateway/run/codex-secrets.json",
  });
  const joined = args.join("\n");
  const env = buildCodexEnv({}, {});

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
  assert.equal(buildCodexEnv({}, {}).CG_MAKE_TOOLBOX_KEY, undefined);
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
    secretBundlePath: "/gateway/run/codex-secrets.json",
  });
  const argv = args.join("\n");
  const env = buildCodexEnv({}, {
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

test("full-access Codex runs keep the deliberate bypass and no restricted profile", () => {
  const args = argsFor({ dangerouslySkip: true, writable: true, clean: false, autoApprove: true });

  assert.ok(args.includes(`approval_policy="never"`));
  assert.ok(!args.includes(`approvals_reviewer="auto_review"`));
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes("--ignore-user-config"));
  assert.ok(!args.some((arg) => arg.startsWith("default_permissions=")));
  assert.ok(!args.some((arg) => arg.startsWith("permissions.")));
});

test("Codex child env points TMPDIR at the private scratch dir for sandboxed runs only", () => {
  const source = { PATH: "/usr/bin", HOME: "/Users/x", TMPDIR: "/var/folders/host" };
  const sandboxed = buildCodexEnv({ tmpDir: "/gw/tmp/run-abc" }, source);
  const full = buildCodexEnv({ tmpDir: "" }, source);

  assert.equal(sandboxed.TMPDIR, "/gw/tmp/run-abc");
  assert.equal(full.TMPDIR, "/var/folders/host");
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

test("Codex JSONL command and message item events map to progress callbacks", () => {
  assert.deepEqual(
    progressFromCodexEvent({ type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "npm test" } }),
    { event: { kind: "tool_use", id: "cmd_1", name: "npm test" } },
  );
  assert.deepEqual(
    progressFromCodexEvent({
      type: "item.completed",
      item: { id: "cmd_1", type: "command_execution", command: "npm test", status: "completed", error: { message: "exit 1" } },
    }),
    { event: { kind: "tool_result", id: "cmd_1", name: "npm test", status: "failed" } },
  );
  assert.deepEqual(
    progressFromCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "stream probe" } }),
    { delta: "stream probe" },
  );
});

test("Codex collab spawn events create a running agent without treating tool completion as child completion", () => {
  const started = progressFromCodexEvent({
    type: "item.started",
    item: {
      id: "call_spawn_1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      prompt: "Inspect Slack progress rendering",
      sender_thread_id: "thread-root",
      receiver_thread_ids: [],
      agents_states: {},
      status: "in_progress",
    },
  });
  const spawned = progressFromCodexEvent({
    type: "item.completed",
    item: {
      id: "call_spawn_1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      prompt: "Inspect Slack progress rendering",
      sender_thread_id: "thread-root",
      receiver_thread_ids: ["thread-child-1"],
      agents_states: {
        "thread-child-1": { status: "running", message: null },
      },
      status: "completed",
    },
  });

  assert.deepEqual(started, {
    event: {
      kind: "agent_activity",
      id: "call_spawn_1",
      engine: "codex",
      description: "Inspect Slack progress rendering",
      status: "running",
    },
  });
  assert.equal(spawned.event.status, "running", "spawn completion only means the child was created");
  assert.equal(spawned.event.id, "call_spawn_1");
  assert.deepEqual(spawned.event.aliasIds, ["thread-child-1"]);
});

test("Codex raw sub-agent activity normalizes camelCase and snake_case terminal states", () => {
  assert.deepEqual(progressFromCodexEvent({
    type: "event_msg",
    payload: {
      type: "sub_agent_activity",
      event_id: "call_spawn_1",
      agent_thread_id: "thread-child-1",
      agent_path: "/root/slack_reviewer",
      kind: "started",
    },
  }), {
    event: {
      kind: "agent_activity",
      id: "call_spawn_1",
      engine: "codex",
      name: "slack_reviewer",
      status: "running",
    },
  });

  assert.deepEqual(progressFromCodexEvent({
    type: "eventMsg",
    payload: {
      type: "subAgentActivity",
      eventId: "call_spawn_1",
      agentThreadId: "thread-child-1",
      agentPath: "/root/slack_reviewer",
      kind: "failed",
      message: "review crashed",
    },
  }), {
    event: {
      kind: "agent_activity",
      id: "call_spawn_1",
      engine: "codex",
      name: "slack_reviewer",
      description: "review crashed",
      status: "failed",
    },
  });
});

test("Codex wait items emit current states for multiple child threads", () => {
  const progress = progressFromCodexEvent({
    type: "item.updated",
    item: {
      id: "call_wait_1",
      type: "collab_tool_call",
      tool: "wait",
      sender_thread_id: "thread-root",
      receiver_thread_ids: ["thread-child-1", "thread-child-2"],
      agents_states: {
        "thread-child-1": { status: "completed", message: "done" },
        "thread-child-2": { status: "errored", message: "review crashed" },
      },
      status: "completed",
    },
  });

  assert.deepEqual(progress.events, [
    {
      kind: "agent_activity",
      id: "thread-child-1",
      engine: "codex",
      status: "completed",
    },
    {
      kind: "agent_activity",
      id: "thread-child-2",
      engine: "codex",
      description: "review crashed",
      status: "failed",
    },
  ]);
});

test("Codex MCP servers carry a generous startup window (cold bridge spawns must not be dropped)", () => {
  const args = argsFor({ composioUserToken: "ck_u", composioToken: "ck_s", skillsToken: "sk", secretBundlePath: "/gateway/run/codex-secrets.json" });
  for (const name of ["composio-user", "composio-agent", "makeitfuture-skills"]) {
    assert.ok(args.includes(`mcp_servers.${name}.startup_timeout_sec=120`), `${name} startup timeout`);
  }
  assert.ok(args.includes("mcp_servers.gateway.startup_timeout_sec=60"), "gateway startup timeout");
});

test("a flag-shaped Slack message can never be parsed as a CLI option", async () => {
  const { argvSafePrompt } = await import("../src/engines/contract.js");
  assert.equal(argvSafePrompt("--file=/etc/passwd"), " --file=/etc/passwd");
  assert.equal(argvSafePrompt("  -x  "), " -x");
  assert.equal(argvSafePrompt("normal prompt"), "normal prompt");
  assert.equal(argvSafePrompt(""), "");
});
