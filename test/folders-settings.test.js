import { readFileSync } from "node:fs";
import os from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [
  { buildSettings, ensureChannelFolder },
  { composioRef, composioUserRef, makeToolboxRef, GATEWAY_TOOL_NAMES, gatewayToolRefs, composioUrl, toolboxUrl, injectedRemoteAllowMatches },
  { channelSettingsFile, channelAdminSettingsFile, gatewayRoot },
] = await Promise.all([
  import("../src/gateway/folders.js"),
  import("../src/gateway/mcp-catalog.js"),
  import("../src/config/paths.js"),
]);

// Claude Code accepts only "disable"/absent for disableBypassPermissionsMode. ANY other value
// (including "allow") makes the CLI silently discard the ENTIRE settings file — no Stop hook, no
// deny list, no memory-off. So the shared variant must pin "disable" and the admin bypass variant
// must OMIT the key rather than set a permissive value.
// A Full-access channel whose container mounts the operator home must be able to Read/Edit it,
// not only see it from Bash: Claude Code confines its file tools to the cwd plus
// `permissions.additionalDirectories`. The entry is derived from the resolved target's mounts
// (kind "operator-home"), never typed in, so the settings file can never name a host path the
// container does not have — and it appears in the ADMIN variant only.
test("the admin variant lists the operator home as an additional directory only when the container mounts it", async () => {
  const mounted = { container: { mounts: [{ kind: "workdir", source: "/w", target: "/w", mode: "rw" }, { kind: "operator-home", source: "/home/op", target: "/home/op", mode: "rw" }, { kind: "mask", type: "tmpfs", source: "", target: "/home/op/.local/share/containers", mode: "rw" }] } };
  const unmounted = { container: { mounts: [{ kind: "workdir", source: "/w", target: "/w", mode: "rw" }] } };

  const bypass = await buildSettings({ _slug: "home-admin", adminMode: true, allowedMcps: [] }, { allowBypass: true, target: mounted });
  assert.deepEqual(bypass.permissions.additionalDirectories, ["/home/op"], "the mount target, and never the mask");

  const bypassNoGrant = await buildSettings({ _slug: "home-admin", adminMode: true, allowedMcps: [] }, { allowBypass: true, target: unmounted });
  assert.deepEqual(bypassNoGrant.permissions.additionalDirectories, []);
  const bypassNoTarget = await buildSettings({ _slug: "home-admin", adminMode: true, allowedMcps: [] }, { allowBypass: true });
  assert.deepEqual(bypassNoTarget.permissions.additionalDirectories, []);

  // The SHARED file (every non-admin author's turn) never widens the file tools, mount or not.
  const shared = await buildSettings({ _slug: "home-admin", adminMode: true, allowedMcps: [] }, { target: mounted });
  assert.deepEqual(shared.permissions.additionalDirectories, []);
});

test("bypass key is 'disable' in shared settings and absent in the bypass variant", async () => {
  const shared = await buildSettings({ _slug: "bypass-probe", allowedMcps: [] });
  assert.equal(shared.permissions.disableBypassPermissionsMode, "disable");

  const bypass = await buildSettings({ _slug: "bypass-probe", allowedMcps: [] }, { allowBypass: true });
  assert.equal("disableBypassPermissionsMode" in bypass.permissions, false);
  // Confinement is the channel container, so neither variant carries an engine sandbox block: an
  // admin turn is "full tools" inside the same boundary, not a boundary switched off.
  assert.equal("sandbox" in bypass, false);
  assert.equal("sandbox" in shared, false);
  // The bypass allowance and the shell grant it implies are the ONLY deltas: the admin variant is
  // exactly the same channel built WITH the shell, plus the omitted bypass key. Stating it against
  // the bashy build (rather than the read-mode shared file) is what keeps the two halves of the
  // escalation — the flag and the permissions the file admits — from drifting apart again.
  const bashy = await buildSettings({ _slug: "bypass-probe", allowBash: true, allowedMcps: [] });
  assert.deepEqual({ ...bypass, permissions: { ...bypass.permissions, disableBypassPermissionsMode: "disable" } }, bashy);
});

