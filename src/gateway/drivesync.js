// Scheduled two-way Google Drive ↔ channel-folder sync, via `rclone bisync`.
//
// A channel with `meta.syncDriveFolder` set (a Drive folder link) gets its WHOLE working folder
// bisync'd with that Drive folder on a timer (QA-0925: the owner wanted the channel, not a
// `Drive/` subfolder, in Drive). What must never cross is filtered out in both directions by a
// filters file: agent instruction and skill files at any depth (`CLAUDE.md`, `AGENTS.md`,
// `AGENTS.override.md`, `CLAUDE.local.md`, `.mcp.json`, `.claude/`, `.agents/`, `.codex/`), channel
// memory (`MEMORY.md`, `memory/`), secrets (`.env*`, keys, credential files, per-run env folders),
// version control and dependency trees — matched case-insensitively. A Drive-side edit therefore
// never plants instructions for the agent, and a local secret is never pushed. Every symlink in the
// folder is excluded for the pass, and rclone itself runs in a throwaway container that mounts only
// the channel folder, the sync state and the key, so a link to elsewhere resolves inside that
// container and never onto the host. A channel adds its own exclusions, one pattern per line, in a
// `.driveignore` file at the folder root. A folder that is or contains the operator's home, the
// gateway root or the workspace root is refused outright.

// Auth is a Google Workspace SERVICE ACCOUNT: a JSON key file (global setting) is passed to rclone
// via `--drive-service-account-file`, optionally impersonating a subject user (`--drive-impersonate`,
// domain-wide delegation). No interactive `rclone config`, no OAuth, no per-user tokens — and no
// secret ever crosses into the child env (everything rides in argv/flags, and the key stays a path).
//
// Dormant by default: nothing runs unless the global `driveSyncEnabled` switch is on AND rclone is
// installed AND a key file is configured. Missing any of those → a logged skip, never a throw.
// Besides the timer, a pass can be started on demand: one channel (the admin UI's per-channel
// "Sync now" and the `sync_channel_drive` agent tool) or every linked channel (Settings → "Sync all
// now"). Manual passes obey the same switch and share the per-channel in-flight guard.

import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, chmodSync, realpathSync, statSync, lstatSync } from "node:fs";
import {
  getDriveSyncEnabled,
  getDriveSyncKeyFile,
  getDriveSyncKeyJson,
  getDriveSyncSubject,
  getDriveSyncIntervalMinutes,
  getDriveSyncConflict,
  getDriveSyncRclonePath,
} from "../config/settings.js";
import { listChannels } from "../config/store.js";
import { effectiveWorkDir } from "./folders.js";
import { gatewayRoot, configDir, workspaceRoot } from "../config/paths.js";
import { getContainerRuntime } from "../config/settings.js";
import { confinedCommandArgv } from "../runtimes/container/index.js";
import { buildChildEnv } from "../engines/child-env.js";
import { appendTail } from "../util/tail.js";
import { logEvent } from "../util/logger.js";
import { conciseProcessDiagnostic, describeProcessOutcome } from "../util/process-outcome.js";

const MAX_TAIL = 8 * 1024; // keep the last ~8KB of rclone output for diagnostics
const RUN_TIMEOUT_MS = 20 * 60 * 1000; // a single bisync pass may not exceed 20 min

// ── Pure helpers (exported for tests) ──────────────────────────────────────────────────────────

