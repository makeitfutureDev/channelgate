// Codex token accounting from rollout JSONL. `turn.completed.usage` is cumulative for the provider
// thread, so it must never be written as one gateway run. Rollouts retain request-level
// `last_token_usage`, the actual model, child ancestry, and fork baselines.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";

const rolloutCache = new Map();
const ZERO = Object.freeze({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 });

const n = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
export function normalizeCodexTokenUsage(value = {}) {
  const details = value.input_tokens_details || value.inputTokensDetails || {};
  const input = n(value.input_tokens ?? value.inputTokens ?? value.prompt_tokens);
  const cached = Math.min(input, n(value.cached_input_tokens ?? value.cachedInputTokens ?? details.cached_tokens ?? details.cachedTokens));
  const write = Math.min(Math.max(0, input - cached), n(value.cache_write_input_tokens ?? value.cacheWriteInputTokens ?? details.cache_write_tokens ?? details.cacheWriteTokens));
  const output = n(value.output_tokens ?? value.outputTokens ?? value.completion_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: n(value.reasoning_output_tokens ?? value.reasoningOutputTokens),
    total_tokens: n(value.total_tokens ?? value.totalTokens) || input + output,
  };
}

export function addCodexTokenUsage(a = ZERO, b = ZERO) {
  const x = normalizeCodexTokenUsage(a);
  const y = normalizeCodexTokenUsage(b);
  return {
    input_tokens: x.input_tokens + y.input_tokens,
    cached_input_tokens: x.cached_input_tokens + y.cached_input_tokens,
    cache_write_input_tokens: x.cache_write_input_tokens + y.cache_write_input_tokens,
    output_tokens: x.output_tokens + y.output_tokens,
    reasoning_output_tokens: x.reasoning_output_tokens + y.reasoning_output_tokens,
    total_tokens: x.input_tokens + y.input_tokens + x.output_tokens + y.output_tokens,
  };
}

export function subtractCodexTokenUsage(total = ZERO, baseline = ZERO) {
  const t = normalizeCodexTokenUsage(total);
  const b = normalizeCodexTokenUsage(baseline);
  return normalizeCodexTokenUsage({
    input_tokens: Math.max(0, t.input_tokens - b.input_tokens),
    cached_input_tokens: Math.max(0, t.cached_input_tokens - b.cached_input_tokens),
    cache_write_input_tokens: Math.max(0, t.cache_write_input_tokens - b.cache_write_input_tokens),
    output_tokens: Math.max(0, t.output_tokens - b.output_tokens),
    reasoning_output_tokens: Math.max(0, t.reasoning_output_tokens - b.reasoning_output_tokens),
  });
}

