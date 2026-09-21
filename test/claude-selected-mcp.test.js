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
const servers = async (picks, opts) => (await resolveClaudeMcpConfig(picks, opts)).servers;

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
  assert.deepEqual(await servers([pick("echo")], opts), { echo: { ...stdio, args: ["local arg with spaces"] } });
  delete user.projects;
  await writeFile(opts.configFile, JSON.stringify(user));
  assert.deepEqual((await servers([pick("echo")], opts)).echo.args, ["project"]);
  await rm(path.join(opts.discoveryCwd, ".mcp.json"));
  assert.deepEqual(await servers([pick("echo")], opts), { echo: stdio });
  user.mcpServers.echo.env = { HOST_SECRET: "must-not-copy" };
  await writeFile(opts.configFile, JSON.stringify(user));
  const credentialed = await resolveClaudeMcpConfig([pick("echo")], opts);
  assert.deepEqual(credentialed.servers, {}, "a credential-bearing definition is never relayed");
  assert.deepEqual(credentialed.rejected.map((r) => r.name), ["echo"]);
  assert.match(credentialed.rejected[0].reason, /host credentials/);
  assert.ok(!/must-not-copy|HOST_SECRET/.test(JSON.stringify(credentialed)), "a rejection never carries the config value");
});

test("Claude selected names, stale URL grants and unavailable definitions are dropped, never fatal", async () => {
  const opts = await config("selected-invalid");
  await writeFile(opts.configFile, JSON.stringify({ mcpServers: { echo: stdio, web: { type: "http", url: "https://new.example.test/mcp" }, gateway: stdio } }));
  // Each unusable shape is dropped with its own category reason instead of ending the turn, and a
  // healthy sibling in the SAME selection still reaches the payload.
  const cases = [
    [pick("gateway"), /reserved or invalid/],
    [pick("composio-agent"), /reserved or invalid/],
    [pick("makeitfuture-toolbox"), /reserved or invalid/],
    [pick("__proto__"), /reserved or invalid/],
    [pick("constructor"), /reserved or invalid/],
    [pick("bad\nname"), /reserved or invalid/],
    [pick("missing"), /not defined in/],
    [{ name: "web", namespace: "mcp__web", match: { serverUrl: "https://old.example.test/mcp" } }, /no longer matches/],
    [{ ...pick("echo"), namespace: "mcp__gateway" }, /tool namespace/],
  ];
  for (const [entry, reason] of cases) {
    const result = await resolveClaudeMcpConfig([entry, pick("echo")], opts);
    assert.deepEqual(Object.keys(result.servers), ["echo"], JSON.stringify(entry));
    assert.equal(result.rejected.length, 1, JSON.stringify(entry));
    assert.match(result.rejected[0].reason, reason);
    assert.ok(!Object.hasOwn(result.servers, "__proto__") && Object.getPrototypeOf(result.servers) === Object.prototype);
  }
  await writeFile(opts.configFile, '{"private":"do-not-print",broken');
  const unreadable = await resolveClaudeMcpConfig([pick("echo")], opts);
  assert.deepEqual(unreadable.servers, {}, "a corrupt operator config admits nothing");
  assert.match(unreadable.rejected[0].reason, /could not be read/);
  assert.ok(!/private|do-not-print|selected-invalid/.test(JSON.stringify(unreadable)), "no config bytes or paths are disclosed");
  assert.deepEqual(await resolveClaudeMcpConfig([], opts), { servers: {}, rejected: [] }, "no grant never loads an ambient config");
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
    // An unusable selection never ends the turn: the credentialed server is dropped from the
    // payload, the healthy one still launches, and the author is told which was skipped.
    await writeFile(file, JSON.stringify({ mcpServers: { echo: stdio, leaky: { type: "http", url: "https://leaky.example.test/mcp", headers: { Authorization: "must-not-copy" } } } }));
    await patchChannelMeta(entry.slug, { allowedMcps: [pick("echo"), pick("leaky")] });
    const dropped = await runMessage(input);
    assert.match(dropped.content, /Skipped MCP connection: `leaky`/);
    assert.match(dropped.content, /host credentials/);
    assert.ok(!/must-not-copy/.test(dropped.content));
    await patchChannelMeta(entry.slug, { allowedMcps: [] });
    await runMessage(input);
    assert.equal(actual.length, 6);
    assert.deepEqual(actual[4].config.mcpServers.echo, stdio, "the healthy sibling still launched");
    assert.equal(actual[4].config.mcpServers.leaky, undefined, "a credentialed selection never reaches the payload");
    for (const call of actual) {
      assert.ok(call.args.includes("--strict-mcp-config"));
      assert.equal(call.args[call.args.indexOf("--setting-sources") + 1], "");
      assert.equal(call.config.mcpServers.ambient, undefined);
    }
    assert.equal(actual[0].config.mcpServers.echo, undefined);
    assert.deepEqual(actual[1].config.mcpServers.echo, stdio);
    assert.deepEqual(actual[2].config.mcpServers.echo, stdio);
    assert.deepEqual(actual[3].config.mcpServers.echo.args, ["/workspace/v2.mjs"]);
    assert.equal(actual[5].config.mcpServers.echo, undefined);
    assert.ok(actual[2].args.includes("-r"), "the grant remains available in an actual resumed launch");
  } finally {
    await useFakeRuntime(null);
    if (before === null) await rm(file, { force: true }); else await writeFile(file, before);
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
});
