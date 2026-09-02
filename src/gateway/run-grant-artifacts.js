// Engine-global discovery is outside the org/channel/user grant model, so every launch receives
// isolated state roots. Claude's auth/session root and shared skill plugins are stable + immutable
// to preserve safe warm sessions; user/library overlays and every Codex HOME are private per run.
import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { channelFolder, claudeEngineHome, codexEngineHome, gatewayRoot, runTmpDir } from "../config/paths.js";
import { operatorClaudeConfigDir } from "./claude-login.js";
import { runtimeSupports } from "../runtimes/contract.js";
import { getCliIntegrations, getCredentialHomePaths } from "../config/settings.js";
import { hostCredentialSuppressedBy } from "../config/cli-catalog.js";
import { normalizeChannelEnv } from "../config/channel-env.js";
import { buildSettings, enableSkills } from "./folders.js";
import { applyLibrarySkillsToDir } from "./library-skills.js";
import { ensureRealDir } from "./safe-fs.js";
import { toolchainLauncherEntries } from "./toolchain-paths.js";

// ── Isolated-runtime engine homes ─────────────────────────────────────────────────────────────
// Inside a container the engine's HOME is the channel's own persistent volume (plan §5/§8), so
// logins, the npm prefix, Claude's transcripts and Codex's state are per channel and the
// operator's real ~/.claude / ~/.codex are never mounted. These are IN-CONTAINER paths: the daemon
// never creates or reads them, it only names them in the child's environment. The backend may
// publish its own (target.container.home …) — prefer that, so the image layout stays the
// container backend's fact and these literals are only the documented default.
export const CONTAINER_AGENT_HOME = "/home/agent";

export function engineHomesFor(target = null) {
  if (!runtimeSupports(target, "isolated")) return null;
  const home = target?.container?.home || CONTAINER_AGENT_HOME;
  const claudeConfigDir = target?.container?.claudeConfigDir || path.posix.join(home, ".claude");
  const codexHome = target?.container?.codexHome || path.posix.join(home, ".codex");
  return {
    claudeHome: home,
    claudeConfigDir,
    // Host-side state dirs the daemon reads for adoption/usage. There is no host counterpart for a
    // containerized session, so callers get "" rather than a path pointing at the operator's own.
    claudeStateDir: "",
    codexUserHome: home,
    codexHome,
    // Codex's state dir is read from BOTH sides: the CLI writes it inside the container (as
    // CODEX_HOME), and the daemon reads the rollout files back for usage accounting. Only the
    // second one is a path in this filesystem, so this is the HOST view of the channel's home
    // volume — "" while the backend cannot name one, which the accounting must tolerate rather
    // than resolve against the operator's own ~/.codex.
    codexStateDir: target?.container?.homeVolumeHostPath ? path.join(target.container.homeVolumeHostPath, ".codex") : "",
  };
}

export function assertUserSkillOverlaySupported(adapter, userSkills = []) {
  if (userSkills.length > 0 && !adapter?.supports?.userSkillOverlay) {
    throw new Error(`${adapter?.label || adapter?.id || "Selected engine"} cannot isolate per-user skill grants; refusing the run`);
  }
}

const exists = async (file) => {
  try { await access(file); return true; } catch { return false; }
};

async function linkIfPresent(sourceRoot, destinationRoot, name) {
  const source = path.join(sourceRoot, name);
  const destination = path.join(destinationRoot, name);
  if (!(await exists(source)) || await exists(destination)) return;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try { await symlink(source, destination); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  const visit = async (dir, relative = "") => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = path.join(relative, entry.name);
      const file = path.join(dir, entry.name);
      hash.update(`${entry.isSymbolicLink() ? "l" : entry.isDirectory() ? "d" : "f"}:${rel}\0`);
      if (entry.isSymbolicLink()) hash.update(await readlink(file));
      else if (entry.isDirectory()) await visit(file, rel);
      else hash.update(await readFile(file));
    }
  };
  await visit(root);
  return hash.digest("hex").slice(0, 24);
}

// Is `dir` a REAL directory (not a symlink to one)? The workspace is agent-writable, and anything
// copied out of it is re-allowed for reading inside the plugin — so a link at the source is a read
// escape, not a convenience. lstat never follows, which is the whole point.
const isRealDir = async (dir) => {
  try {
    return (await lstat(dir)).isDirectory();
  } catch {
    return false;
  }
};

