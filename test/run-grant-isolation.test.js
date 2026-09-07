import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const gatewayRoot = ensureTestEnv();
const { assertUserSkillOverlaySupported, createRunGrantArtifacts, CONTAINER_AGENT_HOME } = await import("../src/gateway/run-grant-artifacts.js");
const { ensureChannelFolder } = await import("../src/gateway/folders.js");
const { channelSettingsFile, runTmpDir, workspaceFolder } = await import("../src/config/paths.js");
const { localRuntimeTarget } = await import("../src/engines/runtime-target.js");
const { createFakeRuntimeBackend, fakeTarget } = await import("./runtime-fake.js");

// Every run's engine-facing files live under the channel's artifact dir, which the container
// backend bind-mounts at the identical absolute path — and the RuntimeTarget is what names it.
// The fake backend supplies exactly the target production would, minus the container.
const backend = createFakeRuntimeBackend();
const targetFor = (slug, meta = {}) => fakeTarget(backend, slug, meta);
const grants = (options) => createRunGrantArtifacts({ ...options, target: options.target ?? targetFor(options.slug, options.meta || {}) });

const absent = async (file) => {
  try { await access(file); return false; } catch { return true; }
};

test("engines without a native isolated skill mechanism fail closed", () => {
  assert.throws(
    () => assertUserSkillOverlaySupported({ label: "Unsupported", supports: { userSkillOverlay: false } }, ["private"]),
    /cannot isolate per-user skill grants/i,
  );
  assert.doesNotThrow(() => assertUserSkillOverlaySupported({ supports: { userSkillOverlay: false } }, []));
});

test("every engine run uses the run's own engine homes instead of host-global config or state", async () => {
  const source = await readFile(new URL("../src/gateway/run.js", import.meta.url), "utf8");
  // The homes the runners receive are the ones the grant artifacts named (the image's, inside the
  // channel's HOME volume) — never the daemon's synthetic engine home or the operator's own.
  assert.match(source, /claudeHome:\s*grantArtifacts\.claudeHome/);
  assert.match(source, /claudeConfigDir:\s*grantArtifacts\.claudeConfigDir/);
  assert.match(source, /codexStateDir:\s*grantArtifacts\.codexStateDir/);
});

test("clean run artifacts expose no optional MCP or user skill tier", async (t) => {
  const slug = `clean-grants-${Date.now()}`;
  const cleanWorkspace = await ensureChannelFolder(slug, {}, { runMeta: { cleanMode: true } });
  const artifacts = await grants({
    slug,
    meta: {
      cleanMode: true,
      allowedMcps: [{ name: "private", namespace: "mcp__private", match: { serverName: "private" } }],
    },
    userSkills: [],
    sharedSkills: [],
    workspaceSkillsDir: path.join(cleanWorkspace.cwd, ".claude", "skills"),
    needsClaudeSettings: true,
  });
  t.after(() => artifacts.cleanup());

  assert.equal(artifacts.claudePluginDirs.length, 1);
  assert.ok(!(await absent(path.join(artifacts.claudePluginDirs[0], "skills", "gateway-usage", "SKILL.md"))));
  assert.ok(await absent(path.join(artifacts.claudePluginDirs[0], "skills", "private")));
  // Codex uses a prompt catalog rather than a native HOME discovery overlay. Clean has none.
  assert.equal(artifacts.codexSkillSupportDir, "");
  assert.deepEqual(artifacts.personalSkillCatalog, []);
  const settings = JSON.parse(await readFile(artifacts.settingsFile, "utf8"));
  assert.ok(!settings.permissions.allow.includes("mcp__private"));
  assert.ok(!settings.allowedMcpServers.some((entry) => entry?.serverName === "private"));
});