test("admin-mode channels get an admin settings file the CLI will honour", async () => {
  const slug = "bypass-admin-probe";
  await ensureChannelFolder(slug, { adminMode: true, allowedMcps: [] });

  const shared = JSON.parse(readFileSync(channelSettingsFile(slug), "utf8"));
  assert.equal(shared.permissions.disableBypassPermissionsMode, "disable");

  const admin = JSON.parse(readFileSync(channelAdminSettingsFile(slug), "utf8"));
  // Key must be ABSENT (that is what permits --dangerously-skip-permissions). Every other lockdown
  // protection survives in the same file: memory off, the deny list, the Stop hook. Neither file
  // carries an engine sandbox block — the container is the confinement for admin turns too.
  assert.equal("disableBypassPermissionsMode" in admin.permissions, false);
  assert.equal(admin.autoMemoryEnabled, false);
  assert.equal("sandbox" in admin, false);
  assert.equal("sandbox" in shared, false);
  assert.ok(Array.isArray(admin.permissions.deny) && admin.permissions.deny.length > 0);
  assert.ok(admin.hooks && Object.keys(admin.hooks).length > 0);
});

// Read mode's contract is "Read/Glob/Grep only — every other tool asks for approval". Expressing
// that by merely OMITTING Bash from `allow` did not hold: Claude Code answers a simple command
// whose argv head is on its own built-in read-only list (`id`, `cat`, `head`, `strings`, …) before
// it consults --permission-prompt-tool, and a read-mode turn ran `id -un` in the channel's
// container with no card and no approval row (QA, 2026-09-05). An `ask` rule is evaluated ahead of
// that layer, so every mode that does NOT grant the shell must name Bash there.
test("a channel without the shell grants sends every Bash command to the approval card", async () => {
  const askless = [
    { label: "read", meta: {} },
    { label: "read, memory off", meta: { memory: false } },
    { label: "clean", meta: { cleanMode: true } },
    // An admin channel's SHARED file is what a non-admin author runs under (the bypass variant is
    // handed only to an admin author, and grants the shell outright — see the admin-run test
    // below), so it must ask too.
    { label: "admin", meta: { adminMode: true } },
  ];
  for (const { label, meta } of askless) {
    const settings = await buildSettings({ _slug: "claude-ask-bash", ...meta, allowedMcps: [] });
    assert.ok(settings.permissions.ask.includes("Bash"), `${label}: Bash must ask`);
    assert.equal(settings.permissions.allow.includes("Bash"), false, `${label}: Bash must not be pre-approved`);
    // `deny` outranks `allow`, so the shell must never be denied outright here: that would also
    // be the wrong contract (approval is possible), and the same mistake applied to Write/Edit
    // would void the narrow MEMORY.md grant below.
    assert.equal(settings.permissions.deny.includes("Bash"), false, `${label}: ask, never deny`);
    for (const tool of ["Write", "Edit", "MultiEdit", "Write(MEMORY.md)", "Edit(MEMORY.md)"]) {
      assert.equal(settings.permissions.deny.includes(tool), false, `${label}: ${tool} must stay out of deny`);
    }
  }

  // The narrow folder-scoped memory grant survives the ask rule (it is an allow on a scoped
  // Write/Edit, which the Bash ask never touches).
  const readSettings = await buildSettings({ _slug: "claude-ask-bash-memory", allowedMcps: [] });
  assert.ok(readSettings.permissions.allow.includes("Write(MEMORY.md)"));
  assert.ok(readSettings.permissions.allow.includes("Edit(MEMORY.md)"));
});

// `ask` outranks `allow`: naming Bash there for a channel that GRANTED the shell would put an
// approval card in front of every command a bash/auto channel exists to run.
test("granting the shell leaves Bash out of the ask list", async () => {
  for (const { label, meta } of [
    { label: "bash", meta: { allowBash: true } },
    { label: "auto", meta: { autoMode: true } },
    { label: "admin + bash", meta: { adminMode: true, allowBash: true } },
    { label: "clean + bash", meta: { cleanMode: true, allowBash: true } },
  ]) {
    const settings = await buildSettings({ _slug: "claude-ask-bash-granted", ...meta, allowedMcps: [] });
    assert.ok(settings.permissions.allow.includes("Bash"), `${label}: shell granted`);
    assert.equal((settings.permissions.ask || []).includes("Bash"), false, `${label}: granted shell must not ask`);
  }
});

