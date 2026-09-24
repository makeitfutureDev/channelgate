// Claude Code transcript accounting — the Claude twin of ../engines/codex-usage.js.
//
// Claude Code writes one JSONL transcript per session under `<state dir>/projects/<encoded cwd>/
// <session id>.jsonl`, and every assistant record carries the API `usage` block and the model that
// answered. That file is the ONLY durable record of a session the gateway did not launch itself —
// a terminal `claude`, the VS Code extension, the desktop app, or an SSH/VS Code session inside a
// channel container — which is what makes this module the source for ../gateway/external-usage.js.
//
// Two hard constraints shape it:
//
//  1. NO imports beyond node: builtins. The same file is shipped verbatim as inline module source
//     into a channel container (runtime `inspectUsage`, exactly as createCodexUsageReader does) so
//     the side that OWNS the rootless HOME volume does the reading. A single project import would
//     break that, because the container has no checkout.
//  2. It PARSES and AGGREGATES; it never prices. Rates live in ../config/settings.js on the daemon
//     side, so a container never has to know them and a rate change never needs a new image.
//
// Aggregation granularity is (session, UTC hour, model): fine enough for the dashboard's hour
// buckets, coarse enough that a year of transcripts is a few thousand rows.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

// Transcript records can be megabytes (a large tool result is one line), and a scan walks every
// session in a state dir. Lines above this are counted and skipped rather than parsed: a usage
// record is small, so an oversized line is never one.
const MAX_LINE_BYTES = 2_000_000;

const num = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

// Where a session was driven from. Claude Code stamps `entrypoint` on its records; the values below
// are the ones it emits. "sdk-cli" is the headless `claude -p` the gateway itself uses, so it is
// NEVER evidence of an outside session on its own — external-usage.js decides that by session id
// and only uses this label to say HOW an outside session was driven.
const ENTRYPOINT_ORIGIN = {
  cli: "terminal",
  "claude-vscode": "vscode",
  "claude-desktop": "desktop",
  "sdk-cli": "headless",
};

export function claudeOriginFor(entrypoint) {
  return ENTRYPOINT_ORIGIN[String(entrypoint || "")] || "other";
}

// The five token classes Anthropic prices separately. `input_tokens` is the fresh, uncached part;
// cache reads and the two cache-write TTLs are disjoint from it and from each other, so they sum to
// the full input side. The 5m/1h split lives in `usage.cache_creation`; when a transcript predates
// that field, everything falls back to the 5-minute rate — the cheaper write, so an estimate can
// only understate, never invent spend.
export function normalizeClaudeTokenUsage(value = {}) {
  const creation = value.cache_creation || value.cacheCreation || {};
  const writesTotal = num(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens);
  const write1h = Math.min(writesTotal, num(creation.ephemeral_1h_input_tokens ?? creation.ephemeral1hInputTokens));
  const write5mField = num(creation.ephemeral_5m_input_tokens ?? creation.ephemeral5mInputTokens);
  // Trust the split only when it accounts for the reported total; otherwise put the remainder on 5m.
  const write5m = write1h + write5mField === writesTotal ? write5mField : Math.max(0, writesTotal - write1h);
  return {
    input_tokens: num(value.input_tokens ?? value.inputTokens),
    cached_input_tokens: num(value.cache_read_input_tokens ?? value.cacheReadInputTokens),
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    output_tokens: num(value.output_tokens ?? value.outputTokens),
  };
}

export function addClaudeTokenUsage(a, b) {
  return {
    input_tokens: num(a?.input_tokens) + num(b?.input_tokens),
    cached_input_tokens: num(a?.cached_input_tokens) + num(b?.cached_input_tokens),
    cache_write_5m_tokens: num(a?.cache_write_5m_tokens) + num(b?.cache_write_5m_tokens),
    cache_write_1h_tokens: num(a?.cache_write_1h_tokens) + num(b?.cache_write_1h_tokens),
    output_tokens: num(a?.output_tokens) + num(b?.output_tokens),
  };
}

const emptyUsage = () => ({ input_tokens: 0, cached_input_tokens: 0, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, output_tokens: 0 });

