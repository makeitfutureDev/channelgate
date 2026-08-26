#!/usr/bin/env node
// One-time migration for the ChannelGate rename (formerly Claude Gateway for Slack).
//
// Two things move:
//   • the hidden runtime root      ~/.claude-gateway/  →  ~/.channelgate/
//   • the visible workspace root   ~/Slack Agent/<slug>/  →  ~/ChannelGate/<platform>/<slug>/
// and, inside the runtime root, the per-channel metadata and the clean-mode workspaces gain the
// same platform component: channels/<slug> → channels/<platform>/<slug>.
//
// It runs ONCE at boot (src/server.js calls it before the database is opened and before Slack
// connects) and as the post-update step of `update_gateway`. It is idempotent: with the new roots
// already in place there is nothing to do and it returns immediately.
//
// It NEVER fails the boot. Anything unexpected is logged and the daemon carries on — see
// `applyFallback()` for what "carries on" means (the old roots are pinned back into the
// environment, so a half-done or refused migration keeps serving from where the data actually is).
//
//   node scripts/migrate-channelgate.mjs            # migrate
//   node scripts/migrate-channelgate.mjs --dry-run  # print the plan + the audit, change nothing
//   node scripts/migrate-channelgate.mjs --verify   # read-only audit; exit 1 if anything still
//                                                   # points at a pre-rename root
import { access, cp, mkdir, readdir, readFile, realpath, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayRoot, workspaceRoot } from "../src/config/paths.js";
import { platformFolderName } from "../src/platforms/registry.js";

// The pre-rename defaults. Only ever used as SOURCES — nothing is written back to them except the
// MOVED.md breadcrumb.
export const LEGACY_GATEWAY_DIRNAME = ".claude-gateway";
export const LEGACY_WORKSPACE_DIRNAME = "Slack Agent";

const BREADCRUMB = "MOVED.md";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but belongs to another user. Alive for our purposes.
    return e?.code === "EPERM";
  }
}

// Read a lock file written as JSON with a `pid`. Both gateway.lock (src/util/singleton.js) and
// update.lock (src/gateway/update-state.js) use that shape.
function lockHolder(file) {
  try {
    const pid = Number(JSON.parse(readFileSync(file, "utf8"))?.pid);
    return pidAlive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

// ── Which roots are we moving ────────────────────────────────────────────────────────────────
// An explicit env override means the operator already told us where the data lives (a systemd
// install points CHANNELGATE_DIR at /var/lib/…), so there is no rename to perform for that root —
// only the per-channel platform folders inside it.
export function resolveRoots({ env = process.env, home = os.homedir(), legacyRoot, legacyWorkspace, newRoot, newWorkspace } = {}) {
  const rootPinned = Boolean(env.CHANNELGATE_DIR || env.CLAUDE_GATEWAY_DIR);
  const workspacePinned = Boolean(env.CG_WORKSPACE_DIR);
  return {
    legacyRoot: legacyRoot ?? path.join(home, LEGACY_GATEWAY_DIRNAME),
    newRoot: newRoot ?? gatewayRoot(),
    legacyWorkspace: legacyWorkspace ?? path.join(home, LEGACY_WORKSPACE_DIRNAME),
    newWorkspace: newWorkspace ?? workspaceRoot(),
    // A pinned root is only "pinned" when the caller did not hand us explicit roots (tests do).
    rootPinned: legacyRoot === undefined && newRoot === undefined ? rootPinned : false,
    workspacePinned: legacyWorkspace === undefined && newWorkspace === undefined ? workspacePinned : false,
  };
}

// ── Stop-the-world check ─────────────────────────────────────────────────────────────────────
// Three signals that the PRE-RENAME deployment is still doing work under the old roots. Each one
// would be corrupted by moving a directory out from under it:
//   1. gateway.lock held by a live pid — a daemon is running (its DB handle, run-tmp files and
//      every channel cwd point into the old root).
//   2. update.lock held by a live pid — a self-update transaction is mid-flight; it snapshots and
//      restores paths under the old root.
//   3. a bg_jobs row whose recorded pid is still alive — a DETACHED background shell outlives the
//      daemon and keeps its cwd inside the old workspace, so it would keep writing into a folder
//      we just moved.
// Anything we cannot read is treated as "not busy": an unreadable lock is far more likely to be a
// leftover than a running daemon, and refusing forever on a corrupt file would be worse.
export async function busyReason(legacyRoot, { readActiveJobPids = defaultActiveJobPids } = {}) {
  const daemon = lockHolder(path.join(legacyRoot, "gateway.lock"));
  if (daemon) return `the pre-rename daemon is running (gateway.lock held by pid ${daemon})`;
  const updater = lockHolder(path.join(legacyRoot, "update.lock"));
  if (updater) return `a self-update transaction is in flight (update.lock held by pid ${updater})`;
  const jobs = (await readActiveJobPids(legacyRoot)).filter((pid) => pidAlive(pid));
  if (jobs.length) return `${jobs.length} detached background job(s) are still running (pid ${jobs.join(", ")})`;
  return "";
}

// Read the pids of durable background jobs straight out of the old database, read-only, without
// going through src/db (which would open the daemon's cached handle and run migrations).
async function defaultActiveJobPids(legacyRoot) {
  const file = path.join(legacyRoot, "gateway.db");
  if (!(await exists(file))) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT data FROM bg_jobs").all();
      return rows
        .map((r) => {
          try {
            return Number(JSON.parse(r.data)?.pid);
          } catch {
            return 0;
          }
        })
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } finally {
      db.close();
    }
  } catch {
    return []; // no such table / locked / unreadable — treat as idle
  }
}

// ── Reading the database without touching it ─────────────────────────────────────────────────
// A DRY RUN must not create anything, and `getDb()` would: it opens (and therefore CREATES) the
// database at the CURRENT dbFile(), which on an un-migrated machine is inside the new runtime root
// that does not exist yet. That single side effect would then make the real migration refuse to
// move the root, because the destination now exists. So a dry run reads the OLD database directly,
// read-only, and never goes near src/db.
async function openReadOnly(file) {
  if (!(await exists(file))) return null;
  const { DatabaseSync } = await import("node:sqlite");
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

// The database a dry run should inspect: an explicit env override wins, otherwise the file sitting
// in whichever root still holds the data.
export function dryRunDbFile(sourceRoot, env = process.env) {
  const explicit = env.CHANNELGATE_DB || env.CLAUDE_GATEWAY_DB;
  return explicit ? path.resolve(explicit) : path.join(sourceRoot, "gateway.db");
}

// { slug, platform, customWorkDir } for every channel, straight from the two tables the store
// writes. Same shape listChannels() produces, without opening the daemon's cached handle.
export function readChannelRecords(db) {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare("SELECT slug, data FROM channels").all();
  } catch {
    return []; // pre-SQLite install, or an unreadable database — nothing to enumerate
  }
  const metaBySlug = new Map();
  try {
    for (const m of db.prepare("SELECT slug, data FROM channel_meta").all()) {
      try {
        metaBySlug.set(m.slug, JSON.parse(m.data));
      } catch {
        /* unparseable meta — treated as absent */
      }
    }
  } catch {
    /* no channel_meta table */
  }
  const out = [];
  for (const row of rows) {
    const meta = metaBySlug.get(row.slug) || {};
    out.push({ slug: row.slug, platform: meta.platform, customWorkDir: Boolean((meta.workDir || "").trim()) });
  }
  return out;
}

// ── Moving ───────────────────────────────────────────────────────────────────────────────────
// Recursive listing of relative entry paths (+ file sizes) used to prove a cross-device copy
// landed intact before the source is deleted.
async function inventory(root, base = root, out = new Map()) {
  for (const d of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, d.name);
    const rel = path.relative(base, full);
    if (d.isDirectory()) {
      out.set(rel, "dir");
      await inventory(full, base, out);
    } else if (d.isSymbolicLink()) {
      out.set(rel, "link");
    } else {
      out.set(rel, String((await stat(full).catch(() => ({ size: -1 }))).size));
    }
  }
  return out;
}

