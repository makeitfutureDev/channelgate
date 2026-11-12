import { enterpriseFeatureEnabled } from "../../ee/feature-entitlements.js";
// Daemon-owned convergence for durable, locally visible skills. MCP processes only commit
// catalog/grant changes; the daemon observes them here, so two processes never prune each
// other's in-progress materialization. Personal grants belong to individual runs, never here.
import { workspaceSetup } from "../../config/workspace-links.js";
import { createHash } from "node:crypto";
import { listChannels, getChannelMeta } from "../../config/store.js";
import { getOrgAccessGrants } from "../../config/settings.js";
import { platformFolderName } from "../../platforms/registry.js";
import { listSkills, listTemplates } from "./catalog.js";
import { channelSkillGrants } from "./templates.js";
import { withDependencies } from "./resolve.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

let lastFingerprint = "";
let pending = Promise.resolve();
// Signature of the inputs each workspace was last materialized from. A non-forced pass skips a
// channel whose signature is unchanged: a membership flip (pending ↔ member on every Socket Mode
// disconnect/reconnect) changes the PASS fingerprint without changing any folder's inputs, and
// used to rebuild every workspace twice per hiccup. Forced and targeted passes always rebuild.
const materialized = new Map();

async function snapshot() {
  const channels = (await listChannels()).filter((channel) => channel.meta && !channel.meta.archived && channel.meta.botMembership !== "pending");
  const organization = getOrgAccessGrants();
  const shared = digest({
    organization,
    templates: listTemplates(),
    skillTemplatesEnabled: enterpriseFeatureEnabled("skillTemplates"),
    // No file bytes or private skills are needed to detect effective revision changes.
    catalog: listSkills({ viewer: "", includeDeleted: true }).map((skill) => ({
      slug: skill.slug, revision: skill.currentRevisionId, pinned: skill.pinnedRevisionId,
      deleted: skill.deleted, visibility: skill.visibility, channelScope: skill.channelScope,
      updatedAt: skill.updatedAt,
    })),
  });
  const entries = channels.map(({ slug, meta }) => ({
    slug, channelId: meta.channelId, platform: meta.platform, workDir: meta.workDir,
    skills: meta.skills, skillTemplate: meta.skillTemplate, cleanMode: meta.cleanMode, memory: meta.memory,
  }));
  const signatures = new Map(entries.map((entry) => [entry.slug, digest({ shared, channel: entry })]));
  return { channels, organization, fingerprint: digest({ shared, channels: entries }), signatures };
}

function selectionSignature(meta, organization) {
  meta = workspaceSetup(meta);
  const grants = withDependencies([...(organization.skills || []), ...channelSkillGrants(meta)]).names.sort();
  return JSON.stringify({ grants, platform: platformFolderName(meta.workspaceLink?.platform || meta.platform), memory: meta.memory !== false });
}

// The same rule applies at every run/save boundary, including after a rejected but persisted
// admin edit. A later foreground run must not silently overwrite the other conversation's tree.
export async function assertWorkspaceSkillsCompatible(slug, meta) {
  const { effectiveWorkDir } = await import("../folders.js");
  const cwd = effectiveWorkDir(slug, { ...meta, cleanMode: false });
  const organization = getOrgAccessGrants();
  const signature = selectionSignature(meta, organization);
  for (const channel of await listChannels()) {
    if (!channel.meta || channel.meta.archived || channel.slug === slug) continue;
    if (effectiveWorkDir(channel.slug, { ...channel.meta, cleanMode: false }) !== cwd) continue;
    if (selectionSignature(channel.meta, organization) !== signature) {
      throw Object.assign(new Error("The linked working-folder setup could not be resolved. Open the source conversation in Settings and repair its folder assignment."), { code: "workspace_selection_conflict" });
    }
  }
}

// Folder work is synchronous underneath (realpath/stat, the SQLite reads); a pass over every
// channel must hand the event loop back between channels or Socket Mode misses its pings.
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