// A model id as Anthropic bills it. Claude Code echoes the API id (`claude-opus-5`,
// `claude-haiku-4-5-20251001`); the gateway's own CONFIGURED ids can carry a `[1m]` context suffix,
// which is a request option and not a separate price. A dated snapshot keeps the family's rate, so
// the trailing date is dropped — but only when it really is a date, because `claude-opus-4-5` is a
// version, not a snapshot of `claude-opus-4`.
export function claudeBillingModel(model) {
  const raw = String(model || "").trim().toLowerCase().replace(/\[[^\]]*\]/g, "");
  if (!raw) return "";
  return raw.replace(/-(\d{8}|\d{4}(?:-\d{2}){2})$/, "");
}

// A usage-bearing assistant record. `<synthetic>` is Claude Code's placeholder for a local error
// reply that never reached the API, so it carries no spend and is dropped rather than counted at an
// unknown rate.
function assistantUsage(record) {
  if (record?.type !== "assistant") return null;
  const message = record.message;
  if (!message || typeof message !== "object" || !message.usage) return null;
  const model = String(message.model || "");
  if (!model || model === "<synthetic>") return null;
  return { model, usage: normalizeClaudeTokenUsage(message.usage), request: requestKey(record) };
}

// ONE API response can be written as SEVERAL assistant records — one per content block, each with
// its own `uuid` and `apiBlockIndex` but the SAME `requestId`, `message.id` and, critically, the
// same `usage` object. Summing the records therefore bills a single request two or three times.
//
// This is not a theoretical concern: measured against the 52 sessions where Claude Code recorded
// its OWN final cost, counting per record overstated the total by 21% in aggregate and by up to 3x
// on individual sessions. Counting per request instead brings it onto Claude Code's own figure.
//
// `requestId` is the identity to use; `message.id` covers transcripts that predate it, and a record
// with neither falls back to its own uuid (counted once, which is the old behaviour for that row).
function requestKey(record) {
  return String(record?.requestId || record?.message?.id || record?.uuid || "");
}

// A top-level turn: a human prompt, not a tool result and not a subagent's prompt. Counting these
// is what makes an outside session's "turns" comparable with a gateway run on the same chart.
function isUserTurn(record) {
  if (record?.type !== "user" || record.isSidechain === true || record.isMeta === true) return false;
  if (record.toolUseResult !== undefined) return false;
  const content = record.message?.content;
  if (Array.isArray(content)) return content.some((block) => block && block.type !== "tool_result");
  return typeof content === "string" ? Boolean(content.trim()) : Boolean(content);
}

const hourBucket = (iso) => {
  const ms = Date.parse(String(iso || ""));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 13) : "";
};

/**
 * Read ONE transcript into per-(hour, model) aggregates.
 *
 * Returns `{ sessionId, cwd, origin, entrypoint, version, firstTs, lastTs, buckets: [...] }`, where
 * every bucket is `{ bucket, model, requests, turns, usage }`. `requests` counts API calls (each
 * usage-bearing assistant record, subagents included, because their spend is real); `turns` counts
 * only top-level human prompts, and is attributed to the bucket the prompt itself landed in.
 */