// The per-run settings artifact is what a Claude spawn ACTUALLY loads (it overrides the
// settings-admin.json fallback for every Claude run), so the admin bypass contract must hold HERE.
// Regression: the first admin fix patched only the fallback file, and escalated admin turns kept
// running under the shared file's restrictions in production.
test("escalated run artifact settings omit the bypass key; ordinary artifacts pin it — neither carries a sandbox", async (t) => {
  const slug = `bypass-artifact-${Date.now()}`;
  const workspace = await ensureChannelFolder(slug, { adminMode: true });
  const base = {
    slug,
    meta: { adminMode: true },
    userSkills: [],
    sharedSkills: [],
    workspaceSkillsDir: path.join(workspace.cwd, ".claude", "skills"),
    needsClaudeSettings: true,
  };

  const escalated = await grants({ ...base, allowBypass: true });
  t.after(() => escalated.cleanup());
  const adminSettings = JSON.parse(await readFile(escalated.settingsFile, "utf8"));
  assert.equal("disableBypassPermissionsMode" in adminSettings.permissions, false);

  const ordinary = await grants({ ...base, allowBypass: false });
  t.after(() => ordinary.cleanup());
  const sharedSettings = JSON.parse(await readFile(ordinary.settingsFile, "utf8"));
  assert.equal(sharedSettings.permissions.disableBypassPermissionsMode, "disable");

  // An escalated artifact grants the shell and carries no ask rule: the run it belongs to spawns
  // with --dangerously-skip-permissions, and a file that still routed Bash through the approval
  // card silently demoted those turns to read-only (QA, 2026-09-07). The non-escalated artifact of
  // the same shell-less channel keeps asking.
  assert.ok(adminSettings.permissions.allow.includes("Bash"));
  assert.equal("ask" in adminSettings.permissions, false);
  assert.ok(sharedSettings.permissions.ask.includes("Bash"));
  assert.equal(sharedSettings.permissions.allow.includes("Bash"), false);

  // The bypass key and the shell grant that goes with it are the ONLY differences, and the two are
  // different files: the escalated artifact equals the same channel built WITH the shell.
  assert.notEqual(escalated.settingsFile, ordinary.settingsFile);
  const shellGranted = await grants({ ...base, meta: { adminMode: true, allowBash: true }, allowBypass: false });
  t.after(() => shellGranted.cleanup());
  const shellSettings = JSON.parse(await readFile(shellGranted.settingsFile, "utf8"));
  assert.deepEqual({ ...adminSettings, permissions: { ...adminSettings.permissions, disableBypassPermissionsMode: "disable" } }, shellSettings);
  // Confinement is the container, so an escalated turn is "full tools" inside the same boundary —
  // there is no sandbox to lift, and no host path (the operator's home, the gateway root) for a
  // sandbox block to name. Both files are policy only.
  for (const settings of [adminSettings, sharedSettings]) {
    assert.equal("sandbox" in settings, false);
    const rendered = JSON.stringify(settings);
    assert.equal(rendered.includes(os.homedir()), false);
    assert.equal(rendered.includes(gatewayRoot), false);
  }
});

// The per-run copy is what a Claude spawn actually loads, so the read-mode "no shell without an
// approval card" rule has to hold in the artifact, not just in the channel file. It is
// content-addressed, so flipping the shell grant must also move it to a different digest — a warm
// process cannot keep reading yesterday's permissions.
test("the per-run settings copy carries the Bash ask rule, and granting the shell changes its digest", async (t) => {
  const slug = `ask-bash-artifact-${Date.now()}`;
  const workspace = await ensureChannelFolder(slug, {});
  const base = {
    slug,
    userSkills: [],
    sharedSkills: [],
    workspaceSkillsDir: path.join(workspace.cwd, ".claude", "skills"),
    needsClaudeSettings: true,
  };

  const readRun = await grants({ ...base, meta: {} });
  t.after(() => readRun.cleanup());
  const readSettings = JSON.parse(await readFile(readRun.settingsFile, "utf8"));
  assert.ok(readSettings.permissions.ask.includes("Bash"));
  assert.equal(readSettings.permissions.allow.includes("Bash"), false);

  const bashRun = await grants({ ...base, meta: { allowBash: true } });
  t.after(() => bashRun.cleanup());
  const bashSettings = JSON.parse(await readFile(bashRun.settingsFile, "utf8"));
  assert.ok(bashSettings.permissions.allow.includes("Bash"));
  assert.equal((bashSettings.permissions.ask || []).includes("Bash"), false);

  // Different permissions ⇒ different content ⇒ a different content-addressed file.
  assert.notEqual(path.basename(readRun.settingsFile), path.basename(bashRun.settingsFile));
});