// Extract the Drive folder id from whatever the user pasted: a /folders/<id> link (with or without
// the /u/<n> account segment and query string), an ?id=<id> open link, or a bare id. Returns null
// when nothing id-shaped is found. Drive ids are URL-safe base64-ish (letters/digits/_/-).
export function parseDriveFolderId(link) {
  const s = String(link || "").trim();
  if (!s) return null;
  const folders = s.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (folders) return folders[1];
  const idParam = s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (idParam) return idParam[1];
  // A bare id (no slashes, no scheme) — accept it as-is; reject anything that still looks like a URL.
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

// Validate a pasted service-account key: it must be JSON of type "service_account" with the fields
// rclone needs. Returns { ok, email } or { ok:false, error }. Pure — used by the admin save + tests.
export function isServiceAccountJson(str) {
  let obj;
  try {
    obj = JSON.parse(str);
  } catch {
    return { ok: false, error: "Not valid JSON." };
  }
  if (!obj || typeof obj !== "object" || obj.type !== "service_account") {
    return { ok: false, error: 'Not a service-account key (expected "type": "service_account").' };
  }
  if (!obj.private_key || !obj.client_email) {
    return { ok: false, error: "Key is missing private_key / client_email." };
  }
  return { ok: true, email: String(obj.client_email) };
}

// The local side of the sync: the channel's whole working folder.
export function syncRoot(workDir) {
  return workDir;
}

// Never synced, in either direction (rclone filter syntax, anchored at the folder root unless
// unanchored on purpose). The scaffolding is the channel's lockdown; the rest is per-run state,
// secrets, or trees that are rebuilt locally and would flood Drive.
export const DRIVE_SYNC_EXCLUDES = Object.freeze([
  // Agent instructions, skills and MCP config at ANY depth: a Drive editor must never plant them.
  "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", ".mcp.json",
  ".claude/**", ".agents/**", ".codex/**",
  // Channel memory and the gateway's per-channel state.
  "/MEMORY.md", "/memory/**", "/thread-*.json", "/runtime/env/**", "/.driveignore",
  // Secrets.
  ".env", ".env.*", ".env/**", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "*.pem", "*.key",
  "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*", "authorized_keys*", "known_hosts*",
  ".ssh/**", ".aws/**", ".kube/**", ".gnupg/**",
  ".docker/config.json", "*.cg-tmp",
  // Version control and rebuildable trees (a `.git` FILE points a worktree/submodule elsewhere).
  ".git", ".git/**", ".worktrees/**", "node_modules/**", "__pycache__/**", ".venv/**", ".DS_Store",
  // rclone's own link stand-ins: a Drive-side one would become a real symlink with --links.
  "*.rclonelink",
]);
export const DRIVE_IGNORE_FILE = ".driveignore";
const DRIVE_IGNORE_MAX_BYTES = 64 * 1024;

// The filters file bisync reads: the fixed exclusions, then the channel's own `.driveignore`
// patterns — exclusions only (a leading "+"/"-" is dropped and every line becomes an exclude), so
// the file can narrow the sync but never re-include the scaffolding.
export function buildDriveFilters(workDir) {
  const lines = DRIVE_SYNC_EXCLUDES.map((pattern) => `- ${pattern}`);
  let custom = "";
  try {
    const file = path.join(workDir, DRIVE_IGNORE_FILE);
    const buf = readFileSync(file);
    custom = buf.subarray(0, DRIVE_IGNORE_MAX_BYTES).toString("utf8");
  } catch {}
  for (const raw of custom.split(/\r?\n/)) {
    const pattern = raw.trim().replace(/^[+-]\s+/, "");
    if (!pattern || pattern.startsWith("#")) continue;
    lines.push(`- ${pattern}`);
  }
  return `${lines.join("\n")}\n`;
}

// Every symlink under the folder, as root-anchored rclone excludes for this pass (the link and
// anything "inside" it). Excluding them means rclone neither reads through a link nor writes a
// Drive file through one; the confined container is what makes a link created DURING a pass
// harmless. Rebuildable and excluded trees are not walked; the walk is bounded.
const SYMLINK_SCAN_SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", ".worktrees"]);
const SYMLINK_SCAN_MAX_ENTRIES = 250_000;
function globEscape(segment) {
  return segment.replace(/[\\*?[\]{}]/g, (ch) => `\\${ch}`);
}
export function symlinkExcludes(workDir) {
  const out = [];
  let seen = 0;
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > SYMLINK_SCAN_MAX_ENTRIES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const pattern = `/${childRel.split("/").map(globEscape).join("/")}`;
        out.push(pattern, `${pattern}/**`);
      } else if (entry.isDirectory() && !SYMLINK_SCAN_SKIP.has(entry.name)) {
        walk(path.join(dir, entry.name), childRel);
      }
    }
  };
  walk(workDir, "");
  return out;
}