// Custom agent definitions a channel put in its working folder. `--setting-sources ""` (which keeps
// host-user state out of every run) also hides `.claude/agents`, so a plugin directory is the ONLY
// channel that delivers them — same guarded copy the workspace skills get, and the plugin
// namespace (`<plugin>:<agent>`) means a channel agent can never shadow a built-in one.
//
// Symlinks are refused on BOTH sides. A symlinked `.claude/agents` directory made readdir enumerate
// somewhere else entirely (say ~/.ssh), and every `*.md` under it was copied into a plugin the run
// is then allowed to read — a read escape out of the sandbox. Per-entry lstat closes the same hole
// one level down (readdir's dirent can go stale between the listing and the copy).
async function copyWorkspaceAgents(pluginDir, workspaceAgentsDir) {
  if (!workspaceAgentsDir || !(await isRealDir(workspaceAgentsDir))) return false;
  let entries;
  try {
    entries = await readdir(workspaceAgentsDir, { withFileTypes: true });
  } catch {
    return false; // vanished between the check and the read — deliver the plugin without agents
  }
  const agentsDir = path.join(pluginDir, "agents");
  let copied = false;
  for (const entry of entries) {
    // Agent definitions are `<name>.md` files; ignore anything else so a stray directory or
    // dotfile can't smuggle content into the plugin.
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.toLowerCase().endsWith(".md")) continue;
    const source = path.join(workspaceAgentsDir, entry.name);
    let info;
    try {
      info = await lstat(source);
    } catch {
      continue; // vanished — nothing to copy
    }
    if (!info.isFile()) continue; // a symlink swapped in after readdir listed a plain file
    const destination = path.join(agentsDir, entry.name);
    if (await exists(destination)) continue;
    if (!copied) await ensureRealDir(pluginDir, "agents");
    await cp(source, destination, { dereference: false });
    copied = true;
  }
  return copied;
}