test("concurrent users get private settings/plugins without mutating the shared channel tree", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-run-grants-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previousSources = process.env.GATEWAY_SKILL_SOURCES;
  const previousWorkspace = process.env.CG_WORKSPACE_DIR;
  t.after(() => {
    if (previousSources == null) delete process.env.GATEWAY_SKILL_SOURCES;
    else process.env.GATEWAY_SKILL_SOURCES = previousSources;
    if (previousWorkspace == null) delete process.env.CG_WORKSPACE_DIR;
    else process.env.CG_WORKSPACE_DIR = previousWorkspace;
  });

  const sources = path.join(temp, "sources");
  for (const name of ["shared", "user-a", "user-b"]) {
    await mkdir(path.join(sources, name), { recursive: true });
    await writeFile(path.join(sources, name, "SKILL.md"), `# ${name}\n`);
  }
  process.env.GATEWAY_SKILL_SOURCES = sources;
  process.env.CG_WORKSPACE_DIR = path.join(temp, "workspaces");

  const slug = `grant-isolation-${Date.now()}`;
  const sharedMcp = { name: "shared", namespace: "mcp__shared", match: { serverName: "shared" } };
  const durableMeta = { name: "Isolation", skills: ["shared"], allowedMcps: [sharedMcp] };
  await ensureChannelFolder(slug, durableMeta);
  const cleanRun = await ensureChannelFolder(slug, durableMeta, { runMeta: { ...durableMeta, cleanMode: true } });
  assert.equal(cleanRun.cwd, path.join(gatewayRoot, "clean-workspaces", "slack", slug));
  assert.ok(!path.resolve(cleanRun.cwd).startsWith(path.resolve(workspaceFolder(slug)) + path.sep));
  assert.ok(await absent(path.join(cleanRun.cwd, ".claude", "skills", "shared")));

  const userMcp = (name) => ({ name, namespace: `mcp__${name}`, match: { serverName: name } });
  const target = targetFor(slug, durableMeta);
  const [a, b] = await Promise.all([
    createRunGrantArtifacts({ slug, meta: { allowedMcps: [sharedMcp, userMcp("user-a")] }, userSkills: ["user-a"], needsClaudeSettings: true, target }),
    createRunGrantArtifacts({ slug, meta: { allowedMcps: [sharedMcp, userMcp("user-b")] }, userSkills: ["user-b"], needsClaudeSettings: true, target }),
  ]);
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));

  assert.notEqual(a.settingsFile, b.settingsFile);
  // Both land under the channel's artifact dir — the one tree the container mounts — never in the
  // shared run-tmp dir, and never inside the channel's visible work folder.
  assert.ok(path.resolve(a.settingsFile).startsWith(path.resolve(target.artifactDir) + path.sep), a.settingsFile);
  assert.ok(!path.resolve(a.settingsFile).startsWith(path.resolve(runTmpDir()) + path.sep));
  assert.ok(!path.resolve(a.settingsFile).startsWith(path.resolve(workspaceFolder(slug)) + path.sep));
  assert.equal((await stat(path.dirname(a.settingsFile))).mode & 0o777, 0o700);
  assert.equal((await stat(a.settingsFile)).mode & 0o777, 0o600);

  for (const [artifact, own, other] of [[a, "user-a", "user-b"], [b, "user-b", "user-a"]]) {
    const plugin = artifact.claudePluginDirs[0];
    assert.deepEqual(artifact.personalSkillCatalog.map((entry) => entry.name), [own]);
    assert.equal(artifact.personalSkillCatalog[0].path, path.join(plugin, "skills", own, "SKILL.md"));
    assert.ok(!JSON.stringify(artifact.personalSkillCatalog).includes(other), "other author's grant never enters this catalog");
    assert.equal(artifact.codexHome, target.container.codexHome, "persistent auth/session root is unchanged");
    assert.equal(artifact.codexUserHome, target.container.home, "channel CLI HOME is unchanged");
    assert.ok(path.resolve(plugin).startsWith(path.resolve(target.artifactDir) + path.sep), plugin);
    const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "gateway-user-grants");
    assert.equal((await stat(path.join(plugin, ".claude-plugin", "plugin.json"))).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(plugin, "skills", own, "SKILL.md"), "utf8"), `# ${own}\n`);
    assert.ok(await absent(path.join(plugin, "skills", other)));
    assert.equal(artifact.codexSkillSupportDir, "");
  }

  const sharedSkills = path.join(workspaceFolder(slug), ".claude", "skills");
  assert.equal(await readFile(path.join(sharedSkills, "shared", "SKILL.md"), "utf8"), "# shared\n");
  assert.ok(await absent(path.join(sharedSkills, "user-a")));
  assert.ok(await absent(path.join(sharedSkills, "user-b")));
  const sharedSettings = JSON.parse(await readFile(channelSettingsFile(slug), "utf8"));
  assert.ok(sharedSettings.permissions.allow.includes("mcp__shared"));
  assert.ok(!sharedSettings.permissions.allow.includes("mcp__user-a"));
  assert.ok(!sharedSettings.permissions.allow.includes("mcp__user-b"));

  await Promise.all([a.cleanup(), b.cleanup()]);
  assert.ok(!(await absent(a.settingsFile)), "content-addressed settings remain for safe warm reuse");
  assert.ok(!(await absent(b.settingsFile)), "content-addressed settings remain for safe warm reuse");
  assert.ok(await absent(a.personalSkillCatalog[0].path));
  assert.ok(await absent(b.personalSkillCatalog[0].path));
  assert.ok(await absent(a.claudePluginDirs.find((dir) => dir.includes("user-grants-plugin"))));
  assert.ok(await absent(b.claudePluginDirs.find((dir) => dir.includes("user-grants-plugin"))));
  assert.equal(path.resolve(gatewayRoot), path.resolve(process.env.CHANNELGATE_DIR));
});