// A folder whose sync would publish the host itself: the operator's home, the gateway root or the
// workspace root (every channel), or anything that contains one of them. Returns the reason, or "".
export function driveSyncFolderRefusal(workDir, { home = os.homedir(), roots = [gatewayRoot(), workspaceRoot()], ownFolder = "" } = {}) {
  let real;
  try { real = realpathSync(workDir); } catch { real = path.resolve(workDir); }
  const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const guarded = [home, ...roots].filter(Boolean).map((p) => { try { return realpathSync(p); } catch { return path.resolve(p); } });
  if (real === path.parse(real).root) return "the channel folder is the filesystem root";
  for (const g of guarded) {
    if (inside(g, real)) return `the channel folder ${real} is or contains ${g} — syncing it would publish the host's own files. Give the channel its own folder.`;
  }
  // Inside the gateway root is its private state (clean workspaces, credentials, logs) — unless it
  // is also inside the workspace root, where an operator may have placed the channel folders.
  const [gw, ws] = roots.map((p) => { try { return realpathSync(p); } catch { return path.resolve(p); } });
  if (inside(real, gw) && !inside(real, ws)) return `the channel folder ${real} is inside the gateway root — sync a channel work folder instead.`;
  // Inside the workspace root only the channel's OWN folder is its to publish: not a parent holding
  // every channel of a platform, and not the hidden .runtime tree (secret bundles, MCP configs).
  if (inside(real, ws)) {
    const own = ownFolder ? (() => { try { return realpathSync(ownFolder); } catch { return path.resolve(ownFolder); } })() : "";
    if (!own || !inside(real, own)) return `the folder ${real} is inside the workspace root but is not this channel's own folder.`;
  }
  // A hidden folder under the home is configuration (.ssh, .config, .aws, .claude, …), never a project.
  const homeReal = guarded[0];
  if (inside(real, homeReal) && path.relative(homeReal, real).split(path.sep).some((part) => part.startsWith("."))) {
    return `the folder ${real} is a hidden configuration folder of the home — give the channel a project folder.`;
  }
  return "";
}

// The rclone binary as an absolute, real path, so it can be bind-mounted into the confined
// container (the image does not ship rclone).
function resolveBinary(bin) {
  const name = String(bin || "rclone");
  const candidates = name.includes("/") ? [name] : String(buildChildEnv().PATH || process.env.PATH || "").split(path.delimiter).map((d) => path.join(d, name));
  for (const candidate of candidates) {
    try { const real = realpathSync(candidate); if (statSync(real).isFile()) return real; } catch {}
  }
  return "";
}

// What a completed --resync was made FOR. The sentinel records it, and any change — another local
// root, another Drive folder, other filters — makes the next pass a fresh --resync against a clean
// state dir instead of a bisync that compares the new pair against the old pair's listings (which
// would read every file as new or deleted).
export function syncIdentity({ localPath, folderId, filters }) {
  return createHash("sha256").update(JSON.stringify({ localPath, folderId, filters })).digest("hex");
}

// The rclone Drive backend flags that carry service-account auth + scope the remote to one folder.
// Shared by bisync and the connection test so both authenticate identically.
function driveAuthFlags({ folderId, keyFile, subject }) {
  const flags = [
    "--drive-service-account-file", keyFile,
    "--drive-root-folder-id", folderId,
    "--drive-scope", "drive",
  ];
  if (subject) flags.push("--drive-impersonate", subject);
  return flags;
}

// Full argv (sans the leading "rclone") for one bisync pass. `firstRun` seeds the baseline with
// --resync (bisync refuses to run the very first time without it); steady-state runs omit it.
export function buildBisyncArgs({ localPath, folderId, keyFile, subject, workDir, conflict = "newer", firstRun = false, filtersFile = "", extraExcludes = [] }) {
  const args = ["bisync", localPath, ":drive:", ...driveAuthFlags({ folderId, keyFile, subject })];
  args.push("--workdir", workDir); // bisync listing state — kept under the gateway root, not ~/.cache
  if (filtersFile) args.push("--filters-file", filtersFile, "--ignore-case"); // both directions; a change forces --resync
  // Per-pass excludes (this pass's symlinks) ride as flags, outside the filters file, so a link
  // appearing or vanishing does not count as a filter change that forces a --resync.
  for (const pattern of extraExcludes) args.push("--exclude", pattern);
  args.push("--create-empty-src-dirs");
  args.push("--conflict-resolve", conflict, "--conflict-loser", "num"); // keep both sides on a tie
  if (firstRun) args.push("--resync", "--resync-mode", conflict);
  args.push("-v"); // INFO-level lines into the captured log
  return args;
}

