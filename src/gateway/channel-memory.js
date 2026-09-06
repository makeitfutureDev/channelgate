// ── Channel memory system (skill-packaged — nothing goes into CLAUDE.md) ──────
// MEMORY.md and memory/<topic>.md files are the uncapped, portable source of truth. A compact
// catalog is injected at fresh-session start; agents retrieve relevant content through the
// channel-memory tools. The protocol lives in a gateway-maintained `channel-memory` SKILL whose
// description is always in the skills catalog — plus the update_channel_memory MCP tool, whose
// description is re-read every turn.
//
// Recall is discoverable: memorySnapshotPrefix gives every FRESH session the catalog and names the
// search/read tools. Saving is batched and atomic (applyMemoryOperations), and a post-reply
// background review (memory-review.js)
// is the backstop for turns where the model never called the tool.
import { mkdir, access, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { constants, openSync, readSync, writeFileSync, closeSync, renameSync, unlinkSync, fstatSync, lstatSync, statSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { slugify } from "../config/paths.js";
import { getAgentMemory } from "../config/settings.js";
import { readNoFollow, writeNoFollow, createExclusive, ensureRealDir } from "./safe-fs.js";

// Folder-scoped memory: a MEMORY.md inside the channel folder that the agent reads at task start
// and updates as it learns durable channel facts. Confinement-safe (single folder, no cross-channel
// path, Claude's global autoMemory stays off). Resolved per channel: meta.memory overrides the
// gateway default. Off in clean mode (bare run).
export function memoryEnabled(meta = {}) {
  if (meta.cleanMode) return false;
  return meta.memory === undefined ? getAgentMemory() : Boolean(meta.memory);
}
export const MEM_FILE = "MEMORY.md";
export const MEM_DIR = "memory"; // topic files: memory/<topic>.md, linked from the index as [[topic]]
export const MEMORY_SAVE_TOOL = "update_channel_memory";
// The save tool as each engine names it on its event stream: Claude's `mcp__gateway__<tool>`,
// Codex's `gateway.<tool>` / bare `<tool>`. One matcher so the turn counter and the review trigger
// can never disagree about what counts as "the model saved memory this turn".
export function isMemorySaveTool(name) {
  return /(^|__|\.|\/)update_channel_memory$/.test(String(name || "").trim());
}

const MEMORY_SKILL = "channel-memory";
const MEMORY_SKILL_MARKER = ".gateway-memory-skill"; // ours to refresh/remove (≠ library stubs)
const MAX_OPERATIONS = 25;
// Storage has no aggregate fact/topic budget. Each file and mutation still needs an I/O bound:
// these operations run in the daemon and must never block on an agent-created FIFO or huge file.
export const MAX_MEMORY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_BATCH_BYTES = 32 * 1024 * 1024;
// The index is grouped under these headers (seeded on first use). `add` may target one by name;
// an index without headers (pre-sections channels) just appends — nothing breaks.
export const MEMORY_SECTIONS = Object.freeze(["People & preferences", "Decisions", "Environment & gotchas", "Project state"]);

export function memoryBudget(meta = {}) {
  void meta;
  return null;
}

export function memoryUsage(indexContent, meta = {}) {
  const used = String(indexContent || "").length;
  return { used, budget: null, pct: null };
}

function memoryMeter(indexContent, meta) {
  const { used } = memoryUsage(indexContent, meta);
  return `index saved (${used} chars; uncapped)`;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ── Content scan ──────────────────────────────────────────────────────────────
// Memory is agent-written text that gets rendered into every future session's prompt, so a
// poisoned entry would persist across sessions until someone notices. Hermes scans entries with
// its threat-pattern set for the same reason. This is the narrow version: role-override /
// "ignore previous instructions" phrasing, invisible Unicode (hidden text), obvious credential
// material. Legit notes never look like this; a hit is refused with the reason so the model can
// rephrase.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;
const THREAT_PATTERNS = [
  [/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|messages?)\b/i, "prompt-injection wording"],
  [/<\/?\s*system\s*>|\[\s*system\s*\]|^\s*system\s*prompt\s*:/im, "system-role framing"],
  [/\bnew\s+instructions?\s*:/i, "instruction-override wording"],
  [/\b(xox[abpsr]-[A-Za-z0-9-]{10,}|sk-(ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/, "an API token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private-key material"],
  [/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{12,}/i, "a credential-looking value"],
];
export function scanMemoryContent(text) {
  const s = String(text || "");
  if (INVISIBLE_RE.test(s)) return "invisible Unicode characters (hidden text)";
  for (const [re, why] of THREAT_PATTERNS) if (re.test(s)) return why;
  return null;
}

// ── Skill + seed ──────────────────────────────────────────────────────────────
function memorySkillMd(meta) {
  return `---
name: ${MEMORY_SKILL}
description: This channel's PERSISTENT memory (survives across threads/sessions). A compact catalog is injected at session start; search and load relevant memory on demand, and save durable facts with update_channel_memory.
---

# Channel memory

This channel has persistent memory that survives across threads and sessions:

- \`${MEM_FILE}\` — durable facts and topic references, grouped under sections
  (${MEMORY_SECTIONS.join(" · ")}). Storage has no aggregate budget; each file is limited to 8 MiB and each save batch to 32 MiB for safe daemon I/O.
- \`${MEM_DIR}/<topic>.md\` — depth (project state, client details, procedures' gotchas).
  Referenced from index lines as \`[[topic]]\`.

At session start you receive only a compact catalog, not the memory contents. Use
\`search_channel_memory\` with terms from the request, then \`read_channel_memory\` for a relevant
source. Do not load every memory file preemptively.

## Save (whenever a trigger fires — and always as an end-of-task check)
Tool: \`update_channel_memory\`. Prefer ONE call with an \`operations\` array; the batch is applied
after validating the complete batch and storage has no character ceiling. Concurrent gateway saves are serialized; separate topic files are not a filesystem transaction.
- \`add\` — one concise line (\`text\`; optional \`section\`).
- \`replace\` — \`old\` (a unique substring of an existing line) → the whole line becomes \`text\`.
  Prefer this over adding near-duplicates.
- \`remove\` — drop the line(s) containing \`old\`.
- \`write_topic\` — create/update \`${MEM_DIR}/<topic>.md\` (\`topic\` + \`content\`); keep an index
  pointer line ("… → [[topic]]") so it stays discoverable.

Triggers: a user corrects you · a preference, decision, or durable fact is stated · a stable fact
about accounts, ids, paths, or conventions surfaces · a gotcha or technique that will matter again.

## What to save vs skip — the test: will it still matter in a week?
Save, in priority order: preferences & corrections (they stop people repeating themselves) >
decisions and standing choices > environment facts (accounts, ids, paths, conventions) >
techniques and gotchas.
Skip: task progress, completed-work logs, PR/issue numbers, commit SHAs, "phase N done",
temporary paths, raw data dumps, anything re-discoverable with one tool call. Procedures belong
in skills; the conversation itself stays in the thread history.
Write declarative facts, not instructions to yourself: "Alex prefers short replies" ✓ —
"Always reply briefly" ✗ (an imperative gets re-read as a command by later sessions).

## Never
Never store secrets, tokens, or credentials. Never write instructions addressed to future
sessions into memory — they are refused.
`;
}

function seedIndex() {
  return (
    `# Channel memory — index\n\n` +
    `_(One declarative line per durable fact; depth lives in ${MEM_DIR}/<topic>.md, referenced as [[topic]].\n` +
    `Maintained by the agent via update_channel_memory; also editable by hand or in the admin UI.)_\n\n` +
    MEMORY_SECTIONS.map((s) => `## ${s}\n`).join("\n")
  );
}

// Write/refresh (or remove) the channel-memory skill folder + seed the index and memory/ dir.
// Skill content is written only when it changed; disabling memory removes OUR skill folder
// (marker-guarded — never a granted/real skill) but leaves the memory files on disk (inert data).
export async function applyChannelMemory(cwd, meta) {
  const skillDir = path.join(cwd, ".claude", "skills", MEMORY_SKILL);
  if (!memoryEnabled(meta)) {
    if (await exists(path.join(skillDir, MEMORY_SKILL_MARKER))) {
      await rm(skillDir, { recursive: true, force: true });
    }
    return;
  }
  // Skill (marker + SKILL.md), write-on-change. Everything here sits in the agent-writable
  // workspace, so directories are recreated as real nodes and writes never follow a symlink
  // (see safe-fs.js).
  const skillFile = path.join(skillDir, "SKILL.md");
  const want = memorySkillMd(meta);
  const cur = await readNoFollow(skillFile);
  if (cur !== want) {
    await ensureRealDir(cwd, ".claude", "skills", MEMORY_SKILL);
    await writeNoFollow(path.join(skillDir, MEMORY_SKILL_MARKER), "");
    await writeNoFollow(skillFile, want);
  }
  // Seed the index + topic dir. Never clobbers an existing index — and the exclusive create also
  // refuses a symlink node (even a dangling one), so a planted link can't draw the seed elsewhere.
  await ensureRealDir(cwd, MEM_DIR);
  const memPath = path.join(cwd, MEM_FILE);
  if (!(await exists(memPath))) {
    await createExclusive(memPath, seedIndex()).catch(() => {
      /* raced into existence, or a foreign node squats there — leave it alone */
    });
  }
}

// ── Index model ───────────────────────────────────────────────────────────────
// The index is plain lines. Headers (`# …`, `## …`) and the seed note (`_(…)_`) are structure,
// never facts: they are skipped by replace/remove matching and not counted as facts.
const isHeader = (line) => /^\s*#/.test(line);
const isSeedNote = (line) => /^\s*_\(/.test(line) || /\)_\s*$/.test(line);
const isFactLine = (line) => line.trim() && !isHeader(line) && !isSeedNote(line);

export function countMemoryFacts(indexContent) {
  return String(indexContent || "").split("\n").filter(isFactLine).length;
}

function normalizeIndex(text) {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function findSection(lines, name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return -1;
  return lines.findIndex((l) => /^\s*##\s+/.test(l) && l.replace(/^\s*##\s+/, "").trim().toLowerCase() === want);
}

// Insert `line` at the end of the named section (before the next `## ` header, after the last
// non-blank line of the section). Unknown/absent section → append to the end of the index.
function insertLine(lines, line, section) {
  const h = findSection(lines, section);
  if (h < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(line);
    return;
  }
  let next = lines.length;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^\s*##\s+/.test(lines[i])) {
      next = i;
      break;
    }
  }
  let at = next;
  while (at > h + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, line);
}

// Pure: apply ONE index operation to the line array in place; returns a human note ("" = silent).
function applyIndexOp(lines, op) {
  const action = String(op.action || "");
  if (action === "add") {
    const line = String(op.text || "").replace(/\s*\n\s*/g, " ").trim();
    if (!line) throw new Error("add needs text (one concise line).");
    if (isHeader(line)) throw new Error("add: index lines are facts, not headings — drop the leading #.");
    if (lines.some((l) => l.trim() === line)) return `"${line.slice(0, 60)}${line.length > 60 ? "…" : ""}" is already in the index (no duplicate added).`;
    insertLine(lines, line, op.section);
    return "";
  }
  if (action === "replace") {
    const old = String(op.old || "");
    const text = String(op.text || "").replace(/\s*\n\s*/g, " ").trim();
    if (!old) throw new Error("replace needs 'old' (a unique substring of the line to update).");
    if (!text) throw new Error("replace needs text (the new line).");
    const hits = lines.map((l, i) => (isFactLine(l) && l.includes(old) ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) throw new Error(`replace: no index line contains "${old}".`);
    if (hits.length > 1) throw new Error(`replace: "${old}" matches ${hits.length} lines — use a more specific substring (or remove them and add one merged line).`);
    lines[hits[0]] = text;
    return "";
  }
  if (action === "remove") {
    const old = String(op.old || "");
    if (!old) throw new Error("remove needs the 'old' substring identifying the line(s) to drop.");
    const before = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) if (isFactLine(lines[i]) && lines[i].includes(old)) lines.splice(i, 1);
    if (lines.length === before) throw new Error(`remove: no index line contains "${old}".`);
    return "";
  }
  throw new Error(`Unknown action "${action}" — use add, replace, remove, or write_topic.`);
}

function validateTopicOp(op) {
  // Validate the RAW topic BEFORE slugifying: slugify() falls back to "id-unknown" for names it
  // fully strips (e.g. "../.."), which would silently save under a bogus topic instead of
  // erroring back to the agent.
  const raw = String(op.topic || "").trim();
  if (!raw) throw new Error("write_topic needs a topic name (becomes memory/<topic>.md).");
  if (!/[a-z0-9]/i.test(raw)) {
    throw new Error(`write_topic topic "${op.topic}" has no usable characters — name it with letters or digits (it becomes memory/<topic>.md).`);
  }
  const body = String(op.content || "").trim();
  if (!body) throw new Error("write_topic needs content.");
  return { slug: slugify(raw), body }; // slug guaranteed non-empty by the check above
}

// The write API behind the `update_channel_memory` gateway MCP tool — daemon-side, so saving
// works in EVERY mode (read channels can't write files in-sandbox). Validation is all-or-nothing.
// A short synchronous SQLite write transaction excludes other daemon/MCP writers across processes
// for the complete read-modify-write. File publication is individually atomic; ordinary I/O failures
// restore previous files. A process crash between separate file renames can leave a partial batch.
// `cwd` is the channel's effective work dir — the caller resolves it (effectiveWorkDir in
// folders.js), keeping this module free of any folders.js import.
export async function applyMemoryOperations(cwd, meta, operations) {
  const ops = Array.isArray(operations) ? operations.filter((o) => o && typeof o === "object") : [];
  if (!ops.length) throw new Error("Nothing to do — pass an action (add, replace, remove, write_topic) or an operations array.");
  if (ops.length > MAX_OPERATIONS) throw new Error(`Too many operations in one call (${ops.length}; max ${MAX_OPERATIONS}).`);
  let inputBytes = 0;
  for (const op of ops) {
    for (const field of ["text", "old", "content", "topic", "section"]) {
      const bytes = Buffer.byteLength(String(op[field] || ""));
      if (bytes > MAX_MEMORY_FILE_BYTES) throw new Error("Memory fields must not exceed the 8 MiB per-file I/O limit.");
      inputBytes += bytes;
    }
    if (op.action === "write_topic") validateTopicOp(op);
  }
  if (inputBytes > MAX_MEMORY_BATCH_BYTES) throw new Error("Memory batch exceeds the 32 MiB mutation I/O limit.");
  await mkdir(cwd, { recursive: true });
  if (ops.some((op) => op.action === "write_topic")) await ensureRealDir(cwd, MEM_DIR);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  let directories;
  try {
    // Provisioning may have awaited other work. Pin and validate fresh descriptors under the lock;
    // every later read, temporary file, rename and rollback is relative to these pinned parents.
    directories = pinMemoryDirectories(cwd, ops.some((op) => op.action === "write_topic"));
    const result = applyMemoryOperationsLocked(cwd, meta, ops, directories);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally { directories?.close(); }
}

function sameNode(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function pinMemoryDirectories(cwd, includeTopics) {
  const opened = [];
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  try {
    const rootFd = openSync(cwd, directoryFlags);
    opened.push(rootFd);
    const root = `/proc/self/fd/${rootFd}`;
    const rootStat = fstatSync(rootFd);
    let topics = null;
    let topicsStat = null;
    if (includeTopics) {
      // Keep operator-owned links whose targets remain inside the workspace, but resolve their
      // target into components and open each with NOFOLLOW. A changed parent can only fail the
      // save; it cannot redirect any data read/write into the host.
      const canonicalRoot = realpathSync(root);
      const relative = path.relative(canonicalRoot, realpathSync(path.join(root, MEM_DIR)));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Memory directory changed or escaped the workspace; retry after inspecting it.");
      }
      let parent = root;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        const fd = openSync(path.join(parent, segment), directoryFlags);
        opened.push(fd);
        parent = `/proc/self/fd/${fd}`;
      }
      topics = parent;
      topicsStat = statSync(topics);
    }
    const assertCurrent = () => {
      const currentRoot = lstatSync(cwd);
      if (!currentRoot.isDirectory() || !sameNode(currentRoot, rootStat)) throw new Error("Memory workspace moved during the save; inspect the workspace before retrying.");
      if (topics) {
        const relative = path.relative(realpathSync(root), realpathSync(path.join(root, MEM_DIR)));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !sameNode(statSync(path.join(root, MEM_DIR)), topicsStat)) {
          throw new Error("Memory directory moved during the save; inspect the memory files before retrying.");
        }
      }
    };
    assertCurrent();
    return { root, topics, assertCurrent, close: () => { for (const fd of opened.reverse()) closeSync(fd); } };
  } catch (error) {
    for (const fd of opened.reverse()) closeSync(fd);
    throw error;
  }
}

function readMemoryFileSync(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Memory path is not a regular file; remove the special file before saving.");
    if (info.size > MAX_MEMORY_FILE_BYTES) throw new Error("Memory file exceeds the 8 MiB per-file I/O limit; split it into smaller topics before saving.");
    // Never trust st_size as a read limit: a regular file can grow while we hold its descriptor.
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_MEMORY_FILE_BYTES - total + 1));
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_MEMORY_FILE_BYTES) throw new Error("Memory file grew beyond the 8 MiB per-file I/O limit during reading.");
      chunks.push(buffer.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (["ENOENT", "ELOOP", "EISDIR", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function replaceMemoryFileSync(file, body, assertCurrent = () => {}) {
  assertCurrent();
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    writeFileSync(fd, body);
    closeSync(fd);
    fd = undefined;
    assertCurrent();
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function applyMemoryOperationsLocked(cwd, meta, ops, directories) {
  const memPath = path.join(directories.root, MEM_FILE);
  // No-follow read: a planted symlink at MEMORY.md reads as absent (and is replaced as a node by
  // the atomic write below) rather than pulling foreign content into the index.
  const before = readMemoryFileSync(memPath) ?? "";
  const lines = before.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  if (before === "") lines.length = 0;
  const notes = [];
  const topics = [];
  const counts = {};
  for (const op of ops) {
    const action = String(op.action || "");
    counts[action] = (counts[action] || 0) + 1;
    for (const field of ["text", "content"]) {
      const why = scanMemoryContent(op[field]);
      if (why) throw new Error(`Refused ${action}: the ${field} looks like ${why}. Memory holds plain facts about this channel — rephrase without it.`);
    }
    if (action === "write_topic") {
      topics.push(validateTopicOp(op));
      continue;
    }
    const note = applyIndexOp(lines, op);
    if (note) notes.push(note);
  }

  const next = lines.length ? normalizeIndex(lines.join("\n")) : "";
  const indexChanged = normalizeIndex(before) !== next && !(before === "" && next === "");
  // Validation passed for the whole batch — now write. memory/ lives in the agent-writable
  // workspace: recreate it as a real dir and publish each topic via exclusive temp + rename, so a
  // pre-planted symlink at memory/<topic>.md is replaced as a node — never written through.
  const written = [];
  const writes = new Map();
  for (const { slug, body } of topics) {
    const file = path.join(directories.topics, `${slug}.md`);
    writes.set(file, body.replace(/\s+$/, "") + "\n");
    written.push({ topic: slug, path: path.join(cwd, MEM_DIR, `${slug}.md`) });
    notes.push(`Topic [[${slug}]] saved — make sure an index line points to it.`);
  }
  if (indexChanged) writes.set(memPath, next);
  let batchBytes = 0;
  for (const body of writes.values()) {
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_MEMORY_FILE_BYTES) throw new Error("Memory result exceeds the 8 MiB per-file I/O limit; split it into smaller topics.");
    batchBytes += bytes;
  }
  if (batchBytes > MAX_MEMORY_BATCH_BYTES) throw new Error("Memory result exceeds the 32 MiB mutation I/O limit.");
  directories.assertCurrent();
  const previous = new Map([...writes.keys()].map((file) => [file, readMemoryFileSync(file)]));
  const published = [];
  try {
    for (const [file, body] of writes) {
      replaceMemoryFileSync(file, body, directories.assertCurrent);
      published.push(file);
      directories.assertCurrent();
    }
  } catch (error) {
    const failures = [];
    for (const file of published.reverse()) {
      try {
        const body = previous.get(file);
        if (body === null) unlinkSync(file);
        else replaceMemoryFileSync(file, body);
      } catch (rollbackError) { failures.push(rollbackError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Memory batch failed and rollback was incomplete; inspect the memory files before retrying.");
    throw error;
  }

  const meter = indexChanged || !topics.length ? memoryMeter(next || before, meta) : "";
  return {
    path: indexChanged || !written.length ? path.join(cwd, MEM_FILE) : written[written.length - 1].path,
    meter,
    note: notes.join(" "),
    notes,
    indexChanged,
    topics: written,
    counts,
    usage: memoryUsage(next || before, meta),
  };
}

// Single-operation form (the tool's bare action/text/old/topic/content shape, and the existing
// callers/tests). Same semantics as a one-element batch.
export async function updateChannelMemory(cwd, meta, { action, text = "", old = "", topic = "", content = "", section = "" }) {
  return applyMemoryOperations(cwd, meta, [{ action, text, old, topic, content, section }]);
}

// ── Recall: the session-start catalog ─────────────────────────────────────────

export async function readMemorySnapshot(cwd, meta = {}) {
  const raw = (await readNoFollow(path.join(cwd, MEM_FILE))) ?? "";
  const index = normalizeIndex(raw).trim() ? normalizeIndex(raw) : "";
  let topics = [];
  try {
    topics = (await readdir(path.join(cwd, MEM_DIR), { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => d.name.slice(0, -3))
      .sort();
  } catch {
    /* no topic dir yet */
  }
  return { index, facts: countMemoryFacts(index), topics, usage: memoryUsage(index, meta) };
}

// The block prepended to a FRESH session contains bounded metadata only. Memory contents stay out
// of the prompt until the agent searches and reads a relevant source.
export async function memorySnapshotPrefix(cwd, meta = {}) {
  if (!memoryEnabled(meta)) return "";
  const snap = await readMemorySnapshot(cwd, meta);
  if (!snap.facts) return "";
  const topics = snap.topics.slice(0, 100).map((t) => `${MEM_DIR}/${t}.md`).join(", ");
  const more = snap.topics.length > 100 ? `, and ${snap.topics.length - 100} more` : "";
  return (
    `[Channel memory catalog — ${snap.facts} durable facts and ${snap.topics.length} topic files are stored for this channel. ` +
    `Memory contents are not injected. Use search_channel_memory for request-relevant recall, then read_channel_memory for a returned source; never load everything preemptively. ` +
    `${topics ? `Available topic files: ${topics}${more}. ` : ""}` +
    `Save durable facts with update_channel_memory.]\n\n`
  );
}
