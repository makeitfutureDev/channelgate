import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { buildPluginSkill, parsePluginPackage } = await import("../src/gateway/skills/plugin-package.js");
const { compilePluginPackage, pluginServerName, relocatePluginServers, pluginSkillCatalog, requirePluginRuntime } = await import("../src/gateway/plugin-runtime.js");

const claude = { manifest: "claude", components: ["skills", "commands", "agents", "hooks", "mcpServers"] };
const codex = { manifest: "", components: ["skills", "mcpServers"] };
const skill = "---\nname: proof\ndescription: Synthetic package proof\n---\nUse the proof fixture.";
function pkg(manifest = {}, extra = []) {
  return { slug: "package-proof", descriptor: parsePluginPackage(buildPluginSkill([
    { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name: "package-proof", ...manifest }) },
    { path: "skills/proof/SKILL.md", content: skill }, ...extra,
  ])) };
}
function compile(manifest = {}, extra = [], options = {}) {
  return compilePluginPackage(pkg(manifest, extra), { capabilities: claude, writable: true, ...options });
}
const file = (path, value) => ({ path, content: JSON.stringify(value) });

test("approved package compiler keeps native components and restricts skill catalogs to declared roots", () => {
  const compiled = compile({}, [{ path: "docs/SKILL.md", content: skill }]);
  assert.equal(compiled.native, true);
  const native = JSON.parse(compiled.files.find((f) => f.path === ".claude-plugin/plugin.json").content);
  assert.deepEqual(native.skills, ["./skills"]);
  assert.equal(native.mcpServers, undefined);
  assert.deepEqual(pluginSkillCatalog(compiled, "/artifact/package").map((s) => s.path), ["/artifact/package/skills/proof/SKILL.md"]);
  const portable = compile({}, [], { capabilities: codex });
  assert.equal(portable.native, false);
  assert.equal(portable.files.some((f) => f.path.endsWith("plugin.json")), false);
  assert.equal(portable.skillFiles[0].name, "package-proof:proof");
});

test("native agents enumerate Markdown files and cannot shadow the gateway plugin namespace", () => {
  const compiled = compile({}, [{ path: "agents/inspector.md", content: "Inspect the fixture." }]);
  const native = JSON.parse(compiled.files.find((f) => f.path === ".claude-plugin/plugin.json").content);
  assert.deepEqual(native.agents, ["./agents/inspector.md"]);
  assert.throws(() => compile({ name: "gateway-shared-skills" }), /reserved by the gateway/);
  const custom = compile({ mcpServers: "./config/tools.json" }, [file("config/tools.json", { mcpServers: { fixture: { url: "https://example.test/mcp" } } })]);
  assert.equal(custom.files.some((f) => f.path === "config/tools.json"), false, "source control files cannot activate ambient MCPs");
});

test("hooks require live admin bypass and are declared once without implicit hook files", () => {
  const hooks = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node proof.js" }] }] } };
  const files = [file("hooks/hooks.json", hooks)];
  assert.throws(() => compile({}, files), /hooks require/);
  assert.throws(() => compile({}, files, { capabilities: codex, allowBypass: true }), /hooks are unsupported/);
  const compiled = compile({}, files, { allowBypass: true });
  assert.equal(compiled.files.some((f) => f.path === "hooks/hooks.json"), false);
  const native = JSON.parse(compiled.files.find((f) => f.path === ".claude-plugin/plugin.json").content);
  assert.deepEqual(native.hooks, hooks);
  assert.throws(() => compile({ hooks: { Stop: "bad" } }, [], { allowBypass: true }), /invalid hook event/);
});

