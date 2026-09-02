// resolveRuntime(): the ONE place that decides which backend a channel's runs use, and builds the
// RuntimeTarget every backend call receives. Precedence (plan §4 of the P1 brief):
//
//   containerRuntimeEnabled === false → host    the gateway-wide kill switch (v0.8 rollback lever)
//   channel in admin mode             → host    admin channels are honestly unconfined (plan §5/§9)
//   meta.runtime = "host"|"container" → that    the per-channel setting
//   otherwise                         → the gateway default backend (host until rollout flips it)
//
// Clean mode keeps the channel's backend: the bare clean workspace is mounted next to the workdir.
// Background jobs, memory-review runs and scheduled runs resolve through here at THEIR OWN spawn
// time — they outlive the turn that created them (plan §5).
import { effectiveWorkDir } from "../gateway/folders.js";
import { channelArtifactDir, cleanWorkspaceFolder } from "../config/paths.js";
import { getContainerRuntime } from "../config/settings.js";
import { platformOr } from "../platforms/registry.js";
import { isRuntimeBackendId, runtimeBackend } from "./registry.js";

export function decideRuntimeBackend(meta = {}, settings = getContainerRuntime()) {
  if (!settings?.enabled) return { backend: "host", reason: "disabled" };
  if (meta?.adminMode) return { backend: "host", reason: "admin-mode" };
  const pinned = String(meta?.runtime || "").trim();
  if (isRuntimeBackendId(pinned)) return { backend: pinned, reason: "channel" };
  return { backend: settings.defaultBackend === "container" ? "container" : "host", reason: "default" };
}

/**
 * @param {string} slug
 * @param {object} meta                 the effective channel meta
 * @param {object} [options]
 * @param {object} [options.settings]   the container-runtime settings snapshot
 * @param {string} [options.backend]    FORCE a backend, bypassing the precedence above. The one
 *   caller is the session carry-over (src/gateway/session-carry.js), which has to address the
 *   channel's OTHER environment — the container a thread's history is still sitting in, after the
 *   channel itself has moved back to the host. It is deliberately not reachable from a channel
 *   setting, an API override or a chat directive: this is "look at the environment that is not
 *   running this turn", never "run this turn somewhere else".
 */
export function resolveRuntime(slug, meta = {}, { settings = getContainerRuntime(), backend: forced = "" } = {}) {
  const platform = platformOr(meta?.platform).id;
  const decided = decideRuntimeBackend(meta, settings);
  const { backend: id, reason } = isRuntimeBackendId(forced) ? { backend: forced, reason: "override" } : decided;
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