// Argv (sans "rclone") for a cheap read-only connection test: list the folder's entries. Exit 0
// proves the service account authenticates AND can see the folder; an empty folder still exits 0.
export function buildTestArgs({ folderId, keyFile, subject }) {
  return ["lsf", "--max-depth", "1", ":drive:", ...driveAuthFlags({ folderId, keyFile, subject })];
}

// Which channels are eligible this tick: those with a parseable Drive folder link. Pure over the
// listChannels() shape so it's unit-testable; path resolution (fs) happens in the caller.
export function selectSyncChannels(channels) {
  const out = [];
  for (const ch of channels || []) {
    const folderId = parseDriveFolderId(ch?.meta?.syncDriveFolder);
    // Carry meta so the sync targets the channel's ACTUAL working folder (a custom workDir), not
    // just the default one — effectiveWorkDir needs it.
    if (folderId) out.push({ slug: ch.slug, channelId: ch.channelId, name: ch.name, folderId, meta: ch.meta || {} });
  }
  return out;
}

// ── Runtime state (in-memory) ──────────────────────────────────────────────────────────────────

const inFlight = new Set(); // slugs currently syncing — never overlap two passes on one channel
const startedAt = new Map(); // slug -> { at, trigger } for the pass currently running
const lastResult = new Map(); // slug -> { ok, at, trigger, firstRun, tail, summary } for status/debug
let sweeping = false; // one sweep at a time, scheduled or manual
const rcloneChecked = new Map(); // binary path -> "is rclone runnable" probe result

function driveSyncDir() {
  return path.join(gatewayRoot(), "drivesync");
}
// Per-channel bisync working dir (listing state).
function channelWorkDir(slug) {
  return path.join(driveSyncDir(), "work", slug);
}
// The "already resynced" marker. It must NOT be the working dir itself: rclone needs that directory
// to exist before the --resync pass, so a crash/reboot mid-first-run used to leave it behind, every
// later tick then omitted --resync, rclone aborted with "cannot find prior listing", and firstRun
// was false forever — the channel wedged permanently until someone deleted the folder by hand. The
// sentinel is written only AFTER a --resync pass actually succeeds.
export function resyncSentinel(stateDir) {
  return path.join(stateDir, ".resync-complete");
}
// A first run is one with no completed --resync behind it, whatever else survived on disk.
export function needsResync(stateDir, identity = "") {
  let recorded;
  try { recorded = readFileSync(resyncSentinel(stateDir), "utf8"); } catch { return true; }
  if (!identity) return false;
  try { return JSON.parse(recorded)?.identity !== identity; } catch { return true; } // a pre-identity sentinel
}

// rclone refuses to bisync against an EMPTY prior listing — exit 7, "Empty prior Path1 listing.
// Cannot sync to an empty directory … Must run --resync to recover" — and a --resync of two empty
// sides succeeds while leaving exactly such a listing behind (rclone then renames it to .lst-err on
// the failed pass). So a channel linked to an empty Drive folder before anyone put a file on either
// side synced "successfully" once and then failed every tick forever (QA-0925). A listing that
// records NO file has no deletion a fresh --resync could miss, so that — and only that — resyncs
// again. A listing that is missing for any other reason stays an error: after a deliberate
// delete-everything, rclone aborts and renames NON-empty listings to .lst-err, and resyncing there
// would silently copy every deleted file back.
function listingEntries(stateDir, names, suffix) {
  const name = names.find((entry) => entry.endsWith(suffix));
  if (!name) return null;
  try {
    return readFileSync(path.join(stateDir, name), "utf8").split("\n").filter((line) => line.trim() && !line.startsWith("#")).length;
  } catch { return null; }
}
export function priorListingEmpty(stateDir) {
  let names;
  try { names = readdirSync(stateDir); } catch { return false; }
  const sides = [".path1", ".path2"];
  const live = sides.map((side) => listingEntries(stateDir, names, `${side}.lst`));
  if (live.every((n) => n !== null)) return live.every((n) => n === 0);
  if (live.some((n) => n !== null)) return false; // one side missing: not the empty-resync shape
  const aborted = sides.map((side) => listingEntries(stateDir, names, `${side}.lst-err`));
  return aborted.every((n) => n === 0);
}