async function materializePlugin({ pluginDir, name, description, skillNames = [], workspaceSkillsDir = "", workspaceAgentsDir = "", librarySkillsToken = "" }) {
  const skillsDir = path.join(pluginDir, "skills");
  await mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  const copied = await enableSkills(skillsDir, skillNames);
  // Gateway-generated rather than source-library entries. Import fixed names only, never an
  // arbitrary project skill. `cp` retains references/, scripts/, and assets.
  // Same no-follow rule as copyWorkspaceAgents: both the container and the named skill folder must
  // be REAL directories in the workspace, or the copy walks wherever a planted link points.
  const skillsSourceOk = Boolean(workspaceSkillsDir) && (await isRealDir(workspaceSkillsDir));
  for (const skillName of ["gateway-usage", "channel-memory"]) {
    if (!skillsSourceOk) continue;
    const source = path.join(workspaceSkillsDir, skillName);
    const destination = path.join(skillsDir, skillName);
    if (!(await isRealDir(source)) || await exists(destination)) continue;
    await cp(source, destination, { recursive: true });
  }
  await applyLibrarySkillsToDir(skillsDir, librarySkillsToken);
  const hasAgents = await copyWorkspaceAgents(pluginDir, workspaceAgentsDir);
  // The manifest is written LAST so it can declare the directories that actually exist. Claude Code
  // auto-discovers ./skills and ./agents, but naming them keeps an empty-agents plugin from
  // advertising a directory it never created.
  await writeFile(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name, version: "1.0.0", description, ...(hasAgents ? { agents: "./agents" } : {}) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const populated =
    hasAgents || (await readdir(skillsDir, { withFileTypes: true })).some((entry) => entry.isDirectory() || entry.isSymbolicLink());
  return { populated, missing: copied.missing };
}

export async function stableClaudeState() {
  const claudeHome = claudeEngineHome();
  const claudeConfigDir = path.join(claudeHome, ".claude");
  await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
  const claudeStateDir = operatorClaudeConfigDir();
  // Resume/persistence state ONLY. Never link settings, plugins, skills, commands, agents, hooks,
  // or the host ~/.claude.json file — and, deliberately, never `.credentials.json`. That link was
  // the bug: Claude Code writes the credentials file by RENAME, so the first refresh a gateway run
  // performed REPLACED the symlink with an independent copy of the operator's session, which then
  // aged out on its own while the operator's real login stayed current. The gateway now reads the
  // operator's login where it lives and relays its access token instead
  // (src/gateway/claude-login.js + claude-token-relay.js). An engine-home credentials file that
  // already exists is left alone — it may be a deliberate gateway sign-in — but nothing plants one.
  for (const name of ["projects", "sessions", "session-env", "tasks"]) {
    await linkIfPresent(claudeStateDir, claudeConfigDir, name);
  }
  // Synthetic HOME would otherwise hide the narrow tooling credential state (git/gh baseline +
  // enabled CLI integrations) that buildSettings deliberately re-allows only for Bash/Auto or
  // admin-bypass network runs. Link exact targets, never broad .config; the sandbox still denies
  // their real targets in every other mode. linkIfPresent only ever ADDS: disabling an
  // integration later leaves an inert dangling link whose target the sandbox again denies.
  const hostHome = os.homedir();
  for (const name of getCredentialHomePaths()) {
    await linkIfPresent(hostHome, claudeHome, name);
  }
  return { claudeHome, claudeConfigDir, claudeStateDir };
}

async function stableCodexState() {
  // Codex 0.147+ persists the lexical rollout pathname in its thread index. CODEX_HOME therefore
  // cannot live below the per-run grant root: cleanup would delete that pathname even though the
  // rollout survives through a sessions symlink. Keep only auth + session state in this stable,
  // gateway-owned home; personal skills remain in the disposable synthetic HOME below.
  const codexHome = codexEngineHome();
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const codexStateDir = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  await mkdir(path.join(codexStateDir, "sessions"), { recursive: true, mode: 0o700 });
  await linkIfPresent(codexStateDir, codexHome, "auth.json");
  await linkIfPresent(codexStateDir, codexHome, "sessions");
  return { codexHome, codexStateDir };
}

export async function materializeCodexToolchainLaunchers(root, options = {}) {
  const binDir = path.join(root, "codex-toolchain-bin");
  const launchers = toolchainLauncherEntries(options);
  if (launchers.length === 0) return "";
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  for (const { name, target } of launchers) await symlink(target, path.join(binDir, name));
  return binDir;
}

// Claude's sandbox needs the same remedy, but as a STABLE directory. Per-file allowRead grants
// materialize as binds, and a SYMLINK entry cannot be bound — on a host whose ~/.local/bin
// toolchain shims are symlinks (rather than real files) every shim silently vanishes inside the
// sandbox while plain binaries survive, so `node` stops existing in exactly the runs that were
// granted it. A real directory of direct symlinks to the resolved targets keeps symlink
// semantics through a whole-directory grant; prepending it to the child PATH makes the shims
// resolvable again. Content-addressed under the gateway runtime so the settings digest and warm
// fingerprints stay stable until the host toolchain actually changes — which then retires warm
// processes, exactly as a toolchain change should.
export async function materializeStableToolchainLaunchers(options = {}) {
  const launchers = toolchainLauncherEntries(options);
  if (launchers.length === 0) return "";
  const digest = createHash("sha256")
    .update(launchers.map(({ name, target }) => `${name}\0${target}\n`).join(""))
    .digest("hex")
    .slice(0, 24);
  const container = path.join(gatewayRoot(), "runtime", "toolchain-bin");
  const binDir = path.join(container, digest);
  if (await exists(binDir)) return binDir;
  // Publish atomically: concurrent first runs may race on the same digest, and a half-written
  // directory on the final path would hand a run a toolchain with missing entries.
  const staging = path.join(container, `.${digest}-${randomUUID()}.tmp`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const { name, target } of launchers) await symlink(target, path.join(staging, name));
  try {
    await rename(staging, binDir);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code) || !(await exists(binDir))) throw error;
    await rm(staging, { recursive: true, force: true });
  }
  return binDir;
}

