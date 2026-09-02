// The ChannelGate rename: path resolution (roots, env names, per-platform folders), the renamed
// bundled skill, the service identities, the Slack manifest, and the guard that keeps the old
// display name from creeping back into the tree.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The pre-rename display name, assembled at runtime so this file never contains the literal and
// never has to appear in its own allowlist.
const OLD_NAME = ["Claude", "Gateway"].join(" ");

const paths = await import("../src/config/paths.js");
const { platformFolderName, platformFolderNames, PLATFORM_IDS } = await import("../src/platforms/registry.js");
const { validatePlatformAdapter } = await import("../src/platforms/contract.js");
const { ensureChannelFolder, RENAMED_MANAGED_SKILLS } = await import("../src/gateway/folders.js");
const { channelSettingsFile, workspaceFolder, channelFolder, cleanWorkspaceFolder } = paths;

// Run `fn` with a specific process environment and restore it afterwards. The path helpers read
// process.env on every call, so this is the only way to exercise the defaults.
function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── roots ────────────────────────────────────────────────────────────────────────────────────

test("with no env set, the roots are ~/.channelgate and ~/ChannelGate", () => {
  withEnv({ CHANNELGATE_DIR: undefined, CLAUDE_GATEWAY_DIR: undefined, CHANNELGATE_DB: undefined, CLAUDE_GATEWAY_DB: undefined, CG_WORKSPACE_DIR: undefined }, () => {
    assert.equal(paths.gatewayRoot(), path.join(os.homedir(), ".channelgate"));
    assert.equal(paths.dbFile(), path.join(os.homedir(), ".channelgate", "gateway.db"));
    assert.equal(paths.workspaceRoot(), path.join(os.homedir(), "ChannelGate"));
    // The pre-rename names must not survive in the defaults. Compared as the final component
    // only: this suite runs under a synthetic HOME that itself sits inside a path containing the
    // old name, so a substring check on the whole path would be meaningless.
    assert.equal(path.basename(paths.gatewayRoot()), ".channelgate");
    assert.equal(path.basename(paths.workspaceRoot()), "ChannelGate");
  });
});

test("CHANNELGATE_DIR / CHANNELGATE_DB override the defaults", () => {
  withEnv({ CHANNELGATE_DIR: "/tmp/cg-root-probe", CHANNELGATE_DB: "/tmp/cg-db-probe/x.db", CLAUDE_GATEWAY_DIR: undefined, CLAUDE_GATEWAY_DB: undefined }, () => {
    assert.equal(paths.gatewayRoot(), "/tmp/cg-root-probe");
    assert.equal(paths.dbFile(), "/tmp/cg-db-probe/x.db");
  });
});

test("the pre-rename env names are still honoured, once, with a deprecation warning", () => {
  paths.resetLegacyEnvWarnings();
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    withEnv({ CHANNELGATE_DIR: undefined, CHANNELGATE_DB: undefined, CLAUDE_GATEWAY_DIR: "/tmp/legacy-root", CLAUDE_GATEWAY_DB: "/tmp/legacy-root/legacy.db" }, () => {
      assert.equal(paths.gatewayRoot(), "/tmp/legacy-root");
      assert.equal(paths.gatewayRoot(), "/tmp/legacy-root"); // second call: still resolves
      assert.equal(paths.dbFile(), "/tmp/legacy-root/legacy.db");
    });
  } finally {
    console.warn = realWarn;
    paths.resetLegacyEnvWarnings();
  }
  const dirWarnings = warnings.filter((w) => w.includes("CLAUDE_GATEWAY_DIR"));
  // Warned about, but exactly once — this is read on nearly every path lookup.
  assert.equal(dirWarnings.length, 1, `expected one CLAUDE_GATEWAY_DIR warning, got ${warnings.length}: ${warnings.join(" | ")}`);
  assert.match(dirWarnings[0], /deprecated/);
  assert.match(dirWarnings[0], /CHANNELGATE_DIR/);
  assert.equal(warnings.filter((w) => w.includes("CLAUDE_GATEWAY_DB")).length, 1);
});