// Move a tree. `rename` and `copy` are injected so the cross-device path — and a copy that loses
// data — are testable without a second filesystem. On EXDEV (or a rename the filesystem refuses)
// we copy, VERIFY, and only then remove the source: a copy that silently dropped files would
// otherwise be indistinguishable from a successful move, and the source would already be gone.
export async function moveTree(from, to, { rename = fsRename, copy = cp, log = () => {} } = {}) {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
    return "rename";
  } catch (error) {
    if (error?.code !== "EXDEV" && error?.code !== "EPERM" && error?.code !== "ENOTEMPTY") throw error;
    log(`    cross-device (${error.code}) — copying ${from} → ${to} and verifying`);
    const before = await inventory(from);
    await copy(from, to, { recursive: true, verbatimSymlinks: true });
    const after = await inventory(to);
    for (const [rel, sig] of before) {
      const got = after.get(rel);
      if (got === undefined) throw new Error(`copy verification failed: ${rel} is missing at ${to}`);
      if (sig !== got) throw new Error(`copy verification failed: ${rel} differs (${sig} vs ${got})`);
    }
    await rm(from, { recursive: true, force: true });
    return "copy";
  }
}

// Does this directory hold real gateway STATE, as opposed to merely existing? Existence alone is
// far too weak a signal to gate a one-time migration on: a stray `mkdir`, a test that forgot to
// pin its env, or an engine probe reaching for a synthetic home under the runtime root is enough
// to create `~/.channelgate/` with nothing in it — and then the migration would skip forever while
// the daemon quietly served from an empty install next to the operator's real data.
//
// `gateway.db` is the source of truth for everything operational; `config/` holds the JSON that
// predates it. Either one means "this root is live".
export async function hasRuntimeState(root) {
  return (await exists(path.join(root, "gateway.db"))) || (await exists(path.join(root, "config")));
}

// The same question for the visible workspace: a workspace root is "live" only if it actually
// contains folders. An empty `~/ChannelGate/` is a leftover, never a reason to skip.
export async function workspaceHasFolders(root) {
  try {
    return (await readdir(root, { withFileTypes: true })).some((d) => d.isDirectory());
  } catch {
    return false;
  }
}

// Move the CONTENTS of `from` into an existing `to`, entry by entry. Used when the destination
// root exists but holds no state — a leftover directory rather than an install. Nothing at the
// destination is ever overwritten: a name that already exists is reported as a collision and its
// source copy is left exactly where it is, for a human to reconcile.
export async function mergeTree(from, to, { rename = fsRename, copy = cp, log = () => {} } = {}) {
  await mkdir(to, { recursive: true });
  const moved = [];
  const collisions = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === BREADCRUMB) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (await exists(dst)) {
      collisions.push(entry.name);
      log(`    COLLISION: ${dst} already exists — left ${src} in place, nothing overwritten`);
      continue;
    }
    await moveTree(src, dst, { rename, copy, log });
    moved.push(entry.name);
  }
  return { moved, collisions };
}

async function breadcrumb(dir, body, { dryRun }) {
  if (dryRun) return;
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, BREADCRUMB), body, "utf8");
}

// ── Stored absolute paths ────────────────────────────────────────────────────────────────────
// Every mapping the move created, most specific first. A plain "old root → new root" prefix rule
// is not enough: channels/<slug> and clean-workspaces/<slug> gained a platform component INSIDE
// the new root, and a channel's default workspace folder moved to a different root entirely.
// Only paths that actually moved are rewritten — a custom workDir that happens to sit under
// ~/Slack Agent was deliberately NOT moved, so its stored path must stay exactly as it is.
export function buildPathRewrites({ legacyRoot, newRoot, legacyWorkspace, newWorkspace, channels }) {
  const rules = [];
  for (const { slug, platform, customWorkDir } of channels) {
    const pf = platformFolderName(platform);
    rules.push([path.join(newRoot, "channels", slug), path.join(newRoot, "channels", pf, slug)]);
    rules.push([path.join(legacyRoot, "channels", slug), path.join(newRoot, "channels", pf, slug)]);
    rules.push([path.join(newRoot, "clean-workspaces", slug), path.join(newRoot, "clean-workspaces", pf, slug)]);
    rules.push([path.join(legacyRoot, "clean-workspaces", slug), path.join(newRoot, "clean-workspaces", pf, slug)]);
    if (!customWorkDir) rules.push([path.join(legacyWorkspace, slug), path.join(newWorkspace, pf, slug)]);
  }
  // The catch-all for everything else that lives in the runtime root and moved with it wholesale:
  // logs, run-tmp, engine-state, update-backups, models, tools.
  rules.push([legacyRoot, newRoot]);
  // Longest source first so channels/<slug> wins over the bare root prefix.
  rules.sort((a, b) => b[0].length - a[0].length);
  return rules;
}

// Rewrite one string if it is (or is under) a moved path. Boundary-aware: "<root>/channels/ops"
// must not match a stored "<root>/channels/ops-archive".
export function rewritePath(value, rules) {
  if (typeof value !== "string" || !value.startsWith("/")) return value;
  for (const [from, to] of rules) {
    if (value === from) return to;
    if (value.startsWith(from + path.sep)) return to + value.slice(from.length);
  }
  return value;
}

function rewriteDeep(node, rules) {
  if (typeof node === "string") return rewritePath(node, rules);
  if (Array.isArray(node)) return node.map((v) => rewriteDeep(v, rules));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteDeep(v, rules);
    return out;
  }
  return node;
}

// The historical audit log: a record of what happened, never rewritten. The audit reports what it
// still contains so the number is visible rather than silently corrected.
export const HISTORICAL_TABLES = Object.freeze(["events"]);

// Every table in the schema keeps its record in a JSON `data` blob (see src/db/migrations.js), so
// one generic pass covers channel meta workDirs, background-job cwds and log files, approval
// records, active/api run records and anything a later migration adds — rather than a hand-listed
// set of fields that a new column would silently fall out of.
export function rewriteDatabasePaths(db, rules, { dryRun = false } = {}) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  let changed = 0;
  for (const table of tables) {
    // The historical audit log is a record of what happened; rewriting it would make it say
    // something else. Reported by the audit instead — see countHistoricalPaths().
    if (HISTORICAL_TABLES.includes(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes("data")) continue;
    const key = ["id", "slug", "channel_id", "user_id"].find((c) => columns.includes(c));
    if (!key) continue;
    const rows = db.prepare(`SELECT ${key} AS k, data FROM ${table}`).all();
    for (const row of rows) {
      let parsed;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const next = JSON.stringify(rewriteDeep(parsed, rules));
      if (next === row.data) continue;
      changed++;
      if (!dryRun) db.prepare(`UPDATE ${table} SET data = ? WHERE ${key} = ?`).run(next, row.k);
    }
  }
  return changed;
}

// JSON files that are not in the database but do carry absolute paths: the update state, each
// update backup's manifest, and the UI-managed settings file.
async function rewriteJsonFiles(root, rules, { dryRun, log }) {
  const files = [path.join(root, "update-state.json"), path.join(root, "config", "settings.json")];
  try {
    for (const d of await readdir(path.join(root, "update-backups"), { withFileTypes: true })) {
      if (d.isDirectory()) files.push(path.join(root, "update-backups", d.name, "manifest.json"));
    }
  } catch {
    /* no backups yet */
  }
  let changed = 0;
  for (const file of files) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const next = JSON.stringify(rewriteDeep(parsed, rules), null, 2) + "\n";
    if (JSON.stringify(rewriteDeep(parsed, rules)) === JSON.stringify(parsed)) continue;
    changed++;
    log(`    rewrite paths in ${file}`);
    if (!dryRun) await writeFile(file, next, "utf8");
  }
  return changed;
}

// ── Text stores ──────────────────────────────────────────────────────────────────────────────
// The JSON/deep rewrite above only reaches values that are already parsed. A lot of what has to
// move lives in plain text — TOML, Markdown, a launchd plist, a systemd unit — so this is the
// same rule applied to raw text.
//
// Two guards make a substring replacement safe here:
//   · BOUNDARY. A match only counts when the old root ends at a real path boundary. Without this,
//     `<home>/Slack Agent` would also rewrite `<home>/Slack Agent-archive`, which is a different
//     directory that did not move.
//   · URLs. `https://example.com/home/management/Slack Agent` is a link, not a local path.
//     A match preceded (within its own unbroken token) by `://` is skipped.
const PATH_TAIL = /[A-Za-z0-9._-]/;