export async function createRunGrantArtifacts({
  slug,
  meta = {},
  userSkills = [],
  sharedSkills = [],
  workspaceSkillsDir = "",
  workspaceAgentsDir = "",
  librarySkillsToken = "",
  needsClaudeSettings = false,
  allowBypass = false,
  target = null,
} = {}) {
  // WHERE this run's engine-facing files go. A host run keeps every path exactly as it always
  // was: a mkdtemp under the gateway's run-tmp dir, the stable settings/plugin roots inside the
  // channel's metadata folder. An ISOLATED run may not be handed a single path under the gateway
  // root — that tree is never mounted into a container — so all of it moves under the channel's
  // artifact dir, which the backend bind-mounts at the IDENTICAL absolute path. Same 0700/0600
  // modes, same content-addressed layout, same cleanup.
  const isolated = runtimeSupports(target, "isolated");
  // Fail loudly rather than quietly writing under the gateway root: a containerized engine cannot
  // open a path there, so falling back would produce a run whose settings and MCP config silently
  // do not exist on the side that has to read them.
  if (isolated && !target?.artifactDir) {
    throw new Error("an isolated runtime target must carry an artifactDir — a containerized engine has nowhere else to read this run's files from");
  }
  const containerHomes = engineHomesFor(target);
  const artifactRoot = isolated ? target.artifactDir : runTmpDir();
  const runsRoot = isolated ? path.join(artifactRoot, "runs") : artifactRoot;
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(runsRoot, "grants-"));
  try {
    // Everything below is HOST plumbing that an isolated run neither needs nor may have: the
    // stable Claude state dir (whose projects/sessions/tasks are symlinks into the operator's own
    // ~/.claude — mounting it would expose every transcript on the box), the per-run Codex
    // synthetic HOME with its credential symlinks, and both toolchain launcher directories (the
    // image ships its own node/npm/gh on PATH). The container's HOME is a per-channel volume, so
    // the engines are simply told where it is.
    const { claudeHome, claudeConfigDir, claudeStateDir } = containerHomes || (await stableClaudeState());

    // Codex discovers personal skills from both CODEX_HOME/skills and HOME/.agents/skills. Keep
    // CODEX_HOME stable and grant-free for resumable state, and isolate every run's grants under
    // its synthetic HOME. This avoids both cross-user skill leakage and disposable rollout paths.
    const codexUserHome = containerHomes ? containerHomes.codexUserHome : path.join(root, "codex-user-home");
    const { codexHome, codexStateDir } = containerHomes || (await stableCodexState());
    // The per-run Codex skill overlay lives under that synthetic HOME, so an isolated run has
    // nowhere host-side to put it (HOME is inside the channel's volume). "" = no overlay dir,
    // which is also no Codex sandbox read-grant — correct, since the engine's own sandbox is off
    // behind the OS boundary.
    const codexSkillsDir = containerHomes ? "" : path.join(codexUserHome, ".agents", "skills");
    if (codexSkillsDir) await mkdir(codexSkillsDir, { recursive: true, mode: 0o700 });
    const codexToolchainBinDir = containerHomes
      ? ""
      : await materializeCodexToolchainLaunchers(root, { root: gatewayRoot(), integrations: getCliIntegrations() });
    const toolchainBinDir = containerHomes
      ? ""
      : await materializeStableToolchainLaunchers({ root: gatewayRoot(), integrations: getCliIntegrations() });
    // Codex's synthetic HOME is per RUN, so suppression here is a real "never linked" (Claude's
    // home is shared between channels, where the same rule is enforced by the sandbox instead).
    const credentialHomePaths = containerHomes
      ? []
      : getCredentialHomePaths({ suppress: hostCredentialSuppressedBy(Object.keys(normalizeChannelEnv(meta.env))) });
    for (const name of credentialHomePaths) {
      await linkIfPresent(os.homedir(), codexUserHome, name);
    }
    // Same narrow tooling state Claude receives for write + approved-network runs. Return both the
    // synthetic paths and their resolved targets: OS sandboxes may authorize a symlink at either
    // lookup stage. The Codex runner grants these only in approved mode, never network-off.
    const codexCredentialPaths = [];
    for (const name of credentialHomePaths) {
      const source = path.join(os.homedir(), name);
      if (!(await exists(source))) continue;
      codexCredentialPaths.push(path.join(codexUserHome, name));
      try { codexCredentialPaths.push(await realpath(source)); } catch { /* vanished after exists */ }
    }
    const codexCopied = codexSkillsDir ? await enableSkills(codexSkillsDir, userSkills) : { enabled: [], missing: [] };
    if (codexSkillsDir) await applyLibrarySkillsToDir(codexSkillsDir, librarySkillsToken);

    const claudePluginDirs = [];
    let missingSkills = [...codexCopied.missing];
    // The two content-addressed roots a warm process keeps reading between turns. Host: the
    // channel's metadata folder, as before. Isolated: the artifact dir, mounted at the same
    // absolute path inside the container so the digest path the engine was given resolves there.
    const stableArtifactRoot = isolated ? artifactRoot : path.join(channelFolder(slug, meta?.platform), "runtime");

    // Org/channel + gateway-generated skills are immutable content-addressed plugins. Their path
    // stays stable while content stays stable, so a normal warm process can be reused safely; a
    // grant/body update changes the path and therefore the warm fingerprint.
    if (sharedSkills.length > 0 || workspaceSkillsDir || workspaceAgentsDir) {
      const staging = path.join(root, "shared-plugin-staging");
      const shared = await materializePlugin({
        pluginDir: staging,
        name: "gateway-shared-skills",
        description: "Versioned organization, channel, and gateway skills and agents",
        skillNames: sharedSkills,
        workspaceSkillsDir,
        workspaceAgentsDir,
      });
      missingSkills = [...new Set([...missingSkills, ...shared.missing])];
      if (shared.populated) {
        const digest = await treeDigest(staging);
        const stableRoot = path.join(stableArtifactRoot, "claude-plugins");
        const stablePlugin = path.join(stableRoot, digest);
        await mkdir(stableRoot, { recursive: true, mode: 0o700 });
        if (await exists(stablePlugin)) await rm(staging, { recursive: true, force: true });
        else {
          try { await rename(staging, stablePlugin); } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(error?.code) || !(await exists(stablePlugin))) throw error;
            await rm(staging, { recursive: true, force: true });
          }
        }
        claudePluginDirs.push(stablePlugin);
      }
    }

    // User grants and library favorites can differ by author/token, so they remain per-run and
    // make only those Claude turns cold. They are deleted after the process exits.
    let claudePluginEphemeral = false;
    if (userSkills.length > 0 || librarySkillsToken) {
      const pluginDir = path.join(root, "user-grants-plugin");
      const personal = await materializePlugin({
        pluginDir,
        name: "gateway-user-grants",
        description: "Private skill grants for one gateway run",
        skillNames: userSkills,
        librarySkillsToken,
      });
      missingSkills = [...new Set([...missingSkills, ...personal.missing])];
      if (personal.populated) {
        claudePluginDirs.push(pluginDir);
        claudePluginEphemeral = true;
      }
    }

    let settingsFile = "";
    if (needsClaudeSettings) {
      const settings = await buildSettings({ ...meta, _slug: slug }, { allowBypass, target });
      // Re-allow only skill plugin roots below the denied runtime. Claude/Codex auth/session
      // siblings remain inaccessible to model-generated tools. An isolated target has no sandbox
      // block to carve into — the OS boundary is the confinement, and the plugin dirs are inside
      // the mounted artifact dir already.
      for (const pluginDir of settings.sandbox ? claudePluginDirs : []) {
        const sandboxPath = `/${path.resolve(pluginDir).replace(/^\/+/, "")}`;
        settings.sandbox.filesystem.allowRead = [...new Set([...settings.sandbox.filesystem.allowRead, sandboxPath])];
      }
      const content = `${JSON.stringify(settings, null, 2)}\n`;
      const digest = createHash("sha256").update(content).digest("hex").slice(0, 24);
      const settingsRoot = path.join(stableArtifactRoot, "claude-settings");
      settingsFile = path.join(settingsRoot, `${digest}.json`);
      await mkdir(settingsRoot, { recursive: true, mode: 0o700 });
      if (!(await exists(settingsFile))) {
        // Publish only a complete JSON file. Concurrent first runs may create the same digest;
        // atomic rename means Claude can never observe the truncate/write window of writeFile on
        // the final path. POSIX replaces with identical content; Windows may report destination
        // exists, which is equally successful after another publisher won the race.
        const temporary = path.join(settingsRoot, `.${digest}-${randomUUID()}.tmp`);
        await writeFile(temporary, content, { mode: 0o600 });
        try { await rename(temporary, settingsFile); } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code) || !(await exists(settingsFile))) throw error;
        } finally {
          await rm(temporary, { force: true }).catch(() => {});
        }
      }
    }

    return {
      settingsFile,
      claudePluginDirs,
      claudePluginEphemeral,
      claudeHome,
      claudeConfigDir,
      claudeStateDir,
      codexUserHome,
      codexHome,
      codexStateDir,
      codexSkillSupportDir: codexSkillsDir,
      codexCredentialPaths: [...new Set(codexCredentialPaths)],
      codexToolchainBinDir,
      toolchainBinDir,
      missingSkills,
      // Every engine-facing path this run produced sits under one root (the mkdtemp above for the
      // per-run pieces; the content-addressed stable roots survive on purpose, as they always did).
      artifactRoot,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