test("unsupported components and ambient settings fail closed", () => {
  for (const [component, path] of [["commands", "commands/proof.md"], ["agents", "agents/proof.md"]]) {
    assert.throws(() => compile({}, [{ path, content: "proof" }], { capabilities: codex }), new RegExp(`${component} are unsupported`));
  }
  for (const [component, path] of [["apps", ".apps.json"], ["lspServers", ".lsp.json"]]) {
    assert.throws(() => compile({}, [file(path, {})]), new RegExp(`${component} are unsupported`));
  }
  for (const path of ["settings.json", ".claude/settings.json", ".codex/config.toml"]) {
    assert.throws(() => compile({}, [{ path, content: "{}" }]), /settings overrides are unsupported/);
  }
  assert.throws(() => compile({ settings: { permissions: {} } }), /settings overrides are unsupported/);
});

test("MCP servers are namespaced, removed from native discovery, and refuse duplicate names", () => {
  const result = compile({ mcpServers: { proof: { type: "http", url: "https://example.test/mcp" } } });
  assert.equal(result.servers[0].name, pluginServerName("package-proof", "proof"));
  assert.notEqual(pluginServerName("a-b", "proof"), pluginServerName("a_b", "proof"));
  assert.notEqual(pluginServerName("package-proof", "proof"), pluginServerName("package-proof", "other"));
  const native = JSON.parse(result.files.find((f) => f.path === ".claude-plugin/plugin.json").content);
  assert.equal(native.mcpServers, undefined);
  const external = compile({}, [file(".mcp.json", { mcpServers: { proof: { url: "https://example.test/mcp" } } })]);
  assert.equal(external.files.some((f) => f.path === ".mcp.json"), false);
  assert.throws(() => compile({ mcpServers: { proof: { url: "https://example.test/mcp" } } },
    [file(".mcp.json", { proof: { url: "https://example.test/other" } })]), /duplicate MCP/);
});

test("MCP executable transports require writable mode and expand only package root placeholders", () => {
  const definition = { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "--label", "reviewed fixture"] };
  assert.throws(() => compile({ mcpServers: { proof: definition } }, [], { writable: false }), /Worker or Full-access/);
  const compiled = compile({ mcpServers: { proof: definition } });
  const relocated = relocatePluginServers(compiled.servers, "/artifact/package");
  assert.deepEqual(relocated[0].definition.args, ["/artifact/package/server.js", "--label", "reviewed fixture"]);
  assert.equal(compiled.servers[0].definition.args[0], "${CLAUDE_PLUGIN_ROOT}/server.js");
  assert.throws(() => relocatePluginServers([{ plugin: "proof", sourceName: "proof", definition: { command: "$HOME/server" } }], "/artifact/package"), /separately configured connection/);
});

test("source authentication, invalid transports, and ambiguous definitions require selected connections", () => {
  const definitions = [
    { url: "https://example.test/mcp", headers: { Authorization: "Bearer fixture" } },
    { url: "https://example.test/mcp", bearer_token_env_var: "TOKEN" },
    { url: "https://example.test/mcp?token=fixture" },
    { url: "https://example.test/mcp#fixture" },
    { url: "https://fixture:fixture@example.test/mcp" },
    { url: "file:///tmp/server" },
    { url: "https://example.test/${TOKEN}" },
    { url: "https://example.test/mcp", type: "sse" },
    { url: "https://example.test/mcp", command: "node" },
    { command: "node", env: { TOKEN: "fixture" } },
    { command: "node", args: ["server.js", "--api-key=fixture"] },
    { command: "node", args: ["server.js", "--token", "fixture"] },
    { command: "node", args: ["${TOKEN}"] },
    { command: "node", args: [123] },
    { command: "node", args: "server.js" },
    { command: "node", args: ["bad\nvalue"] },
    { command: "node", transport: { command: "other" } },
    null, [], "https://example.test/mcp",
  ];
  for (const definition of definitions) {
    const compiled = compile({ mcpServers: { proof: definition } });
    assert.equal(compiled.servers[0].definition, null, JSON.stringify(definition));
  }
});

test("runtime compiler failures propagate rather than silently loading partial packages", () => {
  assert.throws(() => requirePluginRuntime({ codex: { error: "unsupported package" } }, "codex"), /unsupported package/);
  assert.deepEqual(requirePluginRuntime(null, "codex"), { dirs: [], skills: [], servers: [] });
});
