// Daemon-owned convergence for durable, locally visible skills. MCP processes only commit
// catalog/grant changes; the daemon observes them here, so two processes never prune each
// other's in-progress materialization. Personal grants belong to individual runs, never here.
import { createHash } from "node:crypto";
import { listChannels, getChannelMeta } from "../../config/store.js";
import { getOrgAccessGrants } from "../../config/settings.js";
import { platformFolderName } from "../../platforms/registry.js";
import { listSkills, listTemplates } from "./catalog.js";
import { channelSkillGrants } from "./templates.js";
import { withDependencies } from "./resolve.js";

let lastFingerprint = "";
let pending = Promise.resolve();

async function snapshot() {
  const channels = (await listChannels()).filter((channel) => channel.meta);
  const organization = getOrgAccessGrants();
  const fingerprint = createHash("sha256").update(JSON.stringify({
    organization,
    templates: listTemplates(),
    // No file bytes or private skills are needed to detect effective revision changes.
    catalog: listSkills({ viewer: "", includeDeleted: true }).map((skill) => ({
      slug: skill.slug, revision: skill.currentRevisionId, pinned: skill.pinnedRevisionId,
      deleted: skill.deleted, visibility: skill.visibility, channelScope: skill.channelScope,
      updatedAt: skill.updatedAt,
    })),
    channels: channels.map(({ slug, meta }) => ({
      slug, channelId: meta.channelId, platform: meta.platform, workDir: meta.workDir,
      skills: meta.skills, skillTemplate: meta.skillTemplate, cleanMode: meta.cleanMode,
    })),
  })).digest("hex");
  return { channels, organization, fingerprint };
}

async function syncPass({ channelSlugs = null, force = true, log = console.warn } = {}) {
  const state = await snapshot();
  if (!force && !channelSlugs && state.fingerprint === lastFingerprint) {
    return { ok: true, synced: [], failed: [], warnings: [], unchanged: true };
  }
  // folders → templates is an existing dependency; keep the return edge lazy.
  const { ensureChannelFolder, effectiveWorkDir } = await import("../folders.js");
  const selected = channelSlugs ? new Set(channelSlugs) : null;
  const destinations = new Map();
  for (const channel of state.channels) {
    const cwd = effectiveWorkDir(channel.slug, { ...channel.meta, cleanMode: false });
    const grants = withDependencies([...(state.organization.skills || []), ...channelSkillGrants(channel.meta)]).names.sort();
    const signature = JSON.stringify({ grants, platform: platformFolderName(channel.meta.platform) });
    if (!destinations.has(cwd)) destinations.set(cwd, new Set());
    destinations.get(cwd).add(signature);
  }
  const result = { ok: true, synced: [], failed: [], warnings: [], unchanged: false };
  for (const channel of state.channels) {
    if (selected && !selected.has(channel.slug)) continue;
    try {
      // Read again at the write boundary, so a queued UI save uses the committed record.
      const meta = await getChannelMeta(channel.slug);
      if (!meta) continue;
      const cwd = effectiveWorkDir(channel.slug, { ...meta, cleanMode: false });
      if (destinations.get(cwd)?.size > 1) {
        throw new Error("This working folder is assigned to conversations with different shared skill grants. Choose separate folders or align their grants.");
      }
      const folder = await ensureChannelFolder(channel.slug, meta);
      if (folder.skillSync?.missing?.length) result.warnings.push({ slug: channel.slug, missing: folder.skillSync.missing });
      result.synced.push(channel.slug);
    } catch (error) {
      result.ok = false;
      const failure = { slug: channel.slug, error: error?.message || String(error) };
      result.failed.push(failure);
      log(`[skills] workspace sync failed for ${failure.slug}: ${failure.error}`);
    }
  }
  // Failed passes retry even without another catalog change. A targeted pass cannot certify
  // other folders against this fingerprint, and a concurrent change is caught next time.
  if (result.ok && !selected) lastFingerprint = state.fingerprint;
  return result;
}

export function syncWorkspaceSkills(options = {}) {
  const run = pending.catch(() => {}).then(() => syncPass(options));
  pending = run;
  return run;
}

export async function syncWorkspaceSkillsOrThrow(options = {}) {
  let result;
  try {
    result = await syncWorkspaceSkills(options);
  } catch (error) {
    result = { ok: false, synced: [], warnings: [], failed: [{ slug: "workspace catalog", error: error?.message || String(error) }] };
  }
  if (!result.ok) {
    const error = new Error(`Saved, but workspace skills could not be synchronized: ${result.failed.map((item) => `${item.slug}: ${item.error}`).join("; ")}`);
    Object.assign(error, { code: "workspace_sync_failed", status: 503, saved: true, workspaceSync: result });
    throw error;
  }
  return result;
}

// Independent of remote source polling: disabling Git sync must not disable local grant
// revocations. This checks catalog state, not filesystem drift; boot and every run repair drift.
export function startWorkspaceSkillSync({ intervalMs = 5000, log = console.warn } = {}) {
  let running = false;
  const runNow = async () => {
    if (running) return;
    running = true;
    try {
      return await syncWorkspaceSkills({ force: false, log });
    } catch (error) {
      log(`[skills] workspace reconciliation failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(runNow, intervalMs);
  timer.unref?.();
  return { runNow, stop: () => clearInterval(timer) };
}