test("the engine homes are the image's — the operator's own engine state is never read, linked or written", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-engine-state-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const claudeState = path.join(temp, "host-claude");
  const codexState = path.join(temp, "host-codex");
  await mkdir(path.join(claudeState, "projects"), { recursive: true });
  await mkdir(path.join(claudeState, "plugins", "host-plugin"), { recursive: true });
  await mkdir(path.join(claudeState, "skills", "host-skill"), { recursive: true });
  await mkdir(path.join(codexState, "sessions"), { recursive: true });
  await mkdir(path.join(codexState, "skills", "host-skill"), { recursive: true });
  await writeFile(path.join(claudeState, ".credentials.json"), "{}\n");
  await writeFile(path.join(claudeState, "settings.json"), "{}\n");
  await writeFile(path.join(codexState, "auth.json"), "{}\n");
  await writeFile(path.join(codexState, "config.toml"), "model = 'host'\n");
  const listing = async (dir) => (await readdir(dir, { recursive: true })).sort();
  const [claudeBefore, codexBefore] = [await listing(claudeState), await listing(codexState)];

  const oldClaude = process.env.CLAUDE_CONFIG_DIR;
  const oldCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeState;
  process.env.CODEX_HOME = codexState;
  t.after(() => {
    if (oldClaude == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  });

  const artifacts = await grants({ slug: "state-isolation", needsClaudeSettings: true });
  t.after(() => artifacts.cleanup());
  // The homes are IN-CONTAINER paths inside the channel's own HOME volume: the daemon only names
  // them in the child's environment. The login rides in as a relay of the operator's access token
  // (src/gateway/claude-login.js) — the credentials file itself is never copied or linked, since a
  // linked copy became an independent, self-expiring one the first time Claude Code rewrote it.
  assert.equal(artifacts.claudeHome, CONTAINER_AGENT_HOME);
  assert.equal(artifacts.claudeConfigDir, `${CONTAINER_AGENT_HOME}/.claude`);
  assert.equal(artifacts.codexUserHome, CONTAINER_AGENT_HOME);
  assert.equal(artifacts.codexHome, `${CONTAINER_AGENT_HOME}/.codex`);
  assert.equal(artifacts.claudeStateDir, "", "no host-side Claude state dir stands in for the container's");
  assert.equal(artifacts.codexStateDir, "", "…and none for Codex until the backend can name the home volume");
  // Nothing the run produced points into, or was created inside, the operator's state dirs.
  for (const value of [artifacts.settingsFile, ...artifacts.claudePluginDirs, artifacts.artifactRoot]) {
    assert.ok(!path.resolve(value).startsWith(temp + path.sep), value);
  }
  assert.deepEqual(await listing(claudeState), claudeBefore, "the operator's ~/.claude is untouched");
  assert.deepEqual(await listing(codexState), codexBefore, "the operator's ~/.codex is untouched");
  // And the settings file the run loads names none of it.
  const rendered = await readFile(artifacts.settingsFile, "utf8");
  assert.equal(rendered.includes(claudeState), false);
  assert.equal(rendered.includes(codexState), false);
});