test("the new env name wins over the pre-rename one", () => {
  withEnv({ CHANNELGATE_DIR: "/tmp/new-root", CLAUDE_GATEWAY_DIR: "/tmp/old-root" }, () => {
    assert.equal(paths.gatewayRoot(), "/tmp/new-root");
  });
});

// ── per-platform folders ─────────────────────────────────────────────────────────────────────

test("every platform declares a folder name and they are unique, safe path components", () => {
  const names = platformFolderNames();
  assert.equal(names.length, PLATFORM_IDS.length);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
  assert.deepEqual(
    { slack: platformFolderName("slack"), teams: platformFolderName("msteams"), chat: platformFolderName("googlechat") },
    { slack: "slack", teams: "teams", chat: "google-chat" },
  );
});

test("an unknown or missing platform resolves to Slack's folder, never to a literal id", () => {
  // Fail-closed: every stored row written before multi-platform support is a Slack row, and a
  // folder named after an unrecognized id would strand that channel's work.
  for (const value of ["", null, undefined, "discord", "SLACK "]) {
    assert.equal(platformFolderName(value), "slack", `platform ${JSON.stringify(value)}`);
  }
});

test("a descriptor without a usable folderName fails adapter validation", () => {
  const base = () => ({
    id: "probe", label: "Probe", idPrefix: "probe:", folderName: "probe", transport: "test", status: "scaffold",
    conversationKinds: ["channel"], capabilities: {},
    formatOutbound: () => ({ text: "", chunks: [] }), createConnector: () => null, health: async () => ({ ready: false }),
  });
  const { folderName, ...missing } = base();
  assert.throws(() => validatePlatformAdapter(missing), /missing folderName/);
  // A separator or a dot-name would let a descriptor escape the root it names.
  assert.throws(() => validatePlatformAdapter({ ...base(), folderName: "a/b" }), /single path component/);
  assert.throws(() => validatePlatformAdapter({ ...base(), folderName: ".." }), /single path component/);
  assert.throws(() => validatePlatformAdapter({ ...base(), folderName: "Teams" }), /single path component/);
});

test("channel, workspace and clean-mode folders all carry the platform component", () => {
  withEnv({ CHANNELGATE_DIR: "/tmp/root", CLAUDE_GATEWAY_DIR: undefined, CG_WORKSPACE_DIR: "/tmp/ws" }, () => {
    assert.equal(workspaceFolder("ops", "slack"), "/tmp/ws/slack/ops");
    assert.equal(workspaceFolder("ops", "msteams"), "/tmp/ws/teams/ops");
    assert.equal(workspaceFolder("ops", "googlechat"), "/tmp/ws/google-chat/ops");
    assert.equal(workspaceFolder("ops"), "/tmp/ws/slack/ops");
    assert.equal(channelFolder("ops", "msteams"), "/tmp/root/channels/teams/ops");
    assert.equal(paths.channelMetaFile("ops", "msteams"), "/tmp/root/channels/teams/ops/meta.json");
    assert.equal(paths.channelSessionsFile("ops", "msteams"), "/tmp/root/channels/teams/ops/sessions.json");
    assert.equal(paths.channelSettingsFile("ops", "googlechat"), "/tmp/root/channels/google-chat/ops/.claude/settings.json");
    assert.equal(paths.channelAdminSettingsFile("ops", "googlechat"), "/tmp/root/channels/google-chat/ops/.claude/settings-admin.json");
    assert.equal(paths.channelSkillsDir("ops", "googlechat"), "/tmp/root/channels/google-chat/ops/.claude/skills");
    assert.equal(cleanWorkspaceFolder("ops", "msteams"), "/tmp/root/clean-workspaces/teams/ops");
  });
});

// ── the generated sandbox ────────────────────────────────────────────────────────────────────

