import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";

const gatewayRoot = ensureTestEnv();
const { assertUserSkillOverlaySupported, createRunGrantArtifacts, materializeCodexToolchainLaunchers } = await import("../src/gateway/run-grant-artifacts.js");
const { ensureChannelFolder } = await import("../src/gateway/folders.js");
const { channelSettingsFile, runTmpDir, workspaceFolder } = await import("../src/config/paths.js");
const { HOST_IDENTITY_PATHS } = await import("../src/gateway/host-sensitive-paths.js");

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

test("every engine run uses isolated homes instead of host-global config or skills", async () => {
  const source = await readFile(new URL("../src/gateway/run.js", import.meta.url), "utf8");
  assert.match(source, /claudeHome:\s*grantArtifacts\.claudeHome/);
  assert.match(source, /codexUserHome:\s*grantArtifacts\.codexUserHome/);
});

test("clean run artifacts expose no optional MCP or user skill tier", async (t) => {
  const slug = `clean-grants-${Date.now()}`;
  const cleanWorkspace = await ensureChannelFolder(slug, {}, { runMeta: { cleanMode: true } });
  const artifacts = await createRunGrantArtifacts({
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
  assert.deepEqual(await readdir(artifacts.codexSkillSupportDir), []);
  const settings = JSON.parse(await readFile(artifacts.settingsFile, "utf8"));
  assert.ok(!settings.permissions.allow.includes("mcp__private"));
  assert.ok(!settings.allowedMcpServers.some((entry) => entry?.serverName === "private"));
});

// The per-run settings artifact is what a Claude spawn ACTUALLY loads (it overrides the
// settings-admin.json fallback for every Claude run), so the admin sandbox-off contract must
// hold HERE. Regression: the first admin-sandbox-off fix patched only the fallback file, and
// escalated admin turns kept seeing the sandbox tmpfs home in production.
test("escalated run artifact settings lift the sandbox; ordinary artifacts keep it", async (t) => {
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

  const escalated = await createRunGrantArtifacts({ ...base, allowBypass: true });
  t.after(() => escalated.cleanup());
  const adminSettings = JSON.parse(await readFile(escalated.settingsFile, "utf8"));
  assert.equal(adminSettings.sandbox.enabled, false);
  assert.equal("disableBypassPermissionsMode" in adminSettings.permissions, false);
  // The filesystem block must survive: plugin allowRead grants are appended to it.
  assert.ok(Array.isArray(adminSettings.sandbox.filesystem.allowRead));

  const ordinary = await createRunGrantArtifacts({ ...base, allowBypass: false });
  t.after(() => ordinary.cleanup());
  const sharedSettings = JSON.parse(await readFile(ordinary.settingsFile, "utf8"));
  assert.equal(sharedSettings.sandbox.enabled, true);
  assert.equal(sharedSettings.permissions.disableBypassPermissionsMode, "disable");
  for (const hostPath of HOST_IDENTITY_PATHS) {
    assert.ok(sharedSettings.sandbox.filesystem.denyRead.includes(hostPath));
  }
});

test("personal library favorites are isolated per run instead of written to shared skills", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const token = String(options.headers?.Authorization || "").replace(/^Bearer\s+/, "");
    return {
      ok: true,
      json: async () => ({ favorites: [{ name: token === "isolation-token-a" ? "Favorite A" : "Favorite B", description: "private" }] }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const [a, b] = await Promise.all([
    createRunGrantArtifacts({ slug: "library-a", librarySkillsToken: "isolation-token-a" }),
    createRunGrantArtifacts({ slug: "library-b", librarySkillsToken: "isolation-token-b" }),
  ]);
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));

  assert.ok(!(await absent(path.join(a.claudePluginDirs[0], "skills", "favorite-a", "SKILL.md"))));
  assert.ok(await absent(path.join(a.claudePluginDirs[0], "skills", "favorite-b")));
  assert.ok(!(await absent(path.join(b.codexSkillSupportDir, "favorite-b", "SKILL.md"))));
  assert.ok(await absent(path.join(b.codexSkillSupportDir, "favorite-a")));
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
  const [a, b] = await Promise.all([
    createRunGrantArtifacts({ slug, meta: { allowedMcps: [sharedMcp, userMcp("user-a")] }, userSkills: ["user-a"], needsClaudeSettings: true }),
    createRunGrantArtifacts({ slug, meta: { allowedMcps: [sharedMcp, userMcp("user-b")] }, userSkills: ["user-b"], needsClaudeSettings: true }),
  ]);
  t.after(() => Promise.all([a.cleanup(), b.cleanup()]));

  assert.notEqual(a.settingsFile, b.settingsFile);
  assert.ok(path.resolve(a.settingsFile).startsWith(path.resolve(gatewayRoot) + path.sep));
  assert.ok(!path.resolve(a.settingsFile).startsWith(path.resolve(runTmpDir()) + path.sep));
  assert.equal((await stat(path.dirname(a.settingsFile))).mode & 0o777, 0o700);
  assert.equal((await stat(a.settingsFile)).mode & 0o777, 0o600);

  for (const [artifact, own, other] of [[a, "user-a", "user-b"], [b, "user-b", "user-a"]]) {
    const plugin = artifact.claudePluginDirs[0];
    const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "gateway-user-grants");
    assert.equal((await stat(path.join(plugin, ".claude-plugin", "plugin.json"))).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(plugin, "skills", own, "SKILL.md"), "utf8"), `# ${own}\n`);
    assert.ok(await absent(path.join(plugin, "skills", other)));
    assert.equal(await readFile(path.join(artifact.codexSkillSupportDir, own, "SKILL.md"), "utf8"), `# ${own}\n`);
    assert.ok(await absent(path.join(artifact.codexSkillSupportDir, other)));
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
  assert.ok(await absent(a.claudePluginDirs.find((dir) => dir.includes("user-grants-plugin"))));
  assert.ok(await absent(b.claudePluginDirs.find((dir) => dir.includes("user-grants-plugin"))));
  assert.equal(path.resolve(gatewayRoot), path.resolve(process.env.CHANNELGATE_DIR));
});