test("private granted skill support assets are copied into the run's plugin under the mounted artifact dir", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-skill-assets-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const sources = path.join(temp, "sources");
  const skill = path.join(sources, "asset-skill");
  await mkdir(path.join(skill, "references"), { recursive: true });
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Asset skill\nRead references/details.md and run scripts/check.sh.\n");
  await writeFile(path.join(skill, "references", "details.md"), "private reference\n");
  await writeFile(path.join(skill, "scripts", "check.sh"), "#!/bin/sh\necho private-script\n");
  const oldSources = process.env.GATEWAY_SKILL_SOURCES;
  process.env.GATEWAY_SKILL_SOURCES = sources;
  t.after(() => { if (oldSources == null) delete process.env.GATEWAY_SKILL_SOURCES; else process.env.GATEWAY_SKILL_SOURCES = oldSources; });

  const target = targetFor("asset-skill-run");
  const artifacts = await createRunGrantArtifacts({
    slug: "asset-skill-run",
    meta: {},
    userSkills: ["asset-skill"],
    sharedSkills: [],
    needsClaudeSettings: true,
    target,
  });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await readFile(path.join(plugin, "skills", "asset-skill", "references", "details.md"), "utf8"), "private reference\n");
  assert.match(await readFile(path.join(plugin, "skills", "asset-skill", "scripts", "check.sh"), "utf8"), /private-script/);
  // The plugin is readable inside the container because it sits under the artifact dir the
  // backend mounts at the same path — not because a sandbox rule re-allowed it: there is none.
  assert.ok(path.resolve(plugin).startsWith(path.resolve(target.artifactDir) + path.sep), plugin);
  const settings = JSON.parse(await readFile(artifacts.settingsFile, "utf8"));
  assert.equal("sandbox" in settings, false);
  // Codex has no host-side overlay for a per-user grant (its skills live in the HOME volume).
  assert.equal(artifacts.codexSkillSupportDir, "");
});

test("unchanged shared gateway skills reuse an immutable warm-safe plugin path", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-stable-plugin-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceSkillsDir = path.join(temp, "workspace-skills");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage", "references"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "references", "slack.md"), "stable support\n");

  const [a, b] = await Promise.all([
    grants({ slug: "stable-plugin", workspaceSkillsDir, needsClaudeSettings: true }),
    grants({ slug: "stable-plugin", workspaceSkillsDir, needsClaudeSettings: true }),
  ]);
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));
  assert.deepEqual(a.claudePluginDirs, b.claudePluginDirs);
  assert.equal(a.settingsFile, b.settingsFile);
  const publishedSettings = await readFile(a.settingsFile, "utf8");
  assert.doesNotThrow(() => JSON.parse(publishedSettings));
  assert.equal(a.claudeHome, b.claudeHome);
  assert.equal(a.claudePluginEphemeral, false);
  assert.equal(await readFile(path.join(a.claudePluginDirs[0], "skills", "gateway-usage", "references", "slack.md"), "utf8"), "stable support\n");
});

