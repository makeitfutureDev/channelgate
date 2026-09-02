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
//   node scripts/migrate-channelgate.mjs --verify   # read-only audit; exit 1 if STATE still points
//                                                   # at a pre-rename root
//   node scripts/migrate-channelgate.mjs --repath   # re-run every repath pass against the CURRENT
//                                                   # roots; moves nothing. Idempotent.
//
// `--verify` counts STATE only — the fields the daemon and the engines READ BACK (a transcript's
// `cwd`, a rollout's `cwd`/`workspace_roots`, the Codex thread index's `rollout_path`, config and
// database fields, service-file paths). A pre-rename path quoted inside a message, a tool result or
// a shell transcript is HISTORY: rewriting it would edit what was said, so it is reported in a
// separate bucket that never counts toward the exit code. And once the move has happened, a state
// path that STILL EXISTS on disk is correct wherever it points — a channel with a custom `workDir`
// under `~/Slack Agent/` was deliberately not moved, so its recorded cwd is accurate, not stale.
import { access, cp, mkdir, readdir, readFile, realpath, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
    const workDir = (meta.workDir || "").trim();
    out.push({ slug: row.slug, platform: meta.platform, workDir, customWorkDir: Boolean(workDir) });
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

// ── Operator-supplied path rules ─────────────────────────────────────────────────────────────
// `--repath --from <old> --to <new>` (repeatable): a folder the operator moved BY HAND, which the
// rename rules above cannot know about — the daemon's own checkout, a channel's custom `workDir`,
// a project directory. Each pair is one more rewrite rule: every pass a repath runs applies it,
// and `--verify` handed the same pairs counts what still names the old side. Validated up front,
// because a bad rule is applied to every store: both sides absolute, distinct, and the new path
// never under the old one (that rule would rewrite its own output on the next run and never
// settle).
export function parsePathPairs(argv) {
  const pairs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--to") throw new Error(`--to${argv[i + 1] ? ` ${argv[i + 1]}` : ""} has no preceding --from`);
    if (argv[i] !== "--from") continue;
    const from = argv[i + 1];
    if (!from || from.startsWith("--")) throw new Error("--from needs a path");
    if (argv[i + 2] !== "--to") throw new Error(`--from ${from} needs a matching --to <new path>`);
    const to = argv[i + 3];
    if (!to || to.startsWith("--")) throw new Error(`--to after --from ${from} needs a path`);
    pairs.push([from, to]);
    i += 3;
  }
  return normalizePathPairs(pairs);
}

export function normalizePathPairs(pairs = []) {
  const out = [];
  for (const pair of pairs) {
    const [from, to] = Array.isArray(pair) ? pair : [pair?.from, pair?.to];
    if (typeof from !== "string" || typeof to !== "string" || !path.isAbsolute(from) || !path.isAbsolute(to)) {
      throw new Error(`path rule ${JSON.stringify(pair)}: both sides must be absolute paths`);
    }
    const a = path.resolve(from);
    const b = path.resolve(to);
    if (a === b) throw new Error(`path rule ${a} → ${b}: both sides are the same path`);
    if (a === path.parse(a).root) throw new Error(`path rule ${a} → ${b}: the old side cannot be the filesystem root`);
    if (b.startsWith(a + path.sep)) throw new Error(`path rule ${a} → ${b}: the new path lies under the old one, so the rule would never settle`);
    out.push([a, b]);
  }
  return out;
}

// Longest source first, whatever a rule's origin, so the most specific rule wins.
export function mergeRules(base, extra = []) {
  return [...base, ...extra].sort((a, b) => b[0].length - a[0].length);
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

// Where the path token that starts at `at` ENDS. The audit has to answer "does this path still
// exist on disk?", which needs the whole path, not just the root prefix that matched. Everything
// that cannot appear inside a pathname we write — a quote, a bracket, whitespace, a shell or XML
// delimiter — terminates it, and ordinary sentence punctuation is trimmed off the tail.
const PATH_STOP = /["'`\s<>|(){}\[\],;=\\*?]/;

function pathTokenAt(text, at, from) {
  let end = at + from.length;
  while (end < text.length && !PATH_STOP.test(text[end])) end++;
  let token = text.slice(at, end);
  while (token.length > from.length && /[.,:;]/.test(token[token.length - 1])) token = token.slice(0, -1);
  return token;
}

// Replace every boundary-safe, non-URL occurrence of a moved path. Returns the new text, how many
// occurrences were rewritten, and the full path token behind each one (what the audit classifies).
export function rewriteTextOccurrences(text, rules) {
  let out = text;
  let count = 0;
  const matches = [];
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
      matches.push(pathTokenAt(out, at, from));
      next += out.slice(cursor, at) + to;
      cursor = at + from.length;
      count++;
    }
    out = next + out.slice(cursor);
  }
  return { text: out, count, matches };
}

