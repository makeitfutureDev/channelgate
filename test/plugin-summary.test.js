import test from "node:test";
import assert from "node:assert/strict";
import { pluginBadge, pluginSummary } from "../public/plugin-summary.js";

test("plugin review shows component paths and declared engines without exposing raw connection config", () => {
  const item = { plugin: { kind: "plugin", engines: ["claude", "codex", "<script>"], components: { skills: ["skills"], hooks: ["hooks/<img>.json"], mcpServers: [".mcp.json"] }, manifest: { token: "secret-value" } } };
  const html = pluginSummary(item);
  assert.match(pluginBadge(item), />Plugin</);
  assert.match(html, /Claude, Codex/);
  assert.match(html, /Skills<\/dt><dd><code>skills/);
  assert.match(html, /hooks\/&lt;img&gt;.json/);
  assert.match(html, /MCP servers/);
  assert.match(html, /accounts and credentials must be configured separately/);
  assert.doesNotMatch(html, /<img>|<script>|secret-value/);
});

test("plain skills have no plugin presentation and metadata fallback is supported", () => {
  assert.equal(pluginBadge({ slug: "plain" }), "");
  assert.equal(pluginSummary({ meta: { plugin: "invalid" } }), "");
  assert.match(pluginSummary({ meta: { plugin: { kind: "plugin" } } }), /Unknown/);
});

test("API metadata summary removes unknown fields and non-string component payloads", async () => {
  const { pluginSummaryFromMetadata } = await import("../src/gateway/skills/plugin-summary.js");
  const summary = pluginSummaryFromMetadata({ plugin: { kind: "plugin", name: "test", engines: ["claude", "unknown"], manifestPath: ".claude-plugin/plugin.json", headers: { Authorization: "secret" }, env: { TOKEN: "secret" }, components: { hooks: ["hooks.json", { command: "secret" }], mcpServers: { env: "secret" }, apps: [".apps.json"], unknown: ["secret"] } } });
  assert.deepEqual(summary.engines, ["claude"]);
  assert.deepEqual(summary.components.hooks, ["hooks.json"]);
  assert.deepEqual(summary.components.mcpServers, []);
  assert.deepEqual(summary.components.apps, [".apps.json"]);
  assert.doesNotMatch(JSON.stringify(summary), /secret|headers|TOKEN|unknown/);
  assert.equal(pluginSummaryFromMetadata({}), undefined);
});