// Does the old path END here, or does the text carry on into a DIFFERENT path? `/ws/ops/x` and
// `/ws/ops-archive` both continue; `/ws/ops.` at the end of a sentence does not. A dot is the
// awkward case — it starts a real extension (`/ws/ops.bak`) and it ends a sentence — so it counts
// as a boundary only when nothing alphanumeric follows it.
function endsHere(text, index) {
  const after = text[index];
  if (after === undefined || after === "/") return true;
  if (after === ".") return !/[A-Za-z0-9]/.test(text[index + 1] ?? "");
  return !PATH_TAIL.test(after);
}

function insideUrl(text, index) {
  // Walk back to the start of the token the match sits in; a `://` inside it means a URL.
  let start = index;
  while (start > 0 && !/[\s"'`(<[{,]/.test(text[start - 1])) start--;
  return text.slice(start, index).includes("://");
}

// Replace every boundary-safe, non-URL occurrence of a moved path. Returns the new text and how
// many occurrences were rewritten.
export function rewriteTextOccurrences(text, rules) {
  let out = text;
  let count = 0;
  for (const [from, to] of rules) {
    if (!out.includes(from)) continue;
    let next = "";
    let cursor = 0;
    for (;;) {
      const at = out.indexOf(from, cursor);
      if (at === -1) break;
      if (!endsHere(out, at + from.length) || insideUrl(out, at)) {
        next += out.slice(cursor, at + from.length);
        cursor = at + from.length;
        continue;
      }
      next += out.slice(cursor, at) + to;
      cursor = at + from.length;
      count++;
    }
    out = next + out.slice(cursor);
  }
  return { text: out, count };
}

// Count occurrences without changing anything — the shared primitive behind `--verify`.
export function countTextOccurrences(text, rules) {
  return rewriteTextOccurrences(text, rules).count;
}

async function rewriteTextFile(file, rules, { dryRun, log = () => {} } = {}) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return 0;
  }
  const { text, count } = rewriteTextOccurrences(raw, rules);
  if (!count) return 0;
  log(`    ${count} path(s) in ${file}`);
  if (!dryRun) await writeFile(file, text, "utf8");
  return count;
}

// A JSONL store (Claude Code transcripts, Codex rollouts). Only lines that actually mention a
// moved path are re-serialised; every other line is kept byte for byte, so a one-time migration
// cannot silently reformat a 2 MB transcript. A line that mentions one and does NOT parse aborts
// the whole file — a half-rewritten transcript is worse than an un-migrated one.
export async function rewriteJsonlFile(file, rules, { dryRun = false } = {}) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { count: 0 };
  }
  const lines = raw.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!countTextOccurrences(line, rules)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return { count: 0, error: `${file}: line ${i + 1} does not parse (${error.message}) — file left untouched` };
    }
    const next = JSON.stringify(rewriteDeep(parsed, rules));
    if (next === line) continue;
    lines[i] = next;
    count++;
  }
  if (count && !dryRun) await writeFile(file, lines.join("\n"), "utf8");
  return { count };
}

async function* walkFiles(dir, match) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow a link out of the tree we were handed
    if (entry.isDirectory()) yield* walkFiles(full, match);
    else if (match(entry.name)) yield full;
  }
}

// ── Claude Code session stores ───────────────────────────────────────────────────────────────
// Claude Code keeps a session per PROJECT, and the project is identified by the directory name
// `<stateDir>/projects/<encoded-cwd>/`. `claude -r <id>` resolves that directory from the cwd it
// is launched in, so a channel whose folder moved cannot resume anything until the directory is
// renamed to the encoding of its NEW cwd.
//
// The encoding is Claude Code's own (verified against the shipped CLI, v2.1.246): every character
// outside [A-Za-z0-9] becomes "-", and a name longer than 200 characters is truncated to 200 with
// a "-<hash>" suffix, the hash being a 32-bit string hash of the FULL cwd in base 36. Reproduced
// here rather than approximated, because a name we compute differently is a session Claude Code
// will never find.
export const CLAUDE_PROJECT_NAME_MAX = 200;

function claudeStringHash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return h;
}

export function claudeProjectDirName(cwd) {
  const encoded = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= CLAUDE_PROJECT_NAME_MAX) return encoded;
  return `${encoded.slice(0, CLAUDE_PROJECT_NAME_MAX)}-${Math.abs(claudeStringHash(String(cwd))).toString(36)}`;
}

// The cwd a project directory belongs to, read from the transcripts rather than guessed from the
// directory NAME. The encoding is lossy — `/a/b/c` and `/a/b-c` encode identically — so decoding a
// name would be a guess, and a wrong guess renames someone else's sessions. Every transcript line
// Claude Code writes for a real turn carries the absolute `cwd`, so we read it.
export async function claudeProjectCwd(dir) {
  let names;
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
  } catch {
    return "";
  }
  for (const name of names.sort()) {
    let raw;
    try {
      raw = await readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(line)?.cwd;
        if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
      } catch {
        /* keep looking */
      }
    }
  }
  return "";
}

// Rename each project directory whose cwd moved, and rewrite the `cwd` fields inside its
// transcripts (including the per-session `subagents/` and `tool-results/` trees). `knownCwds` maps
// an encoded directory NAME to its cwd, for directories with no readable transcript.
export async function rewriteClaudeProjects(projectsDir, rules, { dryRun = false, log = () => {}, knownCwds = new Map() } = {}) {
  const result = { renamed: 0, files: 0, occurrences: 0, collisions: [], errors: [], unresolved: [] };
  let entries;
  try {
    entries = (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory() || e.isSymbolicLink());
  } catch {
    return result; // no Claude state on this host
  }
  for (const entry of entries) {
    const dir = path.join(projectsDir, entry.name);
    const cwd = (await claudeProjectCwd(dir)) || knownCwds.get(entry.name) || "";
    if (!cwd) {
      // Only worth reporting when the NAME suggests it belongs to something that moved.
      if (rules.some(([from]) => entry.name.startsWith(claudeProjectDirName(from)))) result.unresolved.push(entry.name);
      continue;
    }
    const newCwd = rewritePath(cwd, rules);
    let current = dir;
    if (newCwd !== cwd) {
      const target = claudeProjectDirName(newCwd);
      if (target !== entry.name) {
        const targetDir = path.join(projectsDir, target);
        if (await exists(targetDir)) {
          result.collisions.push(entry.name);
          log(`    COLLISION: ${targetDir} already exists — left ${entry.name} in place`);
          continue;
        }
        log(`    ${entry.name} → ${target}  (cwd ${cwd} → ${newCwd})`);
        if (!dryRun) await fsRename(dir, targetDir);
        current = dryRun ? dir : targetDir;
        result.renamed++;
      }
    }
    // The transcripts record the cwd on nearly every line; a resumed session that reports the old
    // one would send the model a path that no longer exists.
    for await (const file of walkFiles(current, (name) => name.endsWith(".jsonl") || name.endsWith(".json"))) {
      const { count, error } = await rewriteJsonlFile(file, rules, { dryRun });
      if (error) {
        result.errors.push(error);
        continue;
      }
      if (count) {
        result.files++;
        result.occurrences += count;
      }
    }
  }
  return result;
}

// The rest of the engine home. `.claude.json` (both the home-level and the state-level copy) keys
// a `projects` map by absolute cwd, and `settings.json` can name directories.
export async function rewriteClaudeEngineHome(claudeHome, rules, { dryRun = false, log = () => {} } = {}) {
  let count = 0;
  for (const rel of [".claude.json", path.join(".claude", ".claude.json"), path.join(".claude", "settings.json")]) {
    count += await rewriteTextFile(path.join(claudeHome, rel), rules, { dryRun, log });
  }
  return count;
}