// Count occurrences without changing anything — the shared primitive behind `--verify`.
export function countTextOccurrences(text, rules) {
  return rewriteTextOccurrences(text, rules).count;
}

// The same sweep, but returning the PATHS it found rather than a number. `--verify` needs them:
// after the move, a pre-rename path that still resolves on disk is a directory that deliberately
// did not move, not a stale pointer.
export function findTextOccurrences(text, rules) {
  return rewriteTextOccurrences(text, rules).matches;
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

// ── State vs. content inside an engine transcript ────────────────────────────────────────────
// An engine transcript is two things in one file: a few fields the engine READS BACK to restore a
// session, and the conversation itself. Only the first kind may be repathed. The second is a record
// of what was said and done — a message that quoted `~/Slack Agent/ops`, a `cat` whose stdout
// printed it, a shell command that ran there — and rewriting it would edit history to say something
// that never happened. So both the rewrite and the audit decide per JSON KEY PATH, never by
// substring. The lists are deliberately tiny and explicit: a key that is not on one is content.
//
// Claude Code (`<projects>/**/*.jsonl`, plus the per-session `subagents/*.json`): every transcript
// line carries the session's working directory as a top-level `cwd`, and that is the field
// `claude -r` and our own claudeProjectCwd() read back. Nothing else in a line is resume state —
// `toolUseResult.*`, `message.content[].*`, `snapshot.trackedFileBackups` (whose object KEYS are
// paths, and object keys are never rewritten anyway) are all records of a past turn.
export const CLAUDE_STATE_KEYPATHS = Object.freeze(["cwd"]);

// Codex rollouts (`~/.codex/sessions/**/*.jsonl`, format v0.143): the resume state is the
// `session_meta` header's `cwd` and the last `turn_context`'s `cwd` + `workspace_roots` — both live
// at `payload.*`, and no other line type carries those keys.
//
// `world_state.payload.state.environments.filesystem` is the DECISION worth writing down. It is a
// rendered XML blob (`<filesystem><workspace_roots><root>…</root></workspace_roots>…`) that Codex
// emits once per turn, next to the `turn_context` it was derived from, as the environment context
// shown to the model. It is NOT read back to locate anything: on resume Codex re-derives the world
// state from the restored `turn_context`/`session_meta` cwd, so a repath of those two fields is
// what actually moves the session. Treated as CONTENT — as are its neighbours
// `state.agents_md.directory` (the label on an inlined copy of an AGENTS.md) and
// `state.environments.environments.local.cwd` (the same cwd, already covered authoritatively above).
export const CODEX_STATE_KEYPATHS = Object.freeze(["payload.cwd", "payload.workspace_roots[]"]);

// Split every legacy-path occurrence in a parsed JSON value into the two buckets, by key path.
// Array elements inherit their parent's key path with a `[]` suffix.
export function classifyJsonPaths(value, rules, stateKeyPaths = []) {
  const allow = new Set(stateKeyPaths);
  const state = [];
  const content = [];
  const walk = (node, keyPath) => {
    if (typeof node === "string") {
      const found = findTextOccurrences(node, rules);
      if (found.length) (allow.has(keyPath) ? state : content).push(...found);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, `${keyPath}[]`);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        // An object KEY that is itself a path (Claude's `snapshot.trackedFileBackups`) is content
        // by construction: rewriteDeep walks values only, so nothing ever rewrites a key.
        content.push(...findTextOccurrences(key, rules));
        walk(child, keyPath ? `${keyPath}.${key}` : key);
      }
    }
  };
  walk(value, "");
  return { state, content };
}

// Rewrite only the values sitting at an allowed key path. Same shape as rewriteDeep, which stays
// the whole-document rule used by the stores that hold nothing but state (the database, config).
function rewriteDeepAt(node, rules, allow, keyPath = "") {
  if (typeof node === "string") return allow.has(keyPath) ? rewritePath(node, rules) : node;
  if (Array.isArray(node)) return node.map((v) => rewriteDeepAt(v, rules, allow, `${keyPath}[]`));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteDeepAt(v, rules, allow, keyPath ? `${keyPath}.${k}` : k);
    return out;
  }
  return node;
}

