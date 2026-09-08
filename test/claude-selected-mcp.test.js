import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";
import { resolveClaudeMcpConfig, safeClaudeMcpDefinition } from "../src/engines/claude-mcp.js";

const scratch = ensureTestEnv();
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "selected-mcp-workspaces");
const pick = (name) => ({ name, namespace: "mcp__" + name.replace(/[^a-zA-Z0-9]+/g, "_"), match: { serverName: name } });
const stdio = { type: "stdio", command: "node", args: ["/workspace/echo.mjs"] };

async function config(name) {
  const dir = path.join(scratch, name);
  await mkdir(dir, { recursive: true });
  return { configFile: path.join(dir, ".claude.json"), discoveryCwd: dir };
}

test("Claude transport extraction rejects credentials, interpolation, malformed and unknown options", () => {
  assert.deepEqual(safeClaudeMcpDefinition({ ...stdio, env: {}, headers: {} }), stdio);
  for (const type of ["http", "sse"]) assert.deepEqual(safeClaudeMcpDefinition({ type, url: "https://example.test/mcp" }), { type, url: "https://example.test/mcp" });
  const bad = [
    { env: { API_KEY: "private" } }, { headers: { Authorization: "private" } },
    { oauth: {} }, { headersHelper: "credential-helper" }, { http_headers_helper: "credential-helper" },
    { bearer_token_env_var: "HOST_TOKEN" }, { env: [] }, { args: [1] }, { args: "--api-key private" },
    { args: ["--api-key", "private"] }, { args: ["--token=private"] }, { args: ["${HOST_TOKEN}"] },
    { command: "${HOST_COMMAND}" }, { disabled: true }, { type: "unknown" },
  ];
  for (const extra of bad) assert.equal(safeClaudeMcpDefinition({ ...stdio, ...extra }), null, JSON.stringify(extra));
  for (const url of ["https://u:secret@example.test/mcp", "https://example.test/mcp?token=secret", "https://example.test/mcp#secret", "file:///secret", "https://${HOST}/mcp"])
    assert.equal(safeClaudeMcpDefinition({ type: "http", url }), null);
});

test("Claude selected scopes use fresh bytes and preserve exact args without copying unselected config", async () => {
  const opts = await config("selected-scopes");
  const user = { unrelatedCredential: "must-not-copy", mcpServers: { echo: structuredClone(stdio), unselected: { command: "never" } }, projects: { [opts.discoveryCwd]: { mcpServers: { echo: { ...stdio, args: ["local arg with spaces"] } } } } };
  await writeFile(opts.configFile, JSON.stringify(user));
  await writeFile(path.join(opts.discoveryCwd, ".mcp.json"), JSON.stringify({ mcpServers: { echo: { ...stdio, args: ["project"] } } }));
  assert.deepEqual(await resolveClaudeMcpConfig([pick("echo")], opts), { echo: { ...stdio, args: ["local arg with spaces"] } });
  delete user.projects;
  await writeFile(opts.configFile, JSON.stringify(user));
  assert.deepEqual((await resolveClaudeMcpConfig([pick("echo")], opts)).echo.args, ["project"]);
  await rm(path.join(opts.discoveryCwd, ".mcp.json"));
  assert.deepEqual(await resolveClaudeMcpConfig([pick("echo")], opts), { echo: stdio });
  user.mcpServers.echo.env = { HOST_SECRET: "must-not-copy" };
  await writeFile(opts.configFile, JSON.stringify(user));
  await assert.rejects(resolveClaudeMcpConfig([pick("echo")], opts), /no safe matching transport/);
});

