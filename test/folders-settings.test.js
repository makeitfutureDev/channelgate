import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [
  { buildSettings, ensureChannelFolder },
  { composioRef, composioUserRef, makeToolboxRef, GATEWAY_TOOL_NAMES, gatewayToolRefs },
  { channelSettingsFile, channelAdminSettingsFile, claudeEngineHome },
  { getCredentialHomePaths },
] = await Promise.all([
  import("../src/gateway/folders.js"),
  import("../src/gateway/mcp-catalog.js"),
  import("../src/config/paths.js"),
  import("../src/config/settings.js"),
]);

// Claude Code accepts only "disable"/absent for disableBypassPermissionsMode. ANY other value
// (including "allow") makes the CLI silently discard the ENTIRE settings file — no Stop hook, no
// deny list, no memory-off, no sandbox. So the shared variant must pin "disable" and the admin
// bypass variant must OMIT the key rather than set a permissive value.
test("bypass key is 'disable' in shared settings and absent in the bypass variant", async () => {
  const shared = await buildSettings({ _slug: "bypass-probe", allowedMcps: [] });
  assert.equal(shared.permissions.disableBypassPermissionsMode, "disable");

  const bypass = await buildSettings({ _slug: "bypass-probe", allowedMcps: [] }, { allowBypass: true });
  assert.equal("disableBypassPermissionsMode" in bypass.permissions, false);
  // The sandbox-off delta must live in buildSettings itself: the per-run artifact every Claude
  // spawn loads is derived from THIS call, not from the settings-admin.json clone.
  assert.equal(bypass.sandbox.enabled, false);
  assert.ok(Array.isArray(bypass.sandbox.filesystem.allowRead));
  assert.equal(shared.sandbox.enabled, true);
});

test("admin-mode channels get an admin settings file the CLI will honour", async () => {
  const slug = "bypass-admin-probe";
  await ensureChannelFolder(slug, { adminMode: true, allowedMcps: [] });

  const shared = JSON.parse(readFileSync(channelSettingsFile(slug), "utf8"));
  assert.equal(shared.permissions.disableBypassPermissionsMode, "disable");

  const admin = JSON.parse(readFileSync(channelAdminSettingsFile(slug), "utf8"));
  // Key must be ABSENT (that is what permits --dangerously-skip-permissions) and the OS sandbox
  // must be OFF — the admin contract is "full tools, sandbox off", and the bypass flag alone
  // never lifts the sandbox (Claude Code applies settings.sandbox regardless of the flag; with
  // it left enabled, a Linux escalated turn saw a tmpfs home hiding every real file outside the
  // allowRead binds). Every non-sandbox lockdown protection still survives in the same file.
  assert.equal("disableBypassPermissionsMode" in admin.permissions, false);
  assert.equal(admin.autoMemoryEnabled, false);
  assert.equal(admin.sandbox.enabled, false);
  // The shared variant is untouched: every non-escalated run keeps the full OS sandbox.
  assert.equal(shared.sandbox.enabled, true);
  assert.ok(Array.isArray(admin.permissions.deny) && admin.permissions.deny.length > 0);
  assert.ok(admin.hooks && Object.keys(admin.hooks).length > 0);
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

test("Claude approved-network Bash mode grants classic and XDG Git config narrowly", async () => {
  for (const mode of [{ allowBash: true }, { autoMode: true }]) {
    const settings = await buildSettings({ _slug: "claude-network-git", ...mode, allowNetwork: true, allowedMcps: [] });
    const allowRead = settings.sandbox.filesystem.allowRead;
    for (const suffix of ["/.gitconfig", "/.git-credentials", "/.config/git", "/.config/gh", "/.ssh/known_hosts"]) {
      assert.ok(allowRead.some((entry) => entry.endsWith(suffix)), `${JSON.stringify(mode)} ${suffix}`);
    }
    // known_hosts is the ONLY .ssh path — keys and ssh config must stay denied. Both the real
    // target and its synthetic-HOME link are granted, so match on the suffix, not the count.
    for (const entry of allowRead.filter((e) => e.includes("/.ssh"))) {
      assert.ok(entry.endsWith("/.ssh/known_hosts"), `${JSON.stringify(mode)} ${entry}`);
    }
  }
});

test("credential grants cover the synthetic engine HOME, not just the real target", async () => {
  // The engine runs with HOME=claudeEngineHome(), inside the read-denied gateway root. git/gh
  // reach their config through THAT path (a symlink to the host's), and the sandbox refuses at
  // the link before the allowed real target is reached — so both stages must be granted or
  // `git push` dies with EPERM on ~/.gitconfig in a fully network-enabled channel.
  const settings = await buildSettings({ _slug: "claude-synthetic-home-git", allowBash: true, allowNetwork: true, allowedMcps: [] });
  const allowRead = settings.sandbox.filesystem.allowRead;
  const engineHome = claudeEngineHome();
  for (const rel of getCredentialHomePaths()) {
    assert.ok(
      allowRead.some((entry) => entry === path.join(engineHome, rel)),
      `synthetic HOME grant missing for ${rel}`,
    );
    assert.ok(
      allowRead.some((entry) => entry === path.join(os.homedir(), rel)),
      `real-target grant missing for ${rel}`,
    );
  }
});

test("credential grants are withheld from read-only and network-off channels", async () => {
  const engineHome = claudeEngineHome();
  const cases = [
    { label: "network on, read-only", meta: { allowNetwork: true } },
    { label: "bash on, network off", meta: { allowBash: true } },
  ];
  for (const { label, meta } of cases) {
    const settings = await buildSettings({ _slug: "claude-no-git-grants", ...meta, allowedMcps: [] });
    const allowRead = settings.sandbox.filesystem.allowRead;
    for (const rel of getCredentialHomePaths()) {
      assert.ok(!allowRead.includes(path.join(engineHome, rel)), `${label}: leaked synthetic ${rel}`);
      assert.ok(!allowRead.includes(path.join(os.homedir(), rel)), `${label}: leaked real ${rel}`);
    }
  }
});

test("gateway MCP permission list tracks registered gateway tools", () => {
  // Tool registrations live in the per-group modules under src/mcp/tools/ (registered by the
  // gateway-server.js entry). Group order differs from the flat pre-split file, so compare the
  // registered names as a sorted list — same set, no duplicates, nothing lost.
  const toolModules = ["schedules.js", "background.js", "channel-admin.js", "tokens.js", "slack-native.js"];
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
