// Real image validation, without provider credentials or a model call. Live conversational
// acceptance remains separate in TEST-PLAN.md. All CLI execution occurs inside a test container.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const live = process.env.CG_LIVE_PLUGIN_CONTAINER === "1";

test("live: compiled plugins validate and their MCP server works inside the channel image", { skip: !live, timeout: 120_000 }, async () => {
  const { __setContainerRuntime, __resetContainerRuntime, bootContainerRuntime, stopContainerRuntime, containerBackend } = await import("../src/runtimes/container/index.js");
  const { resolveRuntime } = await import("../src/runtimes/resolve.js");
  const { importSkillTree } = await import("../src/gateway/skills/import-folder.js");
  const { createRunGrantArtifacts } = await import("../src/gateway/run-grant-artifacts.js");
  const settings = { enabled: true, defaultBackend: "container", cli: "auto", image: process.env.CG_LIVE_IMAGE || "channelgate/runtime:latest", idleMinutes: 10, maxRunning: 8, pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true };
  const runtime = __setContainerRuntime({ log: () => {} });
  const boot = await bootContainerRuntime({ settings, log: () => {} });
  stopContainerRuntime();
  assert.equal(boot.cli.ok, true, "container CLI required for opted-in test");
  assert.equal(boot.image.present, true, "built channel image required for opted-in test");
  const slug = `cg-plugin-${randomBytes(4).toString("hex")}`;
  const meta = { platform: "slack", channelId: "C-PLUGIN-FIXTURE", allowBash: true, adminMode: true };
  const target = resolveRuntime(slug, meta, { settings });
  let artifacts;
  try {
    const imported = await importSkillTree(new URL("./fixtures/plugins/", import.meta.url).pathname);
    assert.deepEqual(imported.errors, []);
    artifacts = await createRunGrantArtifacts({ slug, meta, sharedSkills: ["fixture-portable-plugin", "fixture-native-plugin"], allowBypass: true, target });
    assert.equal(artifacts.pluginRuntime.claude.error, undefined);
    await containerBackend.ensureUp(target, {});
    const exec = async (args) => {
      const result = await runtime.exec.runExec(target, [target.container.name, ...args], { retry: false, timeoutMs: 60_000 });
      assert.equal(result.code, 0, String(result.stderr || result.stdout));
      return String(result.stdout || "");
    };
    for (const directory of artifacts.pluginRuntime.claude.dirs) {
      const out = await exec(["claude", "plugin", "validate", directory]);
      assert.match(out, /valid|passed/i);
    }
    const server = artifacts.pluginRuntime.claude.servers[0].definition;
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "plugin_echo", arguments: { value: "CONTAINER-42" } } },
    ];
    const code = `const {execFileSync}=require('node:child_process');process.stdout.write(execFileSync(${JSON.stringify(server.command)},${JSON.stringify(server.args)},{input:${JSON.stringify(requests.map((r) => JSON.stringify(r)).join("\n") + "\n")}}))`;
    assert.match(await exec(["node", "-e", code]), /PLUGIN-ECHO:CONTAINER-42/);
  } finally {
    await artifacts?.cleanup();
    await containerBackend.destroy(target, { volumes: true });
    __resetContainerRuntime();
  }
});