test("Claude selected names, stale URL grants and unavailable definitions fail closed", async () => {
  const opts = await config("selected-invalid");
  await writeFile(opts.configFile, JSON.stringify({ mcpServers: { echo: stdio, web: { type: "http", url: "https://new.example.test/mcp" }, gateway: stdio } }));
  for (const name of ["gateway", "composio-agent", "makeitfuture-toolbox", "__proto__", "constructor", "bad\nname"])
    await assert.rejects(resolveClaudeMcpConfig([pick(name)], opts), /invalid or reserved/);
  await assert.rejects(resolveClaudeMcpConfig([pick("missing")], opts), /no safe matching transport/);
  await assert.rejects(resolveClaudeMcpConfig([{ name: "web", namespace: "mcp__web", match: { serverUrl: "https://old.example.test/mcp" } }], opts), /no safe matching transport/);
  await assert.rejects(resolveClaudeMcpConfig([{ ...pick("echo"), namespace: "mcp__gateway" }], opts), /no safe matching transport/);
  await writeFile(opts.configFile, '{"private":"do-not-print",broken');
  await assert.rejects(resolveClaudeMcpConfig([pick("echo")], opts), (error) => /could not be read safely/.test(error.message) && !/private|do-not-print|selected-invalid/.test(error.message));
  assert.deepEqual(await resolveClaudeMcpConfig([], opts), {}, "no grant never loads an ambient config");
});

test("actual Claude launches keep settings isolation while grants add, resume, change and revoke", async () => {
  const { useFakeRuntime, createFakeRuntimeBackend } = await import("./runtime-fake.js");
  const { setUser, upsertChannelEntry, saveChannelMeta, patchChannelMeta } = await import("../src/config/store.js");
  const { saveSettings } = await import("../src/config/settings.js");
  const { runMessage } = await import("../src/gateway/run.js");
  const { operatorClaudeConfigDir } = await import("../src/gateway/claude-login.js");
  const file = path.join(operatorClaudeConfigDir(), ".claude.json");
  const before = await readFile(file, "utf8").catch(() => null);
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = operatorClaudeConfigDir();
  const backend = createFakeRuntimeBackend();
  const spawn = backend.spawn;
  const actual = [];
  backend.spawn = (target, spec) => {
    const args = spec.args || [];
    if (spec.cmd === "claude" && args.includes("--mcp-config")) {
      actual.push({ args: [...args], config: JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")) });
    }
    return spawn(target, spec);
  };
  await useFakeRuntime(backend);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { echo: stdio, ambient: { command: "never" } } }));
    saveSettings({ engine: "claude", engineFallback: false, agentMemory: false, memoryReviewEvery: 0, composioMode: "personal" });
    await setUser("U_PICKED_MCP", { name: "MCP fixture", approved: true });
    const entry = await upsertChannelEntry("C_PICKED_MCP", { name: "picked-mcp", type: "channel" });
    await saveChannelMeta(entry.slug, { channelId: "C_PICKED_MCP", name: "picked-mcp", type: "channel", engine: "claude", memory: false, allowedMcps: [] });
    const input = { channelId: "C_PICKED_MCP", authorId: "U_PICKED_MCP", threadKey: "picked.1", origin: "slack_foreground", preferCold: true, text: "List available tools." };
    await runMessage(input);
    await patchChannelMeta(entry.slug, { allowedMcps: [pick("echo")] });
    await runMessage(input);
    await runMessage(input);
    await writeFile(file, JSON.stringify({ mcpServers: { echo: { ...stdio, args: ["/workspace/v2.mjs"] } } }));
    await runMessage(input);
    await patchChannelMeta(entry.slug, { allowedMcps: [] });
    await runMessage(input);
    assert.equal(actual.length, 5);
    for (const call of actual) {
      assert.ok(call.args.includes("--strict-mcp-config"));
      assert.equal(call.args[call.args.indexOf("--setting-sources") + 1], "");
      assert.equal(call.config.mcpServers.ambient, undefined);
    }
    assert.equal(actual[0].config.mcpServers.echo, undefined);
    assert.deepEqual(actual[1].config.mcpServers.echo, stdio);
    assert.deepEqual(actual[2].config.mcpServers.echo, stdio);
    assert.deepEqual(actual[3].config.mcpServers.echo.args, ["/workspace/v2.mjs"]);
    assert.equal(actual[4].config.mcpServers.echo, undefined);
    assert.ok(actual[2].args.includes("-r"), "the grant remains available in an actual resumed launch");
  } finally {
    await useFakeRuntime(null);
    if (before === null) await rm(file, { force: true }); else await writeFile(file, before);
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});