// A JSONL store (Claude Code transcripts, Codex rollouts). Only lines that actually mention a
// moved path are re-serialised; every other line is kept byte for byte, so a one-time migration
// cannot silently reformat a 2 MB transcript. A line that mentions one and does NOT parse aborts
// the whole file — a half-rewritten transcript is worse than an un-migrated one.
//
// `stateKeyPaths` names the fields that may be touched; without it the whole document is rewritten
// (rewritePath only ever replaces a string that IS a moved path, so prose was never in scope —
// the allowlist is what keeps a past tool call's `file_path` out of it too).
export async function rewriteJsonlFile(file, rules, { dryRun = false, stateKeyPaths = null } = {}) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { count: 0 };
  }
  const allow = stateKeyPaths ? new Set(stateKeyPaths) : null;
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
    const next = JSON.stringify(allow ? rewriteDeepAt(parsed, rules, allow) : rewriteDeep(parsed, rules));
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
      const { count, error } = await rewriteJsonlFile(file, rules, { dryRun, stateKeyPaths: CLAUDE_STATE_KEYPATHS });
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
    const { count, error } = await rewriteJsonlFile(file, rules, { dryRun, stateKeyPaths: CODEX_STATE_KEYPATHS });
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

// Does anything under this tree still mention a moved path? Only `--repath` asks: during the
// one-time migration every cache holds the old paths by definition, but a repath that dropped every
// warm cache on every run would churn a healthy install for nothing.
async function treeMentions(dir, rules) {
  for await (const file of walkFiles(dir, () => true)) {
    if (await countInFile(file, rules)) return true;
  }
  return false;
}

async function countInFile(file, rules) {
  try {
    return countTextOccurrences(await readFile(file, "utf8"), rules);
  } catch {
    return 0;
  }
}

export async function purgeRegenerableCaches(channelsRoot, { dryRun = false, log = () => {}, staleRules = null } = {}) {
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
        if (staleRules && !(await treeMentions(target, staleRules))) continue;
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
// It counts STATE, and only state. Three rules decide what that means:
//
//   1. PER KEY, NOT PER SUBSTRING. Inside an engine transcript, only the fields the engine reads
//      back count (CLAUDE_STATE_KEYPATHS / CODEX_STATE_KEYPATHS above). A pre-rename path quoted
//      in a message, a tool result, a stdout capture or a rendered environment snapshot is a
//      record of what happened; the migration must never rewrite it, so the audit must never bill
//      it. Those go to the "historical content" bucket, next to the `events` audit log.
//   2. A NAME IS NOT STATE, A CWD IS. A Claude project directory is stale when its name is no
//      longer the encoding of its own cwd, or when that cwd no longer exists — not because the
//      name still spells a pre-rename path. A channel whose custom `workDir` really is
//      `~/Slack Agent/<slug>` was deliberately left in place, and the directory encoding that cwd
//      is exactly right.
//   3. AFTER THE MOVE, A PATH THAT STILL RESOLVES IS CORRECT. Once the migration has run, a state
//      field naming a pre-rename path that STILL EXISTS on disk points at a real directory that
//      did not move. It is reported, separately, and does not count. Before the move nothing has
//      moved yet, so this exoneration is switched off and every occurrence is billed — which is
//      what makes `--verify` useful as a pre-flight as well as an acceptance check.
//
// Everything the migration rewrites is scanned, plus the stores it deliberately does not, so a
// non-zero total always means "something the migration should have covered is still wrong" — and
// `--repath` is the command that fixes exactly what this counts.
function legacyRulesFor({ legacyRoot, legacyWorkspace }) {
  // `to` is irrelevant when counting; the boundary and URL rules are what matter.
  return [
    [legacyRoot, legacyRoot],
    [legacyWorkspace, legacyWorkspace],
  ].sort((a, b) => b[0].length - a[0].length);
}

async function findInFile(file, rules) {
  try {
    return findTextOccurrences(await readFile(file, "utf8"), rules);
  } catch {
    return [];
  }
}

async function findInTree(dir, rules, match = () => true) {
  const paths = [];
  let files = 0;
  for await (const file of walkFiles(dir, match)) {
    const here = await findInFile(file, rules);
    if (here.length) {
      paths.push(...here);
      files++;
    }
  }
  return { paths, files };
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// Classify one JSON or JSONL file. A single-line JSONL file and a whole-document `.json` are the
// same thing to `JSON.parse`, so the whole file is tried first and the per-line walk is the
// fallback. A line that mentions a moved path and does not parse is reported on its own: the
// migration refuses to touch that file, so nobody should be told it was handled.
async function classifyJsonFile(file, rules, stateKeyPaths) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { state: [], content: [], unparsed: 0 };
  }
  if (!countTextOccurrences(raw, rules)) return { state: [], content: [], unparsed: 0 };
  const whole = tryParse(raw);
  if (whole.ok) {
    const { state, content } = classifyJsonPaths(whole.value, rules, stateKeyPaths);
    return { state, content, unparsed: 0 };
  }
  const state = [];
  const content = [];
  let unparsed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const here = countTextOccurrences(line, rules);
    if (!here) continue;
    const parsed = tryParse(line);
    if (!parsed.ok) {
      unparsed += here;
      continue;
    }
    const split = classifyJsonPaths(parsed.value, rules, stateKeyPaths);
    state.push(...split.state);
    content.push(...split.content);
  }
  return { state, content, unparsed };
}