// ── Codex state ──────────────────────────────────────────────────────────────────────────────
// Codex persists the lexical rollout pathname in its thread index (see
// src/engines/codex-usage.js), writes the cwd into each rollout's header line, and can name
// project directories in config.toml. All three have to follow the move or a resumed Codex thread
// looks up a rollout that is not there any more.
export async function rewriteCodexState(codexHome, rules, { dryRun = false, log = () => {} } = {}) {
  const result = { indexRows: 0, files: 0, occurrences: 0, errors: [] };

  // The thread index: a plain TEXT column, so a targeted UPDATE rather than a JSON pass.
  let names = [];
  try {
    names = (await readdir(codexHome)).filter((name) => /^state.*\.sqlite$/.test(name));
  } catch {
    names = [];
  }
  for (const name of names) {
    const file = path.join(codexHome, name);
    let db;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(file, dryRun ? { readOnly: true } : {});
      const rows = db.prepare("SELECT id, rollout_path FROM threads WHERE rollout_path IS NOT NULL").all();
      for (const row of rows) {
        const next = rewritePath(String(row.rollout_path), rules);
        if (next === row.rollout_path) continue;
        result.indexRows++;
        if (!dryRun) db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(next, row.id);
      }
    } catch (error) {
      // No `threads` table on this Codex version, or the file is locked by a running Codex.
      result.errors.push(`${file}: ${error.message}`);
    } finally {
      try {
        db?.close();
      } catch {
        /* no-op */
      }
    }
  }

  // Rollout transcripts. `sessions` is often a symlink to the operator's ~/.codex/sessions, so it
  // is resolved explicitly rather than walked through (walkFiles never follows links).
  let sessionsDir = path.join(codexHome, "sessions");
  try {
    sessionsDir = await realpath(sessionsDir);
  } catch {
    /* absent — nothing to walk */
  }
  for await (const file of walkFiles(sessionsDir, (name) => name.endsWith(".jsonl"))) {
    const { count, error } = await rewriteJsonlFile(file, rules, { dryRun });
    if (error) {
      result.errors.push(error);
      continue;
    }
    if (count) {
      result.files++;
      result.occurrences += count;
    }
  }

  // config.toml keys `[projects."<abs path>"]` sections; shell snapshots bake the cwd into a
  // sourced script.
  const configCount = await rewriteTextFile(path.join(codexHome, "config.toml"), rules, { dryRun, log });
  if (configCount) {
    result.files++;
    result.occurrences += configCount;
  }
  for await (const file of walkFiles(path.join(codexHome, "shell_snapshots"), () => true)) {
    const count = await rewriteTextFile(file, rules, { dryRun, log });
    if (count) {
      result.files++;
      result.occurrences += count;
    }
  }
  return result;
}

// ── Typed database columns ───────────────────────────────────────────────────────────────────
// The JSON pass covers every `data` blob. A handful of columns hold a path as a bare string
// instead (`usage_repair_batches.backup_path` today), and a later migration may add more, so this
// walks EVERY text column that is not a `data` blob and rewrites the values that are moved paths.
// `events` is the historical audit log: rewriting it would falsify a record of what happened, so
// it is counted and reported, never changed (see HISTORICAL_TABLES above).
export function rewriteTypedColumns(db, rules, { dryRun = false } = {}) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const changed = [];
  for (const table of tables) {
    if (HISTORICAL_TABLES.includes(table)) continue;
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const pk = info.filter((c) => c.pk).map((c) => c.name);
    const key = pk.length === 1 ? pk[0] : info.find((c) => ["id", "slug", "channel_id", "user_id"].includes(c.name))?.name;
    if (!key) continue;
    for (const column of info) {
      if (column.name === "data" || column.name === key) continue; // blobs go through the JSON pass
      if (!/^TEXT/i.test(String(column.type || ""))) continue;
      const rows = db.prepare(`SELECT ${key} AS k, ${column.name} AS v FROM ${table} WHERE ${column.name} LIKE '/%'`).all();
      for (const row of rows) {
        const next = rewritePath(String(row.v), rules);
        if (next === row.v) continue;
        changed.push(`${table}.${column.name}`);
        if (!dryRun) db.prepare(`UPDATE ${table} SET ${column.name} = ? WHERE ${key} = ?`).run(next, row.k);
      }
    }
  }
  return changed;
}

// Occurrences left in the historical log, reported but never rewritten.
export function countHistoricalPaths(db, rules) {
  let count = 0;
  for (const table of HISTORICAL_TABLES) {
    let rows;
    try {
      rows = db.prepare(`SELECT data FROM ${table} WHERE data IS NOT NULL`).all();
    } catch {
      continue;
    }
    for (const row of rows) count += countTextOccurrences(String(row.data), rules);
  }
  return count;
}

// ── Config JSON that is not the settings file ────────────────────────────────────────────────
// mcp-catalog.json holds admin-curated MCP servers, whose stdio `command`/`args`/`env` regularly
// name an absolute path. The pre-SQLite JSON files are still on disk as inert backups; they are
// rewritten too so a restore from them lands on the new layout.
export async function rewriteConfigJson(root, rules, { dryRun = false, log = () => {} } = {}) {
  const files = ["mcp-catalog.json", "users.json", "channels.json", "schedules.json", "acks.json", "followups.json"];
  let count = 0;
  for (const name of files) count += await rewriteTextFile(path.join(root, "config", name), rules, { dryRun, log });
  return count;
}

// Per-channel `runtime/` holds CONTENT-ADDRESSED caches: the per-run Claude settings file is named
// after the sha256 of its own contents, and each staged plugin tree after the digest of the tree
// (see src/gateway/run-grant-artifacts.js). Rewriting a path inside one would leave a file whose
// name no longer describes it, and the next run would miss the cache and write a second copy
// anyway. They are pure caches — deleting them is both correct and vastly cheaper than rewriting
// (on this project's production install they hold ~95k of the ~99k path occurrences in the
// channels tree). The next run recreates whatever it needs, with the new paths.
export const REGENERABLE_RUNTIME_DIRS = Object.freeze(["claude-settings", "claude-plugins"]);

export async function purgeRegenerableCaches(channelsRoot, { dryRun = false, log = () => {} } = {}) {
  const removed = [];
  const platforms = await readdir(channelsRoot, { withFileTypes: true }).catch(() => []);
  for (const platform of platforms) {
    if (!platform.isDirectory()) continue;
    const level = path.join(channelsRoot, platform.name);
    // The channels root is one level of platform folders now, but a half-migrated tree (or a
    // pinned root that never moved) can still be flat — handle both by checking each level.
    const candidates = [level];
    for (const child of await readdir(level, { withFileTypes: true }).catch(() => [])) {
      if (child.isDirectory()) candidates.push(path.join(level, child.name));
    }
    for (const dir of candidates) {
      for (const name of REGENERABLE_RUNTIME_DIRS) {
        const target = path.join(dir, "runtime", name);
        if (!(await exists(target))) continue;
        removed.push(target);
        if (!dryRun) await rm(target, { recursive: true, force: true });
      }
    }
  }
  if (removed.length) log(`    ${removed.length} content-addressed run cache(s) dropped (recreated on the next run)`);
  return removed;
}

// Legacy per-channel JSON left behind by the pre-SQLite layout (meta.json / sessions.json and the
// thread-override files), which the store keeps as inert backups.
export async function rewriteChannelLegacyJson(channelsRoot, rules, { dryRun = false, log = () => {} } = {}) {
  let count = 0;
  for await (const file of walkFiles(channelsRoot, (name) => name.endsWith(".json"))) {
    // `.claude/` is regenerated wholesale by ensureChannelFolder; `runtime/` is purged above.
    if (file.includes(`${path.sep}.claude${path.sep}`)) continue;
    if (file.includes(`${path.sep}runtime${path.sep}`)) continue;
    count += await rewriteTextFile(file, rules, { dryRun, log });
  }
  return count;
}

// ── Text inside the work folders ─────────────────────────────────────────────────────────────
// A channel's memory and its instruction file are the agent's own prose, and either can quote an
// absolute path it was told to use. `.claude/settings.json` is regenerated, not rewritten.
export async function rewriteWorkFolderText(folders, rules, { dryRun = false, log = () => {} } = {}) {
  const result = { files: 0, occurrences: 0 };
  for (const folder of folders) {
    const targets = [path.join(folder, "MEMORY.md"), path.join(folder, "CLAUDE.md"), path.join(folder, "AGENTS.md")];
    for await (const file of walkFiles(path.join(folder, "memory"), (name) => name.endsWith(".md"))) targets.push(file);
    for (const file of targets) {
      const count = await rewriteTextFile(file, rules, { dryRun, log });
      if (count) {
        result.files++;
        result.occurrences += count;
      }
    }
  }
  return result;
}

