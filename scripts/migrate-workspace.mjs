#!/usr/bin/env node
// Migrate channel WORKING folders from the old hidden location to the visible workspace.
//
// Originally a channel's agent ran inside ~/.channelgate/channels/<slug> (the same folder
// that holds its meta.json / sessions.json / lockdown settings). The working folder later moved
// to a visible per-channel workspace folder. On machines provisioned before that change, the agent's
// work content (files it created, AGENTS.md, uploads) is still in the hidden folder and would
// not appear in the new workspace. This moves that content across, leaving the daemon's own
// entries (CHANNEL_FOLDER_DAEMON_ENTRIES: metadata, lockdown settings, runtime scratch) in the
// hidden root.
//
// Safe to run on every update: it never clobbers a file already at the destination, skips
// channels that use a custom workDir (those never ran in the hidden folder), and never fails
// the update — a problem here just prints a warning.
import { readdir, readFile, mkdir, rename, stat, lstat, cp, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHANNEL_FOLDER_DAEMON_ENTRIES, CHANNEL_RUNTIME_DIR, channelFolder, workspaceFolder, workspaceRoot } from "../src/config/paths.js";
import { listChannels } from "../src/config/store.js";

// Entries that BELONG in the hidden runtime root and must not move to the workspace.
const KEEP_IN_ROOT = new Set(CHANNEL_FOLDER_DAEMON_ENTRIES);

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readMeta(slug, platform) {
  try {
    return JSON.parse(await readFile(path.join(channelFolder(slug, platform), "meta.json"), "utf8"));
  } catch {
    return {};
  }
}

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

// Until 2026-11 this script did not know the runtime scratch folder and moved it into the work
// folder on the first update after a channel was created — the folder a container mounts, and the
// folder whose `env/` holds a run's environment while that run is starting. Undo what is provably
// that mistake and nothing else: only EMPTY directories are removed (rmdir, never a recursive
// delete), so a project that really has a `runtime` folder keeps every file in it. Anything with
// content is reported for the operator, loudest when it looks like a run's environment file.
async function tidyStrayRuntime(workDir, log) {
  const stray = path.join(workDir, CHANNEL_RUNTIME_DIR);
  let info;
  try {
    info = await lstat(stray);
  } catch {
    return "absent";
  }
  if (!info.isDirectory()) return "kept";
  const top = await entries(stray);
  if (!top) return "kept";
  const env = top.find((entry) => entry.name === "env" && entry.isDirectory());
  const envFiles = env ? (await entries(path.join(stray, "env"))) || [] : [];
  if (top.every((entry) => entry === env) && !envFiles.length) {
    try {
      if (env) await rmdir(path.join(stray, "env"));
      await rmdir(stray);
      return "removed";
    } catch {
      return "kept"; // raced with something writing there — leave it
    }
  }
  const leaked = envFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".env")).length;
  if (leaked) {
    log(`  ⚠ ${stray}/env holds ${leaked} environment file(s) an earlier update moved into the work folder. ` +
      "They can contain this conversation's secrets and its container can read them: delete them, and rotate those secrets if the folder is shared.");
  } else {
    log(`  • ${stray} was moved here by an earlier update and is not empty — left in place for review.`);
  }
  return "kept";
}

export async function migrateWorkspace({ log = console.log } = {}) {
  // Enumerate CHANNEL RECORDS, never directory names: since the per-platform rename the channels
  // root holds platform folders (slack/, teams/, google-chat/), and treating those names as slugs
  // would move one platform's whole tree into a workspace folder called after the platform.
  let channels = [];
  try {
    channels = await listChannels();
  } catch {
    channels = [];
  }
  const summary = { movedChannels: 0, movedItems: 0, skipped: 0, tidied: 0 };
  if (!channels.length) {
    log("→ Workspace migration: no channels yet — nothing to move.");
    return summary;
  }

  for (const channel of channels) {
    const slug = channel.slug;
    const platform = channel.meta?.platform;
    const meta = channel.meta ?? (await readMeta(slug, platform));
    // A custom (real-project) work dir never ran inside the hidden folder — leave it alone.
    const custom = (meta.workDir || "").trim();
    if (custom && path.isAbsolute(custom)) {
      summary.skipped++;
      continue;
    }

    const from = channelFolder(slug, platform);
    const to = workspaceFolder(slug, platform);
    if (await tidyStrayRuntime(to, log) === "removed") summary.tidied++;
    const names = ((await entries(from)) || []).map((d) => d.name).filter((n) => !KEEP_IN_ROOT.has(n));
    if (!names.length) {
      summary.skipped++; // nothing to move, or the channel folder is not provisioned yet
      continue;
    }

    await mkdir(to, { recursive: true });
    let here = 0;
    for (const name of names) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (await exists(dst)) continue; // never clobber what's already in the workspace
      try {
        await rename(src, dst);
      } catch {
        // Cross-device or busy: copy then remove the original.
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
        await rm(src, { recursive: true, force: true });
      }
      here++;
    }
    if (here) {
      summary.movedChannels++;
      summary.movedItems += here;
      log(`  • ${slug}: moved ${here} item(s) → ${to}`);
    } else {
      summary.skipped++;
    }
  }

  log(
    `→ Workspace migration: ${summary.movedChannels} channel(s)/${summary.movedItems} item(s) moved, ${summary.skipped} unchanged` +
    `${summary.tidied ? `, ${summary.tidied} stray runtime folder(s) removed from work folders` : ""}. Workspace: ${workspaceRoot()}`,
  );
  return summary;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  migrateWorkspace().catch((e) => {
    console.warn(`⚠ Workspace migration skipped (${e.message}). Working folders left in place.`);
    process.exit(0);
  });
}