test("a channel's custom agents ride the plugin, since --setting-sources \"\" hides .claude/agents", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-plugin-agents-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceSkillsDir = path.join(temp, "workspace", ".claude", "skills");
  const workspaceAgentsDir = path.join(temp, "workspace", ".claude", "agents");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");
  await mkdir(path.join(workspaceAgentsDir, "nested"), { recursive: true });
  await writeFile(path.join(workspaceAgentsDir, "reviewer.md"), "---\nname: reviewer\n---\nReview it.\n");
  await writeFile(path.join(workspaceAgentsDir, "notes.txt"), "not an agent\n");
  await writeFile(path.join(workspaceAgentsDir, ".hidden.md"), "not an agent\n");

  const target = targetFor("agent-grants");
  const artifacts = await createRunGrantArtifacts({ slug: "agent-grants", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true, target });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await readFile(path.join(plugin, "agents", "reviewer.md"), "utf8"), "---\nname: reviewer\n---\nReview it.\n");
  // Only `<name>.md` files travel: no stray sibling, dotfile, or directory gets into the plugin.
  assert.equal(await absent(path.join(plugin, "agents", "notes.txt")), true);
  assert.equal(await absent(path.join(plugin, "agents", ".hidden.md")), true);
  assert.equal(await absent(path.join(plugin, "agents", "nested")), true);
  const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.agents, "./agents");
  // The plugin root is under the one tree the container mounts, so the agents arrive readable.
  assert.ok(path.resolve(plugin).startsWith(path.resolve(target.artifactDir) + path.sep), plugin);
});

// The workspace is AGENT-writable and the plugin directory is mounted readable inside the
// container, so anything copied out of `.claude/agents` becomes readable to the run. A symlinked
// agents directory therefore made readdir enumerate somewhere else entirely (~/.ssh, the gateway
// config dir) and every `*.md` under it was handed to the model — a read escape. Both the
// directory and each entry must be real.
test("a symlinked .claude/agents directory is refused instead of followed out of the workspace", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-plugin-agents-link-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceSkillsDir = path.join(temp, "workspace", ".claude", "skills");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");

  const elsewhere = path.join(temp, "outside-agents");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(elsewhere, "stolen.md"), "---\nname: stolen\n---\nHost secrets.\n");
  const workspaceAgentsDir = path.join(temp, "workspace", ".claude", "agents");
  await symlink(elsewhere, workspaceAgentsDir);

  const artifacts = await grants({ slug: "agent-grants-link", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await absent(path.join(plugin, "agents")), true, "nothing is copied through the link");
  assert.equal(await absent(path.join(plugin, "agents", "stolen.md")), true);
  const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.agents, undefined, "and the plugin never advertises an agents directory");
  assert.equal(await readFile(path.join(elsewhere, "stolen.md"), "utf8").then(() => true), true, "the link target is untouched");
});

test("a symlinked agent ENTRY is skipped even when the directory itself is real", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-plugin-agent-entry-link-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceSkillsDir = path.join(temp, "workspace", ".claude", "skills");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");

  const secret = path.join(temp, "host-secret.md");
  await writeFile(secret, "SECRET\n");
  const workspaceAgentsDir = path.join(temp, "workspace", ".claude", "agents");
  await mkdir(workspaceAgentsDir, { recursive: true });
  await writeFile(path.join(workspaceAgentsDir, "real.md"), "---\nname: real\n---\nFine.\n");
  await symlink(secret, path.join(workspaceAgentsDir, "linked.md"));

  const artifacts = await grants({ slug: "agent-grants-entry-link", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await readFile(path.join(plugin, "agents", "real.md"), "utf8"), "---\nname: real\n---\nFine.\n");
  assert.equal(await absent(path.join(plugin, "agents", "linked.md")), true, "the linked entry never travels");
});

test("a channel with no custom agents ships a plugin with no agents directory and no manifest claim", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-plugin-no-agents-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceSkillsDir = path.join(temp, "workspace", ".claude", "skills");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");

  const artifacts = await grants({
    slug: "agent-grants-empty",
    workspaceSkillsDir,
    workspaceAgentsDir: path.join(temp, "workspace", ".claude", "agents"), // never created
  });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await absent(path.join(plugin, "agents")), true);
  const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal("agents" in manifest, false);
  assert.ok(!(await absent(path.join(plugin, "skills", "gateway-usage", "SKILL.md"))));
});

test("a channel whose ONLY grant is a custom agent still gets a plugin", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-plugin-only-agents-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceAgentsDir = path.join(temp, "workspace", ".claude", "agents");
  await mkdir(workspaceAgentsDir, { recursive: true });
  await writeFile(path.join(workspaceAgentsDir, "triage.md"), "# triage\n");

  const artifacts = await grants({ slug: "agent-only", workspaceAgentsDir });
  t.after(() => artifacts.cleanup());
  assert.equal(artifacts.claudePluginDirs.length, 1);
  assert.equal(await readFile(path.join(artifacts.claudePluginDirs[0], "agents", "triage.md"), "utf8"), "# triage\n");
});

