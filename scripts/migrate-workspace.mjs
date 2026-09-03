#!/usr/bin/env node
// Migrate channel WORKING folders from the old hidden location to the visible workspace.
//
// Originally a channel's agent ran inside ~/.channelgate/channels/<slug> (the same folder
// that holds its meta.json / sessions.json / lockdown settings). The working folder later moved
// to a visible per-channel workspace folder. On machines provisioned before that change, the agent's
// work content (files it created, AGENTS.md, uploads) is still in the hidden folder and would
// not appear in the new workspace. This moves that content across, leaving meta.json,
// sessions.json and .claude/ (lockdown settings, regenerable skills) in the hidden root.
//
// Safe to run on every update: it never clobbers a file already at the destination, skips
// channels that use a custom workDir (those never ran in the hidden folder), and never fails
// the update — a problem here just prints a warning.
import { readdir, readFile, mkdir, rename, stat, cp, rm } from "node:fs/promises";
import path from "node:path";
import { channelFolder, workspaceFolder, workspaceRoot } from "../src/config/paths.js";
import { listChannels } from "../src/config/store.js";

// Entries that BELONG in the hidden runtime root and must not move to the workspace.
const KEEP_IN_ROOT = new Set(["meta.json", "sessions.json", ".claude"]);

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

async function migrate() {
  // Enumerate CHANNEL RECORDS, never directory names: since the per-platform rename the channels
  // root holds platform folders (slack/, teams/, google-chat/), and treating those names as slugs
  // would move one platform's whole tree into a workspace folder called after the platform.
  let channels = [];
  try {
    channels = await listChannels();
  } catch {
    channels = [];
  }
  if (!channels.length) {
    console.log("→ Workspace migration: no channels yet — nothing to move.");
    return;
  }

  let movedChannels = 0;
  let movedItems = 0;
  let skipped = 0;

  for (const channel of channels) {
    const slug = channel.slug;
    const platform = channel.meta?.platform;
    const meta = channel.meta ?? (await readMeta(slug, platform));
    // A custom (real-project) work dir never ran inside the hidden folder — leave it alone.
    const custom = (meta.workDir || "").trim();
    if (custom && path.isAbsolute(custom)) {
      skipped++;
      continue;
    }

    const from = channelFolder(slug, platform);
    const to = workspaceFolder(slug, platform);
    let names = [];
    try {
      names = (await readdir(from, { withFileTypes: true })).map((d) => d.name).filter((n) => !KEEP_IN_ROOT.has(n));
    } catch {
      names = []; // channel folder not provisioned yet
    }
    if (!names.length) {
      skipped++;
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
      movedChannels++;
      movedItems += here;
      console.log(`  • ${slug}: moved ${here} item(s) → ${to}`);
    } else {
      skipped++;
    }
  }

  console.log(
    `→ Workspace migration: ${movedChannels} channel(s)/${movedItems} item(s) moved, ${skipped} unchanged. Workspace: ${workspaceRoot()}`,
  );
}

migrate().catch((e) => {
  console.warn(`⚠ Workspace migration skipped (${e.message}). Working folders left in place.`);
  process.exit(0);
});