// ── Service definitions ──────────────────────────────────────────────────────────────────────
// The installed service definition bakes the runtime root into its log paths (and, on launchd,
// into the environment). After the move those paths point at a directory that no longer exists, so
// the service would start and then fail to open its own log. These are user-owned files, so they
// are rewritten in place — but the running service still holds the OLD definition: launchd and
// systemd both cache it until told otherwise, which is why this reports a reload command.
export function serviceDefinitionPaths(home = os.homedir()) {
  return [
    // macOS, both install modes.
    path.join(home, "Library", "LaunchAgents", "com.makeitfuture.channelgate.plist"),
    path.join(home, "Library", "LaunchAgents", "com.makeitfuture.claude-gateway.plist"),
    // Linux, the user-scope unit an ordinary single-user box runs.
    path.join(home, ".config", "systemd", "user", "channelgate.service"),
    path.join(home, ".config", "systemd", "user", "claude-gateway.service"),
  ];
}

// Rewriting a service definition is not enough: both service managers keep their own cached copy
// of it. systemd needs `daemon-reload` before the next start picks up the new log paths, and
// launchd needs the job booted out and bootstrapped again — a `kickstart -k` re-runs the OLD
// definition. The migration cannot do that itself (it runs INSIDE the service it would tear down),
// so it leaves a marker and the updater's restart step consumes it. See
// scripts/update-runner.mjs applyPendingServiceReload().
export function serviceReloadMarkerFile(root) {
  return path.join(root, "service-reload-required.json");
}

export async function rewriteServiceDefinitions(home, rules, { dryRun = false, log = () => {} } = {}) {
  const result = { files: [], occurrences: 0, reloads: [] };
  for (const file of serviceDefinitionPaths(home)) {
    const count = await rewriteTextFile(file, rules, { dryRun, log });
    if (!count) continue;
    result.files.push(file);
    result.occurrences += count;
    const reload = file.endsWith(".plist")
      ? `launchctl bootout gui/$(id -u)/${path.basename(file, ".plist")} && launchctl bootstrap gui/$(id -u) ${file}`
      : "systemctl --user daemon-reload";
    if (!result.reloads.includes(reload)) result.reloads.push(reload);
  }
  return result;
}

// ── The audit (`--verify`) ───────────────────────────────────────────────────────────────────
// A read-only sweep for anything still pointing at a pre-rename root. It is the acceptance test
// for the migration and safe to run while the daemon is up: it opens the database read-only, never
// follows a symlink out of a tree it was handed, and writes nothing.
//
// Every store the migration rewrites is scanned, plus the two it deliberately does NOT: the
// historical `events` log (rewriting an audit trail would falsify a record of what happened) and
// the operator's own Claude/Codex state outside the runtime root. Those are reported separately so
// a non-zero total always means "something the migration should have covered is still wrong".
function legacyRulesFor({ legacyRoot, legacyWorkspace }) {
  // `to` is irrelevant when counting; the boundary and URL rules are what matter.
  return [
    [legacyRoot, legacyRoot],
    [legacyWorkspace, legacyWorkspace],
  ].sort((a, b) => b[0].length - a[0].length);
}

async function countInFile(file, rules) {
  try {
    return countTextOccurrences(await readFile(file, "utf8"), rules);
  } catch {
    return 0;
  }
}

async function countInTree(dir, rules, match = () => true) {
  let count = 0;
  let files = 0;
  for await (const file of walkFiles(dir, match)) {
    const here = await countInFile(file, rules);
    if (here) {
      count += here;
      files++;
    }
  }
  return { count, files };
}