test("clean cwd escapes a git project ancestor and cannot discover its skills", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-clean-git-root-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const oldWorkspace = process.env.CG_WORKSPACE_DIR;
  process.env.CG_WORKSPACE_DIR = path.join(temp, "repo");
  t.after(() => { if (oldWorkspace == null) delete process.env.CG_WORKSPACE_DIR; else process.env.CG_WORKSPACE_DIR = oldWorkspace; });
  await mkdir(path.join(process.env.CG_WORKSPACE_DIR, ".git"), { recursive: true });
  await mkdir(path.join(process.env.CG_WORKSPACE_DIR, ".agents", "skills", "ancestor-leak"), { recursive: true });
  await writeFile(path.join(process.env.CG_WORKSPACE_DIR, ".agents", "skills", "ancestor-leak", "SKILL.md"), "# must not load\n");

  const slug = `clean-git-${Date.now()}`;
  const clean = await ensureChannelFolder(slug, {}, { runMeta: { cleanMode: true } });
  assert.ok(!path.resolve(clean.cwd).startsWith(path.resolve(process.env.CG_WORKSPACE_DIR) + path.sep));
  assert.equal(await absent(path.join(clean.cwd, ".agents", "skills", "ancestor-leak")), true);
});

test("a target without an artifactDir — or no target at all — is refused instead of writing under the gateway root", async () => {
  // A containerized engine cannot open a path under the gateway root (that tree is never mounted),
  // so quietly falling back there would produce a run whose settings and MCP config do not exist on
  // the side that has to read them. The daemon's own local target mounts nothing and names none.
  const isolatedWithoutDir = { runtime: { id: "test-isolated", capabilities: { isolated: true } }, artifactDir: "" };
  for (const target of [isolatedWithoutDir, localRuntimeTarget(process.cwd()), null, undefined]) {
    await assert.rejects(
      createRunGrantArtifacts({ slug: "iso-no-artifact-dir", target }),
      /runtime target must carry an artifactDir/,
    );
  }
  assert.equal(await absent(path.join(runTmpDir(), "runs")), true, "nothing was written to the shared run-tmp dir");
});

test("an unreadable .claude/agents directory delivers the plugin without agents instead of failing the run", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return t.skip("root reads everything");
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-plugin-agents-unreadable-"));
  const workspaceSkillsDir = path.join(temp, "workspace", ".claude", "skills");
  const workspaceAgentsDir = path.join(temp, "workspace", ".claude", "agents");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");
  await mkdir(workspaceAgentsDir, { recursive: true });
  await writeFile(path.join(workspaceAgentsDir, "reviewer.md"), "---\nname: reviewer\n---\nReview it.\n");
  await chmod(workspaceAgentsDir, 0o000);
  t.after(async () => {
    await chmod(workspaceAgentsDir, 0o700);
    await rm(temp, { recursive: true, force: true });
  });

  // Some containerized test users retain CAP_DAC_OVERRIDE even with a non-zero uid. In that
  // environment chmod(000) cannot create the failure this test is specifically about; ordinary
  // Linux CI still exercises the branch.
  try {
    await readdir(workspaceAgentsDir);
    return t.skip("effective user can still read chmod(000) directories");
  } catch {
    // Expected fixture state.
  }

  const artifacts = await grants({ slug: "agent-grants-unreadable", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await absent(path.join(plugin, "agents")), true, "nothing could be listed, so nothing is copied");
  const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal("agents" in manifest, false);
  assert.ok(!(await absent(path.join(plugin, "skills", "gateway-usage", "SKILL.md"))), "the rest of the plugin is delivered");
});


test("an unavailable selected personal grant fails visibly instead of an empty catalog", async () => {
  await assert.rejects(grants({ slug: "missing-personal-fixture", userSkills: ["missing-personal-fixture-unique-0907"] }), /Personal skill grants could not be loaded: missing-personal-fixture-unique-0907/);
});