test("the on-disk lockdown files carry the ask rule for a channel without the shell", async () => {
  const slug = "ask-bash-files";
  await ensureChannelFolder(slug, { adminMode: true, allowedMcps: [] });

  const shared = JSON.parse(readFileSync(channelSettingsFile(slug), "utf8"));
  const admin = JSON.parse(readFileSync(channelAdminSettingsFile(slug), "utf8"));
  // The SHARED file is every non-admin author's turn in this channel: it asks.
  assert.ok(shared.permissions.ask.includes("Bash"), "shared: Bash asks on disk");
  assert.equal(shared.permissions.allow.includes("Bash"), false, "shared: Bash not pre-approved on disk");
  // The admin variant is the bypassed admin turn's file, so it grants the shell instead of asking
  // for it — an ask rule there is not merely redundant, it took the shell away (2026-09-07).
  assert.ok(admin.permissions.allow.includes("Bash"), "admin: Bash granted on disk");
  assert.equal("ask" in admin.permissions, false, "admin: no ask rule on disk");

  const bashSlug = "ask-bash-files-shell";
  await ensureChannelFolder(bashSlug, { allowBash: true, allowedMcps: [] });
  const bashSettings = JSON.parse(readFileSync(channelSettingsFile(bashSlug), "utf8"));
  assert.ok(bashSettings.permissions.allow.includes("Bash"));
  assert.equal((bashSettings.permissions.ask || []).includes("Bash"), false);
});

test("Claude settings explicitly pre-approve embedded gateway MCP tools", async () => {
  const settings = await buildSettings({ _slug: "claude-gateway-tools", cleanMode: false, allowedMcps: [] });
  const allow = settings.permissions.allow;

  assert.ok(allow.includes("mcp__gateway"));
  assert.ok(allow.includes("mcp__gateway__create_schedule"));
  assert.ok(allow.includes("mcp__gateway__run_in_background"));
  assert.ok(allow.includes("mcp__gateway__report_progress"));
  assert.ok(allow.includes("mcp__gateway__permission_prompt"));
  assert.ok(GATEWAY_TOOL_NAMES.includes("report_progress"));
  assert.deepEqual(gatewayToolRefs().filter((tool) => !allow.includes(tool)), []);
});

test("clean mode does not pre-approve gateway MCP tools", async () => {
  const settings = await buildSettings({ _slug: "claude-clean", cleanMode: true, allowedMcps: [] });
  const allow = settings.permissions.allow;

  assert.equal(allow.includes("mcp__gateway"), false);
  assert.deepEqual(gatewayToolRefs().filter((tool) => allow.includes(tool)), []);
});

test("Claude settings pre-approve personal and shared Composio MCPs outside clean mode", async () => {
  const settings = await buildSettings({ _slug: "claude-composio", cleanMode: false, allowedMcps: [] });
  const cleanSettings = await buildSettings({ _slug: "claude-composio-clean", cleanMode: true, allowedMcps: [] });

  assert.ok(settings.permissions.allow.includes(composioRef().namespace));
  assert.ok(settings.permissions.allow.includes(composioUserRef().namespace));
  assert.equal(cleanSettings.permissions.allow.includes(composioRef().namespace), false);
  assert.equal(cleanSettings.permissions.allow.includes(composioUserRef().namespace), false);
});

test("Claude settings allow the stable Make toolbox namespace only outside clean mode", async () => {
  const settings = await buildSettings({ _slug: "claude-make-toolbox", cleanMode: false, allowedMcps: [] });
  const cleanSettings = await buildSettings({ _slug: "claude-make-toolbox-clean", cleanMode: true, allowedMcps: [] });

  assert.ok(settings.permissions.allow.includes(makeToolboxRef().namespace));
  assert.ok(settings.allowedMcpServers.some((match) => match.serverName === "make-toolbox"));
  assert.equal(cleanSettings.permissions.allow.includes(makeToolboxRef().namespace), false);
  assert.equal(cleanSettings.allowedMcpServers.some((match) => match.serverName === "make-toolbox"), false);
});

// The "Allow network" switch is the container's business (the engine network policy and, next,
// the egress proxy), never the settings file's: there is no sandbox to punch git/gh credential
// holes into, and the channel's own logins live in its HOME volume inside the container.
test("the Allow network switch never reaches the settings file", async () => {
  for (const mode of [{ allowBash: true }, { autoMode: true }, {}]) {
    const on = await buildSettings({ _slug: "claude-network", ...mode, allowNetwork: true, allowedMcps: [] });
    const off = await buildSettings({ _slug: "claude-network", ...mode, allowNetwork: false, allowedMcps: [] });
    assert.deepEqual(on, off, JSON.stringify(mode));
  }
});