export async function auditLegacyPaths({ env = process.env, home = os.homedir(), ...rootOverrides } = {}) {
  const { legacyRoot, newRoot, legacyWorkspace, newWorkspace } = resolveRoots({ env, home, ...rootOverrides });
  const rules = legacyRulesFor({ legacyRoot, legacyWorkspace });
  // Audit whichever runtime root is live: the new one once the move has happened, the old one
  // before it. That is what makes `--verify` useful both as a pre-flight and as the acceptance
  // check afterwards.
  const root = (await hasRuntimeState(newRoot)) ? newRoot : legacyRoot;
  const groups = [];
  const add = (store, count, { covered = true, detail = [] } = {}) => {
    if (count) groups.push({ store, count, covered, detail });
  };

  // 1 + 2 + 3. The database.
  const db = await openReadOnly(path.join(root, "gateway.db")) || (await openReadOnly(dryRunDbFile(root, env)));
  if (db) {
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      let blobs = 0;
      const blobDetail = [];
      let typed = 0;
      const typedDetail = [];
      for (const table of tables) {
        if (HISTORICAL_TABLES.includes(table)) continue;
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        for (const column of info) {
          if (!/^TEXT/i.test(String(column.type || ""))) continue;
          let rows;
          try {
            rows = db.prepare(`SELECT ${column.name} AS v FROM ${table} WHERE ${column.name} IS NOT NULL`).all();
          } catch {
            continue;
          }
          let here = 0;
          for (const row of rows) here += countTextOccurrences(String(row.v), rules);
          if (!here) continue;
          if (column.name === "data") {
            blobs += here;
            blobDetail.push(`${table}.data: ${here}`);
          } else {
            typed += here;
            typedDetail.push(`${table}.${column.name}: ${here}`);
          }
        }
      }
      add("database JSON blobs", blobs, { detail: blobDetail });
      add("database typed columns", typed, { detail: typedDetail });
      add("database historical log (events) — NOT rewritten by design", countHistoricalPaths(db, rules), { covered: false });
    } finally {
      try {
        db.close();
      } catch {
        /* no-op */
      }
    }
  }

  // 4. Config JSON + the runtime-root JSON files.
  let config = 0;
  const configDetail = [];
  for (const rel of ["config/settings.json", "config/mcp-catalog.json", "config/users.json", "config/channels.json", "config/schedules.json", "config/acks.json", "config/followups.json", "update-state.json"]) {
    const here = await countInFile(path.join(root, rel), rules);
    if (here) {
      config += here;
      configDetail.push(`${rel}: ${here}`);
    }
  }
  const backups = await countInTree(path.join(root, "update-backups"), rules, (n) => n.endsWith(".json"));
  if (backups.count) {
    config += backups.count;
    configDetail.push(`update-backups/*/manifest.json: ${backups.count}`);
  }
  // `channels/**` splits three ways: the regenerated lockdown files, the content-addressed run
  // caches the migration DELETES, and the legacy JSON backups it rewrites. Counted separately so
  // the acceptance number is not dominated by caches that are about to be dropped.
  let caches = 0;
  let cacheFiles = 0;
  let lockdown = 0;
  const channelsRoot = path.join(root, "channels");
  for await (const file of walkFiles(channelsRoot, (n) => n.endsWith(".json"))) {
    const here = await countInFile(file, rules);
    if (!here) continue;
    if (file.includes(`${path.sep}runtime${path.sep}`)) {
      caches += here;
      cacheFiles++;
    } else if (file.includes(`${path.sep}.claude${path.sep}`)) {
      lockdown += here;
    } else {
      config += here;
      configDetail.push(`${path.relative(root, file)}: ${here}`);
    }
  }
  add("config + runtime JSON", config, { detail: configDetail });
  add("per-channel lockdown files (regenerated by the migration)", lockdown);
  add("content-addressed run caches (dropped by the migration)", caches, { detail: [`${cacheFiles} file(s)`] });

  // 5. Claude Code state. The projects directory is normally a symlink into the operator's real
  // ~/.claude, so it is resolved explicitly.
  const claudeHome = path.join(root, "engine-state", "claude", "home");
  let projectsDir = path.join(claudeHome, ".claude", "projects");
  try {
    projectsDir = await realpath(projectsDir);
  } catch {
    /* absent */
  }
  const staleDirs = [];
  let transcripts = 0;
  let transcriptFiles = 0;
  try {
    for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(projectsDir, entry.name);
      const cwd = await claudeProjectCwd(dir);
      const namesStale = rules.some(([from]) => entry.name === claudeProjectDirName(from) || entry.name.startsWith(`${claudeProjectDirName(from)}-`));
      const cwdStale = cwd ? countTextOccurrences(cwd, rules) > 0 : false;
      if (namesStale || cwdStale) staleDirs.push(entry.name);
      const here = await countInTree(dir, rules, (n) => n.endsWith(".jsonl") || n.endsWith(".json"));
      transcripts += here.count;
      transcriptFiles += here.files;
    }
  } catch {
    /* no Claude state on this host */
  }
  add("Claude project directories (stale names)", staleDirs.length, { detail: staleDirs });
  add("Claude transcripts (cwd fields)", transcripts, { detail: [`${transcriptFiles} file(s)`] });
  let claudeFiles = 0;
  for (const rel of [".claude.json", ".claude/.claude.json", ".claude/settings.json"]) {
    claudeFiles += await countInFile(path.join(claudeHome, rel), rules);
  }
  add("Claude engine-home config", claudeFiles);

  // 6. Codex state.
  const codexHome = path.join(root, "engine-state", "codex", "home", ".codex");
  let codex = 0;
  const codexDetail = [];
  const codexConfig = await countInFile(path.join(codexHome, "config.toml"), rules);
  if (codexConfig) {
    codex += codexConfig;
    codexDetail.push(`config.toml: ${codexConfig}`);
  }
  let sessionsDir = path.join(codexHome, "sessions");
  try {
    sessionsDir = await realpath(sessionsDir);
  } catch {
    /* absent */
  }
  const rollouts = await countInTree(sessionsDir, rules, (n) => n.endsWith(".jsonl"));
  if (rollouts.count) {
    codex += rollouts.count;
    codexDetail.push(`sessions/**/*.jsonl: ${rollouts.count} in ${rollouts.files} file(s)`);
  }
  const snapshots = await countInTree(path.join(codexHome, "shell_snapshots"), rules);
  if (snapshots.count) {
    codex += snapshots.count;
    codexDetail.push(`shell_snapshots: ${snapshots.count} in ${snapshots.files} file(s)`);
  }
  let indexRows = 0;
  try {
    for (const name of (await readdir(codexHome)).filter((n) => /^state.*\.sqlite$/.test(n))) {
      const idx = await openReadOnly(path.join(codexHome, name));
      if (!idx) continue;
      try {
        for (const row of idx.prepare("SELECT rollout_path FROM threads WHERE rollout_path IS NOT NULL").all()) {
          indexRows += countTextOccurrences(String(row.rollout_path), rules);
        }
      } catch {
        /* older schema */
      } finally {
        try {
          idx.close();
        } catch {
          /* no-op */
        }
      }
    }
  } catch {
    /* no codex state */
  }
  if (indexRows) {
    codex += indexRows;
    codexDetail.push(`threads index rollout_path: ${indexRows}`);
  }
  add("Codex state", codex, { detail: codexDetail });

  // 7. Work folders (both roots — before the move they are under the old one).
  let work = 0;
  const workDetail = [];
  for (const wsRoot of [newWorkspace, legacyWorkspace]) {
    for (const name of ["MEMORY.md", "CLAUDE.md", "AGENTS.md"]) {
      const here = await countInTree(wsRoot, rules, (n) => n === name);
      if (here.count) {
        work += here.count;
        workDetail.push(`${name}: ${here.count} in ${here.files} file(s) under ${wsRoot}`);
      }
    }
    const mem = await countInTree(wsRoot, rules, (n) => n.endsWith(".md"));
    void mem; // counted per-name above; the sweep here is only to catch memory/<topic>.md
  }
  add("work folder text", work, { detail: workDetail });

  // 8. Service definitions.
  let service = 0;
  const serviceDetail = [];
  for (const file of serviceDefinitionPaths(home)) {
    const here = await countInFile(file, rules);
    if (here) {
      service += here;
      serviceDetail.push(`${file}: ${here}`);
    }
  }
  add("service definitions", service, { detail: serviceDetail });

  const total = groups.filter((g) => g.covered).reduce((n, g) => n + g.count, 0);
  const historical = groups.filter((g) => !g.covered).reduce((n, g) => n + g.count, 0);
  return { root, legacyRoot, legacyWorkspace, groups, total, historical };
}

export function formatAudit(audit, { title = "audit" } = {}) {
  const lines = [`[migrate] ${title}: scanning ${audit.root} for paths under ${audit.legacyRoot} or ${audit.legacyWorkspace}`];
  if (!audit.groups.length) lines.push("  ✓ nothing found — every store is on the new paths");
  for (const group of audit.groups) {
    lines.push(`  • ${group.store}: ${group.count}`);
    for (const detail of group.detail) lines.push(`      ${detail}`);
  }
  lines.push(`[migrate] ${title}: ${audit.total} occurrence(s) the migration is responsible for` + (audit.historical ? `, plus ${audit.historical} in the historical log (left by design)` : ""));
  return lines;
}

