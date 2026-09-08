// Boot + housekeeping for the skills platform: fill the catalog from what this host already has
// (the bundled starter library, the operator's skill folders), seed the built-in templates, and
// keep git sources synced on a timer. Everything is best-effort and logged — the catalog is a
// convenience for every turn, never a reason a turn cannot run.
import { readFileSync } from "node:fs";
import { importBundledSkills, importHostSkillFolders, importSkillTree } from "./import-folder.js";
import { seedBuiltinTemplates } from "./templates.js";
import { syncGitSource } from "./git-sync.js";
import { syncGatewaySource } from "./peer-sync.js";
import { listSources, getSource, sourceSecret, catalogStats, recordSourceSync } from "./catalog.js";
import { skillSourceDirs } from "../folders.js";
import { getSkillsSyncIntervalMinutes } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";
import { retireStandaloneGatewaySkills } from "./retire.js";
import { syncWorkspaceSkills, startWorkspaceSkillSync } from "./workspace-sync.js";

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version || "";
  } catch {
    return "";
  }
}

// Import bundled + host-folder skills and seed templates. Returns a summary for the boot log.
export async function bootSkillsPlatform({ log = console.log } = {}) {
  const summary = { bundled: null, host: null, retired: null, templates: [], stats: null, errors: [] };
  try {
    summary.bundled = await importBundledSkills({ version: packageVersion() });
  } catch (err) {
    summary.errors.push(`bundled: ${err?.message || err}`);
  }
  try {
    summary.host = await importHostSkillFolders(skillSourceDirs());
  } catch (err) {
    summary.errors.push(`host folders: ${err?.message || err}`);
  }
  try {
    summary.retired = retireStandaloneGatewaySkills();
  } catch (err) {
    summary.errors.push(`retired built-ins: ${err?.message || err}`);
  }
  try {
    summary.templates = seedBuiltinTemplates();
  } catch (err) {
    summary.errors.push(`templates: ${err?.message || err}`);
  }
  try {
    summary.stats = catalogStats();
  } catch {
    /* stats are informational */
  }
  try {
    summary.workspaces = await syncWorkspaceSkills({ log });
    summary.errors.push(...summary.workspaces.failed.map((item) => `workspace ${item.slug}: ${item.error}`));
  } catch (err) {
    summary.errors.push(`workspaces: ${err?.message || err}`);
  }
  const hostImported = (summary.host?.results || []).reduce((n, r) => n + r.imported.length, 0);
  const hostSkills = (summary.host?.results || []).reduce((n, r) => n + r.presentSlugs.length, 0);
  log(
    `[skills] catalog ready: ${summary.stats?.skills ?? "?"} skills (bundled ${summary.bundled?.presentSlugs.length ?? 0}, host folders ${hostSkills}${hostImported ? `, ${hostImported} new/changed` : ""}${summary.host?.tombstoned ? `, ${summary.host.tombstoned} tombstoned` : ""}), ${summary.stats?.sources ?? 0} sources, ${summary.stats?.templates ?? 0} templates${summary.templates.length ? ` (seeded ${summary.templates.join(", ")})` : ""}${summary.errors.length ? ` — errors: ${summary.errors.join("; ")}` : ""}`,
  );
  return summary;
}

// A folder source imports a host directory the way git sync imports a tarball, recording the same
// last-sync state on the source row.
export async function syncFolderSource(source) {
  const src = getSource(typeof source === "number" ? source : source?.id) || source;
  const result = await importSkillTree(src.url, { ownerKind: "git", sourceId: src.id, sourceRef: src.url, status: src.mode === "auto" ? "active" : "staged", requireRoot: true });
  const stats = {
    discovered: result.presentSlugs.length + result.conflicts.length,
    created: result.imported.filter((x) => x.created).length,
    updated: result.imported.filter((x) => !x.created).length,
    staged: src.mode === "auto" ? 0 : result.imported.length,
    unchanged: result.unchanged.length,
    tombstoned: 0,
    conflicts: result.conflicts,
    errors: result.errors,
  };
  const ok = result.errors.length === 0;
  recordSourceSync(src.id, { ok, ref: "", error: ok ? "" : result.errors.map((e) => `${e.slug}: ${e.error}`).join("; "), stats });
  return { ok, error: ok ? "" : stats.errors.map((e) => e.error).join("; "), ...stats, ...result };
}

