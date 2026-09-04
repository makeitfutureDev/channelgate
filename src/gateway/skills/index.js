// Boot + housekeeping for the skills platform: fill the catalog from what this host already has
// (the bundled starter library, the operator's skill folders), seed the built-in templates, and
// keep git sources synced on a timer. Everything is best-effort and logged — the catalog is a
// convenience for every turn, never a reason a turn cannot run.
import { readFileSync } from "node:fs";
import { importBundledSkills, importHostSkillFolders } from "./import-folder.js";
import { seedBuiltinTemplates } from "./templates.js";
import { syncAllGitSources, syncGitSource } from "./git-sync.js";
import { listSources, catalogStats } from "./catalog.js";
import { skillSourceDirs } from "../folders.js";
import { getSkillsGithubToken, getSkillsSyncIntervalMinutes } from "../../config/settings.js";
import { logEvent } from "../../util/logger.js";

function packageVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version || "";
  } catch {
    return "";
  }
}

// Import bundled + host-folder skills and seed templates. Returns a summary for the boot log.
export async function bootSkillsPlatform({ log = console.log } = {}) {
  const summary = { bundled: null, host: null, templates: [], stats: null, errors: [] };
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
    summary.templates = seedBuiltinTemplates();
  } catch (err) {
    summary.errors.push(`templates: ${err?.message || err}`);
  }
  try {
    summary.stats = catalogStats();
  } catch {
    /* stats are informational */
  }
  const hostImported = (summary.host?.results || []).reduce((n, r) => n + r.imported.length, 0);
  const hostSkills = (summary.host?.results || []).reduce((n, r) => n + r.presentSlugs.length, 0);
  log(
    `[skills] catalog ready: ${summary.stats?.skills ?? "?"} skills (bundled ${summary.bundled?.presentSlugs.length ?? 0}, host folders ${hostSkills}${hostImported ? `, ${hostImported} new/changed` : ""}${summary.host?.tombstoned ? `, ${summary.host.tombstoned} tombstoned` : ""}), ${summary.stats?.sources ?? 0} sources, ${summary.stats?.templates ?? 0} templates${summary.templates.length ? ` (seeded ${summary.templates.join(", ")})` : ""}${summary.errors.length ? ` — errors: ${summary.errors.join("; ")}` : ""}`,
  );
  return summary;
}

// Run one sync of every enabled git source and log a one-line result per source.
export async function runScheduledSkillSync({ log = console.log, fetchImpl = fetch } = {}) {
  const results = await syncAllGitSources({ token: getSkillsGithubToken(), fetchImpl, log });
  for (const r of results) {
    if (r.ok) log(`[skills] synced ${r.url}: ${r.discovered} skills (${r.created} new, ${r.updated} updated, ${r.staged} staged, ${r.unchanged} unchanged${r.tombstoned ? `, ${r.tombstoned} removed` : ""}${r.conflicts.length ? `, ${r.conflicts.length} conflicts` : ""})`);
    else log(`[skills] sync FAILED for ${r.url}: ${r.error}`);
    logEvent("skill_source_sync", { source: r.id, ok: r.ok, discovered: r.discovered, created: r.created, updated: r.updated, staged: r.staged, tombstoned: r.tombstoned, error: r.ok ? "" : r.error });
  }
  return results;
}

export async function syncOneSource(id, { log = console.log, fetchImpl = fetch } = {}) {
  const r = await syncGitSource(Number(id), { token: getSkillsGithubToken(), fetchImpl, log });
  logEvent("skill_source_sync", { source: Number(id), ok: r.ok, discovered: r.discovered, created: r.created, updated: r.updated, staged: r.staged, tombstoned: r.tombstoned, error: r.ok ? "" : r.error });
  return r;
}

// The sync timer. Interval comes from settings (minutes; 0 = off). A first pass runs shortly
// after boot when any git source exists, so a restart never leaves sources stale for an hour.
export function startSkillsSync({ log = console.log, initialDelayMs = 30_000, fetchImpl = fetch } = {}) {
  let timer = null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (listSources().some((s) => s.kind === "git" && s.enabled)) await runScheduledSkillSync({ log, fetchImpl });
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
      if (timer) clearInterval(timer);
      timer = null;
    },
    runNow: tick,
  };
}