export async function scanClaudeTranscript(file, { sessionId = "" } = {}) {
  const buckets = new Map();
  const result = {
    file,
    sessionId: sessionId || path.basename(file).replace(/\.jsonl$/, ""),
    cwd: "",
    entrypoint: "",
    origin: "other",
    version: "",
    firstTs: "",
    lastTs: "",
    requests: 0,
    turns: 0,
    skippedLines: 0,
    duplicateBlocks: 0,
    buckets: [],
  };
  // Request identities already billed in this transcript (see requestKey).
  const seenRequests = new Set();
  const bump = (bucket, model) => {
    const key = `${bucket} ${model}`;
    let row = buckets.get(key);
    if (!row) {
      row = { bucket, model, requests: 0, turns: 0, usage: emptyUsage() };
      buckets.set(key, row);
    }
    return row;
  };
  let stream;
  try {
    stream = createReadStream(file, { encoding: "utf8" });
  } catch {
    return result;
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || line.length > MAX_LINE_BYTES) {
        if (line) result.skippedLines += 1;
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        result.skippedLines += 1;
        continue;
      }
      if (typeof record?.cwd === "string" && record.cwd && !result.cwd) result.cwd = record.cwd;
      if (typeof record?.entrypoint === "string" && record.entrypoint) result.entrypoint = record.entrypoint;
      if (typeof record?.version === "string" && record.version) result.version = record.version;
      const ts = typeof record?.timestamp === "string" ? record.timestamp : "";
      if (ts) {
        if (!result.firstTs || ts < result.firstTs) result.firstTs = ts;
        if (ts > result.lastTs) result.lastTs = ts;
      }
      const bucket = hourBucket(ts);
      if (!bucket) continue;
      if (isUserTurn(record)) {
        bump(bucket, "").turns += 1;
        result.turns += 1;
        continue;
      }
      const priced = assistantUsage(record);
      if (!priced) continue;
      // Every block of one response repeats the same usage; the first block is the one that pays.
      if (priced.request && seenRequests.has(priced.request)) {
        result.duplicateBlocks += 1;
        continue;
      }
      if (priced.request) seenRequests.add(priced.request);
      const row = bump(bucket, claudeBillingModel(priced.model));
      row.requests += 1;
      row.usage = addClaudeTokenUsage(row.usage, priced.usage);
      result.requests += 1;
    }
  } catch {
    // A truncated or unreadable transcript still contributes whatever it yielded before the fault:
    // dropping the whole session would understate spend that definitely happened.
  } finally {
    lines.close();
    stream.destroy?.();
  }
  result.origin = claudeOriginFor(result.entrypoint);
  // A turn-only bucket (a prompt whose answer landed in the next hour) keeps its empty model key so
  // the caller can fold the turn count in without inventing a model.
  result.buckets = [...buckets.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : a.model.localeCompare(b.model)));
  return result;
}

/** Every transcript under a Claude state dir, newest activity first, with size + mtime for the
 *  incremental scan. `projects/` is the only tree Claude Code writes sessions into. */
export async function listClaudeTranscripts(stateDir) {
  const root = path.join(String(stateDir || ""), "projects");
  let projects = [];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry.name);
      try {
        const info = await stat(file);
        out.push({ file, sessionId: entry.name.slice(0, -6), project: project.name, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        /* vanished between readdir and stat — nothing to scan */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Scan a whole state dir. `known` is a map of `sessionId -> { size, mtimeMs }` from the last scan;
 * an unchanged file is reported as `unchanged` and never reopened, which is what keeps a scan over
 * a thousand sessions cheap enough to run hourly.
 *
 * `skipSessions` drops a session before it is opened at all — external-usage.js passes the
 * gateway's own session ids there, so a gateway transcript is never even read.
 */
export async function scanClaudeState(stateDir, { known = {}, skipSessions = [], limit = 0, sinceMs = 0 } = {}) {
  const skip = new Set(skipSessions);
  const files = await listClaudeTranscripts(stateDir);
  const sessions = [];
  const unchanged = [];
  const skipped = [];
  let scanned = 0;
  for (const entry of files) {
    if (sinceMs && entry.mtimeMs < sinceMs) continue;
    if (skip.has(entry.sessionId)) {
      skipped.push(entry.sessionId);
      continue;
    }
    const seen = known[entry.sessionId];
    if (seen && Number(seen.size) === entry.size && Number(seen.mtimeMs) === Math.trunc(entry.mtimeMs)) {
      unchanged.push(entry.sessionId);
      continue;
    }
    if (limit && scanned >= limit) break;
    scanned += 1;
    const parsed = await scanClaudeTranscript(entry.file, { sessionId: entry.sessionId });
    sessions.push({ ...parsed, project: entry.project, size: entry.size, mtimeMs: Math.trunc(entry.mtimeMs) });
  }
  return { stateDir, sessions, unchanged, skipped, total: files.length, truncated: Boolean(limit) && scanned >= limit };
}

// The container half's entry point, mirroring reduceCodexUsage: one operation switch the inline
// module source dispatches on, so the daemon and the container run byte-identical parsing.
export async function reduceClaudeUsage({ operation, ...args } = {}) {
  if (!args.stateDir) throw new Error("Claude state directory is required");
  switch (operation) {
    case "list": return listClaudeTranscripts(args.stateDir);
    case "scan": return scanClaudeState(args.stateDir, args);
    default: throw new Error("unknown Claude usage inspection");
  }
}