export async function auditLegacyPaths({ env = process.env, home = os.homedir(), extraRules = [], ...rootOverrides } = {}) {
  const { legacyRoot, newRoot, legacyWorkspace, newWorkspace } = resolveRoots({ env, home, ...rootOverrides });
  // An operator-supplied `--from` path counts exactly like a pre-rename root: a store that still
  // names it is stale for the same reason, and `--repath` with the same pair is the repair.
  const extra = normalizePathPairs(extraRules);
  const rules = mergeRules(legacyRulesFor({ legacyRoot, legacyWorkspace }), extra.map(([from]) => [from, from]));
  // Audit whichever runtime root is live: the new one once the move has happened, the old one
  // before it. That is what makes `--verify` useful both as a pre-flight and as the acceptance
  // check afterwards.
  const root = (await hasRuntimeState(newRoot)) ? newRoot : legacyRoot;
  // Has the move already happened? Only afterwards does "this path still exists" mean "it was
  // deliberately left where it is" — before it, everything still exists because nothing moved yet.
  const migrated = root === newRoot && !(await hasRuntimeState(legacyRoot));

  const groups = [];
  const resolved = new Map(); // path → { count, stores:Set } — legacy paths that still exist
  const add = (store, count, { kind = "state", detail = [] } = {}) => {
    if (count) groups.push({ store, count, kind, covered: kind === "state", detail });
  };
  // How many of these occurrences are actually stale? After the move, one that still resolves on
  // disk names a directory that did not move — recorded, not billed.
  const stale = (store, paths) => {
    if (!migrated) return paths.length;
    let gone = 0;
    for (const p of paths) {
      if (!existsSync(p)) {
        gone++;
        continue;
      }
      const entry = resolved.get(p) || { count: 0, stores: new Set() };
      entry.count++;
      entry.stores.add(store);
      resolved.set(p, entry);
    }
    return gone;
  };

  // 1 + 2 + 3. The database. Every row of every table is the daemon's own state, so all of it is
  // billable — except the historical audit log, which is a record of what happened.
  const db = (await openReadOnly(path.join(root, "gateway.db"))) || (await openReadOnly(dryRunDbFile(root, env)));
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
          const found = [];
          for (const row of rows) found.push(...findTextOccurrences(String(row.v), rules));
          const here = stale(`${table}.${column.name}`, found);
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
      add("database historical log (events) — NOT rewritten by design", countHistoricalPaths(db, rules), { kind: "content" });
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
    const here = stale(rel, await findInFile(path.join(root, rel), rules));
    if (here) {
      config += here;
      configDetail.push(`${rel}: ${here}`);
    }
  }
  const backups = await findInTree(path.join(root, "update-backups"), rules, (n) => n.endsWith(".json"));
  const backupCount = stale("update-backups", backups.paths);
  if (backupCount) {
    config += backupCount;
    configDetail.push(`update-backups/*/manifest.json: ${backupCount}`);
  }
  // `channels/**` splits three ways: the regenerated lockdown files, the content-addressed run
  // caches the migration DELETES, and the legacy JSON backups it rewrites. Counted separately so
  // the acceptance number is not dominated by caches that are about to be dropped.
  let caches = 0;
  let cacheFiles = 0;
  let lockdown = 0;
  const channelsRoot = path.join(root, "channels");
  for await (const file of walkFiles(channelsRoot, (n) => n.endsWith(".json"))) {
    const rel = path.relative(root, file);
    const here = stale(rel, await findInFile(file, rules));
    if (!here) continue;
    if (file.includes(`${path.sep}runtime${path.sep}`)) {
      caches += here;
      cacheFiles++;
    } else if (file.includes(`${path.sep}.claude${path.sep}`)) {
      lockdown += here;
    } else {
      config += here;
      configDetail.push(`${rel}: ${here}`);
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
  const transcriptFiles = new Set();
  let history = 0;
  let historyFiles = 0;
  let unparsed = 0;
  try {
    for (const entry of await readdir(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(projectsDir, entry.name);
      const cwd = await claudeProjectCwd(dir);
      const nameLegacy = rules.some(([from]) => entry.name === claudeProjectDirName(from) || entry.name.startsWith(`${claudeProjectDirName(from)}-`));
      const cwdLegacy = cwd ? findTextOccurrences(cwd, rules).length > 0 : false;
      if (!cwd) {
        // No readable transcript: the NAME is all there is to go on, and a name that spells a root
        // we moved is worth a human's attention.
        if (nameLegacy) staleDirs.push(`${entry.name} (no readable transcript — cwd unknown)`);
      } else if (nameLegacy || cwdLegacy) {
        const expected = claudeProjectDirName(cwd);
        if (expected !== entry.name) {
          // `claude -r` resolves the directory from the cwd it is launched in, so a name that is
          // not the encoding of its own cwd is a session nobody can reach.
          staleDirs.push(`${entry.name} → should be ${expected} (cwd ${cwd})`);
        } else if (cwdLegacy && stale("Claude project directories", [cwd])) {
          staleDirs.push(`${entry.name} (cwd ${cwd} no longer exists)`);
        }
      }
      for await (const file of walkFiles(dir, (n) => n.endsWith(".jsonl") || n.endsWith(".json"))) {
        const split = await classifyJsonFile(file, rules, CLAUDE_STATE_KEYPATHS);
        const here = stale("Claude transcripts", split.state);
        if (here) {
          transcripts += here;
          transcriptFiles.add(file);
        }
        if (split.content.length) {
          history += split.content.length;
          historyFiles++;
        }
        unparsed += split.unparsed;
      }
    }
  } catch {
    /* no Claude state on this host */
  }
  add("Claude project directories (stale names)", staleDirs.length, { detail: staleDirs });
  add("Claude transcripts (cwd fields)", transcripts, { detail: [`${transcriptFiles.size} file(s)`] });
  add(`Claude transcripts (message + tool content, ${CLAUDE_STATE_KEYPATHS.join("/")} excluded) — NOT rewritten by design`, history, {
    kind: "content",
    detail: [`${historyFiles} file(s)`],
  });
  let claudeFiles = 0;
  for (const rel of [".claude.json", ".claude/.claude.json", ".claude/settings.json"]) {
    claudeFiles += stale(`Claude ${rel}`, await findInFile(path.join(claudeHome, rel), rules));
  }
  add("Claude engine-home config", claudeFiles);

  // 6. Codex state.
  const codexHome = path.join(root, "engine-state", "codex", "home", ".codex");
  let codex = 0;
  const codexDetail = [];
  let codexHistory = 0;
  let codexHistoryFiles = 0;
  const codexConfig = stale("Codex config.toml", await findInFile(path.join(codexHome, "config.toml"), rules));
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
  let rollouts = 0;
  const rolloutFiles = new Set();
  for await (const file of walkFiles(sessionsDir, (n) => n.endsWith(".jsonl"))) {
    const split = await classifyJsonFile(file, rules, CODEX_STATE_KEYPATHS);
    const here = stale("Codex rollouts", split.state);
    if (here) {
      rollouts += here;
      rolloutFiles.add(file);
    }
    if (split.content.length) {
      codexHistory += split.content.length;
      codexHistoryFiles++;
    }
    unparsed += split.unparsed;
  }
  if (rollouts) {
    codex += rollouts;
    codexDetail.push(`sessions/**/*.jsonl ${CODEX_STATE_KEYPATHS.join(" + ")}: ${rollouts} in ${rolloutFiles.size} file(s)`);
  }
  const snapshots = await findInTree(path.join(codexHome, "shell_snapshots"), rules);
  const snapshotCount = stale("Codex shell_snapshots", snapshots.paths);
  if (snapshotCount) {
    codex += snapshotCount;
    codexDetail.push(`shell_snapshots: ${snapshotCount} in ${snapshots.files} file(s)`);
  }
  let indexRows = 0;
  try {
    for (const name of (await readdir(codexHome)).filter((n) => /^state.*\.sqlite$/.test(n))) {
      const idx = await openReadOnly(path.join(codexHome, name));
      if (!idx) continue;
      try {
        const found = [];
        for (const row of idx.prepare("SELECT rollout_path FROM threads WHERE rollout_path IS NOT NULL").all()) {
          found.push(...findTextOccurrences(String(row.rollout_path), rules));
        }
        indexRows += stale("Codex threads index", found);
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
  add("Codex rollouts (message + tool content, world_state snapshots) — NOT rewritten by design", codexHistory, {
    kind: "content",
    detail: [`${codexHistoryFiles} file(s)`],
  });
  add("engine transcript lines that do not parse (the migration leaves that file untouched)", unparsed, { kind: "content" });

  // 7. Work folders (both roots — before the move they are under the old one).
  let work = 0;
  const workDetail = [];
  for (const wsRoot of [newWorkspace, legacyWorkspace]) {
    for (const name of ["MEMORY.md", "CLAUDE.md", "AGENTS.md"]) {
      const found = await findInTree(wsRoot, rules, (n) => n === name);
      const here = stale(`work folder ${name}`, found.paths);
      if (here) {
        work += here;
        workDetail.push(`${name}: ${here} in ${found.files} file(s) under ${wsRoot}`);
      }
    }
    const mem = await findInTree(wsRoot, rules, (n) => n.endsWith(".md"));
    void mem; // counted per-name above; the sweep here is only to catch memory/<topic>.md
  }
  add("work folder text", work, { detail: workDetail });

  // 8. Service definitions.
  let service = 0;
  const serviceDetail = [];
  for (const file of serviceDefinitionPaths(home)) {
    const here = stale(`service ${path.basename(file)}`, await findInFile(file, rules));
    if (here) {
      service += here;
      serviceDetail.push(`${file}: ${here}`);
    }
  }
  add("service definitions", service, { detail: serviceDetail });

  // The paths that still exist: not a finding, but the reason a number that used to be non-zero
  // now is not, so it is printed rather than silently dropped.
  const resolvedTotal = [...resolved.values()].reduce((n, e) => n + e.count, 0);
  add("pre-rename paths that still exist on disk (never moved — correct as recorded)", resolvedTotal, {
    kind: "resolved",
    detail: [...resolved.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([p, e]) => `${p}: ${e.count} reference(s) in ${[...e.stores].sort().join(", ")}`),
  });

  const total = groups.filter((g) => g.kind === "state").reduce((n, g) => n + g.count, 0);
  const historical = groups.filter((g) => g.kind === "content").reduce((n, g) => n + g.count, 0);
  return { root, legacyRoot, legacyWorkspace, extraFroms: extra.map(([from]) => from), migrated, groups, total, historical, resolved: resolvedTotal };
}

export function formatAudit(audit, { title = "audit" } = {}) {
  const under = [audit.legacyRoot, audit.legacyWorkspace, ...(audit.extraFroms || [])].join(" or ");
  const lines = [`[migrate] ${title}: scanning ${audit.root} for paths under ${under}`];
  if (!audit.total) lines.push("  ✓ nothing found — every store is on the new paths");
  const section = (kind, heading) => {
    const here = audit.groups.filter((g) => g.kind === kind);
    if (!here.length) return;
    if (heading) lines.push(`  ${heading}`);
    for (const group of here) {
      lines.push(`  • ${group.store}: ${group.count}`);
      for (const detail of group.detail) lines.push(`      ${detail}`);
    }
  };
  section("state", "");
  section("content", "historical content — a record of what was said and done, left by design:");
  section("resolved", "still on disk — deliberately not moved, so the recorded path is correct:");
  const aside = [
    audit.historical ? `${audit.historical} in historical content` : "",
    audit.resolved ? `${audit.resolved} that still resolve on disk` : "",
  ].filter(Boolean);
  lines.push(
    `[migrate] ${title}: ${audit.total} occurrence(s) the migration is responsible for` +
      (aside.length ? `, plus ${aside.join(" and ")} (left by design)` : ""),
  );
  return lines;
}

// ── The migration ────────────────────────────────────────────────────────────────────────────
export async function migrateChannelGate({
  dryRun = false,
  // REPATH mode: run every rewrite pass against the CURRENT roots and move nothing. Safe to run
  // any number of times after a migration (or on a host somebody migrated by hand): the rules are
  // built from the same channel records, so a store already on the new paths matches no rule and
  // a second run changes nothing. See `--repath` in docs/OPERATIONS.md.
  repath = false,
  // Operator-supplied `--from/--to` pairs (see parsePathPairs): folders moved by hand.
  extraRules = [],
  log = (line) => console.log(line),
  env = process.env,
  home = os.homedir(),
  rename = fsRename,
  ...rootOverrides
} = {}) {
  const roots = resolveRoots({ env, home, ...rootOverrides });
  const extra = normalizePathPairs(extraRules);
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
  const rootMode = repath
    ? "repath"
    : rootPinned
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
  const moveWorkspace = !repath && !workspacePinned && (await exists(legacyWorkspace)) && (await workspaceHasFolders(legacyWorkspace));

  // Where the live runtime root is once the root step is done. A repath never moves it, so it runs
  // against whichever root actually holds the install — exactly what the audit scans.
  const rootForChannels = repath
    ? newHasState
      ? newRoot
      : legacyRoot
    : rootMode === "none" && !(await exists(newRoot))
      ? legacyRoot
      : newRoot;
  if (!repath && !movingRoot && !moveWorkspace && !(await exists(path.join(rootForChannels, "channels")))) {
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
    ran: true, dryRun, repath, rootMode, busy, movedRoot: "", extraRules: extra,
    channels: 0, workspaces: 0, metaFolders: 0, cleanWorkspaces: 0,
    rewrittenRows: 0, rewrittenFiles: 0, typedColumns: [], purgedCaches: [], regenerated: 0,
    claude: { renamed: 0, files: 0, occurrences: 0, collisions: [], errors: [], unresolved: [] },
    codex: { indexRows: 0, files: 0, occurrences: 0, errors: [] },
    workFolders: { files: 0, occurrences: 0 },
    services: { files: [], occurrences: 0, reloads: [] },
    collisions: [], errors: [],
  };

  log(
    `[migrate] ChannelGate ${repath ? "repath — re-applying every path rewrite against the CURRENT roots; nothing is moved" : "rename migration"}` +
      `${dryRun ? " — DRY RUN, nothing will be written" : ""}`,
  );
  log(`[migrate] plan:`);
  if (busy) log(`  • busy: ${busy} — a real run would refuse right now`);
  if (repath) log(`  • runtime root   ${rootForChannels} (unchanged) · workspace root ${newWorkspace} (unchanged)`);
  else if (rootMode === "move") log(`  • runtime root   ${legacyRoot} → ${newRoot}`);
  else if (rootMode === "merge") log(`  • runtime root   ${legacyRoot} → ${newRoot} (destination exists but holds no state — merging into it)`);
  else if (rootMode === "blocked") log(`  • runtime root   ${newRoot} already holds gateway state — NOT touching it; ${legacyRoot} is left for you to reconcile by hand`);
  else log(`  • runtime root   ${rootForChannels} (unchanged)`);
  if (moveWorkspace) log(`  • workspace root ${legacyWorkspace} → ${newWorkspace} (per channel, namespaced by platform)`);
  else if (!repath) log(`  • workspace root ${newWorkspace} (unchanged)`);
  for (const [from, to] of extra) log(`  • path rule      ${from} → ${to} (operator-supplied: a folder moved by hand)`);

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
      records = (await listChannels()).map((c) => {
        const workDir = (c.meta?.workDir || "").trim();
        return { slug: c.slug, platform: c.meta?.platform, workDir, customWorkDir: Boolean(workDir) };
      });
    }
    summary.channels = records.length;

    for (const rec of records) {
      const pf = platformFolderName(rec.platform);
      // A repath moves nothing: the folders are already where they belong (or the operator put
      // them there by hand), and only the STORED paths are brought back into line.
      if (repath) continue;
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
    const rules = mergeRules(buildPathRewrites({ legacyRoot, newRoot: rootForChannels, legacyWorkspace, newWorkspace, channels: records }), extra);
    // The engine home moves with the runtime root, and Claude Code's project directory is keyed on
    // it, so it needs a rule of its own even though it is covered by the bare-root catch-all.
    const db = dryRun ? dryDb : (await import("../src/db/index.js")).getDb();
    summary.rewrittenRows = db ? rewriteDatabasePaths(db, rules, { dryRun }) : 0;
    log(`  • ${summary.rewrittenRows} stored record(s) with an absolute path under the old roots`);
    summary.typedColumns = db ? rewriteTypedColumns(db, rules, { dryRun }) : [];
    if (summary.typedColumns.length) log(`  • ${summary.typedColumns.length} typed database column value(s): ${[...new Set(summary.typedColumns)].join(", ")}`);
    summary.rewrittenFiles = await rewriteJsonFiles(rootForChannels, rules, { dryRun, log });
    summary.rewrittenFiles += await rewriteConfigJson(rootForChannels, rules, { dryRun, log });
    summary.purgedCaches = await purgeRegenerableCaches(path.join(rootForChannels, "channels"), { dryRun, log, staleRules: repath ? rules : null });
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
    if (dryRun && !repath) workFolders.push(...records.filter((rec) => !rec.customWorkDir).map((rec) => path.join(legacyWorkspace, rec.slug)));
    // A custom workDir that an operator-supplied rule covers: the folder is already at its new
    // place (the rule says the operator moved it), so its prose is rewritten THERE.
    for (const rec of records) {
      if (!rec.customWorkDir) continue;
      const moved = rewritePath(rec.workDir, extra);
      if (moved !== rec.workDir) workFolders.push(moved);
    }
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
    if (dryRun || repath) {
      const title = repath ? (dryRun ? "audit (repath preview)" : "audit (post-repath)") : "audit (pre-migration)";
      summary.audit = await auditLegacyPaths({ env, home, extraRules: extra, ...rootOverrides });
      for (const line of formatAudit(summary.audit, { title })) log(line);
      if (dryRun) {
        log(`[migrate] dry run would leave ${summary.audit.historical} occurrence(s) behind (historical content, by design).`);
      }
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

// ── `--repath` ───────────────────────────────────────────────────────────────────────────────
// Every rewrite pass the migration runs, against the CURRENT roots, moving nothing. It is the
// repair tool for the case the migration cannot cover: a host somebody migrated by hand, a store
// that was locked when the one-time run went through, a channel folder an operator moved
// themselves. It is idempotent — the rules are keyed on the pre-rename roots and on the flat
// `channels/<slug>` layout, so a store already on the new paths matches nothing and a second run
// reports zero — and it refuses while the daemon is running, exactly as the migration does,
// because it rewrites the same live stores. `--dry-run --repath` previews it.
export async function repathChannelGate(options = {}) {
  return migrateChannelGate({ ...options, repath: true });
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
  const dryRun = process.argv.includes("--dry-run");
  // `--from <old> --to <new>` (repeatable): a folder the operator moved by hand — see parsePathPairs.
  let extraRules = [];
  try {
    extraRules = parsePathPairs(process.argv.slice(2));
  } catch (error) {
    console.error(`[migrate] ${error.message}`);
    console.error("Usage: node scripts/migrate-channelgate.mjs [--dry-run] [--verify | --repath] [--from <old path> --to <new path>]...");
    process.exit(2);
  }
  if (extraRules.length && !process.argv.includes("--verify") && !process.argv.includes("--repath")) {
    console.error("[migrate] --from/--to are repath rules: use them with --repath (apply) or --verify (count).");
    process.exit(2);
  }
  if (process.argv.includes("--verify")) {
    // Read-only. Safe to run against a live install, and the acceptance check after a real run.
    // The exit code is STATE only: historical content and paths that still resolve are reported
    // and never billed, so a non-zero exit always means there is something to repair.
    const audit = await auditLegacyPaths({ extraRules });
    for (const line of formatAudit(audit, { title: "verify" })) console.log(line);
    process.exit(audit.total > 0 ? 1 : 0);
  }
  if (process.argv.includes("--repath")) {
    // Operator-invoked, so unlike the boot path a refusal or a failure is an error exit — there is
    // no daemon to keep serving and nothing to fall back onto.
    const result = await repathChannelGate({ dryRun, extraRules });
    process.exit(result.failed || result.refused ? 1 : 0);
  }
  await migrateChannelGateAtBoot({ dryRun });
}