// Sync ONE source of any kind (git / folder / gateway) and log the outcome.
export async function syncOneSource(id, { log = console.log, fetchImpl = fetch } = {}) {
  const src = getSource(Number(id));
  if (!src) throw new Error(`source #${id} not found`);
  let r;
  if (src.kind === "git") r = await syncGitSource(src, { token: sourceSecret(src.id), fetchImpl, log });
  else if (src.kind === "gateway") r = await syncGatewaySource(src, { log });
  else r = await syncFolderSource(src);
  if (r.ok) log(`[skills] synced ${src.url}: ${r.discovered} skills (${r.created} new, ${r.updated} updated, ${r.staged} staged, ${r.unchanged} unchanged${r.tombstoned ? `, ${r.tombstoned} removed` : ""}${r.conflicts?.length ? `, ${r.conflicts.length} conflicts` : ""})`);
  else log(`[skills] sync FAILED for ${src.url}: ${r.error}`);
  logEvent("skill_source_sync", { source: src.id, kind: src.kind, ok: r.ok, discovered: r.discovered, created: r.created, updated: r.updated, staged: r.staged, tombstoned: r.tombstoned, error: r.ok ? "" : r.error });
  return { id: src.id, url: src.url, kind: src.kind, ...r };
}

// Sync every enabled source, one after another; one failure never stops the others.
export async function runScheduledSkillSync({ log = console.log, fetchImpl = fetch } = {}) {
  const results = [];
  for (const src of listSources()) {
    if (!src.enabled) continue;
    try {
      results.push(await syncOneSource(src.id, { log, fetchImpl }));
    } catch (err) {
      results.push({ id: src.id, url: src.url, kind: src.kind, ok: false, error: err?.message || String(err), discovered: 0, created: 0, updated: 0, staged: 0, unchanged: 0, tombstoned: 0, conflicts: [] });
    }
  }
  return results;
}

// Webhook-triggered sync: coalesce bursts of pushes into one sync per source.
const pendingWebhookSyncs = new Map();
export function triggerSourceSync(id, { delayMs = 5000, log = console.log } = {}) {
  const key = Number(id);
  if (pendingWebhookSyncs.has(key)) return false;
  const timer = setTimeout(() => {
    pendingWebhookSyncs.delete(key);
    syncOneSource(key, { log }).catch((err) => log(`[skills] webhook sync failed for source #${key}: ${err?.message || err}`));
  }, delayMs);
  timer.unref?.();
  pendingWebhookSyncs.set(key, timer);
  return true;
}

// The sync timer. Interval comes from settings (minutes; 0 = off). A first pass runs shortly
// after boot when any git source exists, so a restart never leaves sources stale for an hour.
export function startSkillsSync({ log = console.log, initialDelayMs = 30_000, fetchImpl = fetch } = {}) {
  const workspaces = startWorkspaceSkillSync({ log });
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (listSources().some((s) => s.enabled && s.kind !== "folder")) await runScheduledSkillSync({ log, fetchImpl });
    } catch (err) {
      log(`[skills] scheduled sync failed: ${err?.message || err}`);
    } finally {
      running = false;
    }
  };
  const minutes = getSkillsSyncIntervalMinutes();
  if (minutes > 0) {
    timer = setInterval(tick, minutes * 60_000);
    timer.unref?.();
    const first = setTimeout(tick, initialDelayMs);
    first.unref?.();
  }
  return {
    stop() {
      workspaces.stop();
      if (timer) clearInterval(timer);
      timer = null;
    },
    runNow: tick,
  };
}
