// resolveRuntime(): the ONE place that builds the RuntimeTarget every backend call receives.
// Container is the universal default. Host execution requires process-local sudo authority that
// run.js mints after checking the author's CURRENT admin rank and an explicit sudo thread, sudo
// schedule, or submitted form from such a schedule. A stored sudoMode field grants nothing.
// Clean mode keeps the same backend: the bare clean workspace is mounted next to the workdir.
// Background jobs, memory-review runs and scheduled runs resolve through here at THEIR OWN spawn
// time — they outlive the turn that created them.
import { effectiveWorkDir } from "../gateway/folders.js";
import { forbiddenWorkDirMessage, forbiddenWorkDirReason } from "../gateway/workdir-boundary.js";
import { cleanWorkspaceFolder } from "../config/paths.js";
import { getContainerRuntime } from "../config/settings.js";
import { platformOr } from "../platforms/registry.js";
import { DEFAULT_RUNTIME_BACKEND, isRuntimeBackendId, runtimeBackend } from "./registry.js";
import { runtimeArtifactDir } from "./container/names.js";
import { hasSudoRuntimeAuthority } from "./sudo-authority.js";

// Kept as a function so every caller asks "where does this turn run?" through one door. Stored
// channel metadata always resolves to the container; only authorized daemon paths may add proof.
export function decideRuntimeBackend(meta = {}) {
  return hasSudoRuntimeAuthority(meta)
    ? { backend: "host", reason: "thread-sudo" }
    : { backend: DEFAULT_RUNTIME_BACKEND, reason: "default" };
}

/**
 * @param {string} slug
 * @param {object} meta                 the effective channel meta
 * @param {object} [options]
 * @param {boolean} [options.isAdminAuthor] verified current principal rank; defaults to project-only
 * @param {object} [options.settings]   the container-runtime settings snapshot
 */
export function resolveRuntime(slug, meta = {}, { settings = getContainerRuntime(), backend: forced = "", isAdminAuthor = false } = {}) {
  const platform = platformOr(meta?.platform).id;
  const decided = decideRuntimeBackend(meta);
  const { backend: id, reason } = isRuntimeBackendId(forced)
    ? { backend: forced, reason: "session-carry" }
    : decided;
  const backend = runtimeBackend(id);
  // A stored custom work folder that is one of the daemon's own trees, or another conversation's
  // folder, is never mounted: the spawn fails closed with the remedy instead of handing that
  // directory to a container (src/gateway/workdir-boundary.js). Checked at every spawn — turns,
  // background jobs, schedules and reviews all come through here.
  const stored = String(meta?.workDir || "").trim();
  if (stored) {
    const reason = forbiddenWorkDirReason(stored, { slug });
    if (reason) throw new Error(forbiddenWorkDirMessage(slug, stored, reason));
  }
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
    artifactDir: id === "container" ? runtimeArtifactDir(slug, platform, isAdminAuthor === true ? "admin" : "project") : null,
    settings,
    // Trusted caller option, never channel metadata or a caller-supplied author attribution.
    runtimeScope: isAdminAuthor === true ? "admin" : "project",
    container: null,
  };
  return backend.prepareTarget(base);
}

export { runtimeArtifactDir } from "./container/names.js";
