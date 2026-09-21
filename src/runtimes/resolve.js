// resolveRuntime(): the ONE place that builds the RuntimeTarget every backend call receives.
// Container is the universal default. The only channel-turn exception is `meta.sudoMode`, a
// transient fact run.js adds after it verifies BOTH the sticky thread flag and the current author's
// admin status. It is never a stored channel setting or API override.
// Clean mode keeps the same backend: the bare clean workspace is mounted next to the workdir.
// Background jobs, memory-review runs and scheduled runs resolve through here at THEIR OWN spawn
// time — they outlive the turn that created them.
import { effectiveWorkDir } from "../gateway/folders.js";
import { channelArtifactDir, cleanWorkspaceFolder } from "../config/paths.js";
import { getContainerRuntime } from "../config/settings.js";
import { platformOr } from "../platforms/registry.js";
import { DEFAULT_RUNTIME_BACKEND, isRuntimeBackendId, runtimeBackend } from "./registry.js";
import { hasSudoRuntimeAuthority } from "./sudo-authority.js";

// Kept as a function so every caller asks "where does this turn run?" through one door. Stored
// channel metadata always resolves to the container; only run.js may add the transient sudo fact.
export function decideRuntimeBackend(meta = {}) {
  return hasSudoRuntimeAuthority(meta)
    ? { backend: "host", reason: "thread-sudo" }
    : { backend: DEFAULT_RUNTIME_BACKEND, reason: "default" };
}

/**
 * @param {string} slug
 * @param {object} meta                 the effective channel meta
 * @param {object} [options]
 * @param {object} [options.settings]   the container-runtime settings snapshot
 */
export function resolveRuntime(slug, meta = {}, { settings = getContainerRuntime(), backend: forced = "" } = {}) {
  const platform = platformOr(meta?.platform).id;
  const decided = decideRuntimeBackend(meta);
  const { backend: id, reason } = isRuntimeBackendId(forced)
    ? { backend: forced, reason: "session-carry" }
    : decided;
  const backend = runtimeBackend(id);
  const cwd = effectiveWorkDir(slug, meta);
  const workDir = meta?.cleanMode ? effectiveWorkDir(slug, { ...meta, cleanMode: false }) : cwd;
  const base = {
    backend: id,
    runtime: backend,
    reason,
    slug,
    platform,
    meta,
    cwd,
    workDir,
    cleanWorkDir: cleanWorkspaceFolder(slug, platform),
    artifactDir: id === "container" ? channelArtifactDir(slug, platform) : null,
    settings,
    container: null,
  };
  return backend.prepareTarget(base);
}
