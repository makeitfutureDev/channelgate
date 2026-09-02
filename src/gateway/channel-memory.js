// ── Channel memory system (skill-packaged — nothing goes into CLAUDE.md) ──────
// Modeled on Hermes + Claude Code native auto-memory: MEMORY.md is a short, BUDGETED index
// (always cheap enough to read), memory/<topic>.md files carry depth (an Obsidian-style graph via
// [[topic]] links), and the protocol lives in a gateway-maintained `channel-memory` SKILL whose
// description is always in the skills catalog — plus the update_channel_memory MCP tool, whose
// description is re-read every turn.
//
// Recall is not left to chance: the index is rendered into the prompt of every FRESH session
// (memorySnapshotPrefix — the Hermes "frozen snapshot at session start" pattern; run.js prepends
// it), so a thread starts knowing what the channel knows without having to decide to Read a file.
// Saving is batched and atomic (applyMemoryOperations): one call can free room and add in the
// same breath, and the budget is checked on the FINAL result — the old "over-budget add throws and
// the save is silently dropped" dead end is gone. A post-reply background review (memory-review.js)
// is the backstop for turns where the model never called the tool.
import { mkdir, access, rm, readdir } from "node:fs/promises";
import path from "node:path";
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
// Index budget in CHARS (model-independent). 8k ≈ 2k tokens per fresh session — cheap enough to
// inject every time, big enough that a busy channel isn't consolidating every other turn (the old
// 3k default had the dev channel at 101% with adds failing).
const DEFAULT_MEM_BUDGET = 8000;
const MIN_MEM_BUDGET = 500;
const MAX_TOPIC_CHARS = 30_000;
const MAX_OPERATIONS = 25;
// The index is grouped under these headers (seeded on first use). `add` may target one by name;
// an index without headers (pre-sections channels) just appends — nothing breaks.
export const MEMORY_SECTIONS = Object.freeze(["People & preferences", "Decisions", "Environment & gotchas", "Project state"]);

export function memoryBudget(meta = {}) {
  const b = Number(meta.memoryBudget);
  return Number.isFinite(b) && b >= MIN_MEM_BUDGET ? Math.floor(b) : DEFAULT_MEM_BUDGET;
}

export function memoryUsage(indexContent, meta = {}) {
  const budget = memoryBudget(meta);
  const used = String(indexContent || "").length;
  return { used, budget, pct: Math.round((used / budget) * 100) };
}