// Resolve the effective service-account key FILE for rclone. A pasted JSON key (write-only setting)
// wins: it's materialized to a chmod-600 file in the runtime config dir — outside every channel
// sandbox, and passed to rclone as a PATH so the private key never enters argv or the child env.
// Falling back: a configured on-host key-file path. Returns "" when neither is usable. Rewrites the
// managed file only when the stored JSON changed; removes it when the JSON is cleared.
export function resolveDriveSyncKeyFile() {
  const json = getDriveSyncKeyJson();
  const managed = path.join(configDir(), "drive-sa.json");
  if (json) {
    try {
      let current = null;
      try { current = readFileSync(managed, "utf8"); } catch {}
      if (current !== json) writeFileSync(managed, json, { mode: 0o600 });
      chmodSync(managed, 0o600); // enforce 600 even if the file pre-existed with looser perms
      return managed;
    } catch (e) {
      console.error("[drivesync] could not write managed key file:", e?.message || e);
      return "";
    }
  }
  // No pasted JSON — drop any stale managed file, then fall back to a configured on-host path.
  try { if (existsSync(managed)) rmSync(managed, { force: true }); } catch {}
  const file = getDriveSyncKeyFile();
  return file && existsSync(file) ? file : "";
}

// Is the rclone binary runnable? Successful probes are cached per binary path. Misses are retried:
// setup/update may install rclone while the daemon is already running, and that repair must take
// effect without requiring a restart. An absolute path still sidesteps a minimal service PATH.
export function rcloneAvailable(bin) {
  const key = String(bin || "");
  if (rcloneChecked.get(key) === true) return true;
  let ok;
  try {
    const r = spawnSync(key, ["version"], { env: buildChildEnv(), stdio: "ignore" });
    ok = !r.error && r.status === 0;
  } catch {
    ok = false;
  }
  if (ok) rcloneChecked.set(key, true);
  else rcloneChecked.delete(key);
  return ok;
}

// Run one rclone invocation, capturing a rolling tail of its output. Resolves (never rejects) with
// { ok, code, tail }. Cross-platform: a bare argv spawn (no shell), portable timeout + kill.
function runRclone(bin, args, cwd, { onTimeout = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: buildChildEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const outcome = describeProcessOutcome({ spawnError: err });
      resolve({ ok: false, code: null, signal: "", tail: "", outcome });
      return;
    }
    let tail = "";
    let timedOut = false;
    const onChunk = (chunk) => { tail = appendTail(tail, chunk, MAX_TAIL); };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    const timer = setTimeout(() => {
      timedOut = true;
      try { onTimeout?.(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
    }, RUN_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (err) => {
      clearTimeout(timer);
      const outcome = describeProcessOutcome({ spawnError: err });
      resolve({ ok: false, code: null, signal: "", tail, outcome });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const outcome = describeProcessOutcome({ code, signal, timedOut, timeout: "20-minute" });
      resolve({ ok: outcome.ok === true, code, signal: signal || "", tail, outcome });
    });
  });
}

// How a bisync pass is launched. `buildArgs(paths)` makes the rclone argv for the paths the process
// will see. Default: a one-shot confined container. The state dir, filters and key are mounted at a
// RANDOM path per pass, so a symlink planted in the channel folder mid-pass cannot aim at them (the
// work folder keeps its real path — it is what the channel sees). Tests with a fake rclone use the
// host launcher.
async function confinedRcloneLaunch({ bin, slug, localPath, stateDir, filtersFile, keyFile, buildArgs }) {
  const rclone = resolveBinary(bin);
  if (!rclone) throw new Error(`rclone not found (${bin})`);
  const base = `/cg-sync-${randomBytes(12).toString("hex")}`;
  const inside = { localPath, stateDir: `${base}/state`, filtersFile: `${base}/state/filters.txt`, keyFile: `${base}/key.json` };
  const name = `cg-drivesync-${String(slug).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60)}-${randomBytes(4).toString("hex")}`;
  const argv = await confinedCommandArgv({
    binds: [
      { source: localPath },
      { source: stateDir, target: inside.stateDir },
      { source: filtersFile, target: inside.filtersFile, readOnly: true },
      { source: keyFile, target: inside.keyFile, readOnly: true },
      { source: rclone, target: "/usr/local/bin/cg-rclone", readOnly: true },
    ],
    entrypoint: "/usr/local/bin/cg-rclone",
    args: buildArgs(inside),
    settings: getContainerRuntime(),
    name,
  });
  // A killed `podman run` client leaves the container running (and holding bisync's lock).
  // Non-blocking and immediate (-t 0): the daemon's event loop never waits on the removal.
  return { argv, cleanup: () => { try { spawn(argv[0], ["rm", "-f", "-t", "0", name], { env: buildChildEnv(), stdio: "ignore", detached: true }).unref(); } catch {} } };
}
let launch = confinedRcloneLaunch;
export const __confinedRcloneLaunch = confinedRcloneLaunch;
export function __setDriveSyncLauncher(fn) { launch = fn || confinedRcloneLaunch; }
export const HOST_LAUNCHER = async ({ bin, localPath, stateDir, filtersFile, keyFile, buildArgs }) =>
  ({ argv: [bin, ...buildArgs({ localPath, stateDir, filtersFile, keyFile })], cleanup: () => {} });

