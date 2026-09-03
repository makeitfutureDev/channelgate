import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { buildClaudeArgs, buildPersistentArgs, buildClaudeEnv, canUseClaudeWarmPool } = await import("../src/engines/claude.js");

// Mirror of codex-args.test.js for the Claude side: these builders assemble the argv that
// decides session identity, lockdown settings, MCP injection, and — most critically — whether
// --dangerously-skip-permissions rides along. A silent regression here means full-permission
// runs for non-admins, so every flag's presence AND absence is pinned.

function argsFor(overrides = {}) {
  return buildClaudeArgs({
    prompt: "check schedules",
    sessionId: "11111111-2222-3333-4444-555555555555",
    isNewSession: true,
    ...overrides,
  });
}

test("one-shot args carry the stream-json contract and the trimmed prompt", () => {
  const args = argsFor({ prompt: "  check schedules  " });
  assert.deepEqual(args.slice(0, 2), ["-p", "check schedules"]);
  assert.ok(args.includes("--output-format"));
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.ok(args.includes("--include-partial-messages"));
});

test("new session uses --session-id; resume uses -r — never both", () => {
  const fresh = argsFor({ isNewSession: true });
  assert.equal(fresh[fresh.indexOf("--session-id") + 1], "11111111-2222-3333-4444-555555555555");
  assert.ok(!fresh.includes("-r"));

  const resumed = argsFor({ isNewSession: false });
  assert.equal(resumed[resumed.indexOf("-r") + 1], "11111111-2222-3333-4444-555555555555");
  assert.ok(!resumed.includes("--session-id"));
});

test("--dangerously-skip-permissions is appended ONLY when explicitly requested", () => {
  assert.ok(!argsFor().includes("--dangerously-skip-permissions"), "default must be confined");
  assert.ok(!argsFor({ dangerouslySkip: false }).includes("--dangerously-skip-permissions"));
  assert.ok(argsFor({ dangerouslySkip: true }).includes("--dangerously-skip-permissions"));
});

test("MCP config is a file path with --strict-mcp-config, and strict never appears without it", () => {
  const withMcp = argsFor({ mcpConfig: "/tmp/mcp-run.json", strictMcp: true });
  assert.equal(withMcp[withMcp.indexOf("--mcp-config") + 1], "/tmp/mcp-run.json");
  assert.ok(withMcp.includes("--strict-mcp-config"));

  const noMcp = argsFor({ mcpConfig: null, strictMcp: true });
  assert.ok(!noMcp.includes("--mcp-config"));
  assert.ok(!noMcp.includes("--strict-mcp-config"), "strict without a config would be meaningless");

  const laxMcp = argsFor({ mcpConfig: "/tmp/mcp-run.json", strictMcp: false });
  assert.ok(!laxMcp.includes("--strict-mcp-config"));
});

test("settings/model/effort/permission-prompt flags appear only when provided", () => {
  const bare = argsFor();
  for (const flag of ["--settings", "--model", "--effort", "--permission-prompt-tool"]) {
    assert.ok(!bare.includes(flag), `${flag} must be absent by default`);
  }

  const full = argsFor({
    settingsFile: "/tmp/chan/.claude/settings.json",
    model: "claude-sonnet-5",
    effort: "high",
    permissionPromptTool: "mcp__gateway__permission_prompt",
  });
  assert.equal(full[full.indexOf("--settings") + 1], "/tmp/chan/.claude/settings.json");
  assert.equal(full[full.indexOf("--model") + 1], "claude-sonnet-5");
  assert.equal(full[full.indexOf("--effort") + 1], "high");
  assert.equal(full[full.indexOf("--permission-prompt-tool") + 1], "mcp__gateway__permission_prompt");
});

