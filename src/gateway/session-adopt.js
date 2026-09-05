// Adopting an EXISTING local engine session into a Slack thread — the write direction of the
// 💻 "Resume in terminal" button. That button hands out `cd "<folder>" && claude --resume <id>`;
// pasting the same line back as `/resume …` re-attaches the terminal conversation to the thread,
// so a session started (or continued) on the gateway machine keeps going in Slack.
//
// The hard rule this module exists to enforce: a session may only be adopted in the channel whose
// own working folder produced it. An engine locates a session by the directory you run it in, so
// the session file records a `cwd`; that cwd must be THIS channel's effective work dir. Without
// the check, anyone could type a session id from another channel's project folder and have the
// gateway replay that private conversation into their own channel — confinement laundered through
// a session id. Adoption is refused in every other channel, and refused outright when the id is
// already bound to a different thread (two threads resuming one session would interleave turns in
// the same cwd).
//
// WHERE that session file is depends on where the channel runs. Under the container runtime a
// thread's transcripts live in the channel's own HOME volume, not in the daemon's engine dirs — and
// rootless Podman puts that volume behind a user-namespace mapping, so the daemon usually cannot
// even traverse into it. So a lookup walks candidate STORES, cheapest first: the daemon's own state
// dirs (a legacy, pre-container session), the HOME volume read directly where a host leaves it
// readable, and otherwise the container itself, asked through the runtime's read-only
// `inspectState`. Whichever store answers, the same-channel rule below is applied to the cwd the
// transcript itself recorded.
import path from "node:path";
import os from "node:os";
import { createReadStream } from "node:fs";
import { access, constants, realpath, stat } from "node:fs/promises";
import readline from "node:readline";
import { getDb } from "../db/index.js";
import { findCodexRollout } from "../engines/codex-usage.js";
import { engineLabel, engineStateDir, ENGINE_IDS } from "../engines/registry.js";
import { runtimeCanInspectState } from "../runtimes/contract.js";
import { expandCarryEntry } from "../runtimes/copy.js";
import { listChannels } from "../config/store.js";
import { effectiveWorkDir } from "./folders.js";

// Engines whose sessions live in a local, gateway-readable store and can therefore be adopted.
// OpenCode keeps its history in its own server-side store with no cwd we can verify, so a session
// of its cannot pass the same-channel check and is refused explicitly rather than silently bound.
const ADOPTABLE = new Set(["claude", "codex"]);

// The real state dirs — the same expressions run-grant-artifacts.js uses to build the engine
// homes it hands the subprocess. Those homes only SYMLINK `projects` / `sessions` back here, so
// reading the host store sees exactly what a resumed run will see.
export function claudeStateDir() {
  return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}
export function codexStateDir() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