// What the file carries is POLICY (tool permissions, MCP allowlist, memory off, the Stop hook);
// confinement is the channel container. So no variant may name a host path — the engine never
// sees the daemon's filesystem, and a path into it would be a file the engine cannot open.
test("no settings variant carries a sandbox block or a host path", async () => {
  const cases = [
    { label: "read-only", meta: {} },
    { label: "network on, read-only", meta: { allowNetwork: true } },
    { label: "bash on, network off", meta: { allowBash: true } },
    { label: "bash + network", meta: { allowBash: true, allowNetwork: true } },
    { label: "auto", meta: { autoMode: true, allowNetwork: true } },
    { label: "admin", meta: { adminMode: true, allowBash: true, allowNetwork: true } },
    { label: "clean", meta: { cleanMode: true } },
  ];
  for (const { label, meta } of cases) {
    for (const allowBypass of [false, true]) {
      const settings = await buildSettings({ _slug: "claude-no-host-paths", ...meta, allowedMcps: [] }, { allowBypass });
      assert.equal("sandbox" in settings, false, `${label}: sandbox block`);
      const rendered = JSON.stringify(settings);
      assert.equal(rendered.includes(os.homedir()), false, `${label}: leaked the operator's home`);
      assert.equal(rendered.includes(gatewayRoot()), false, `${label}: leaked the gateway root`);
    }
  }
});