test("engine state overlays preserve auth/session only and omit host-global customizations", async (t) => {
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

  const oldGateway = process.env.CHANNELGATE_DIR;
  const oldClaude = process.env.CLAUDE_CONFIG_DIR;
  const oldCodex = process.env.CODEX_HOME;
  process.env.CHANNELGATE_DIR = path.join(temp, "gateway-runtime");
  process.env.CLAUDE_CONFIG_DIR = claudeState;
  process.env.CODEX_HOME = codexState;
  t.after(() => {
    if (oldGateway == null) delete process.env.CHANNELGATE_DIR; else process.env.CHANNELGATE_DIR = oldGateway;
    if (oldClaude == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
    if (oldCodex == null) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  });

  const artifacts = await createRunGrantArtifacts({ slug: "state-isolation" });
  t.after(() => artifacts.cleanup());
  // The credentials file is deliberately NOT linked any more. Claude Code writes it by rename, so
  // the link became an independent copy on the first refresh a gateway run performed — which then
  // expired on its own while the operator's real login stayed current. The gateway reads the
  // operator's login where it lives and relays its access token instead (src/gateway/claude-login.js).
  await assert.rejects(() => readlink(path.join(artifacts.claudeConfigDir, ".credentials.json")), /ENOENT/);
  assert.equal(await readlink(path.join(artifacts.claudeConfigDir, "projects")), path.join(claudeState, "projects"));
  assert.equal(await readlink(path.join(artifacts.codexHome, "auth.json")), path.join(codexState, "auth.json"));
  assert.equal(await readlink(path.join(artifacts.codexHome, "sessions")), path.join(codexState, "sessions"));
  assert.ok(!artifacts.codexHome.startsWith(artifacts.codexUserHome), "CODEX_HOME must survive per-run cleanup for resume");
  assert.equal(artifacts.codexSkillSupportDir, path.join(artifacts.codexUserHome, ".agents", "skills"));
  for (const forbidden of [
    path.join(artifacts.claudeConfigDir, "settings.json"),
    path.join(artifacts.claudeConfigDir, "plugins"),
    path.join(artifacts.claudeConfigDir, "skills", "host-skill"),
    path.join(artifacts.claudeHome, ".claude.json"),
    path.join(artifacts.codexHome, "config.toml"),
    path.join(artifacts.codexHome, "skills", "host-skill"),
  ]) assert.equal(await absent(forbidden), true, forbidden);
  assert.equal((await lstat(artifacts.claudeHome)).isDirectory(), true);
  assert.equal((await lstat(artifacts.codexUserHome)).isDirectory(), true);

  const stableCodexHome = artifacts.codexHome;
  await artifacts.cleanup();
  assert.equal((await lstat(stableCodexHome)).isDirectory(), true, "stable Codex state survives grant cleanup");
  assert.equal(await absent(artifacts.codexUserHome), true, "private skill grants are removed after the run");
});

test("Codex toolchain launchers remain symlinks inside the run-private granted directory", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-codex-launchers-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = path.join(temp, "home");
  const hostBin = path.join(home, ".local", "bin");
  const npmTarget = path.join(home, ".local", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(hostBin, { recursive: true });
  await mkdir(path.dirname(npmTarget), { recursive: true });
  await writeFile(npmTarget, "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n");
  await chmod(npmTarget, 0o755);
  await symlink(npmTarget, path.join(hostBin, "npm"));

  const binDir = await materializeCodexToolchainLaunchers(path.join(temp, "run"), {
    home,
    dirs: [hostBin],
  });
  const launcher = path.join(binDir, "npm");
  assert.equal((await lstat(launcher)).isSymbolicLink(), true, "npm must not be flattened to a regular file");
  assert.equal(await readlink(launcher), npmTarget, "the launcher must resolve from npm's real package location");
});

test("private granted skill support assets are copied and narrowly readable", async (t) => {
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

  const artifacts = await createRunGrantArtifacts({
    slug: "asset-skill-run",
    meta: {},
    userSkills: ["asset-skill"],
    sharedSkills: [],
    needsClaudeSettings: true,
  });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await readFile(path.join(plugin, "skills", "asset-skill", "references", "details.md"), "utf8"), "private reference\n");
  assert.match(await readFile(path.join(plugin, "skills", "asset-skill", "scripts", "check.sh"), "utf8"), /private-script/);
  assert.equal(await readFile(path.join(artifacts.codexSkillSupportDir, "asset-skill", "references", "details.md"), "utf8"), "private reference\n");
  const settings = JSON.parse(await readFile(artifacts.settingsFile, "utf8"));
  const sandboxPlugin = `/${path.resolve(plugin).replace(/^\/+/, "")}`;
  assert.ok(settings.sandbox.filesystem.allowRead.includes(sandboxPlugin));
  // The outer test harness itself may run from a synthetic HOME whose pathname contains
  // "codex-user-home". Assert against this run's concrete private roots, not a name substring.
  for (const privateHome of [artifacts.claudeHome, artifacts.codexUserHome]) {
    const sandboxHome = `/${path.resolve(privateHome).replace(/^\/+/, "")}`;
    assert.ok(!settings.sandbox.filesystem.allowRead.some((entry) => entry === sandboxHome || entry.startsWith(`${sandboxHome}/`)));
  }
});