async function syncPass({ channelSlugs = null, force = true, log = console.warn } = {}) {
  const state = await snapshot();
  if (!force && !channelSlugs && state.fingerprint === lastFingerprint) {
    return { ok: true, synced: [], skipped: [], failed: [], warnings: [], unchanged: true };
  }
  // folders → templates is an existing dependency; keep the return edge lazy.
  const { ensureChannelFolder, effectiveWorkDir } = await import("../folders.js");
  const selected = channelSlugs ? new Set(channelSlugs) : null;
  const destinations = new Map();
  for (const channel of state.channels) {
    const cwd = effectiveWorkDir(channel.slug, { ...channel.meta, cleanMode: false });
    const signature = selectionSignature(channel.meta, state.organization);
    if (!destinations.has(cwd)) destinations.set(cwd, new Set());
    destinations.get(cwd).add(signature);
  }
  const result = { ok: true, synced: [], skipped: [], failed: [], warnings: [], unchanged: false };
  for (const channel of state.channels) {
    if (selected && !selected.has(channel.slug)) continue;
    const signature = state.signatures.get(channel.slug);
    if (!force && !selected && materialized.get(channel.slug) === signature) {
      result.skipped.push(channel.slug);
      continue;
    }
    try {
      // Read again at the write boundary, so a queued UI save uses the committed record.
      const meta = await getChannelMeta(channel.slug);
      if (!meta || meta.archived) continue;
      const cwd = effectiveWorkDir(channel.slug, { ...meta, cleanMode: false });
      if (destinations.get(cwd)?.size > 1) {
        throw new Error("The linked working-folder setup could not be synchronized. Check the source conversation in Settings.");
      }
      // The destination map above IS the shared-folder conflict check for this pass; re-running
      // the per-channel assertion inside ensureChannelFolder would scan every channel for every
      // channel (quadratic in the deployment size, all of it blocking filesystem work).
      const folder = await ensureChannelFolder(channel.slug, meta, { workspaceConflictsChecked: true });
      materialized.set(channel.slug, signature);
      if (folder.skillSync?.missing?.length) result.warnings.push({ slug: channel.slug, missing: folder.skillSync.missing });
      result.synced.push(channel.slug);
    } catch (error) {
      materialized.delete(channel.slug);
      if (["channel_archived", "channel_membership_unverified"].includes(error?.code)) {
        // Verification can change without a catalog edit; retry this pass after readiness returns.
        result.deferred = true;
        continue;
      }
      result.ok = false;
      const failure = { slug: channel.slug, error: error?.message || String(error) };
      result.failed.push(failure);
      log(`[skills] workspace sync failed for ${failure.slug}: ${failure.error}`);
    } finally {
      await yieldToEventLoop();
    }
  }
  // Failed passes retry even without another catalog change. A targeted pass cannot certify
  // other folders against this fingerprint, and a concurrent change is caught next time.
  if (result.ok && !result.deferred && !selected) lastFingerprint = state.fingerprint;
  return result;
}

export function syncWorkspaceSkills(options = {}) {
  const run = pending.catch(() => {}).then(() => syncPass(options));
  pending = run;
  return run;
}

// What a successful membership verification owes the workspaces: a catch-up for the channels it
// RESTORED (the bot was re-invited while the gateway could not see it), and nothing else. The
// routine periodic pass finds nothing restored and must not touch a folder — forcing a full
// rebuild here every five minutes is what stalled a 140-channel deployment until Slack dropped it.
export function syncRestoredWorkspaces(result = {}) {
  const restored = Array.isArray(result?.restored) ? result.restored.filter(Boolean) : [];
  if (!restored.length) return Promise.resolve({ ok: true, synced: [], skipped: [], failed: [], warnings: [], unchanged: true });
  return syncWorkspaceSkills({ channelSlugs: restored });
}

export async function syncWorkspaceSkillsOrThrow(options = {}) {
  let result;
  try {
    result = await syncWorkspaceSkills(options);
  } catch (error) {
    result = { ok: false, synced: [], skipped: [], warnings: [], failed: [{ slug: "workspace catalog", error: error?.message || String(error) }] };
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