test("gateway MCP permission list tracks registered gateway tools", () => {
  // Tool registrations live in the per-group modules under src/mcp/tools/ (registered by the
  // gateway-server.js entry). Group order differs from the flat pre-split file, so compare the
  // registered names as a sorted list — same set, no duplicates, nothing lost.
  const toolModules = ["schedules.js", "background.js", "channel-admin.js", "tokens.js", "slack-native.js", "skills.js"];
  const source = toolModules
    .map((file) => readFileSync(new URL(`../src/mcp/tools/${file}`, import.meta.url), "utf8"))
    .join("\n");
  const registered = [...source.matchAll(/server\.registerTool\(\s*\n\s*"([^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual([...GATEWAY_TOOL_NAMES].sort(), [...registered].sort());
});

test("progress report registration uses the shared contract and remains ack-only", () => {
  const source = readFileSync(new URL("../src/mcp/tools/background.js", import.meta.url), "utf8");
  const reportTool = source.match(/server\.registerTool\(\s*\n\s*"report_progress",[\s\S]*?\n\s*\);/)?.[0] || "";

  assert.match(source, /import \{ progressReportInputSchema \} from "\.\.\/\.\.\/engines\/progress-report\.js";/);
  assert.match(source, /if \(ctx\.progressReport\)/); // the ctx field, not a process-wide env side channel
  assert.match(reportTool, /before substantive work/);
  assert.match(reportTool, /inputSchema: progressReportInputSchema/);
  assert.match(reportTool, /async \(\) => text\("Foreground Slack Plan accepted\."\)/);
});

test("gateway MCP channel controls use the active engine selection field", () => {
  const entry = readFileSync(new URL("../src/mcp/gateway-server.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/mcp/tools/channel-admin.js", import.meta.url), "utf8");

  assert.match(entry, /claims\.engine/);
  assert.match(source, /selectionFieldForEngine\(activeEngine\)/);
  assert.match(source, /persistedSelectionForEngine\(activeEngine, s\)/);
});

// Claude Code matches a REMOTE server against `allowedMcpServers` by URL as soon as the list has any
// serverUrl entry — a channel's picked global server adds one — and a serverName entry then no
// longer admits it: the CLI dropped composio-user / composio-agent as "blocked by enterprise policy"
// and the model never saw them (#int-sales, 2026-09-04). Every injected remote server therefore
// carries its URL beside its name, and clean mode still carries nothing.
test("the lockdown admits the injected remote servers by URL next to a picked global server", async () => {
  const picked = { name: "aioutreach", namespace: "mcp__aioutreach", match: { serverUrl: "https://mcp.example.test/aioutreach" } };
  const settings = await buildSettings({ _slug: "claude-remote-allow", cleanMode: false, allowedMcps: [picked], makeToolboxUrl: "https://hook.eu2.make.com/mcp/example" });
  const urls = settings.allowedMcpServers.filter((m) => m.serverUrl).map((m) => m.serverUrl);
  for (const url of [composioUrl(), toolboxUrl(), "https://hook.eu2.make.com/mcp/example", picked.match.serverUrl]) {
    assert.ok(urls.includes(url), `missing serverUrl entry for ${url}`);
  }
  assert.ok(settings.allowedMcpServers.some((m) => m.serverName === composioRef().name));
  assert.ok(settings.allowedMcpServers.some((m) => m.serverName === composioUserRef().name));

  const cleanSettings = await buildSettings({ _slug: "claude-remote-allow-clean", cleanMode: true, allowedMcps: [picked] });
  assert.deepEqual(cleanSettings.allowedMcpServers, []);
});

test("SDK-mode Composio adds its tool-router host pattern; a malformed Make toolbox URL adds nothing", () => {
  const sdk = injectedRemoteAllowMatches({ composioSdk: true }).map((m) => m.serverUrl);
  assert.ok(sdk.includes("https://*.composio.dev/*"));
  assert.ok(sdk.includes(composioUrl()));
  const personal = injectedRemoteAllowMatches({}).map((m) => m.serverUrl);
  assert.equal(personal.includes("https://*.composio.dev/*"), false);
  assert.equal(injectedRemoteAllowMatches({ makeToolboxUrl: "not a url" }).some((m) => m.serverUrl === "not a url"), false);
});

// The "full" capability profile sets adminMode ONLY (never allowBash/autoMode), so an admin
// channel's meta normally has no shell grant of its own — and the admin-run variant inherited the
// read-mode `ask: ["Bash"]` rule from the shared file. Claude Code still evaluated that rule for a
// --dangerously-skip-permissions turn: a bare `pwd` came back denied, `kill -9 $PPID` was refused
// as "Contains simple_expansion", and the admin turn reported the shell "not actually granted" and
// fell back to Read-only (QA, 2026-09-07). The variant is handed ONLY to an admin author in an
// adminMode channel — the same turn that receives the bypass flag — so granting the shell there
// widens nothing that the flag did not already permit, and the file must stop contradicting it.
test("the admin-run variant grants the shell outright and carries no ask rule", async () => {
  const admin = await buildSettings({ _slug: "admin-shell", adminMode: true, allowedMcps: [] }, { allowBypass: true });
  for (const tool of ["Bash", "Write", "Edit", "MultiEdit"]) {
    assert.ok(admin.permissions.allow.includes(tool), `${tool} granted in the admin variant`);
  }
  assert.equal("ask" in admin.permissions, false, "no ask rule may contradict the bypass");
  assert.equal("disableBypassPermissionsMode" in admin.permissions, false);
  // Same shape as the bashy branch: the broad Write/Edit grant makes the narrow MEMORY.md pair
  // redundant, so it is not emitted twice.
  for (const scoped of ["Write(MEMORY.md)", "Edit(MEMORY.md)"]) {
    assert.equal(admin.permissions.allow.includes(scoped), false, `${scoped} is redundant beside the broad grant`);
  }
  // Everything else the lockdown carries survives the widening.
  assert.equal(admin.autoMemoryEnabled, false);
  assert.equal("sandbox" in admin, false);
  assert.ok(admin.permissions.deny.includes("mcp__claude-in-chrome"));
  assert.ok(admin.hooks && Object.keys(admin.hooks).length > 0);

  // The SHARED file is unchanged — it is what every NON-admin author in the same channel runs
  // under, and it must keep sending each command to the approval card.
  const shared = await buildSettings({ _slug: "admin-shell", adminMode: true, allowedMcps: [] });
  assert.deepEqual(shared.permissions.ask, ["Bash"]);
  assert.equal(shared.permissions.allow.includes("Bash"), false);
  assert.equal(shared.permissions.disableBypassPermissionsMode, "disable");

  // A channel that is not in admin mode is untouched on both variants (nothing ever hands it the
  // bypass file, but the generator must not widen a read-mode channel either way).
  const readShared = await buildSettings({ _slug: "read-shell", allowedMcps: [] });
  assert.deepEqual(readShared.permissions.ask, ["Bash"]);
  assert.equal(readShared.permissions.allow.includes("Bash"), false);
});