// Sync one channel. Assumes the caller resolved config + eligibility. Serialized per-slug: a pass
// that is already running (scheduled or manual) is never doubled — the caller gets `busy`.
async function syncOne({ slug, channelId, folderId, meta }, { bin, keyFile, subject, conflict, trigger = "schedule" }) {
  if (inFlight.has(slug)) return { busy: true }; // previous pass still running — skip this one
  inFlight.add(slug);
  startedAt.set(slug, { at: Date.now(), trigger });
  try {
    const workDir = effectiveWorkDir(slug, meta || {}); // the channel's real folder (honors a custom workDir)
    const refusal = driveSyncFolderRefusal(workDir, { ownFolder: effectiveWorkDir(slug, {}) });
    if (refusal) {
      lastResult.set(slug, { ok: false, at: Date.now(), trigger, firstRun: false, tail: "", summary: `Refused: ${refusal}` });
      await logEvent("drivesync_error", { slug, channel: channelId, trigger, outcome: "refused", tail: refusal.slice(0, 300) });
      console.error(`[drivesync] ${slug} refused: ${refusal}`);
      return { ok: false };
    }
    const localPath = syncRoot(workDir);
    const stateDir = channelWorkDir(slug);
    const filters = buildDriveFilters(workDir);
    const identity = syncIdentity({ localPath, folderId, filters });
    const initial = needsResync(stateDir, identity);
    // A changed pair starts from a clean state dir: the old pair's listings describe other paths.
    if (initial && existsSync(resyncSentinel(stateDir))) { try { rmSync(stateDir, { recursive: true, force: true }); } catch {} }
    const firstRun = initial || priorListingEmpty(stateDir);
    mkdirSync(localPath, { recursive: true }); // both sides must exist before bisync
    mkdirSync(stateDir, { recursive: true });
    const filtersFile = path.join(stateDir, "filters.txt");
    writeFileSync(filtersFile, filters, { mode: 0o600 });
    const extraExcludes = symlinkExcludes(localPath);
    const buildArgs = (p) => buildBisyncArgs({ localPath: p.localPath, folderId, keyFile: p.keyFile, subject, workDir: p.stateDir, conflict, firstRun, filtersFile: p.filtersFile, extraExcludes });
    let res;
    try {
      const { argv, cleanup } = await launch({ bin, slug, localPath, stateDir, filtersFile, keyFile, buildArgs });
      res = await runRclone(argv[0], argv.slice(1), workDir, { onTimeout: cleanup });
    } catch (error) {
      const message = String(error?.message || error);
      res = { ok: false, code: null, signal: "", tail: message, outcome: { kind: "failed", summary: `could not start: ${message}` } };
    }
    lastResult.set(slug, {
      ok: res.ok,
      at: Date.now(),
      trigger,
      firstRun,
      tail: res.tail,
      summary: res.ok ? "" : (conciseProcessDiagnostic(res.tail, 300) || res.outcome?.summary || "failed before it completed"),
    });
    if (res.ok) {
      // Only a COMPLETED --resync earns the sentinel; until it exists every tick retries the resync.
      if (firstRun) {
        try { writeFileSync(resyncSentinel(stateDir), `${JSON.stringify({ identity, at: new Date().toISOString() })}\n`, { mode: 0o600 }); } catch {}
      }
      await logEvent("drivesync_run", { slug, channel: channelId, firstRun, trigger });
    } else {
      // A failed first run must retry --resync next tick against a clean slate, so drop the
      // (now-stale) listing state. No sentinel was written, so the retry stays a first run either
      // way — this only removes a half-built baseline rclone would otherwise read.
      // Only a genuine first run may be dropped: a failed forced resync keeps the sentinel and the
      // listings that show what happened.
      if (initial) { try { rmSync(stateDir, { recursive: true, force: true }); } catch {} }
      await logEvent("drivesync_error", { slug, channel: channelId, trigger, code: res.code, signal: res.signal, outcome: res.outcome?.kind, tail: res.tail.slice(-800) });
      const detail = conciseProcessDiagnostic(res.tail, 300);
      console.error(`[drivesync] ${slug} bisync ${res.outcome?.summary || "failed before it completed"}${detail ? `: ${detail}` : ""}`);
    }
    return { ok: res.ok };
  } finally {
    inFlight.delete(slug);
    startedAt.delete(slug);
  }
}