// ── The migration ────────────────────────────────────────────────────────────────────────────
export async function migrateChannelGate({
  dryRun = false,
  log = (line) => console.log(line),
  env = process.env,
  home = os.homedir(),
  rename = fsRename,
  ...rootOverrides
} = {}) {
  const roots = resolveRoots({ env, home, ...rootOverrides });
  const { legacyRoot, newRoot, legacyWorkspace, newWorkspace, rootPinned, workspacePinned } = roots;

  // What to do with the RUNTIME ROOT. Decided on STATE, not on existence — see hasRuntimeState().
  //   pinned  — the operator pointed CHANNELGATE_DIR/CLAUDE_GATEWAY_DIR somewhere explicit; the
  //             root is where they say it is and nothing is renamed. The folders below it still
  //             gain their platform component.
  //   none    — the pre-rename root holds no state (or is absent): nothing to move.
  //   blocked — the new root is already LIVE. Never merge into a live install; say so loudly and
  //             leave the old root alone for a human.
  //   merge   — the new root exists but holds no state: a leftover. Move the old contents in,
  //             never overwriting anything already there.
  //   move    — the ordinary case: rename the old root onto the new path.
  const legacyHasState = !rootPinned && (await hasRuntimeState(legacyRoot));
  const newHasState = await hasRuntimeState(newRoot);
  const rootMode = rootPinned
    ? "pinned"
    : !legacyHasState
      ? "none"
      : newHasState
        ? "blocked"
        : (await exists(newRoot))
          ? "merge"
          : "move";
  const movingRoot = rootMode === "merge" || rootMode === "move";

  // The workspace is judged the same way: an EMPTY ~/ChannelGate is a leftover, not an install, so
  // its mere existence never skips the per-channel moves. Each destination is still checked
  // individually below and never clobbered.
  const moveWorkspace = !workspacePinned && (await exists(legacyWorkspace)) && (await workspaceHasFolders(legacyWorkspace));

  // Where the live runtime root is once the root step is done.
  const rootForChannels = rootMode === "none" && !(await exists(newRoot)) ? legacyRoot : newRoot;
  if (!movingRoot && !moveWorkspace && !(await exists(path.join(rootForChannels, "channels")))) {
    return { ran: false, reason: "nothing to migrate", dryRun };
  }

  // Stop-the-world. A DRY RUN deliberately skips this gate: previewing the plan while the daemon
  // is up is exactly when an operator wants it, and a dry run writes nothing, creates nothing, and
  // opens the database read-only. The finding is still reported, as the first line of the plan, so
  // the preview says plainly that a real run would refuse right now.
  const busy = (await busyReason(movingRoot || rootMode === "blocked" ? legacyRoot : rootForChannels)) || (await busyReason(rootForChannels));
  if (busy && !dryRun) {
    log(`[migrate] REFUSED: ${busy}. Stop it and restart — nothing was moved.`);
    return { ran: false, refused: busy, dryRun };
  }

  let dryDb = null;
  const summary = {
    ran: true, dryRun, rootMode, busy, movedRoot: "",
    channels: 0, workspaces: 0, metaFolders: 0, cleanWorkspaces: 0,
    rewrittenRows: 0, rewrittenFiles: 0, typedColumns: [], purgedCaches: [], regenerated: 0,
    claude: { renamed: 0, files: 0, occurrences: 0, collisions: [], errors: [], unresolved: [] },
    codex: { indexRows: 0, files: 0, occurrences: 0, errors: [] },
    workFolders: { files: 0, occurrences: 0 },
    services: { files: [], occurrences: 0, reloads: [] },
    collisions: [], errors: [],
  };

  log(`[migrate] ChannelGate rename migration${dryRun ? " — DRY RUN, nothing will be written" : ""}`);
  log(`[migrate] plan:`);
  if (busy) log(`  • busy: ${busy} — a real run would refuse right now`);
  if (rootMode === "move") log(`  • runtime root   ${legacyRoot} → ${newRoot}`);
  else if (rootMode === "merge") log(`  • runtime root   ${legacyRoot} → ${newRoot} (destination exists but holds no state — merging into it)`);
  else if (rootMode === "blocked") log(`  • runtime root   ${newRoot} already holds gateway state — NOT touching it; ${legacyRoot} is left for you to reconcile by hand`);
  else log(`  • runtime root   ${rootForChannels} (unchanged)`);
  if (moveWorkspace) log(`  • workspace root ${legacyWorkspace} → ${newWorkspace} (per channel, namespaced by platform)`);
  else log(`  • workspace root ${newWorkspace} (unchanged)`);

  try {
    if (rootMode === "move") {
      if (!dryRun) summary.movedRoot = await moveTree(legacyRoot, newRoot, { rename, log });
      else summary.movedRoot = "planned";
      log(`  • moved the runtime root (${summary.movedRoot})`);
    } else if (rootMode === "merge") {
      if (dryRun) {
        summary.movedRoot = "planned-merge";
        for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
          if (entry.name === BREADCRUMB) continue;
          if (await exists(path.join(newRoot, entry.name))) {
            summary.collisions.push(entry.name);
            log(`    COLLISION: ${path.join(newRoot, entry.name)} already exists — ${entry.name} would be left in place`);
          }
        }
      } else {
        const merged = await mergeTree(legacyRoot, newRoot, { rename, log });
        summary.collisions = merged.collisions;
        summary.movedRoot = "merge";
      }
      log(`  • merged the runtime root into the existing (stateless) ${newRoot}${summary.collisions.length ? ` — ${summary.collisions.length} collision(s) left behind` : ""}`);
    }

    // Where the per-channel folders are RIGHT NOW. After a real root move they are already under
    // the new root; on a dry run the root was not moved, so the plan has to inspect (and print)
    // the old one — otherwise a dry run reports zero metadata folders on a machine that has them.
    const channelsFrom = dryRun && movingRoot ? legacyRoot : rootForChannels;

    // Channel records come from the STORE, never from a directory listing: the folder names alone
    // cannot tell us a channel's platform, and a folder without a record is not a channel. On a
    // dry run that store is opened read-only at its current location (see openReadOnly).
    let records;
    if (dryRun) {
      dryDb = await openReadOnly(dryRunDbFile(channelsFrom, env));
      records = readChannelRecords(dryDb);
    } else {
      const { listChannels } = await import("../src/config/store.js");
      records = (await listChannels()).map((c) => ({
        slug: c.slug,
        platform: c.meta?.platform,
        customWorkDir: Boolean((c.meta?.workDir || "").trim()),
      }));
    }
    summary.channels = records.length;

    for (const rec of records) {
      const pf = platformFolderName(rec.platform);
      // Per-channel metadata: <root>/channels/<slug> → <root>/channels/<platform>/<slug>
      const metaFrom = path.join(channelsFrom, "channels", rec.slug);
      const metaTo = path.join(rootForChannels, "channels", pf, rec.slug);
      if (path.resolve(metaFrom) !== path.resolve(metaTo) && (await exists(metaFrom)) && !(await exists(metaTo))) {
        log(`  • ${rec.slug}: channels/${rec.slug} → channels/${pf}/${rec.slug}`);
        if (!dryRun) await moveTree(metaFrom, metaTo, { rename, log });
        summary.metaFolders++;
      }
      // Clean-mode workspace, same rule.
      const cleanFrom = path.join(channelsFrom, "clean-workspaces", rec.slug);
      const cleanTo = path.join(rootForChannels, "clean-workspaces", pf, rec.slug);
      if (path.resolve(cleanFrom) !== path.resolve(cleanTo) && (await exists(cleanFrom)) && !(await exists(cleanTo))) {
        log(`  • ${rec.slug}: clean-workspaces/${rec.slug} → clean-workspaces/${pf}/${rec.slug}`);
        if (!dryRun) await moveTree(cleanFrom, cleanTo, { rename, log });
        summary.cleanWorkspaces++;
      }
      // Visible work folder. A channel with a CUSTOM workDir never used the default folder, so it
      // is skipped entirely — the operator's project directory is not ours to move.
      if (rec.customWorkDir) {
        log(`  • ${rec.slug}: custom workDir — left untouched`);
        continue;
      }
      const wsFrom = path.join(legacyWorkspace, rec.slug);
      const wsTo = path.join(newWorkspace, pf, rec.slug);
      if (wsFrom === wsTo || !(await exists(wsFrom))) continue;
      if (await exists(wsTo)) {
        log(`  • ${rec.slug}: SKIPPED — ${wsTo} already exists (never clobbered)`);
        continue;
      }
      log(`  • ${rec.slug}: ${wsFrom} → ${wsTo}`);
      if (!dryRun) await moveTree(wsFrom, wsTo, { rename, log });
      summary.workspaces++;
    }

    // Stored absolute paths. The rules describe every move; from here on each STORE that can hold
    // one of those paths gets the same rules applied in whatever form that store keeps them.
    const rules = buildPathRewrites({ legacyRoot, newRoot: rootForChannels, legacyWorkspace, newWorkspace, channels: records });
    // The engine home moves with the runtime root, and Claude Code's project directory is keyed on
    // it, so it needs a rule of its own even though it is covered by the bare-root catch-all.
    const db = dryRun ? dryDb : (await import("../src/db/index.js")).getDb();
    summary.rewrittenRows = db ? rewriteDatabasePaths(db, rules, { dryRun }) : 0;
    log(`  • ${summary.rewrittenRows} stored record(s) with an absolute path under the old roots`);
    summary.typedColumns = db ? rewriteTypedColumns(db, rules, { dryRun }) : [];
    if (summary.typedColumns.length) log(`  • ${summary.typedColumns.length} typed database column value(s): ${[...new Set(summary.typedColumns)].join(", ")}`);
    summary.rewrittenFiles = await rewriteJsonFiles(rootForChannels, rules, { dryRun, log });
    summary.rewrittenFiles += await rewriteConfigJson(rootForChannels, rules, { dryRun, log });
    summary.purgedCaches = await purgeRegenerableCaches(path.join(rootForChannels, "channels"), { dryRun, log });
    summary.rewrittenFiles += await rewriteChannelLegacyJson(path.join(rootForChannels, "channels"), rules, { dryRun, log });

    // Claude Code sessions. `projects` is normally a symlink into the operator's real ~/.claude,
    // so it is resolved before anything under it is touched. Without this every thread's `-r`
    // resume breaks: Claude Code looks the project up by the cwd it is launched in.
    const claudeHome = path.join(rootForChannels, "engine-state", "claude", "home");
    let projectsDir = path.join(claudeHome, ".claude", "projects");
    try {
      projectsDir = await realpath(projectsDir);
    } catch {
      /* no Claude state yet */
    }
    // Directories with no readable transcript still get renamed when their NAME is exactly the
    // encoding of a cwd we know moved.
    const knownCwds = new Map();
    for (const [from] of rules) knownCwds.set(claudeProjectDirName(from), from);
    log(`  • Claude sessions: ${projectsDir}`);
    summary.claude = await rewriteClaudeProjects(projectsDir, rules, { dryRun, log, knownCwds });
    summary.rewrittenFiles += await rewriteClaudeEngineHome(claudeHome, rules, { dryRun, log });
    log(`    ${summary.claude.renamed} project dir(s) renamed, ${summary.claude.occurrences} cwd field(s) in ${summary.claude.files} transcript(s)` +
      (summary.claude.collisions.length ? `, ${summary.claude.collisions.length} collision(s)` : "") +
      (summary.claude.unresolved.length ? `, ${summary.claude.unresolved.length} unresolved` : ""));
    summary.errors.push(...summary.claude.errors);

    // Codex: the thread index's rollout_path column, the rollout transcripts' cwd, config.toml.
    summary.codex = await rewriteCodexState(path.join(rootForChannels, "engine-state", "codex", "home", ".codex"), rules, { dryRun, log });
    log(`  • Codex state: ${summary.codex.indexRows} index row(s), ${summary.codex.occurrences} path(s) in ${summary.codex.files} file(s)`);

    // The agent's own prose inside each default work folder.
    const workFolders = records
      .filter((rec) => !rec.customWorkDir)
      .map((rec) => path.join(newWorkspace, platformFolderName(rec.platform), rec.slug));
    if (dryRun) workFolders.push(...records.filter((rec) => !rec.customWorkDir).map((rec) => path.join(legacyWorkspace, rec.slug)));
    summary.workFolders = await rewriteWorkFolderText(workFolders, rules, { dryRun, log });
    log(`  • work folder text: ${summary.workFolders.occurrences} path(s) in ${summary.workFolders.files} file(s)`);

    // The installed service definition names the runtime root in its log paths.
    summary.services = await rewriteServiceDefinitions(home, rules, { dryRun, log });
    if (summary.services.files.length) {
      log(`  • service definition(s) updated: ${summary.services.files.join(", ")}`);
      for (const reload of summary.services.reloads) log(`    RELOAD REQUIRED before the next restart: ${reload}`);
      if (!dryRun) {
        await mkdir(rootForChannels, { recursive: true });
        await writeFile(
          serviceReloadMarkerFile(rootForChannels),
          `${JSON.stringify({ at: new Date().toISOString(), files: summary.services.files, reloads: summary.services.reloads }, null, 2)}\n`,
          "utf8",
        );
      }
    }

    // Regenerate every channel's lockdown: the sandbox allow/deny lists embed absolute paths, so a
    // settings file written before the move points the sandbox at folders that no longer exist.
    if (!dryRun) {
      const { ensureChannelFolder } = await import("../src/gateway/folders.js");
      const { getChannelMeta } = await import("../src/config/store.js");
      for (const rec of records) {
        try {
          await ensureChannelFolder(rec.slug, (await getChannelMeta(rec.slug)) || {});
          summary.regenerated++;
        } catch (error) {
          summary.errors.push(`${rec.slug}: ${error.message}`);
        }
      }
    }
    log(`  • regenerated ${summary.regenerated} channel sandbox settings file(s)`);

    // Warm sessions hold the OLD cwd. They live only in this process's session pool, and this
    // migration runs before the daemon boots one — so "dropping" them is exactly the restart that
    // is part of the migration. Said out loud so nobody adds a persistent warm pool without
    // revisiting this.
    log("  • warm engine sessions: none to drop (the migration runs before the pool starts)");

    if (!dryRun) {
      const when = new Date().toISOString();
      if (movingRoot) {
        await breadcrumb(
          legacyRoot,
          `# Moved\n\nClaude Gateway is now **ChannelGate**. This runtime root moved to:\n\n    ${newRoot}\n\nMigrated ${when} by \`scripts/migrate-channelgate.mjs\`. This directory is now empty and can be deleted.\n`,
          { dryRun },
        );
      }
      if (moveWorkspace && summary.workspaces) {
        await breadcrumb(
          legacyWorkspace,
          `# Moved\n\nClaude Gateway is now **ChannelGate**. Channel working folders moved to:\n\n    ${newWorkspace}/<platform>/<channel>\n\nwhere \`<platform>\` is \`slack\`, \`teams\`, or \`google-chat\`. ${summary.workspaces} folder(s) were moved on ${when} by \`scripts/migrate-channelgate.mjs\`. Channels with a custom working folder were left exactly where they were.\n`,
          { dryRun },
        );
      }
    }

    log(
      `[migrate] done: ${summary.channels} channel(s) · ${summary.metaFolders} metadata folder(s) · ` +
        `${summary.workspaces} work folder(s) · ${summary.cleanWorkspaces} clean workspace(s) · ` +
        `${summary.rewrittenRows} record(s) + ${summary.rewrittenFiles} file(s) repathed · ` +
        `${summary.claude.renamed} Claude project dir(s) · ${summary.claude.occurrences + summary.codex.occurrences} engine transcript path(s)` +
        (summary.errors.length ? ` · ${summary.errors.length} error(s): ${summary.errors.join("; ")}` : ""),
    );

    // A dry run ends with the same audit `--verify` prints, so completeness can be judged BEFORE
    // anything moves: everything listed as "the migration is responsible for" is what the plan
    // above would rewrite, and the residue is what it would leave.
    if (dryRun) {
      summary.audit = await auditLegacyPaths({ env, home, ...rootOverrides });
      for (const line of formatAudit(summary.audit, { title: "audit (pre-migration)" })) log(line);
      log(`[migrate] dry run would leave ${summary.audit.historical} occurrence(s) behind (the historical events log, by design).`);
    }
    return summary;
  } catch (error) {
    summary.failed = error.message;
    log(`[migrate] FAILED: ${error.message}`);
    return summary;
  } finally {
    try {
      dryDb?.close();
    } catch {
      /* already closed */
    }
  }
}