test("a channel's lockdown embeds the NEW absolute paths and still read-denies the runtime root", async () => {
  const slug = `rename-sandbox-${Date.now()}`;
  const meta = { name: "Rename probe", platform: "msteams", allowedMcps: [], bash: true };
  const { cwd, settingsFile } = await ensureChannelFolder(slug, meta);

  // The run folder is the platform-namespaced one under the workspace root...
  assert.equal(cwd, workspaceFolder(slug, "msteams"));
  assert.ok(cwd.includes(`${path.sep}teams${path.sep}`), cwd);
  // ...and the lockdown file lives in the platform-namespaced metadata folder.
  assert.equal(settingsFile, channelSettingsFile(slug, "msteams"));
  assert.ok(settingsFile.includes(path.join("channels", "teams", slug)), settingsFile);

  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  const fs = settings.sandbox.filesystem;
  assert.ok(fs.allowWrite.some((p) => p.includes(cwd)), `allowWrite must name the new cwd: ${JSON.stringify(fs.allowWrite)}`);
  // The runtime root stays read-denied wholesale — it holds every other channel plus the tokens.
  const root = paths.gatewayRoot();
  assert.ok(fs.denyRead.some((p) => p.replace(/^\/\//, "/") === root || p.includes(root)), JSON.stringify(fs.denyRead));
  // No stale pre-rename ROOT anywhere in the generated contract. (Compared against the actual
  // legacy default paths, not the bare strings — the test HOME contains the old name itself.)
  const rendered = JSON.stringify(settings);
  assert.equal(rendered.includes(path.join(os.homedir(), "Slack Agent")), false);
  assert.equal(rendered.includes(path.join(os.homedir(), ".claude-gateway")), false);
});

test("the bundled lockdown skill's materialised folder is renamed in place, marker-guarded", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cg-skill-rename-"));
  const sources = path.join(temp, "sources");
  const prevSources = process.env.GATEWAY_SKILL_SOURCES;
  process.env.GATEWAY_SKILL_SOURCES = sources;
  try {
    await mkdir(path.join(sources, "channelgate"), { recursive: true });
    await writeFile(path.join(sources, "channelgate", "SKILL.md"), "# channelgate\n");

    const slug = `skill-rename-${Date.now()}`;
    // First pass materialises the skill under its NEW name.
    const { cwd } = await ensureChannelFolder(slug, { allowedMcps: [], skills: ["channelgate"] });
    const skillsDir = path.join(cwd, ".claude", "skills");
    assert.ok(existsSync(path.join(skillsDir, "channelgate", "SKILL.md")));

    // Recreate the PRE-RENAME shape: the gateway-owned copy under the old name, marker and all.
    await rm(path.join(skillsDir, "channelgate"), { recursive: true, force: true });
    await mkdir(path.join(skillsDir, "claude-gateway"), { recursive: true });
    await writeFile(path.join(skillsDir, "claude-gateway", "SKILL.md"), "# claude-gateway\n");
    await writeFile(path.join(skillsDir, "claude-gateway", ".gateway-managed-skill"), "gateway-owned\n");
    // ...and the grant still stored under the old name.
    await ensureChannelFolder(slug, { allowedMcps: [], skills: ["claude-gateway"] });

    assert.equal(existsSync(path.join(skillsDir, "claude-gateway")), false, "the old folder must be gone");
    assert.ok(existsSync(path.join(skillsDir, "channelgate", "SKILL.md")), "the skill must survive under the new name");
    assert.equal(RENAMED_MANAGED_SKILLS["claude-gateway"], "channelgate");

    // A folder with the same name that we did NOT create (no marker) is never touched.
    await mkdir(path.join(skillsDir, "claude-gateway"), { recursive: true });
    await writeFile(path.join(skillsDir, "claude-gateway", "SKILL.md"), "# hand made\n");
    await ensureChannelFolder(slug, { allowedMcps: [], skills: ["channelgate"] });
    assert.equal(await readFile(path.join(skillsDir, "claude-gateway", "SKILL.md"), "utf8"), "# hand made\n");
  } finally {
    if (prevSources === undefined) delete process.env.GATEWAY_SKILL_SOURCES;
    else process.env.GATEWAY_SKILL_SOURCES = prevSources;
    await rm(temp, { recursive: true, force: true });
  }
});

test("the bundled skill ships in the tree under its new name and is not gitignored", () => {
  const skill = readFileSync(path.join(repoRoot, ".claude/skills/channelgate/SKILL.md"), "utf8");
  assert.match(skill, /^name: "channelgate"$/m);
  assert.equal(existsSync(path.join(repoRoot, ".claude/skills/claude-gateway")), false);
  const ignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^!\.claude\/skills\/channelgate\/$/m);
});

// ── service identities ───────────────────────────────────────────────────────────────────────

test("every shell script parses and the service scripts carry the new identities", () => {
  const scriptsDir = path.join(repoRoot, "scripts");
  const launchd = readFileSync(path.join(scriptsDir, "install-launchd.sh"), "utf8");
  const uninstall = readFileSync(path.join(scriptsDir, "uninstall-launchd.sh"), "utf8");
  const systemd = readFileSync(path.join(scriptsDir, "install-systemd.sh"), "utf8");
  for (const name of ["install-launchd.sh", "uninstall-launchd.sh", "install-systemd.sh"]) {
    execFileSync("bash", ["-n", path.join(scriptsDir, name)], { stdio: "pipe" });
  }

  assert.match(launchd, /^LABEL="com\.makeitfuture\.channelgate"$/m);
  assert.match(systemd, /^UNIT_NAME="channelgate\.service"$/m);
  assert.match(systemd, /Environment=CHANNELGATE_DIR=\$SERVICE_HOME/);

  // An upgrade must tear the OLD job down before installing the new one, in every installer —
  // otherwise two daemons race for the runtime root's singleton lock and KeepAlive/Restart turns
  // that into a crash loop.
  assert.match(launchd, /^LEGACY_LABEL="com\.makeitfuture\.claude-gateway"$/m);
  assert.match(launchd, /Removing the pre-rename LaunchDaemon/);
  assert.match(launchd, /Removing the pre-rename LaunchAgent/);
  assert.match(systemd, /^LEGACY_UNIT_NAME="claude-gateway\.service"$/m);
  assert.match(systemd, /systemctl disable --now "\$LEGACY_UNIT_NAME"/);
  assert.match(uninstall, /LEGACY_LABEL="com\.makeitfuture\.claude-gateway"/);

  // Nothing may assume the checkout's directory NAME — the operator renames it separately.
  assert.match(launchd, /APP_DIR="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/);
  assert.match(systemd, /APP_DIR="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/);
});

test("self-update finds the service under the new identity and still under the old one", async () => {
  const { systemdUnitCandidates, launchdLabelCandidates } = await import("../scripts/update-runner.mjs");
  assert.deepEqual(systemdUnitCandidates({}), ["channelgate.service", "claude-gateway.service"]);
  assert.deepEqual(launchdLabelCandidates(), ["com.makeitfuture.channelgate", "com.makeitfuture.claude-gateway"]);
  // The current env name wins; the pre-rename one is still honoured.
  assert.deepEqual(systemdUnitCandidates({ CHANNELGATE_SYSTEMD_UNIT: "x.service" }), ["x.service"]);
  assert.deepEqual(systemdUnitCandidates({ CLAUDE_GATEWAY_SYSTEMD_UNIT: "y.service" }), ["y.service"]);
  assert.deepEqual(systemdUnitCandidates({ CHANNELGATE_SYSTEMD_UNIT: "x.service", CLAUDE_GATEWAY_SYSTEMD_UNIT: "y.service" }), ["x.service"]);
});

test("package identity is channelgate and the lockfile agrees", () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  assert.equal(pkg.name, "channelgate");
  assert.equal(pkg.private, true);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.packages[""].license, pkg.license);
  assert.ok(pkg.keywords.includes("channelgate"));
  assert.ok(pkg.description.includes("ChannelGate"));
});

test("the Slack app manifest is valid JSON, renamed, and keeps its scopes and events", () => {
  const raw = readFileSync(path.join(repoRoot, "slack-app-manifest.json"), "utf8");
  const manifest = JSON.parse(raw); // throws on invalid JSON — that is the assertion
  assert.equal(manifest.display_information.name, "ChannelGate");
  assert.match(manifest.display_information.long_description, /^ChannelGate /);
  assert.equal(manifest.features.bot_user.display_name, "channelgate");
  assert.equal(raw.includes(OLD_NAME), false);
  // Scopes and events are the app's contract with an existing install — the rename must not move
  // a single one of them.
  assert.equal(manifest.oauth_config.scopes.bot.length, 21);
  for (const scope of ["app_mentions:read", "chat:write", "commands", "lists:write", "users:read"]) {
    assert.ok(manifest.oauth_config.scopes.bot.includes(scope), scope);
  }
  assert.equal(manifest.settings.event_subscriptions.bot_events.length, 11);
  assert.equal(manifest.settings.socket_mode_enabled, true);
});

// ── the guard ────────────────────────────────────────────────────────────────────────────────

// The ONLY files allowed to still carry it: the "formerly" attributions, the published
// CHANGELOG/LICENSE history (whose wording is a record and must not be rewritten), the upgrade
// notes, and the migration script that names the layout it is migrating FROM. Anything else is a
// rename that was missed. The count is capped per file so a new occurrence has to be justified.
const OLD_NAME_ALLOWLIST = new Map([
  ["README.md", 2],
  ["CHANGELOG.md", 2],
  ["LICENSE.md", 1],
  ["AUTHORS.md", 1],
  ["CONTRIBUTING.md", 1],
  ["FEATURES.md", 1],
  ["INSTALL.md", 1],
  ["TEST-PLAN.md", 2],
  ["docs/LICENSING-SUMMARY.md", 1],
  ["scripts/migrate-channelgate.mjs", 3],
  ["test/license.test.js", 1],
  ["test/readme.test.js", 1],
]);

test("the old display name survives only in the 'formerly' lines and the published history", () => {
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-cI", OLD_NAME], { cwd: repoRoot, encoding: "utf8" });
  } catch (error) {
    // `git grep` exits 1 when there are no matches at all — that is a pass.
    if (error.status !== 1) throw error;
    return;
  }
  const hits = new Map();
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const idx = line.lastIndexOf(":");
    hits.set(line.slice(0, idx), Number(line.slice(idx + 1)));
  }
  const unexpected = [...hits.keys()].filter((f) => !OLD_NAME_ALLOWLIST.has(f));
  assert.deepEqual(unexpected, [], `these files still carry the pre-rename display name: ${unexpected.join(", ")}`);
  for (const [file, count] of hits) {
    const max = OLD_NAME_ALLOWLIST.get(file);
    assert.ok(count <= max, `${file} has ${count} pre-rename-name hits, the allowlist permits ${max}`);
  }
});

// The only places in the shipped code allowed to name a pre-rename path or identifier, and why.
const LEGACY_NAME_ALLOWLIST = new Map([
  ["src/config/paths.js", "the comment that documents the rename"],
  ["src/gateway/folders.js", "RENAMED_MANAGED_SKILLS maps the old bundled-skill name forward"],
  ["src/slack/app-context.js", "\"Slack Agent\" here is Slack's own split-view feature, not our old name"],
  ["src/web/routes/settings.js", "boots out the pre-rename launchd label as well as the new one"],
]);

test("no shipped source file resolves a pre-rename root or label as its own", () => {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-lI", "-e", "Slack Agent", "-e", ".claude-gateway", "--", "src", "public"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
  } catch (error) {
    if (error.status !== 1) throw error; // exit 1 = no matches at all
  }
  const files = out ? out.split("\n") : [];
  const unexpected = files.filter((f) => !LEGACY_NAME_ALLOWLIST.has(f));
  assert.deepEqual(unexpected, [], `pre-rename path/identifier left in: ${unexpected.join(", ")}`);
});
