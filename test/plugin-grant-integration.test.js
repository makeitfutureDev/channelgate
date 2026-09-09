import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { createRunGrantArtifacts } = await import("../src/gateway/run-grant-artifacts.js");
const { buildEngineMcpRuntime } = await import("../src/gateway/run-engine-mcp.js");
const { putSkillRevision, approveRevision, pinSkill } = await import("../src/gateway/skills/catalog.js");
const { buildPluginSkill } = await import("../src/gateway/skills/plugin-package.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");
const backend = createFakeRuntimeBackend();
const meta = { platform: "slack", allowBash: true };
const artifacts = (slug, sharedSkills = [], userSkills = []) => createRunGrantArtifacts({ slug, meta, sharedSkills, userSkills, target: fakeTarget(backend, slug, meta) });
const packageFiles = (name, version = "one") => buildPluginSkill([
  { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name, description: "Granted integration package" }) },
  { path: "skills/example/SKILL.md", content: `---\nname: example\ndescription: Package ${version}\n---\n${version}\n` },
  { path: ".mcp.json", content: JSON.stringify({ mcpServers: { lookup: { type: "http", url: "https://example.com/mcp" } } }) },
]);

test("approval, package revision updates, pin rollback and revocation control both engine artifacts", async (t) => {
  const slug = "pkg-lifecycle";
  const first = putSkillRevision({ slug, files: packageFiles(slug), status: "staged" });
  const runs = [];
  t.after(async () => { for (const run of runs) await run.cleanup(); });
  const launch = async (grants = [slug]) => { const run = await artifacts("pkg-channel", grants); runs.push(run); return run; };
  const staged = await launch();
  assert.deepEqual(staged.pluginRuntime.claude.dirs, []);
  assert.deepEqual(staged.pluginRuntime.codex.skills, []);
  approveRevision(first.revision.id);
  const approved = await launch();
  assert.equal(approved.pluginRuntime.claude.dirs.length, 1);
  assert.equal(approved.pluginRuntime.codex.skills.length, 1);
  assert.equal(approved.pluginRuntime.codex.servers.length, 1);
  assert.match(await readFile(approved.pluginRuntime.codex.skills[0].path, "utf8"), /one/);
  const native = JSON.parse(await readFile(path.join(approved.pluginRuntime.claude.dirs[0], ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(native.mcpServers, undefined, "native discovery cannot bypass the selected MCP runtime");
  const settings = JSON.parse(await readFile(approved.settingsFile, "utf8"));
  assert.ok(settings.allowedMcpServers.some((s) => s.serverName === approved.pluginRuntime.claude.servers[0].name));
  const mcp = await buildEngineMcpRuntime({ engine: "claude", target: fakeTarget(backend, "pkg-channel", meta), pluginRuntime: approved.pluginRuntime, slug: "pkg-channel", channelId: "C_PACKAGE", authorId: "U_PACKAGE", threadKey: "C_PACKAGE:123", origin: "slack_foreground" });
  assert.equal(JSON.parse(mcp.mcpConfigJson).mcpServers[approved.pluginRuntime.claude.servers[0].name].url, "https://example.com/mcp");
  putSkillRevision({ slug, files: packageFiles(slug, "two") });
  const updated = await launch();
  assert.notEqual(updated.pluginRuntime.claude.dirs[0], approved.pluginRuntime.claude.dirs[0]);
  assert.match(await readFile(updated.pluginRuntime.codex.skills[0].path, "utf8"), /two/);
  pinSkill(slug, first.revision.revisionNo);
  const rollback = await launch();
  assert.equal(rollback.pluginRuntime.claude.dirs[0], approved.pluginRuntime.claude.dirs[0]);
  const revoked = await launch([]);
  assert.deepEqual(revoked.pluginRuntime.claude.dirs, []);
  assert.deepEqual(revoked.pluginRuntime.codex.skills, []);
  assert.deepEqual(revoked.pluginRuntime.codex.servers, []);
});

test("personal packages stay in ephemeral run artifacts and channel targets use separate paths", async (t) => {
  const slug = "pkg-private";
  putSkillRevision({ slug, files: packageFiles(slug), visibility: "personal", createdBy: "U_PRIVATE" });
  const personal = await artifacts("pkg-author-channel", [], [slug]);
  const other = await artifacts("pkg-author-channel");
  const channelB = await artifacts("pkg-other-channel", [], [slug]);
  t.after(async () => { await personal.cleanup(); await other.cleanup(); await channelB.cleanup(); });
  assert.equal(personal.claudePluginEphemeral, true);
  assert.match(personal.pluginRuntime.claude.dirs[0], /\/runs\/grants-/);
  assert.deepEqual(other.pluginRuntime.claude.dirs, []);
  assert.deepEqual(other.pluginRuntime.codex.skills, []);
  assert.notEqual(personal.artifactRoot, channelB.artifactRoot);
  for (const run of [personal, channelB]) for (const engine of ["claude", "codex"]) {
    for (const skill of run.pluginRuntime[engine].skills) assert.ok(skill.path.startsWith(`${run.artifactRoot}/`));
  }
  const personalPath = personal.pluginRuntime.codex.skills[0].path;
  await personal.cleanup();
  await assert.rejects(access(personalPath), { code: "ENOENT" });
});

test("tampered compiled package bytes are restored from the approved revision", async (t) => {
  const slug = "pkg-tamper";
  putSkillRevision({ slug, files: packageFiles(slug) });
  const original = await artifacts("pkg-tamper-channel", [slug]);
  t.after(() => original.cleanup());
  const file = original.pluginRuntime.codex.skills[0].path;
  const expected = await readFile(file, "utf8");
  await writeFile(file, "tampered instructions");
  const next = await artifacts("pkg-tamper-channel", [slug]);
  t.after(() => next.cleanup());
  assert.equal(next.pluginRuntime.codex.error, undefined);
  assert.equal(await readFile(next.pluginRuntime.codex.skills[0].path, "utf8"), expected);
});

test("two catalog packages cannot collide in the native plugin namespace", async (t) => {
  putSkillRevision({ slug: "collision-one", files: packageFiles("shared-native-name") });
  putSkillRevision({ slug: "collision-two", files: packageFiles("shared-native-name") });
  const run = await artifacts("pkg-collision-channel", ["collision-one", "collision-two"]);
  t.after(() => run.cleanup());
  assert.match(run.pluginRuntime.claude.error, /same plugin name/);
  assert.deepEqual(run.pluginRuntime.claude.dirs, []);
});

for (const mode of ["inline", "file"]) test(`dual-manifest packages select each engine's ${mode} MCP configuration`, async (t) => {
  const slug = `pkg-dual-manifest-${mode}`;
  putSkillRevision({ slug, files: buildPluginSkill(["claude", "codex"].flatMap((engine) => {
    const config = { lookup: { url: `https://${engine}.example.com/mcp` } };
    return [{
      path: `.${engine}-plugin/plugin.json`,
      content: JSON.stringify({ name: slug, mcpServers: mode === "inline" ? config : `./config/${engine}.json` }),
    }, ...(mode === "file" ? [{ path: `config/${engine}.json`, content: JSON.stringify({ mcpServers: config }) }] : [])];
  })) });
  const run = await artifacts("pkg-dual-channel", [slug]);
  t.after(() => run.cleanup());
  for (const engine of ["claude", "codex"]) {
    assert.equal(run.pluginRuntime[engine].error, undefined);
    assert.equal(run.pluginRuntime[engine].servers.length, 1);
    assert.equal(run.pluginRuntime[engine].servers[0].definition.url, `https://${engine}.example.com/mcp`);
  }
  assert.deepEqual(run.pluginRuntime.codex.dirs, [], "Codex still receives no native plugin directory");
  if (mode === "file") for (const engine of ["claude", "codex"]) {
    await assert.rejects(access(path.join(run.pluginRuntime.claude.dirs[0], "config", `${engine}.json`)), { code: "ENOENT" });
  }
});
