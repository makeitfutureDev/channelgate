// resolveRuntime(): the ONE place that builds the RuntimeTarget every backend call receives.
//
// Since 2026-09-03 there is exactly one channel runtime — the container backend — so there is no
// precedence table any more: no gateway kill switch, no per-channel pin, and admin-mode channels
// run in containers like every other channel (their work folder is bind-mounted read-write, which
// is the trust the admin mode carries; the container is still the boundary around everything else).
// Clean mode keeps the same backend: the bare clean workspace is mounted next to the workdir.
// Background jobs, memory-review runs and scheduled runs resolve through here at THEIR OWN spawn
// time — they outlive the turn that created them.
import { effectiveWorkDir } from "../gateway/folders.js";
import { channelArtifactDir, cleanWorkspaceFolder } from "../config/paths.js";
import { getContainerRuntime } from "../config/settings.js";
import { platformOr } from "../platforms/registry.js";
import { DEFAULT_RUNTIME_BACKEND, runtimeBackend } from "./registry.js";

// Kept as a function so the admin API and the MCP tools can keep asking "where does this channel
// run?" through one door; the answer is always the container backend now.
export function decideRuntimeBackend() {
  return { backend: DEFAULT_RUNTIME_BACKEND, reason: "only-runtime" };
}

/**
 * @param {string} slug
 * @param {object} meta                 the effective channel meta
 * @param {object} [options]
 * @param {object} [options.settings]   the container-runtime settings snapshot
 */
export function resolveRuntime(slug, meta = {}, { settings = getContainerRuntime() } = {}) {
  const platform = platformOr(meta?.platform).id;
  const { backend: id, reason } = decideRuntimeBackend();
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
    artifactDir: channelArtifactDir(slug, platform),
    settings,
    container: null,
  };
  return backend.prepareTarget(base);
}