// Slack delivers message text HTML-escaped (`&&` arrives as `&amp;&amp;`) and helpfully rewrites
// straight quotes to curly ones when "smart" formatting is on. A pasted resume command must
// survive both, plus the code fences/backticks people wrap commands in.
function unwrapPastedCommand(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/```/g, " ")
    .replace(/`/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Session ids are engine-minted opaque tokens (Claude/Codex: a uuid; others: a prefixed slug).
// Deliberately narrow: no dots, slashes, or spaces, so a parsed id can never carry a path
// fragment into the store lookups below.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

// Recognize the resume command each engine advertises (registry `resumeCommand`), so whatever the
// 💻 button printed can be pasted straight back. `-r` is Claude's short form, which people who
// live in the terminal type instead.
const COMMAND_FORMS = [
  { engine: "claude", re: /\bclaude\b[^&|;]*?\s(?:--resume|-r)\s+("[^"]+"|'[^']+'|\S+)/i },
  { engine: "codex", re: /\bcodex\b(?:\s+exec)?\s+resume\s+("[^"]+"|'[^']+'|\S+)/i },
  { engine: "opencode", re: /\bopencode\b[^&|;]*?\s--session\s+("[^"]+"|'[^']+'|\S+)/i },
];

const CD_RE = /\bcd\s+("[^"]+"|'[^']+'|[^\s&|;]+)/i;

function unquote(value) {
  const v = String(value || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

// Parse `/resume`'s argument into { sessionId, cwd, engine }. Accepts the full pasted command
// (`cd "/path" && claude --resume <id>`), just the engine invocation, or a bare session id — the
// three forms a user actually has at hand. `engine`/`cwd` are "" when the text didn't say; the
// caller resolves the engine from the thread and always verifies cwd against the session file
// itself, so an omitted (or wrong) `cd` can never widen what gets adopted.
export function parseResumeRequest(text) {
  const value = unwrapPastedCommand(text);
  if (!value) return null;
  const cwd = unquote(value.match(CD_RE)?.[1] || "");
  for (const form of COMMAND_FORMS) {
    const raw = unquote(value.match(form.re)?.[1] || "");
    if (raw && SESSION_ID_RE.test(raw)) return { sessionId: raw, cwd, engine: form.engine };
  }
  // Bare id — the whole argument is one token that looks like a session id.
  const bare = unquote(value);
  if (SESSION_ID_RE.test(bare)) return { sessionId: bare, cwd, engine: "" };
  return null;
}

// Session transcripts grow to megabytes; the fields we need (cwd, start time) are in the opening
// records, so a lookup must never read the whole file. Both stores below cap at the same number of
// lines, and the container store additionally caps the bytes — a truncated last line simply fails
// to parse, which is already how a corrupt record is treated.
const HEAD_LINES = 50;
// …and the same in bytes, because a single record can be a megabyte on its own (a large tool
// result), so a line count alone is not a bound. Measured against live transcripts: a Codex
// rollout's `session_meta` (which carries the cwd) is one ~19 KB line, and a Claude transcript's
// first record naming a cwd sat around byte 25 K — this leaves an order of magnitude of headroom
// and still bounds what a lookup reads.
const HEAD_BYTES = 512_000;

// The opening lines of a JSONL transcript on the daemon's filesystem.
async function readHeadLines(file, { maxLines = HEAD_LINES, maxBytes = HEAD_BYTES } = {}) {
  let input;
  try {
    input = createReadStream(file, { encoding: "utf8" });
  } catch {
    return [];
  }
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const out = [];
  let read = 0;
  try {
    for await (const line of reader) {
      out.push(line);
      read += line.length + 1;
      if (out.length >= maxLines || read >= maxBytes) break;
    }
  } catch {
    /* unreadable/truncated transcript — whatever was read still gets parsed */
  } finally {
    reader.close();
    input.destroy();
  }
  return out;
}

// The first parsed record that satisfies `pick`.
function firstRecord(lines, pick) {
  for (const line of lines || []) {
    if (!String(line || "").trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const value = pick(parsed);
    if (value) return value;
  }
  return null;
}

// ── Where a transcript can be read from ───────────────────────────────────────────────────────
// A store answers two questions and nothing else: which files match a pattern (with their mtime),
// and what a matched file's opening lines say. `dir` is set only when the store is a directory this
// process can open — Codex's own rollout index is a SQLite file in its state dir, and only a
// directory store can consult it.
//
// The pattern is a carry pattern (src/runtimes/copy.js): `*` inside a segment, never across one, so
// the same expression drives a node:fs expansion here and a shell glob inside a container.

// A directory on the daemon's filesystem: the gateway's own engine state dirs, and — where a host
// leaves the HOME volume traversable — the channel's volume.
function directoryStore(kind, dir) {
  return {
    kind,
    dir,
    async matches(rel) {
      if (!dir) return [];
      const from = path.join(dir, rel);
      const out = [];
      for (const pair of expandCarryEntry({ rel, from, to: from, kind: "file" })) {
        let info;
        try {
          info = await stat(pair.from);
        } catch {
          continue;
        }
        if (!info.isFile()) continue;
        out.push({ file: pair.from, mtimeMs: info.mtimeMs, head: null });
      }
      return out;
    },
    async head(file) {
      return readHeadLines(file);
    },
  };
}

// The channel's own container, through the runtime's read-only `inspectState`. One call brings back
// every match WITH its opening lines, so `head()` never crosses the boundary a second time.
function runtimeStore(target, stateDir) {
  const heads = new Map();
  return {
    kind: "container",
    dir: "",
    async matches(rel) {
      const found = await target.runtime.inspectState(target, { globs: [path.posix.join(stateDir, rel)], maxLines: HEAD_LINES, maxBytes: HEAD_BYTES });
      const out = [];
      for (const entry of found || []) {
        const file = String(entry?.path || "");
        if (!file) continue;
        const head = Array.isArray(entry?.head) ? entry.head : [];
        heads.set(file, head);
        out.push({ file, mtimeMs: Number(entry?.mtimeMs) || 0, head });
      }
      return out;
    },
    async head(file) {
      return heads.get(file) || [];
    },
  };
}

async function readableDir(dir) {
  try {
    await access(dir, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// This engine's state dir INSIDE the channel's container. engineStateDir() answers with the host
// dir when the target names none, so the container's answer is only trusted when it actually
// differs from the no-target one.
function containerStateDir(engine, target) {
  if (!target?.container) return "";
  const inside = engineStateDir(engine, target);
  return inside && inside !== engineStateDir(engine, null) ? inside : "";
}

// The daemon's view of an in-container path, when the backend can name where the HOME volume's data
// dir sits on this filesystem (`homeVolumeHostPath`, settled by the container lifecycle). Usually
// unusable: rootless Podman owns the volume's own directory as the mapped sub-uid with mode 0700,
// so the files inside are unreachable even though they belong to the daemon's uid. That is why
// readableDir() decides whether this store is used, not whether the path can be composed.
function volumeView(target, inside) {
  const home = String(target?.container?.home || "");
  const volume = String(target?.container?.homeVolumeHostPath || "");
  if (!home || !volume || !inside) return "";
  const rel = path.posix.relative(home, inside);
  if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) return "";
  return path.join(volume, rel);
}

// The stores to search for this engine, cheapest first. The daemon's own dirs cost a readdir; the
// container costs a container start, so it is asked last and only when the first two say nothing.
async function storesFor(engine, { dirs = {}, target = null } = {}) {
  const stores = [];
  const hostDir = engine === "claude" ? dirs.claude || claudeStateDir() : dirs.codex || codexStateDir();
  if (hostDir) stores.push(directoryStore("host", hostDir));
  const inside = containerStateDir(engine, target);
  if (!inside) return stores;
  const onHost = volumeView(target, inside);
  if (onHost && (await readableDir(onHost))) stores.push(directoryStore("volume", onHost));
  else if (runtimeCanInspectState(target)) stores.push(runtimeStore(target, inside));
  return stores;
}

// The most recently written match. A session id is unique, so this normally picks the only one.
function newest(matches = []) {
  return matches.reduce((best, entry) => (!best || entry.mtimeMs > best.mtimeMs ? entry : best), null);
}

// Claude encodes a session's cwd into its project directory name by replacing every non
// alphanumeric character with "-". Only used as a FALLBACK identity check for a transcript that
// records no cwd (very old or truncated): the encoding is lossy (a space and a slash both become
// "-"), so it can confirm a directory we already have in hand but can never reconstruct one.
export function claudeProjectDirName(dir) {
  return String(dir || "").replace(/[^a-zA-Z0-9]/g, "-");
}

// Find a Claude session id anywhere in a store's project tree. Matching every project directory
// (rather than computing the encoded name for one) keeps this independent of that encoding, and
// makes "not found" a fact rather than a guess about the naming scheme.
async function locateClaudeSession(sessionId, store) {
  const match = newest(await store.matches(`projects/*/${sessionId}.jsonl`));
  if (!match) return null;
  const head = match.head || (await store.head(match.file));
  const cwd = firstRecord(head, (r) => (typeof r?.cwd === "string" && r.cwd ? r.cwd : null));
  return {
    file: match.file,
    cwd: cwd || "",
    // Both sides are POSIX (the daemon and every container run on Linux — src/runtimes/copy.js).
    projectDir: path.basename(path.dirname(match.file)),
    lastActivity: match.mtimeMs,
    store: store.kind,
  };
}

async function locateCodexSession(sessionId, store) {
  // A rollout's filename carries a timestamp nobody can recompute, so it is found by pattern —
  // `sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, the same tree the carry moves. Codex also
  // keeps its own index (a SQLite state db beside that tree); only a directory store can open one,
  // so it is a shortcut and never the requirement.
  let file = store.dir ? await findCodexRollout(store.dir, sessionId).catch(() => "") : "";
  let lastActivity = 0;
  let head = null;
  if (file) {
    try {
      lastActivity = (await stat(file)).mtimeMs;
    } catch {
      file = "";
    }
  }
  if (!file) {
    const match = newest(await store.matches(`sessions/*/*/*/*${sessionId}*.jsonl`));
    if (!match) return null;
    file = match.file;
    lastActivity = match.mtimeMs;
    head = match.head;
  }
  const lines = head || (await store.head(file));
  const cwd = firstRecord(lines, (r) => (r?.type === "session_meta" && typeof r?.payload?.cwd === "string" ? r.payload.cwd : null));
  return { file, cwd: cwd || "", projectDir: "", lastActivity, store: store.kind };
}

/**
 * Locate a session in the stores this channel can reach. Returns null when the id doesn't exist
 * anywhere the gateway can see — the gateway resumes sessions, it never invents them.
 *
 * @param {string} engine
 * @param {string} sessionId
 * @param {object} [options]
 * @param {object} [options.dirs]    override the daemon-side state dirs (tests)
 * @param {object} [options.target]  the channel's RuntimeTarget, so a containerized session is found
 * @param {Function} [options.log]
 */
export async function locateSession(engine, sessionId, options = {}) {
  const id = String(sessionId || "");
  // The id goes into a glob on both sides of the container boundary; SESSION_ID_RE is what keeps a
  // path fragment or a wildcard from ever reaching one.
  if (!SESSION_ID_RE.test(id) || !ADOPTABLE.has(engine)) return null;
  const log = options.log || (() => {});
  for (const store of await storesFor(engine, options)) {
    let found = null;
    try {
      found = engine === "claude" ? await locateClaudeSession(id, store) : await locateCodexSession(id, store);
    } catch (error) {
      // A container that will not start, a CLI that is gone: the remaining stores still answer, and
      // "not found" stays a fact about this machine rather than a swallowed crash.
      log(`[gateway] could not read ${engine} sessions from the ${store.kind} store: ${error?.message || error}`);
      continue;
    }
    if (found) {
      // WHICH store answered is the fact that was missing while adoption was quietly impossible for
      // every containerized channel; one log line makes it visible in the journal.
      if (store.kind !== "host") log(`[gateway] found ${engine} session ${id} in this channel's ${store.kind === "container" ? "container" : "HOME volume"}`);
      return found;
    }
  }
  return null;
}

// Every thread currently bound to this session id, excluding the thread asking to adopt it. A
// session is single-writer: the same id resumed from two threads would interleave two
// conversations in one transcript, and each turn would see the other's context.
export function sessionBindings(sessionId, { exceptSlug = "", exceptThreadKey = "" } = {}) {
  const rows = getDb().prepare("SELECT slug, thread_key FROM sessions WHERE session_id = ?").all(sessionId) || [];
  return rows.filter((r) => !(r.slug === exceptSlug && r.thread_key === exceptThreadKey)).map((r) => ({ slug: r.slug, threadKey: r.thread_key }));
}

async function realOrResolved(dir) {
  const resolved = path.resolve(String(dir || ""));
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function sameDirectory(a, b) {
  if (!a || !b) return false;
  return (await realOrResolved(a)) === (await realOrResolved(b));
}

// Slack's slash-command parsing collapses runs of whitespace, so a folder named "Projects
// Customers" survives a paste but a DOUBLE-spaced one does not. Only the PASTED `cd` suffers this
// (the transcript's cwd is read from disk), and only to confirm the user pasted one coherent
// command — so compare it whitespace-insensitively rather than refusing a session whose own
// recorded cwd already matched.
function collapsed(dir) {
  return String(dir || "").replace(/\s+/g, " ").replace(/\/+$/, "");
}
async function pastedPathMatches(pasted, dir) {
  if (await sameDirectory(pasted, dir)) return true;
  // The collapsed spelling doesn't exist on disk, so realpath can't canonicalize it — compare it
  // against both the resolved and the fully-real form of the target (they differ wherever a
  // parent is a symlink, e.g. a symlinked /tmp or home directory).
  const target = collapsed(pasted);
  return target === collapsed(path.resolve(String(dir || ""))) || target === collapsed(await realOrResolved(dir));
}

// Which channel (if any) works in this directory. Used only to make the refusal actionable —
// "that session belongs to #acme" — never to widen what the asking channel may adopt.
async function channelOwningDir(dir) {
  let channels = [];
  try {
    channels = await listChannels();
  } catch {
    return null;
  }
  for (const channel of channels) {
    const work = effectiveWorkDir(channel.slug, channel.meta || {});
    if (await sameDirectory(work, dir)) return channel;
  }
  return null;
}

function channelDisplay(channel) {
  if (!channel) return "";
  const name = channel.meta?.name || channel.name || channel.slug;
  return channel.meta?.isDM ? `a DM (${name})` : `#${String(name).replace(/^#/, "")}`;
}

function shortId(sessionId) {
  return String(sessionId).length > 12 ? `${String(sessionId).slice(0, 8)}…` : String(sessionId);
}

function ago(ms) {
  const delta = Date.now() - ms;
  if (!Number.isFinite(delta) || delta < 0) return "";
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

// Decide whether this thread may adopt the requested session, and say why not in the user's terms.
// Pure decision + lookups: it performs NO writes, so the caller owns session/pool mutation and can
// order it against its own run-safety checks.
//
// `target` is the channel's RuntimeTarget — without it only the daemon's own state dirs are
// searched, which under the container runtime means every live session is invisible.
//
// Returns { ok:true, sessionId, engine, cwd, replacing, message } or { ok:false, message }.
export async function planSessionAdoption({ arg, slug, threadKey, workDir, threadEngine = "", currentSessionId = "", dirs = {}, target = null, log = () => {} }) {
  const parsed = parseResumeRequest(arg);
  if (!parsed) {
    return {
      ok: false,
      message:
        "I couldn't find a session id in that. Paste the command from the 💻 button, or just the id:\n" +
        "```/resume cd \"/path/to/folder\" && claude --resume <session-id>```",
    };
  }
  // Only an EXPLICIT harness in the pasted text can make the request unadoptable. An inherited
  // thread engine is a guess, so a bare id in an OpenCode thread still gets looked up properly.
  if (parsed.engine && !ENGINE_IDS.includes(parsed.engine)) return { ok: false, message: `I don't know the \`${parsed.engine}\` harness, so I can't resume its sessions.` };
  if (parsed.engine && !ADOPTABLE.has(parsed.engine)) {
    return { ok: false, message: `${engineLabel(parsed.engine)} sessions can't be adopted into a thread — it keeps no local transcript I can verify belongs to this channel.` };
  }
  const engine = parsed.engine || (ADOPTABLE.has(threadEngine) ? threadEngine : "claude");

  // When the text named no harness, the thread's engine is only a first guess — Claude and Codex
  // both mint uuids, so a pasted bare id says nothing about who owns it. Try the other adoptable
  // stores before declaring the session missing.
  const lookup = { dirs, target, log };
  let located = await locateSession(engine, parsed.sessionId, lookup);
  let resolvedEngine = engine;
  if (!located && !parsed.engine) {
    for (const candidate of ADOPTABLE) {
      if (candidate === engine) continue;
      located = await locateSession(candidate, parsed.sessionId, lookup);
      if (located) {
        resolvedEngine = candidate;
        break;
      }
    }
  }
  if (!located) {
    // Name the harness the PASTED TEXT named, never the thread's: a `claude --resume` line pasted
    // into a Codex thread used to come back as a missing "Codex session", which sends people
    // hunting for the wrong id. With no harness in the text BOTH stores were searched, so the
    // refusal claims neither.
    const missing = parsed.engine
      ? `${engineLabel(parsed.engine)} session \`${parsed.sessionId}\``
      : `session \`${parsed.sessionId}\` in Claude's or Codex's history`;
    const searched = target?.container ? "this channel's container and the gateway's own history" : "the gateway's own history";
    return {
      ok: false,
      message:
        `I can't find ${missing} — I looked in ${searched}. ` +
        "Check the id, and make sure the session was created in THIS channel: another channel's sessions stay in its own container, and sessions from your laptop aren't here.",
    };
  }

  // ── The same-channel rule ───────────────────────────────────────────────────────────────────
  // The transcript's own recorded cwd is authoritative (a pasted `cd` is just a claim). When the
  // transcript predates cwd recording, fall back to Claude's encoded project-directory name,
  // which still ties the session to a directory — never to trusting the pasted path.
  const sessionCwd = located.cwd;
  const matchesChannel = sessionCwd
    ? await sameDirectory(sessionCwd, workDir)
    : Boolean(located.projectDir) && located.projectDir === claudeProjectDirName(workDir);
  if (!matchesChannel) {
    const owner = sessionCwd ? await channelOwningDir(sessionCwd) : null;
    const where = owner ? ` That folder belongs to ${channelDisplay(owner)} — run \`/resume\` there.` : "";
    return {
      ok: false,
      message:
        `That session was started in ${sessionCwd ? `\`${sessionCwd}\`` : "another folder"}, but this channel works in \`${workDir}\`. ` +
        `A session can only be resumed in the channel that owns its folder.${where}`,
    };
  }
  // A pasted `cd` that disagrees with the transcript means the user copied two different things
  // together; refuse rather than quietly resuming something other than what they read.
  if (parsed.cwd && !(await pastedPathMatches(parsed.cwd, workDir))) {
    return {
      ok: false,
      message: `The \`cd\` in that command points at \`${parsed.cwd}\`, which isn't this channel's folder (\`${workDir}\`). Paste the command exactly as the 💻 button gave it, in the channel it came from.`,
    };
  }

  const bound = sessionBindings(parsed.sessionId, { exceptSlug: slug, exceptThreadKey: threadKey });
  if (bound.length) {
    const elsewhere = bound.some((b) => b.slug !== slug);
    return {
      ok: false,
      message: elsewhere
        ? "That session is already attached to another channel's thread. A session can only live in one place — `/clear` it there first."
        : "That session is already attached to another thread in this channel. Continue it there, or `/clear` that thread first.",
    };
  }

  if (currentSessionId && currentSessionId === parsed.sessionId) {
    return { ok: false, message: `This thread is already continuing session \`${shortId(parsed.sessionId)}\` — just send your next message.` };
  }

  const last = ago(located.lastActivity);
  return {
    ok: true,
    sessionId: parsed.sessionId,
    engine: resolvedEngine,
    cwd: workDir,
    replacing: Boolean(currentSessionId),
    message:
      `🔁 This thread now continues ${engineLabel(resolvedEngine)} session \`${parsed.sessionId}\`` +
      (last ? ` (last active ${last})` : "") +
      `, running in \`${workDir}\`.` +
      (currentSessionId ? " Its previous session was replaced." : "") +
      "\nSend your next message here and I'll pick up where that conversation left off.",
  };
}