test("unchanged shared gateway skills reuse an immutable warm-safe plugin path", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-stable-plugin-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceSkillsDir = path.join(temp, "workspace-skills");
  await mkdir(path.join(workspaceSkillsDir, "gateway-usage", "references"), { recursive: true });
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "SKILL.md"), "# Gateway usage\n");
  await writeFile(path.join(workspaceSkillsDir, "gateway-usage", "references", "slack.md"), "stable support\n");

  const [a, b] = await Promise.all([
    createRunGrantArtifacts({ slug: "stable-plugin", workspaceSkillsDir, needsClaudeSettings: true }),
    createRunGrantArtifacts({ slug: "stable-plugin", workspaceSkillsDir, needsClaudeSettings: true }),
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

  const artifacts = await createRunGrantArtifacts({ slug: "agent-grants", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true });
  t.after(() => artifacts.cleanup());
  const plugin = artifacts.claudePluginDirs[0];
  assert.equal(await readFile(path.join(plugin, "agents", "reviewer.md"), "utf8"), "---\nname: reviewer\n---\nReview it.\n");
  // Only `<name>.md` files travel: no stray sibling, dotfile, or directory gets into the plugin.
  assert.equal(await absent(path.join(plugin, "agents", "notes.txt")), true);
  assert.equal(await absent(path.join(plugin, "agents", ".hidden.md")), true);
  assert.equal(await absent(path.join(plugin, "agents", "nested")), true);
  const manifest = JSON.parse(await readFile(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.agents, "./agents");
  // The plugin root is the one path re-allowed for reading, so the agents arrive readable.
  const settings = JSON.parse(await readFile(artifacts.settingsFile, "utf8"));
  assert.ok(settings.sandbox.filesystem.allowRead.includes(`/${path.resolve(plugin).replace(/^\/+/, "")}`));
});

// The workspace is AGENT-writable and the plugin directory is re-allowed for READING inside the
// sandbox, so anything copied out of `.claude/agents` becomes readable to the run. A symlinked
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

  const artifacts = await createRunGrantArtifacts({ slug: "agent-grants-link", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true });
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

  const artifacts = await createRunGrantArtifacts({ slug: "agent-grants-entry-link", workspaceSkillsDir, workspaceAgentsDir, needsClaudeSettings: true });
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

  const artifacts = await createRunGrantArtifacts({
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

  const artifacts = await createRunGrantArtifacts({ slug: "agent-only", workspaceAgentsDir });
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