// Everything a pass needs, or the one plain reason it can't run. Shared by the timer and the
// manual "Sync now" paths so both refuse for the same reasons: the global switch is the admin's
// off switch for the WHOLE feature, manual runs included.
export function resolveSyncConfig() {
  if (!getDriveSyncEnabled()) return { ok: false, error: "Google Drive sync is turned off (Settings → Google Drive sync → Enable)." };
  const keyFile = resolveDriveSyncKeyFile();
  if (!keyFile) return { ok: false, error: "No service-account key configured (Settings → Google Drive sync)." };
  const bin = getDriveSyncRclonePath();
  if (!rcloneAvailable(bin)) return { ok: false, error: `rclone not found (${bin}). Install it and/or set an absolute path in Settings.` };
  return { ok: true, bin, keyFile, subject: getDriveSyncSubject(), conflict: getDriveSyncConflict() };
}

// One sweep: resolve config, then sync every eligible channel. Errors are contained per-channel.
async function sweep(trigger = "schedule") {
  const cfg = resolveSyncConfig();
  if (!cfg.ok) return; // dormant — switch off, no key, or no rclone
  const eligible = selectSyncChannels(await listChannels());
  for (const ch of eligible) {
    try {
      await syncOne(ch, { ...cfg, trigger });
    } catch (e) {
      console.error(`[drivesync] ${ch.slug} sweep error:`, e?.message || e);
    }
  }
}

// Serialized sweep: the timer and "Sync all now" share one guard, so a manual sweep never stacks
// on a scheduled one (and vice versa). Resolves false when a sweep was already running.
async function runSweep(trigger) {
  if (sweeping) return false;
  sweeping = true;
  try {
    await sweep(trigger);
  } catch (e) {
    console.error("[drivesync] sweep error:", e?.message || e);
  } finally {
    sweeping = false;
  }
  return true;
}

// ── Manual "Sync now" (admin UI buttons + the sync_channel_drive agent tool) ─────────────────────

// A channel's sync state, safe to show anyone who may see the channel: timestamps, ok/failed and a
// concise diagnostic. Never the raw rclone tail (it names local paths and file names at length).
export function driveSyncStatus(slug) {
  const running = startedAt.get(slug) || null;
  const last = lastResult.get(slug) || null;
  return {
    running: Boolean(running),
    runningSince: running ? running.at : null,
    runningTrigger: running ? running.trigger : "",
    last: last ? { ok: last.ok, at: last.at, trigger: last.trigger, firstRun: last.firstRun, summary: last.summary } : null,
  };
}