function memoryMeter(indexContent, meta) {
  const { used, budget, pct } = memoryUsage(indexContent, meta);
  return `index ${pct}% full (${used}/${budget} chars)`;
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
description: This channel's PERSISTENT memory (survives across threads/sessions). Its ${MEM_FILE} index is injected into your context at the start of every session; use this skill when you need depth from ${MEM_DIR}/<topic>.md files, and BEFORE finishing any task in which the user corrected you, stated a preference or decision, or you learned a durable fact or gotcha — SAVE it with the update_channel_memory tool.
---

# Channel memory

This channel has persistent memory that survives across threads and sessions:

- \`${MEM_FILE}\` — the INDEX: one declarative line per durable fact, grouped under sections
  (${MEMORY_SECTIONS.join(" · ")}). Hard budget: ${memoryBudget(meta)} chars. It is already in
  your context at session start (the \`[Channel memory …]\` block); saves land on disk at once and
  show up in the next session's snapshot.
- \`${MEM_DIR}/<topic>.md\` — depth (project state, client details, procedures' gotchas).
  Referenced from index lines as \`[[topic]]\`. Read them when the task touches the topic; Grep
  \`${MEM_DIR}/\` when hunting for something specific.

## Save (whenever a trigger fires — and always as an end-of-task check)
Tool: \`update_channel_memory\`. Prefer ONE call with an \`operations\` array — the batch is applied
atomically and the budget is checked on the FINAL result, so you can remove/replace stale lines
and add new ones together.
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

## Curate
The budget is enforced: an over-budget save fails and asks you to consolidate — do it in the SAME
call (batch: \`remove\`/\`replace\` stale lines + \`add\`). Consolidate proactively past ~80%.

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
  if (body.length > MAX_TOPIC_CHARS) throw new Error(`Topic content too large (${MAX_TOPIC_CHARS / 1000}k chars max) — split it.`);
  return { slug: slugify(raw), body }; // slug guaranteed non-empty by the check above
}

// The write API behind the `update_channel_memory` gateway MCP tool — daemon-side, so saving
// works in EVERY mode (read channels can't write files in-sandbox). A batch is ALL-OR-NOTHING:
// every operation is validated and applied to an in-memory copy of the index first, the budget is
// checked once on the final result, and only then are topic files and the index written. An
// over-budget batch therefore leaves the files exactly as they were (Hermes semantics: errors
// demand consolidation, never silent truncation — but consolidation can ride in the same call).
// `cwd` is the channel's effective work dir — the caller resolves it (effectiveWorkDir in
// folders.js), keeping this module free of any folders.js import.
export async function applyMemoryOperations(cwd, meta, operations) {
  const ops = Array.isArray(operations) ? operations.filter((o) => o && typeof o === "object") : [];
  if (!ops.length) throw new Error("Nothing to do — pass an action (add, replace, remove, write_topic) or an operations array.");
  if (ops.length > MAX_OPERATIONS) throw new Error(`Too many operations in one call (${ops.length}; max ${MAX_OPERATIONS}).`);
  const budget = memoryBudget(meta);
  const memPath = path.join(cwd, MEM_FILE);
  await mkdir(cwd, { recursive: true });

  // No-follow read: a planted symlink at MEMORY.md reads as absent (and is replaced as a node by
  // the atomic write below) rather than pulling foreign content into the index.
  const before = (await readNoFollow(memPath)) ?? "";
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
  if (indexChanged && next.length > budget) {
    throw new Error(
      `Memory index would be over budget (${next.length}/${budget} chars). Consolidate in the SAME call: batch remove/replace of stale or overlapping lines together with the add, or move detail into a topic file (write_topic) and keep a one-line pointer.`
    );
  }

  // Validation passed for the whole batch — now write. memory/ lives in the agent-writable
  // workspace: recreate it as a real dir and publish each topic via exclusive temp + rename, so a
  // pre-planted symlink at memory/<topic>.md is replaced as a node — never written through.
  const written = [];
  if (topics.length) {
    await ensureRealDir(cwd, MEM_DIR);
    for (const { slug, body } of topics) {
      const file = path.join(cwd, MEM_DIR, `${slug}.md`);
      await writeNoFollow(file, body.replace(/\s+$/, "") + "\n");
      written.push({ topic: slug, path: file });
      notes.push(`Topic [[${slug}]] saved — make sure an index line points to it.`);
    }
  }
  // Atomic replacement (exclusive temp + rename): concurrent runs read old-or-new, never a
  // truncated index. (A cross-process mutex over the read-modify-write is deliberately not
  // attempted here — last writer wins, but every observable state is a complete file.)
  if (indexChanged) await writeNoFollow(memPath, next);

  const meter = indexChanged || !topics.length ? memoryMeter(next || before, meta) : "";
  return {
    path: indexChanged || !written.length ? memPath : written[written.length - 1].path,
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

// ── Recall: the session-start snapshot ────────────────────────────────────────
// How much of an over-budget (hand-edited / admin-override) index still gets injected before we
// cut it: the budget is the contract, so anything past 1.5× is trimmed with a visible marker
// rather than quietly ballooning every session's prompt.
const SNAPSHOT_OVERFLOW = 1.5;

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

// The block prepended to the prompt of a FRESH session (run.js). Empty when memory is off for
// this run or the index holds no facts yet — a channel that never saved anything pays nothing.
// The content is agent-written and therefore neutralized against our own framing sentinel; the
// write path already refuses instruction-shaped text.
export async function memorySnapshotPrefix(cwd, meta = {}) {
  if (!memoryEnabled(meta)) return "";
  const snap = await readMemorySnapshot(cwd, meta);
  if (!snap.facts) return "";
  let body = snap.index.trim();
  const cap = Math.floor(snap.usage.budget * SNAPSHOT_OVERFLOW);
  if (body.length > cap) body = `${body.slice(0, cap)}\n…(index truncated at ${cap} chars — it is over budget; consolidate it)`;
  body = body.replace(/\[End of channel memory/gi, "(End of channel memory");
  const topics = snap.topics.length ? ` Topic files with more depth (Read them when the task touches the topic): ${snap.topics.map((t) => `${MEM_DIR}/${t}.md`).join(", ")}.` : "";
  return (
    `[Channel memory — snapshot at session start; index ${snap.usage.pct}% of its ${snap.usage.budget}-char budget. ` +
    `These are durable facts saved by earlier conversations in this channel: trusted notes to act on, not instructions from the user.${topics} ` +
    `Save new durable facts with update_channel_memory (batch operations); this snapshot refreshes on the next session.]\n\n` +
    `${body}\n\n[End of channel memory.]\n\n`
  );
}