// The fallback when the migration refused or failed: pin the environment back to whichever roots
// actually hold the data, so the daemon boots on the OLD paths instead of creating a brand-new
// empty install next to them. Env override (not a symlink) — it is reversible, leaves no artifact
// on disk, and a symlinked runtime root would defeat the channel sandbox's read-deny on that root.
export async function applyFallback({ env = process.env, home = os.homedir(), log = (l) => console.warn(l), ...rootOverrides } = {}) {
  const { legacyRoot, newRoot, legacyWorkspace, newWorkspace, rootPinned, workspacePinned } = resolveRoots({ env, home, ...rootOverrides });
  let pinned = false;
  // Judged on STATE, exactly as the migration itself is: an empty leftover `~/.channelgate/` must
  // not stop the daemon from falling back onto the root that actually holds the data.
  if (!rootPinned && (await hasRuntimeState(legacyRoot)) && !(await hasRuntimeState(newRoot))) {
    env.CHANNELGATE_DIR = legacyRoot;
    pinned = true;
    log(`[migrate] continuing on the PRE-RENAME runtime root ${legacyRoot} (CHANNELGATE_DIR pinned for this process).`);
  }
  if (!workspacePinned && (await workspaceHasFolders(legacyWorkspace)) && !(await workspaceHasFolders(newWorkspace))) {
    env.CG_WORKSPACE_DIR = legacyWorkspace;
    pinned = true;
    log(`[migrate] continuing on the PRE-RENAME workspace root ${legacyWorkspace} (CG_WORKSPACE_DIR pinned for this process).`);
  }
  if (pinned) log("[migrate] re-run `node scripts/migrate-channelgate.mjs` once the blocker is cleared.");
  return pinned;
}

// Boot entry point: never throws, never exits. src/server.js awaits this before opening the DB.
export async function migrateChannelGateAtBoot(options = {}) {
  try {
    const result = await migrateChannelGate(options);
    if (result.refused || result.failed) await applyFallback(options);
    return result;
  } catch (error) {
    console.warn(`[migrate] skipped (${error.message}) — the daemon continues on the existing paths.`);
    await applyFallback(options).catch(() => {});
    return { ran: false, failed: error.message };
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  if (process.argv.includes("--verify")) {
    // Read-only. Safe to run against a live install, and the acceptance check after a real run.
    const audit = await auditLegacyPaths();
    for (const line of formatAudit(audit, { title: "verify" })) console.log(line);
    process.exit(audit.total > 0 ? 1 : 0);
  }
  await migrateChannelGateAtBoot({ dryRun: process.argv.includes("--dry-run") });
}