// Status for every channel with a Drive link — the Settings page's "Sync all now" view.
export async function driveSyncStatusAll() {
  const eligible = selectSyncChannels(await listChannels());
  return {
    sweeping,
    channels: eligible.map((ch) => ({ slug: ch.slug, channelId: ch.channelId, name: ch.name, ...driveSyncStatus(ch.slug) })),
  };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

// Start one channel's bisync pass now, outside the schedule. The pass runs in the daemon and
// outlives the caller; `waitMs` lets a caller (the agent tool) wait a bounded time for the outcome.
// Returns { ok, started, busy, done, error, status } — never throws.
export async function syncChannelNow(slug, { waitMs = 0, trigger = "manual" } = {}) {
  const cfg = resolveSyncConfig();
  if (!cfg.ok) return { ok: false, started: false, error: cfg.error, status: driveSyncStatus(slug) };
  const ch = (await listChannels()).find((c) => c.slug === slug);
  if (!ch) return { ok: false, started: false, error: "Unknown channel.", status: driveSyncStatus(slug) };
  const [target] = selectSyncChannels([ch]);
  if (!target) return { ok: false, started: false, error: "No Google Drive folder is linked to this channel (or the saved link isn't a Drive folder link).", status: driveSyncStatus(slug) };
  if (inFlight.has(slug)) return { ok: true, started: false, busy: true, status: driveSyncStatus(slug) };
  const pass = syncOne(target, { ...cfg, trigger }).catch((e) => {
    console.error(`[drivesync] ${slug} manual sync error:`, e?.message || e);
    return { ok: false };
  });
  let done = false;
  if (waitMs > 0) done = await Promise.race([pass.then(() => true), delay(waitMs).then(() => false)]);
  return { ok: true, started: true, done, status: driveSyncStatus(slug) };
}

// Start a full sweep of every linked channel now. Returns immediately; poll driveSyncStatusAll().
export async function syncAllNow() {
  const cfg = resolveSyncConfig();
  if (!cfg.ok) return { ok: false, started: false, error: cfg.error };
  const channels = selectSyncChannels(await listChannels());
  if (!channels.length) return { ok: false, started: false, error: "No channel has a Google Drive folder linked." };
  if (sweeping) return { ok: true, started: false, busy: true, channels: channels.length };
  runSweep("manual"); // fire and forget — per-channel results land in driveSyncStatus
  return { ok: true, started: true, channels: channels.length };
}

// Daemon IPC entry for the gateway MCP tool (both transports). `slug` comes from the tool's
// capability-verified context, never from model input.
export async function handleDriveSyncIpc({ action, slug, waitMs } = {}) {
  const s = String(slug || "");
  if (!s) return { ok: false, error: "missing channel" };
  if (action === "status") return { ok: true, status: driveSyncStatus(s) };
  if (action === "sync") return syncChannelNow(s, { waitMs: Math.min(Math.max(Number(waitMs) || 0, 0), 45_000), trigger: "agent" });
  return { ok: false, error: `unknown drive sync action "${action}"` };
}

// One-off connection test for the admin UI: does the service account authenticate + see the folder?
// Returns { ok, output } — never throws. Used by the per-channel "Test" button.
export async function testChannelSync({ syncDriveFolder }) {
  const folderId = parseDriveFolderId(syncDriveFolder);
  if (!folderId) return { ok: false, output: "Not a valid Google Drive folder link." };
  const keyFile = resolveDriveSyncKeyFile();
  if (!keyFile) return { ok: false, output: "No service-account key configured (Settings → Google Drive sync)." };
  const bin = getDriveSyncRclonePath();
  if (!rcloneAvailable(bin)) return { ok: false, output: `rclone not found (${bin}). Install it and/or set an absolute path in Settings.` };
  const cwd = driveSyncDir();
  mkdirSync(cwd, { recursive: true }); // spawn ENOENTs if its cwd doesn't exist (Test may fire pre-boot-sweep)
  const res = await runRclone(bin, buildTestArgs({ folderId, keyFile, subject: getDriveSyncSubject() }), cwd);
  return { ok: res.ok, output: driveSyncResultOutput(res) };
}

export function driveSyncResultOutput(result = {}) {
  return String(result.tail || "").trim() || (result.ok
    ? "OK — folder reachable (empty)."
    : `Drive sync ${result.outcome?.summary || "failed before it completed"}.`);
}

// Start the periodic sweep. Interval is read live each tick, so admin changes take effect without a
// restart. Returns the timer. A single sweep is non-overlapping via the per-slug inFlight guard.
export function startDriveSync() {
  mkdirSync(driveSyncDir(), { recursive: true });
  const tick = () => runSweep("schedule"); // don't stack sweeps if one runs long
  // Re-read the interval each fire by scheduling the next tick from within (a fixed setInterval
  // couldn't honor a changed setting). Kick off on a short first delay so boot isn't blocked.
  let timer;
  const schedule = () => {
    const ms = Math.max(1, getDriveSyncIntervalMinutes()) * 60 * 1000;
    timer = setTimeout(async () => { await tick(); schedule(); }, ms);
    timer.unref?.();
  };
  timer = setTimeout(async () => { await tick(); schedule(); }, 30 * 1000);
  timer.unref?.();
  console.log("[drivesync] Google Drive sync sweep started");
  return { stop: () => clearTimeout(timer) };
}
