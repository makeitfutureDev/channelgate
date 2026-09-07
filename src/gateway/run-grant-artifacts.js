// Engine-global discovery is outside the org/channel/user grant model, so every launch receives
// isolated state roots. Claude's auth/session root and shared skill plugins are stable + immutable
// to preserve safe warm sessions; user/library overlays and every Codex HOME are private per run.
import { createHash, randomUUID } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSettings, enableSkills } from "./folders.js";
import { ensureRealDir } from "./safe-fs.js";
import { parseFrontmatter, skillMetadata } from "./skills/frontmatter.js";

// ── Isolated-runtime engine homes ─────────────────────────────────────────────────────────────
// Inside a container the engine's HOME is the channel's own persistent volume (plan §5/§8), so
// logins, the npm prefix, Claude's transcripts and Codex's state are per channel and the
// operator's real ~/.claude / ~/.codex are never mounted. These are IN-CONTAINER paths: the daemon
// never creates or reads them, it only names them in the child's environment. The backend may
// publish its own (target.container.home …) — prefer that, so the image layout stays the
// container backend's fact and these literals are only the documented default.
export const CONTAINER_AGENT_HOME = "/home/agent";

export function engineHomesFor(target = null) {
  if (!target) return null;
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
    // Runtime-owned usage inspection reads CODEX_HOME inside the container. A volume's host
    // path is not a daemon-readable state directory under rootless Podman.
    codexStateDir: "",
  };
}

// Compatibility for callers refreshing artifacts after ensureUp: never publish a rootless
// volume path as readable state. Usage inspection now follows the resolved RuntimeTarget.
export function refreshRuntimeReadPaths(artifacts = {}, target = null) {
  if (target) artifacts.codexStateDir = "";
  return artifacts;
}

export function assertUserSkillOverlaySupported(adapter, userSkills = []) {
  if (userSkills.length > 0 && !adapter?.supports?.userSkillOverlay) {
    throw new Error(`${adapter?.label || adapter?.id || "Selected engine"} cannot isolate per-user skill grants; refusing the run`);
  }
}

const exists = async (file) => {
  try { await access(file); return true; } catch { return false; }
};

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
// is then allowed to read — a read escape from the daemon's filesystem into the run. Per-entry lstat closes the same hole
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

async function materializePlugin({ pluginDir, name, description, skillNames = [], workspaceSkillsDir = "", workspaceAgentsDir = "" }) {
  const skillsDir = path.join(pluginDir, "skills");
  await mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  // Engine plugins are immutable revision snapshots. A fresh materialization timestamp would
  // change their content hash on every turn and retire an otherwise reusable warm process.
  // Omit only that generated observation field here; ordinary workspace materialization keeps
  // its real timestamp, and all revision facts, skill bytes and grants remain fingerprinted.
  const copied = await enableSkills(skillsDir, skillNames, { recordMaterializationTime: false });
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

export async function createRunGrantArtifacts({
  slug,
  meta = {},
  userSkills = [],
  sharedSkills = [],
  workspaceSkillsDir = "",
  workspaceAgentsDir = "",
  needsClaudeSettings = false,
  allowBypass = false,
  target = null,
} = {}) {
  // WHERE this run's engine-facing files go: under the channel's artifact dir, which the container
  // backend bind-mounts at the IDENTICAL absolute path, so the settings copy, the MCP config file
  // and the plugin dirs resolve to the same string on both sides. Same 0700/0600 modes, same
  // content-addressed layout, same cleanup. Fail loudly rather than quietly writing under the
  // gateway root: a containerized engine cannot open a path there, so falling back would produce
  // a run whose settings and MCP config silently do not exist on the side that has to read them.
  if (!target?.artifactDir) {
    throw new Error("a runtime target must carry an artifactDir — a containerized engine has nowhere else to read this run's files from");
  }
  const containerHomes = engineHomesFor(target);
  const artifactRoot = target.artifactDir;
  const runsRoot = path.join(artifactRoot, "runs");
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(runsRoot, "grants-"));
  try {
    // The engines' homes are the channel's own HOME volume inside the container; the daemon only
    // names them in the child's environment and never creates or reads them (engineHomesFor).
    const { claudeHome, claudeConfigDir, claudeStateDir, codexUserHome, codexHome, codexStateDir } = containerHomes;
    // Codex keeps its persistent HOME/auth/session roots. Personal grants use an explicit
    // per-turn catalog pointing at the same ephemeral skill files Claude receives as a plugin;
    // they are usable instructions, not native slash-command registrations.
    const codexSkillsDir = "";
    const personalSkillCatalog = [];
    const claudePluginDirs = [];
    let missingSkills = [];
    // The two content-addressed roots a warm process keeps reading between turns live under the
    // artifact dir, mounted at the same absolute path inside the container so the digest path the
    // engine was given resolves there.
    const stableArtifactRoot = artifactRoot;

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

    // User grants differ by author, so they remain per-run and make only those Claude turns cold.
    // They are deleted after the process exits.
    let claudePluginEphemeral = false;
    if (userSkills.length > 0) {
      const pluginDir = path.join(root, "user-grants-plugin");
      const personal = await materializePlugin({
        pluginDir,
        name: "gateway-user-grants",
        description: "Private skill grants for one gateway run",
        skillNames: userSkills,
      });
      if (personal.missing.length) {
        throw new Error(`Personal skill grants could not be loaded: ${personal.missing.join(", ")}`);
      }
      if (personal.populated) {
        claudePluginDirs.push(pluginDir);
        claudePluginEphemeral = true;
        const personalDir = path.join(pluginDir, "skills");
        for (const entry of (await readdir(personalDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory()) continue;
          const file = path.join(personalDir, entry.name, "SKILL.md");
          const metadata = skillMetadata(parseFrontmatter(await readFile(file, "utf8")).data);
          personalSkillCatalog.push({ name: metadata.name || entry.name, description: metadata.description || `Personal skill ${entry.name}`, path: file });
        }
      }
    }

    let settingsFile = "";
    if (needsClaudeSettings) {
      const settings = await buildSettings({ ...meta, _slug: slug }, { allowBypass, target });
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
      personalSkillCatalog,
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
