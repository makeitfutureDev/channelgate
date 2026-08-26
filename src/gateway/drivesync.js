// Scheduled two-way Google Drive ↔ channel-folder sync, via `rclone bisync`.
//
// A channel with `meta.syncDriveFolder` set (a Drive folder link) gets that folder bisync'd on a
// timer into a DEDICATED `Drive/` subfolder of its working folder — NEVER the folder root. The
// working-folder root holds the confinement scaffolding (`.claude/`, `CLAUDE.md`, `AGENTS.md`,
// `MEMORY.md`, `memory/`, `uploads/`); a two-way sync of the whole folder would push that lockdown
// up to Drive and let a Drive-side edit overwrite it — a confinement breach. Isolating the sync to
// `Drive/` keeps the agent able to read/write synced files inside the sandbox while the lockdown
// stays untouched.
//
// Auth is a Google Workspace SERVICE ACCOUNT: a JSON key file (global setting) is passed to rclone
// via `--drive-service-account-file`, optionally impersonating a subject user (`--drive-impersonate`,
// domain-wide delegation). No interactive `rclone config`, no OAuth, no per-user tokens — and no
// secret ever crosses into the child env (everything rides in argv/flags, and the key stays a path).
//
// Dormant by default: nothing runs unless the global `driveSyncEnabled` switch is on AND rclone is
// installed AND a key file is configured. Missing any of those → a logged skip, never a throw.

import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
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
import { gatewayRoot, configDir } from "../config/paths.js";
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

// The dedicated, sandbox-safe local sync target inside a channel's working folder.
export function syncSubdir(workDir) {
  return path.join(workDir, "Drive");
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
export function buildBisyncArgs({ localPath, folderId, keyFile, subject, workDir, conflict = "newer", firstRun = false }) {
  const args = ["bisync", localPath, ":drive:", ...driveAuthFlags({ folderId, keyFile, subject })];
  args.push("--workdir", workDir); // bisync listing state — kept under the gateway root, not ~/.cache
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
const lastResult = new Map(); // slug -> { ok, at, tail } for status/debug
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
export function needsResync(stateDir) {
  return !existsSync(resyncSentinel(stateDir));
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

// Is the rclone binary runnable? Probed once PER BINARY PATH — a single global boolean meant that
// correcting a wrong path in Settings had no effect until the daemon restarted. An absolute path
// from settings sidesteps launchd's minimal PATH.
export function rcloneAvailable(bin) {
  const key = String(bin || "");
  if (rcloneChecked.has(key)) return rcloneChecked.get(key);
  let ok;
  try {
    const r = spawnSync(key, ["version"], { env: buildChildEnv(), stdio: "ignore" });
    ok = !r.error && r.status === 0;
  } catch {
    ok = false;
  }
  rcloneChecked.set(key, ok);
  return ok;
}

// Run one rclone invocation, capturing a rolling tail of its output. Resolves (never rejects) with
// { ok, code, tail }. Cross-platform: a bare argv spawn (no shell), portable timeout + kill.
function runRclone(bin, args, cwd) {
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

// Sync one channel. Assumes the caller resolved config + eligibility. Serialized per-slug.
async function syncOne({ slug, channelId, folderId, meta }, { bin, keyFile, subject, conflict }) {
  if (inFlight.has(slug)) return; // previous pass still running — skip this tick
  inFlight.add(slug);
  try {
    const workDir = effectiveWorkDir(slug, meta || {}); // the channel's real folder (honors a custom workDir)
    const localPath = syncSubdir(workDir);
    const stateDir = channelWorkDir(slug);
    const firstRun = needsResync(stateDir);
    mkdirSync(localPath, { recursive: true }); // both sides must exist before bisync
    mkdirSync(stateDir, { recursive: true });
    const args = buildBisyncArgs({ localPath, folderId, keyFile, subject, workDir: stateDir, conflict, firstRun });
    const res = await runRclone(bin, args, workDir);
    lastResult.set(slug, { ok: res.ok, at: Date.now(), tail: res.tail });
    if (res.ok) {
      // Only a COMPLETED --resync earns the sentinel; until it exists every tick retries the resync.
      if (firstRun) {
        try { writeFileSync(resyncSentinel(stateDir), `${new Date().toISOString()}\n`, { mode: 0o600 }); } catch {}
      }
      await logEvent("drivesync_run", { slug, channel: channelId, firstRun });
    } else {
      // A failed first run must retry --resync next tick against a clean slate, so drop the
      // (now-stale) listing state. No sentinel was written, so the retry stays a first run either
      // way — this only removes a half-built baseline rclone would otherwise read.
      if (firstRun) { try { rmSync(stateDir, { recursive: true, force: true }); } catch {} }
      await logEvent("drivesync_error", { slug, channel: channelId, code: res.code, signal: res.signal, outcome: res.outcome?.kind, tail: res.tail.slice(-800) });
      const detail = conciseProcessDiagnostic(res.tail, 300);
      console.error(`[drivesync] ${slug} bisync ${res.outcome?.summary || "failed before it completed"}${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    inFlight.delete(slug);
  }
}

// One sweep: resolve config, then sync every eligible channel. Errors are contained per-channel.
async function sweep() {
  if (!getDriveSyncEnabled()) return;
  const keyFile = resolveDriveSyncKeyFile();
  if (!keyFile) return; // no key (pasted JSON or on-host file) yet — dormant
  const bin = getDriveSyncRclonePath();
  if (!rcloneAvailable(bin)) return; // rclone not installed — dormant (logged once at start)
  const subject = getDriveSyncSubject();
  const conflict = getDriveSyncConflict();
  const eligible = selectSyncChannels(await listChannels());
  for (const ch of eligible) {
    try {
      await syncOne(ch, { bin, keyFile, subject, conflict });
    } catch (e) {
      console.error(`[drivesync] ${ch.slug} sweep error:`, e?.message || e);
    }
  }
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
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // don't stack sweeps if one runs long
    ticking = true;
    try {
      await sweep();
    } catch (e) {
      console.error("[drivesync] sweep error:", e?.message || e);
    } finally {
      ticking = false;
    }
  };
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
