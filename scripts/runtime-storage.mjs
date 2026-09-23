#!/usr/bin/env node
// Container storage: what this host holds, and what could be reclaimed.
//
//   npm run runtime:storage                 # report only — the default, and safe to schedule
//   npm run runtime:storage -- --apply      # remove exactly what the report marks "remove"
//   npm run runtime:storage -- --json       # the report as JSON (for a schedule or a dashboard)
//   options: --cli podman|docker, --keep-previous <n> (older spec images kept for rollback, default 1)
//
// Nothing here runs by itself. The gateway never reclaims container storage on its own; an operator
// reads this report and decides, or schedules it deliberately. The rules live in
// src/runtimes/container/storage-report.js: it never removes a running container of this gateway,
// never a channel's HOME volume, never the current or rollback image, and never anything belonging
// to another install whose folders still exist (a second live gateway can share this account's store).
// Run it as the gateway's own OS user: rootless container storage is per user.
import { existsSync, statfsSync } from "node:fs";
import { execFileSync as run, spawnSync as spawn } from "node:child_process";
import { classifyStorage, REMOVE } from "../src/runtimes/container/storage-report.js";
import { currentInstallId } from "../src/runtimes/container/names.js";
import { gatewayRoot } from "../src/config/paths.js";


function parseArgs(argv) {
  const out = { apply: false, json: false, cli: "", keepPrevious: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--cli") out.cli = argv[++i] || "";
    else if (arg === "--keep-previous") out.keepPrevious = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

function pickCli(preferred) {
  for (const bin of preferred ? [preferred] : ["podman", "docker"]) {
    if (spawn(bin, ["--version"], { stdio: "ignore" }).status === 0) return bin;
  }
  throw new Error("no container CLI found (podman or docker)");
}

const cliJson = (bin, args) => {
  const out = run(bin, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
  return out ? JSON.parse(out) : [];
};
const ids = (bin, args) => run(bin, args, { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);

function gather(bin) {
  const containerIds = ids(bin, ["ps", "-aq", "--no-trunc"]);
  const containers = (containerIds.length ? cliJson(bin, ["container", "inspect", ...containerIds]) : []).map((c) => ({
    id: String(c.Id || ""),
    name: String(c.Name || "").replace(/^\//, ""),
    running: Boolean(c.State?.Running),
    status: String(c.State?.Status || ""),
    imageId: String(c.Image || "").replace(/^sha256:/, ""),
    install: String(c.Config?.Labels?.["cg.install"] || ""),
    labeled: c.Config?.Labels?.channelgate === "1" || /^cg-[0-9a-f]+-/.test(String(c.Name || "").replace(/^\//, "")),
    mounts: (c.Mounts || []).map((m) => ({ type: String(m.Type || ""), source: String(m.Source || ""), volume: String(m.Name || "") })),
  }));
  // Top-level images only. `images -a` also lists every intermediate build layer, each reporting
  // its full virtual size — dozens of "4.9 GB" entries that are really the same shared layers, and
  // that `rmi` refuses anyway because tagged images depend on them.
  const imageIds = [...new Set(ids(bin, ["images", "-q", "--no-trunc"]))];
  const images = (imageIds.length ? cliJson(bin, ["image", "inspect", ...imageIds]) : []).map((i) => {
    const id = String(i.Id || "").replace(/^sha256:/, "");
    return {
      id,
      tags: (i.RepoTags || []).filter((t) => t && !t.startsWith("<none>")),
      size: Number(i.Size) || 0,
      spec: String(i.Labels?.["cg.image.version"] || i.Config?.Labels?.["cg.image.version"] || ""),
      layers: layerSizes(bin, id, i.RootFS?.Layers),
    };
  });
  const volumeNames = ids(bin, ["volume", "ls", "-q"]);
  const volumes = volumeNames.map((name) => ({ name }));
  let currentImageId = "";
  try {
    currentImageId = String(cliJson(bin, ["image", "inspect", "channelgate/runtime:latest"])[0]?.Id || "").replace(/^sha256:/, "");
  } catch { /* no runtime image built: nothing is "current", so no own container is called superseded */ }
  return { containers, images, volumes, currentImageId };
}

// Each layer's digest and size: the non-empty history entries, oldest first, line up one-to-one with
// RootFS.Layers. If they do not (a CLI that reports history differently), return null and the report
// falls back to an upper bound rather than guessing.
function layerSizes(bin, id, rootLayers) {
  if (!Array.isArray(rootLayers) || !rootLayers.length) return null;
  try {
    const history = cliJson(bin, ["image", "history", "--no-trunc", "--format", "json", id]);
    const sized = history.filter((h) => Number(h.size ?? h.Size) > 0).reverse();
    if (sized.length !== rootLayers.length) return null;
    return rootLayers.map((digest, k) => ({ digest, size: Number(sized[k].size ?? sized[k].Size) || 0 }));
  } catch { return null; }
}

const gb = (n) => `${(n / 1073741824).toFixed(2)} GB`;

function freeSpace() {
  try {
    const s = statfsSync(gatewayRoot());
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

function printReport(report, disk, apply) {
  if (disk) console.log(`Disk holding the gateway root: ${gb(disk.free)} free of ${gb(disk.total)}${disk.free < 5 * 1073741824 ? "  ⚠ URGENT — under 5 GB" : disk.free < 10 * 1073741824 ? "  ⚠ under 10 GB" : ""}`);
  const section = (title, rows, label) => {
    const remove = rows.filter((r) => r.action === REMOVE);
    console.log(`\n${title}: ${rows.length} total, ${remove.length} reclaimable`);
    for (const r of remove) console.log(`  remove  ${label(r)} — ${r.reason}`);
    const keptWhy = new Map();
    for (const r of rows.filter((x) => x.action !== REMOVE)) keptWhy.set(r.reason, (keptWhy.get(r.reason) || 0) + 1);
    for (const [why, n] of keptWhy) console.log(`  keep    ${n} × ${why}`);
  };
  section("Containers", report.containers, (c) => `${c.name} (${c.status || (c.running ? "running" : "stopped")})`);
  section("Images", report.images, (i) => `${(i.tags[0] || i.id.slice(0, 12))} ${gb(i.size)}`);
  section("Volumes", report.volumes, (v) => v.name);
  console.log(`\nRemoving the images above frees ${report.reclaimableImagePrecision === "exact" ? "" : "at most "}${gb(report.reclaimableImageBytes)} (${report.reclaimableImagePrecision === "exact" ? "counted layer by layer — shared layers are not double-counted" : "an upper bound: layer data was unavailable"}); removed containers add their own small writable layers.`);
  if (!apply) console.log("Nothing was changed. Review the list above, then rerun with --apply to remove exactly the lines marked `remove`.");
}

function applyReport(bin, report) {
  const results = [];
  const step = (what, args) => {
    const r = spawn(bin, args, { encoding: "utf8" });
    results.push({ what, ok: r.status === 0, error: r.status === 0 ? "" : String(r.stderr || "").trim() });
    console.log(`${r.status === 0 ? "removed" : "FAILED "} ${what}${r.status === 0 ? "" : ` — ${String(r.stderr || "").trim()}`}`);
  };
  // Containers first (they pin images and volumes). `rm -v` drops only ANONYMOUS volumes; a named
  // HOME volume survives and is judged separately below.
  for (const c of report.removable.containers) step(`container ${c.name}`, ["rm", "-f", "-v", c.id]);
  for (const i of report.removable.images) step(`image ${i.tags[0] || i.id.slice(0, 12)}`, ["rmi", i.id]);
  for (const v of report.removable.volumes) step(`volume ${v.name}`, ["volume", "rm", v.name]);
  return results;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("Usage: npm run runtime:storage [-- --apply] [--json] [--cli podman|docker] [--keep-previous <n>]");
  process.exit(0);
}
const bin = pickCli(options.cli);
const facts = gather(bin);
const report = classifyStorage({
  ...facts,
  installId: currentInstallId(),
  keepPreviousSpecs: options.keepPrevious,
  sourceExists: (p) => existsSync(p),
});
const disk = freeSpace();
if (options.json) {
  console.log(JSON.stringify({ cli: bin, installId: currentInstallId(), disk, ...report }, null, 2));
} else {
  printReport(report, disk, options.apply);
}
if (options.apply) {
  console.log("");
  const results = applyReport(bin, report);
  const after = freeSpace();
  if (after && disk) console.log(`\nFree space: ${gb(disk.free)} → ${gb(after.free)}.`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