function usageKey(value) {
  const u = normalizeCodexTokenUsage(value);
  return [u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens, u.output_tokens, u.reasoning_output_tokens].join(":");
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function walkJsonl(dir, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function within(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function indexedRolloutPath(stateDir, sessionId) {
  let names = [];
  try { names = await readdir(stateDir); } catch { return ""; }
  for (const name of names.filter((value) => /^state.*\.sqlite$/.test(value)).sort().reverse()) {
    let db;
    try {
      db = new DatabaseSync(path.join(stateDir, name), { readOnly: true });
      const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ? AND rollout_path IS NOT NULL").get(sessionId);
      const candidate = String(row?.rollout_path || "");
      if (candidate && within(candidate, path.join(stateDir, "sessions"))) return candidate;
    } catch {
      // Older Codex state databases may not have the current threads schema; scan below.
    } finally {
      try { db?.close(); } catch { /* no-op */ }
    }
  }
  return "";
}

export async function findCodexRollout(stateDir, sessionId) {
  const id = String(sessionId || "").trim();
  if (!stateDir || !id) return "";
  const cacheKey = `${path.resolve(stateDir)}:${id}`;
  const cached = rolloutCache.get(cacheKey);
  if (cached) {
    try { await stat(cached); return cached; } catch { rolloutCache.delete(cacheKey); }
  }
  const indexed = await indexedRolloutPath(stateDir, id);
  if (indexed) {
    rolloutCache.set(cacheKey, indexed);
    return indexed;
  }
  const files = await walkJsonl(path.join(stateDir, "sessions"));
  const found = files.find((file) => path.basename(file).includes(id)) || "";
  if (found) rolloutCache.set(cacheKey, found);
  return found;
}

async function readMinimalRollout(file, { start = 0 } = {}) {
  const parsed = { meta: null, tasks: [], tokens: [], lastModel: "", lastTimestamp: "" };
  if (!file) return parsed;
  let index = 0;
  let currentModel = "";
  const input = createReadStream(file, { encoding: "utf8", start: Math.max(0, Number(start) || 0) });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    index += 1;
    if (!line.includes("session_meta") && !line.includes("turn_context") && !line.includes("event_msg")) continue;
    const event = safeJson(line);
    if (!event) continue;
    parsed.lastTimestamp = event.timestamp || parsed.lastTimestamp;
    if (event.type === "session_meta" && !parsed.meta) {
      parsed.meta = { ...(event.payload || {}), timestamp: event.timestamp || "" };
      continue;
    }
    if (event.type === "turn_context") {
      currentModel = String(event.payload?.model || currentModel || "");
      parsed.lastModel = currentModel;
      continue;
    }
    if (event.type !== "event_msg") continue;
    const payload = event.payload || {};
    if (payload.type === "task_started" || payload.type === "task_complete") {
      parsed.tasks.push({
        index,
        type: payload.type,
        turnId: String(payload.turn_id || ""),
        startedAt: n(payload.started_at) * 1000,
        completedAt: n(payload.completed_at) * 1000,
        durationMs: n(payload.duration_ms),
        timestamp: event.timestamp || "",
      });
      continue;
    }
    if (payload.type !== "token_count" || !payload.info?.total_token_usage) continue;
    parsed.tokens.push({
      index,
      timestamp: event.timestamp || "",
      total: normalizeCodexTokenUsage(payload.info.total_token_usage),
      last: normalizeCodexTokenUsage(payload.info.last_token_usage || {}),
      model: currentModel,
      contextWindow: n(payload.info.model_context_window),
    });
  }
  return parsed;
}

function uniqueRequests(nodes) {
  const seen = new Set();
  const requests = [];
  for (const node of nodes) {
    const key = usageKey(node.total);
    if (seen.has(key)) continue; // unchanged terminal token_count replay
    seen.add(key);
    if (node.last.input_tokens || node.last.output_tokens) {
      requests.push({ usage: node.last, model: node.model || "", contextWindow: node.contextWindow || 0 });
    }
  }
  return requests;
}

function sumRequests(requests) {
  return requests.reduce((total, request) => addCodexTokenUsage(total, request.usage), ZERO);
}

function firstOwnTaskIndex(parsed) {
  const metaMs = Date.parse(parsed.meta?.timestamp || "");
  if (!Number.isFinite(metaMs)) return 0;
  // `started_at` is integer seconds while the session metadata retains milliseconds. They describe
  // the same instant, so compare at second precision or every child whose metadata had .001–.999
  // milliseconds would be mistaken for copied parent history.
  return parsed.tasks.find((task) => task.type === "task_started" && task.startedAt >= Math.floor(metaMs / 1_000) * 1_000)?.index || 0;
}

function parentId(meta = {}) {
  return String(
    meta.source?.subagent?.thread_spawn?.parent_thread_id ||
    meta.source?.subagent?.threadSpawn?.parentThreadId ||
    meta.parent_thread_id || meta.parentThreadId || meta.forked_from_id || meta.forkedFromId || "",
  );
}

function sourceKind(meta = {}) {
  if (meta.source?.subagent?.thread_spawn) return "thread_spawn";
  if (meta.source?.subagent) return "subagent";
  return typeof meta.source === "string" ? meta.source : "";
}

// WHO a spawned child is. `codex exec --json` never puts a child's identity on stdout (the spawn
// call and every SubAgentActivity item stay inside the CLI), but the child's OWN rollout opens with
// a `session_meta` that names it: `agent_path` ("/root/sandbox_reviewer"), the CLI's `agent_nickname`
// and the spawn's role. This is the only place that identity exists on the daemon's side of the
// container, so both the live card and the usage ledger read it from here.
function codexChildIdentity(meta = {}) {
  const spawn = meta.source?.subagent?.thread_spawn || meta.source?.subagent?.threadSpawn || {};
  const agentPath = String(meta.agent_path || meta.agentPath || spawn.agent_path || spawn.agentPath || "").trim();
  const nickname = String(meta.agent_nickname || meta.agentNickname || spawn.agent_nickname || spawn.agentNickname || "").trim();
  const role = String(meta.agent_role || meta.agentRole || spawn.agent_role || spawn.agentRole || "").trim();
  const depth = Number(spawn.depth ?? spawn.Depth);
  return {
    // The last path segment is the task name the model chose; nickname/role only stand in when a
    // build stops writing the path.
    name: agentPath.split("/").filter(Boolean).pop() || nickname || role || "",
    nickname,
    agentPath,
    role,
    depth: Number.isFinite(depth) ? depth : 0,
  };
}

// A rollout's `session_meta` is always its FIRST line, so identity costs one line — not the whole
// file. Used while the turn is still running, where reading every child in full would be wasteful.
async function rolloutHeaderMeta(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const event = safeJson(line);
      if (event?.type !== "session_meta") return null;
      return { ...(event.payload || {}), timestamp: event.timestamp || event.payload?.timestamp || "" };
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

// Walk the ancestry map upwards. A child of a child is still this turn's work, and a rollout whose
// parent is missing (rotated away) simply does not descend from the root.
function descendsFrom(header, byId, rootSessionId) {
  const seen = new Set();
  let current = header;
  while (current?.parentId && !seen.has(current.id)) {
    if (current.parentId === rootSessionId) return true;
    seen.add(current.id);
    current = byId.get(current.parentId);
  }
  return false;
}

// Every subagent thread this root turn spawned, by identity only — no token math, one line read per
// candidate rollout. Called WHILE the turn runs so the card can open a row per child the moment the
// parent starts waiting on them; `collectCodexChildAccounting` below closes those rows with metrics.
export async function listCodexChildThreads({ stateDir, rootSessionId, startedAtMs = 0, endedAtMs = Date.now() } = {}) {
  const root = String(rootSessionId || "").trim();
  if (!stateDir || !root) return [];
  const files = await walkJsonl(path.join(stateDir, "sessions"));
  const headers = [];
  for (const file of files) {
    if (startedAtMs) {
      const info = await stat(file).catch(() => null);
      if (!info || info.mtimeMs < startedAtMs - 60_000) continue;
    }
    const meta = await rolloutHeaderMeta(file).catch(() => null);
    if (!meta?.id) continue;
    headers.push({ file, meta, id: String(meta.id), parentId: parentId(meta), startedMs: Date.parse(meta.timestamp || "") });
  }
  const byId = new Map(headers.map((header) => [header.id, header]));
  const out = [];
  for (const header of headers) {
    if (header.id === root || !descendsFrom(header, byId, root)) continue;
    if (Number.isFinite(header.startedMs) && (header.startedMs < startedAtMs - 1_000 || header.startedMs > endedAtMs + 2_000)) continue;
    out.push({
      sessionId: header.id,
      parentSessionId: header.parentId,
      startedAtMs: Number.isFinite(header.startedMs) ? header.startedMs : 0,
      source: sourceKind(header.meta),
      ...codexChildIdentity(header.meta),
    });
  }
  return out.sort((a, b) => a.startedAtMs - b.startedAtMs);
}

export async function snapshotCodexUsage(stateDir, sessionId) {
  const file = await findCodexRollout(stateDir, sessionId);
  if (!file) return { file: "", offset: 0, total: { ...ZERO }, model: "" };
  const parsed = await readMinimalRollout(file);
  const info = await stat(file).catch(() => ({ size: 0 }));
  return {
    file,
    offset: Number(info.size) || 0,
    total: parsed.tokens.at(-1)?.total || { ...ZERO },
    model: parsed.lastModel || "",
  };
}

// Read only bytes appended by the serialized root turn. `turn.completed` remains the terminal
// source of truth; request rows are retained for cache-write and >272K request pricing.
export async function readCodexRootAccounting({ stateDir, sessionId, snapshot = {}, terminalUsage = {}, configuredModel = "", startedAtMs = 0 } = {}) {
  const file = await findCodexRollout(stateDir, sessionId);
  const parsed = await readMinimalRollout(file, { start: file === snapshot.file ? snapshot.offset : 0 });
  const ownStart = parsed.tasks.find((task) => task.type === "task_started" && (!startedAtMs || Math.abs(task.startedAt - startedAtMs) < 10_000));
  const nodes = ownStart ? parsed.tokens.filter((token) => token.index > ownStart.index) : parsed.tokens;
  const requests = uniqueRequests(nodes).map((request) => ({ ...request, model: request.model || configuredModel }));
  const terminal = normalizeCodexTokenUsage(terminalUsage);
  const requestTotal = sumRequests(requests);
  const cumulativeDelta = subtractCodexTokenUsage(terminal, snapshot.total || ZERO);
  const cumulativeMatch = usageKey(cumulativeDelta) === usageKey(requestTotal);
  const perTurnMatch = usageKey(terminal) === usageKey(requestTotal);
  // Current Codex emits a thread-cumulative terminal counter. If a future CLI returns per-turn
  // usage instead, the request chain proves that shape and prevents subtracting an older baseline.
  const delta = !cumulativeMatch && perTurnMatch ? terminal : cumulativeDelta;
  const requestMatch = cumulativeMatch || perTurnMatch;
  return {
    usage: delta,
    requests: requestMatch ? requests : [],
    model: parsed.lastModel || configuredModel || snapshot.model || "",
    exactRequests: requestMatch,
    sessionId,
    sourceId: `codex-turn:${sessionId}:${Math.floor(startedAtMs / 1000)}`,
    startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : "",
    endedAt: parsed.lastTimestamp || new Date().toISOString(),
  };
}

async function rolloutHeaders(stateDir, { sinceMs = 0 } = {}) {
  const files = await walkJsonl(path.join(stateDir, "sessions"));
  const headers = [];
  for (const file of files) {
    if (sinceMs) {
      const info = await stat(file).catch(() => null);
      if (!info || info.mtimeMs < sinceMs - 60_000) continue;
    }
    let parsed;
    try { parsed = await readMinimalRollout(file); } catch { continue; }
    if (!parsed.meta?.id) continue;
    headers.push({ file, parsed, id: String(parsed.meta.id), parentId: parentId(parsed.meta), startedMs: Date.parse(parsed.meta.timestamp || "") });
  }
  return headers;
}

// Native children copy the parent's rollout prefix. Charge only counters after the child's own
// task boundary, and attach every descendant created during this root turn.
export async function collectCodexChildAccounting({ stateDir, rootSessionId, startedAtMs = 0, endedAtMs = Date.now() } = {}) {
  if (!stateDir || !rootSessionId) return [];
  const headers = await rolloutHeaders(stateDir, { sinceMs: startedAtMs });
  const byId = new Map(headers.map((header) => [header.id, header]));
  const out = [];
  for (const header of headers) {
    if (!Number.isFinite(header.startedMs) || header.startedMs < startedAtMs - 1_000 || header.startedMs > endedAtMs + 2_000) continue;
    if (!descendsFrom(header, byId, String(rootSessionId))) continue;
    const boundary = firstOwnTaskIndex(header.parsed);
    if (!boundary) continue;
    const before = header.parsed.tokens.filter((token) => token.index < boundary).at(-1)?.total || ZERO;
    const afterNodes = header.parsed.tokens.filter((token) => token.index > boundary);
    const final = afterNodes.at(-1)?.total || before;
    const requests = uniqueRequests(afterNodes).map((request) => ({ ...request, model: request.model || header.parsed.lastModel || "" }));
    const usage = subtractCodexTokenUsage(final, before);
    const requestMatch = usageKey(usage) === usageKey(sumRequests(requests));
    const completed = header.parsed.tasks.filter((task) => task.type === "task_complete" && task.index > boundary).at(-1);
    out.push({
      usage,
      requests: requestMatch ? requests : [],
      exactRequests: requestMatch,
      model: requests.at(-1)?.model || header.parsed.lastModel || "",
      sessionId: header.id,
      parentSessionId: header.parentId,
      source: sourceKind(header.parsed.meta),
      // Identity travels with the accounting so the card can close each child's row by NAME.
      ...codexChildIdentity(header.parsed.meta),
      sourceId: `codex-child:${header.id}`,
      startedAt: new Date(header.startedMs).toISOString(),
      endedAt: completed?.timestamp || header.parsed.lastTimestamp || new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, Date.parse(completed?.timestamp || header.parsed.lastTimestamp || "") - header.startedMs) || null,
    });
  }
  return out;
}

// Historical repair consumes the same minimized representation and branch metadata.
export async function parseCodexRollout(file) {
  return readMinimalRollout(file);
}

export async function listCodexRollouts(stateDir) {
  return walkJsonl(path.join(stateDir, "sessions"));
}

export const codexUsageKey = usageKey;
export const codexParentId = parentId;
export const codexFirstOwnTaskIndex = firstOwnTaskIndex;