test("persistent args feed the prompt over stdin — never on argv — with the same gating", () => {
  const args = buildPersistentArgs({
    sessionId: "11111111-2222-3333-4444-555555555555",
    isNewSession: true,
    mcpConfig: "/tmp/mcp-run.json",
    strictMcp: true,
    dangerouslySkip: false,
    settingsFile: "/tmp/chan/.claude/settings.json",
  });
  assert.ok(!args.includes("check schedules"), "no prompt text may ride on the persistent argv");
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(buildPersistentArgs({ sessionId: "s", isNewSession: true, dangerouslySkip: true }).includes("--dangerously-skip-permissions"));
});

test("both builders gate the session flags identically", () => {
  const persistentResume = buildPersistentArgs({ sessionId: "abc", isNewSession: false });
  assert.equal(persistentResume[persistentResume.indexOf("-r") + 1], "abc");
  assert.ok(!persistentResume.includes("--session-id"));
});

test("fresh and resumed Claude launches load isolated user grants as real plugins", () => {
  const pluginDir = "/gateway/run-tmp/grants-a/gateway-run-plugin";
  const fresh = argsFor({ pluginDirs: [pluginDir] });
  const resumed = buildPersistentArgs({
    sessionId: "abc",
    isNewSession: false,
    pluginDirs: [pluginDir],
  });

  assert.equal(fresh[fresh.indexOf("--plugin-dir") + 1], pluginDir);
  assert.equal(resumed[resumed.indexOf("--plugin-dir") + 1], pluginDir);
  assert.equal(canUseClaudeWarmPool({ preferCold: false, claudePluginDirs: [pluginDir], claudePluginEphemeral: true }), false);
  assert.equal(canUseClaudeWarmPool({ preferCold: false, claudePluginDirs: ["/gateway/stable/shared-plugin"], claudePluginEphemeral: false }), true);
  assert.equal(canUseClaudeWarmPool({ preferCold: false, claudePluginDirs: [] }), true);
});

test("Claude launches exclude host-user settings, plugins, and skills", () => {
  for (const args of [
    buildClaudeArgs({ prompt: "hello", sessionId: "s", isNewSession: true }),
    buildPersistentArgs({ sessionId: "s", isNewSession: true }),
  ]) {
    const index = args.indexOf("--setting-sources");
    assert.ok(index >= 0);
    assert.equal(args[index + 1], "");
  }
});

test("Claude receives gateway instructions explicitly and an isolated HOME/config root", () => {
  const instructionFile = "/workspace/CLAUDE.md";
  for (const args of [
    buildClaudeArgs({ prompt: "hello", sessionId: "s", isNewSession: true, instructionFile }),
    buildPersistentArgs({ sessionId: "s", isNewSession: true, instructionFile }),
  ]) {
    assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], instructionFile);
  }

  const env = buildClaudeEnv(
    { home: "/gateway/run/claude-home", configDir: "/gateway/run/claude-home/.claude" },
    { HOME: "/host-home", CLAUDE_CONFIG_DIR: "/host-config", PATH: "/bin" },
  );
  assert.equal(env.HOME, "/gateway/run/claude-home");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/gateway/run/claude-home/.claude");
  assert.equal(env.PATH, "/bin");
});

test("stable isolated state remains warm while private overlays force cold", () => {
  assert.equal(canUseClaudeWarmPool({ preferCold: false, claudeHome: "/gateway/stable/claude-home", claudePluginDirs: [] }), true);
  assert.equal(canUseClaudeWarmPool({ preferCold: false, claudePluginEphemeral: true }), false);
});

test("--disallowedTools rides along only when a denial list is given (the memory reviewer's guard)", () => {
  assert.ok(!argsFor().includes("--disallowedTools"));
  const args = argsFor({ disallowedTools: ["Bash", "Write", "Agent"] });
  const i = args.indexOf("--disallowedTools");
  assert.ok(i > 0);
  assert.equal(args[i + 1], "Bash,Write,Agent");
  const warm = buildPersistentArgs({ sessionId: "s", isNewSession: true, disallowedTools: ["Bash"] });
  assert.equal(warm[warm.indexOf("--disallowedTools") + 1], "Bash");
  assert.ok(!buildPersistentArgs({ sessionId: "s", isNewSession: true }).includes("--disallowedTools"));
});
