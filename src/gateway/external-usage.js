// Usage the gateway never launched.
//
// The ledger in ./usage.js only knows runs that went through a conversation. But the same two
// engines, on the same machine, under the same billing account, are also driven by hand: a terminal
// `claude` or `codex` in a channel's work folder, the VS Code extension, the desktop apps, and —
// since SSH access and the VS Code lease — sessions INSIDE a channel container. That spend is
// invisible to every chart the gateway draws, which makes the dashboard's total quietly wrong as an
// answer to "what are we spending".
//
// Both CLIs already keep the evidence: Claude Code writes a transcript per session, Codex a rollout
// per thread, each carrying the model, the token counts, the working directory and the client that
// drove it. This module reads those, subtracts everything the gateway itself launched, prices what
// is left, and stores it in `external_usage` for the dashboard to read alongside the ledger.
//
// Three rules keep the numbers honest:
//
//  1. **Nothing is counted twice.** Whose session a transcript belongs to is decided by
//     sessionAttribution() below — by id where the ledger can name one, and otherwise by the places
//     only the gateway runs in. That is what lets the scan read a machine's WHOLE history instead
//     of only what happened after session ids started being recorded.
//  2. **The gateway's own housekeeping is not "outside" usage.** A session whose cwd is inside the
//     runtime root (the Claude token-relay turn, update smokes) is gateway machinery, not someone
//     working by hand, and is dropped.
//  3. **How a session was driven is reported, never inferred into certainty.** `origin` comes from
//     the client's own stamp (Claude's `entrypoint`, Codex's `originator`). A headless invocation
//     looks exactly like the gateway's own, so outside the places the gateway runs it lands under
//     `headless` and says so, rather than being presented as a person at a keyboard.
//
// Container scopes are read through the runtime's read-only `inspectUsage`, the same door
// createCodexUsageReader uses, and ONLY for a container that is already running — a usage scan must
// never start a container, take a lease, or make a turn wait behind it.
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getDb, metaGet, metaSet } from "../db/index.js";
import { cleanWorkspaceFolder, gatewayRoot, workspaceFolder } from "../config/paths.js";
import { getClaudeModelRates, getCodexModelRates } from "../config/settings.js";
import { listChannels } from "../config/store.js";
import { countDrop } from "../util/drops.js";
import { logEvent } from "../util/logger.js";
import { claudeStateDir, codexStateDir } from "./session-adopt.js";
import { scanClaudeState, claudeBillingModel } from "./claude-usage.js";
import { scanCodexState } from "../engines/codex-usage.js";
import { resolveRuntime } from "../runtimes/resolve.js";

export const EXTERNAL_SCAN_INTERVAL_MS = 60 * 60_000;
// A first scan on a long-lived machine can face thousands of transcripts. The cap bounds ONE pass,
// not the backlog: unscanned files keep their place and the next pass continues, because
// `external_usage_files` only bookmarks what was actually read.
export const EXTERNAL_SCAN_FILE_LIMIT = 400;

const num = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

// ── pricing ─────────────────────────────────────────────────────────────────────────────────────
// Claude Code reports a real dollar cost for the runs the gateway launches; a transcript does not,
// so outside Claude usage is priced from the rate table in ../config/settings.js. Every token class
// Anthropic bills separately is priced separately — a chart that multiplied total input tokens by
// the base rate would overstate a cache-heavy agent session several times over.
export function priceClaudeTokens(usage = {}, model = "", rates = getClaudeModelRates()) {
  const rate = rates[claudeBillingModel(model)];
  if (!rate) return null;
  const cost =
    num(usage.input_tokens) * rate.input +
    num(usage.cached_input_tokens) * rate.cacheRead +
    num(usage.cache_write_5m_tokens) * rate.cacheWrite5m +
    num(usage.cache_write_1h_tokens) * rate.cacheWrite1h +
    num(usage.output_tokens) * rate.output;
  return Number((cost / 1_000_000).toFixed(6));
}

// Codex prices the same way the ledger already does, minus the per-request long-context uplift: an
// hour bucket is an aggregate of many requests and the >272K premium is defined per request, so
// applying it to the sum would invent spend. estimateCodexCost makes the same choice for a turn
// aggregate without request detail.
export function priceCodexTokens(usage = {}, model = "", rates = getCodexModelRates()) {
  const key = String(model || "").toLowerCase();
  const rate = rates[key] || rates[Object.keys(rates).filter((k) => key.startsWith(`${k}-`) && /^\d{4}(?:-\d{2}){1,2}$/.test(key.slice(k.length + 1))).sort((a, b) => b.length - a.length)[0]];
  if (!rate || !(rate.input > 0 || rate.output > 0)) return null;
  const cached = Math.min(num(usage.cached_input_tokens), num(usage.input_tokens));
  const cacheWrite = Math.min(num(usage.cache_write_input_tokens), Math.max(0, num(usage.input_tokens) - cached));
  const uncached = Math.max(0, num(usage.input_tokens) - cached - cacheWrite);
  const cost = uncached * rate.input + cached * rate.cachedInput + cacheWrite * rate.input * 1.25 + num(usage.output_tokens) * rate.output;
  return Number((cost / 1_000_000).toFixed(6));
}

// The two engines report their token classes under different names; the dashboard stores one shape.
function tokenColumns(engine, usage = {}) {
  if (engine === "codex") {
    return {
      tokens_in: num(usage.input_tokens),
      tokens_cached: num(usage.cached_input_tokens),
      tokens_cache_write: num(usage.cache_write_input_tokens),
      tokens_out: num(usage.output_tokens),
    };
  }
  // Claude's `input_tokens` is the fresh part only, so the full input side is the sum — the same
  // definition normalizeUsage() uses for a ledger row, which is what keeps the two comparable.
  const cached = num(usage.cached_input_tokens);
  const writes = num(usage.cache_write_5m_tokens) + num(usage.cache_write_1h_tokens);
  return {
    tokens_in: num(usage.input_tokens) + cached + writes,
    tokens_cached: cached,
    tokens_cache_write: writes,
    tokens_out: num(usage.output_tokens),
  };
}

// ── how far back the answer reaches ─────────────────────────────────────────────────────────────
// The scan reads ALL of a machine's history by default. It can only do that because a session the
// gateway ran is recognised even when the ledger cannot name it by id (sessionAttribution below);
// without that, every rotated-out gateway session on disk would be reported as somebody working
// outside the gateway — measured at $82 on the development deployment.
//
// `CHANNELGATE_EXTERNAL_USAGE_SINCE` (an ISO date) limits the window for an operator who wants
// only recent history — a smaller first pass on a machine with years of transcripts, or a
// deliberate cutoff. The first pass also records when tracking began, which the Overview shows so
// a freshly installed gateway does not read its own short history as "nobody works outside chat".
const EXTERNAL_SINCE_KEY = "external_usage_first_scan";

// `create: false` makes this a pure read (null before the first pass), so the admin API can report
// it without a GET quietly writing to the database.
export function externalTrackingSince({ now = Date.now(), create = true } = {}) {
  const override = Date.parse(String(process.env.CHANNELGATE_EXTERNAL_USAGE_SINCE || ""));
  if (Number.isFinite(override)) return override;
  if (create && !metaGet(EXTERNAL_SINCE_KEY)) metaSet(EXTERNAL_SINCE_KEY, new Date(now).toISOString());
  return 0; // all history
}

// When the first pass ran — reported beside the figures, never used to filter them.
export function externalTrackingStartedAt() {
  const stored = metaGet(EXTERNAL_SINCE_KEY);
  return stored ? String(stored) : "";
}

// ── when a deployment has to reprocess what it already stored ───────────────────────────────────
// A pass never re-reads a transcript it has already bookmarked, which is what keeps the hourly scan
// cheap — and also what would freeze a wrong answer in place forever. Two things invalidate stored
// rows without any transcript changing:
//
//   * The SCANNER itself. The per-request de-duplication fix, for instance, moved every stored
//     Claude figure by up to 3x. A gateway that had already scanned would have kept the old numbers
//     indefinitely, because every file was bookmarked as read.
//   * The RATE tables. Outside usage is priced from them, so editing one restates every row.
//
// So a pass compares a fingerprint of both against the one it last completed, and on a mismatch
// forgets its bookmarks ONCE — the ordinary incremental machinery then re-reads everything over the
// next few passes, replacing each session's rows as it goes. Bump EXTERNAL_SCAN_LOGIC_VERSION in
// the same commit as any change to what the scanners extract or how a session is attributed;
// deployments then reprocess themselves on their first pass after the update, with no operator step.
export const EXTERNAL_SCAN_LOGIC_VERSION = 2;
const EXTERNAL_LOGIC_KEY = "external_usage_logic";

export function externalScanFingerprint() {
  const rates = JSON.stringify({ claude: getClaudeModelRates(), codex: getCodexModelRates() });
  return `v${EXTERNAL_SCAN_LOGIC_VERSION}:${createHash("sha256").update(rates).digest("hex").slice(0, 16)}`;
}

// Returns the reason a reprocess is due, or "" when the stored rows are still current.
export function externalScanStaleReason(db = getDb()) {
  const stored = String(metaGet(EXTERNAL_LOGIC_KEY) || "");
  if (!stored) {
    // No fingerprint at all. On a gateway that has never scanned, the first pass reads everything
    // anyway. On one that HAS, the rows were written by a build from before this marker existed —
    // which is exactly the build whose Claude figures were up to 3x high — so they are reprocessed
    // rather than trusted. A gateway already holding correct rows simply recomputes the same ones.
    try {
      return db.prepare("SELECT 1 FROM external_usage_files LIMIT 1").get() ? "scanned by an earlier build" : "";
    } catch {
      return "";
    }
  }
  const current = externalScanFingerprint();
  if (stored === current) return "";
  return stored.split(":")[0] !== current.split(":")[0] ? "scanner updated" : "model rates changed";
}

// Forget every bookmark so the next passes re-read the lot. The fingerprint is stamped at the same
// time: a restart (or a truncated pass) must continue draining the backlog, not start it over.
function forgetBookmarks(db, reason) {
  db.prepare("DELETE FROM external_usage_files").run();
  metaSet(EXTERNAL_LOGIC_KEY, externalScanFingerprint());
  return reason;
}

// ── whose session is this? ──────────────────────────────────────────────────────────────────────
// The one question the whole feature rests on, because getting it wrong in either direction is
// worse than not answering: count a gateway session as outside work and the chart invents spend
// nobody chose to make; miss a real outside session and the total under-reports.
//
// An id recorded in the ledger is proof. Everything else is a place argument — and the places the
// gateway runs in are ones a person does not drive an engine from by hand:
//
//   * Inside a channel CONTAINER, the only thing that ever runs an engine headlessly is the
//     gateway: interactive work there arrives over SSH or the VS Code lease, and stamps itself
//     `cli` / `claude-vscode` accordingly.
//   * On the host, a headless session whose working directory is a channel's own folder (or the
//     gateway runtime root — the Claude token-relay turn, update smokes) is a gateway run whose
//     session row has since rotated out of `sessions`.
//
// The residual error is a person's OWN scripted `claude -p` / `codex exec` inside a channel folder,
// which is read as the gateway's. That is the direction to err in: it understates outside usage
// rather than charging the operator for spend the gateway itself made. Interactive work in a
// channel folder is unaffected — it is not headless.
//
// Measured across the development deployment's full history: 725 of 1,146 Claude transcripts and
// 1,085 of 1,404 Codex rollouts identified by id; 223 and 122 more recovered by folder; 81 and 163
// genuinely interactive outside sessions left standing.
export const SESSION_OWNERS = ["gateway", "outside"];

export function sessionAttribution(session = {}, { knownIds = new Set(), index = [], scope = "host" } = {}) {
  const id = String(session.sessionId || "");
  const parent = String(session.parentSessionId || "");
  const root = String(session.rootSessionId || "");
  if (id && knownIds.has(id)) return { owner: "gateway", reason: "session-id" };
  if (root && root !== id && knownIds.has(root)) return { owner: "gateway", reason: "root-session-id" };
  // A subagent's spend already belongs to the run that spawned it.
  if (parent && knownIds.has(parent)) return { owner: "gateway", reason: "parent-session-id" };
  if (isGatewayInternalCwd(session.cwd)) return { owner: "gateway", reason: "gateway-runtime-folder" };
  if (session.origin === "headless") {
    if (scope === "container") return { owner: "gateway", reason: "headless-in-channel-container" };
    if (matchWorkdir(session.cwd, index)) return { owner: "gateway", reason: "headless-in-channel-folder" };
  }
  return { owner: "outside", reason: session.origin || "other" };
}

// ── what the gateway itself ran ─────────────────────────────────────────────────────────────────
/**
 * Every engine session id the gateway is known to have driven. `slug` narrows it to one channel,
 * which is what keeps a container scan's exclusion list small enough to hand across the runtime
 * boundary as an argument.
 *
 * Three sources, because no single one is complete: the ledger's own `session_id` (exact, but only
 * since schema 28), the live thread bindings (current sessions, including ones that predate the
 * column), and Codex's component rows (a run's provider thread and its subagents' parents).
 */
export function gatewaySessionIds({ slug = "" } = {}) {
  const db = getDb();
  const ids = new Set();
  const add = (rows) => { for (const row of rows) if (row.session_id) ids.add(String(row.session_id)); };
  try {
    add(slug
      ? db.prepare("SELECT DISTINCT session_id FROM usage WHERE session_id <> '' AND slug = ?").all(slug)
      : db.prepare("SELECT DISTINCT session_id FROM usage WHERE session_id <> ''").all());
    add(slug
      ? db.prepare("SELECT DISTINCT session_id FROM sessions WHERE slug = ?").all(slug)
      : db.prepare("SELECT DISTINCT session_id FROM sessions").all());
    for (const column of ["provider_session_id", "parent_provider_session_id"]) {
      const rows = slug
        ? db.prepare(`SELECT DISTINCT ${column} AS session_id FROM usage_components c JOIN usage u ON u.id = c.usage_id WHERE ${column} <> '' AND u.slug = ?`).all(slug)
        : db.prepare(`SELECT DISTINCT ${column} AS session_id FROM usage_components WHERE ${column} <> ''`).all();
      add(rows);
    }
  } catch {
    // A missing column means a database older than schema 28 — the scan still runs, it just has a
    // smaller exclusion set. Returning nothing here would be worse: everything would look external.
  }
  return ids;
}

// ── where a session was working ─────────────────────────────────────────────────────────────────
// Outside work done INSIDE a channel's folder belongs on that channel's row; work anywhere else has
// no conversation to charge and stays in the totals only. Longest match wins so a nested folder is
// not claimed by its parent channel.
export function buildWorkdirIndex(channels = []) {
  const entries = [];
  const seen = new Set();
  const add = (dir, slug, channelId) => {
    if (!dir || !path.isAbsolute(dir)) return;
    const resolved = path.resolve(dir);
    const key = `${resolved}\u0000${slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ dir: resolved, slug, channelId });
  };
  for (const channel of channels) {
    const slug = String(channel?.slug || "");
    if (!slug) continue;
    const meta = channelMeta(channel);
    const channelId = String(channel?.channelId || channel?.id || "");
    // Every folder this channel has ever run in, deliberately NOT via effectiveWorkDir(): that
    // applies a containment check answering "where may a run happen NOW", and this index answers
    // "where has the gateway already run". A channel whose custom folder was later put out of
    // bounds (or whose allowed root was tightened) would otherwise have its whole history
    // reclassified as somebody working outside the gateway — and effectiveWorkDir would log a
    // warning for each such channel on every hourly pass. Read-only either way: nothing here
    // widens where anything is allowed to run.
    add(String(meta.workDir || "").trim(), slug, channelId);
    try {
      add(workspaceFolder(slug, meta.platform), slug, channelId);
      // Clean turns run in a bare workspace of their own, which is still the gateway running.
      add(cleanWorkspaceFolder(slug, meta.platform), slug, channelId);
    } catch {
      /* no folder resolvable for this platform */
    }
  }
  // Longest first, so a nested channel folder is never claimed by the one above it.
  return entries.sort((a, b) => b.dir.length - a.dir.length);
}

// listChannels() returns the index entry and the stored meta side by side, and `platform` can live
// on either. One reader so every consumer here sees the same effective meta.
function channelMeta(channel = {}) {
  const meta = channel.meta || {};
  return { ...meta, platform: meta.platform || channel.platform || "" };
}

export function matchWorkdir(cwd, index = []) {
  const target = path.resolve(String(cwd || ""));
  if (!target || target === ".") return null;
  return index.find((entry) => target === entry.dir || target.startsWith(`${entry.dir}${path.sep}`)) || null;
}

// The gateway's own machinery is not someone working by hand. Anything under the runtime root (the
// token-relay turn, update smokes, engine-state scratch) is dropped rather than reported as spend a
// person chose to make.
function isGatewayInternalCwd(cwd) {
  const root = path.resolve(gatewayRoot());
  const target = path.resolve(String(cwd || ""));
  return Boolean(cwd) && (target === root || target.startsWith(`${root}${path.sep}`));
}

// A turn is recorded in the hour its PROMPT landed, which is not necessarily the hour (or the
// model) its answer was billed in — so both scanners park turn counts on a model-less row. Left
// that way they would count toward the dashboard's totals while belonging to no band, and the
// stacked Runs chart would quietly sum to less than the number above it.
//
// So each turn is folded onto the model that did the most work in its own hour, or failing that in
// the nearest later hour. A session with no billed model at all (a turn interrupted before its
// first API call) contributes no turn: nothing was spent, so there is nothing to attribute.
export function foldTurnsIntoModels(buckets = []) {
  const rows = buckets.map((b) => ({ ...b, usage: { ...b.usage } }));
  const withModel = rows.filter((b) => b.model);
  const dominantAt = (bucket) => {
    const sameHour = withModel.filter((b) => b.bucket === bucket);
    const candidates = sameHour.length ? sameHour : withModel.filter((b) => b.bucket > bucket);
    let best = null;
    for (const row of candidates) {
      const output = num(row.usage?.output_tokens);
      if (!best || output > num(best.usage?.output_tokens) || (output === num(best.usage?.output_tokens) && row.bucket < best.bucket)) best = row;
    }
    return best;
  };
  for (const row of rows) {
    if (row.model || !row.turns) continue;
    const target = dominantAt(row.bucket);
    if (target) target.turns += row.turns;
    row.turns = 0;
  }
  return rows.filter((row) => row.model || row.requests > 0 || row.turns > 0);
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────────
// A session's rows are replaced wholesale on every rescan, because a transcript only ever grows:
// re-reading it yields the same buckets plus new ones, and an UPSERT per bucket would leave a stale
// row behind if a bucket ever disappeared (a truncated or rewritten transcript).
export function saveScopeSessions(db, { scope, scopeKey, engine, sessions, index, knownIds = new Set(), sinceMs = 0, now = Date.now() }) {
  // With CHANNELGATE_EXTERNAL_USAGE_SINCE set, a session that spans the cutoff would otherwise drag
  // its earlier hours in with it. Bucket keys are UTC-hour strings, so the limit is a string
  // comparison. Unset (the default) this is empty and the whole history is kept.
  const sinceBucket = sinceMs ? new Date(sinceMs).toISOString().slice(0, 13) : "";
  const deleteRows = db.prepare("DELETE FROM external_usage WHERE scope = ? AND scope_key = ? AND engine = ? AND session_id = ?");
  const insertRow = db.prepare(
    `INSERT INTO external_usage(scope, scope_key, engine, session_id, bucket, model, origin, cwd, channel_id, slug,
       turns, requests, tokens_in, tokens_cached, tokens_cache_write, tokens_out, cost_usd, cost_estimated, updated_ms)
     VALUES(@scope, @scope_key, @engine, @session_id, @bucket, @model, @origin, @cwd, @channel_id, @slug,
       @turns, @requests, @tokens_in, @tokens_cached, @tokens_cache_write, @tokens_out, @cost_usd, @cost_estimated, @updated_ms)`
  );
  const bookmark = db.prepare(
    `INSERT INTO external_usage_files(scope, scope_key, engine, session_id, size, mtime_ms, scanned_ms)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_key, engine, session_id) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms, scanned_ms = excluded.scanned_ms`
  );
  const claudeRates = getClaudeModelRates();
  const codexRates = getCodexModelRates();
  let rows = 0;
  let cost = 0;
  let outside = 0;
  const attributed = {};
  for (const session of sessions) {
    const sessionId = String(session.sessionId || "");
    if (!sessionId) continue;
    // The bookmark is written even for a session attributed back to the gateway, so a transcript
    // that will never be reported is not reopened on every pass for the rest of its life.
    bookmark.run(scope, scopeKey, engine, sessionId, num(session.size), num(session.mtimeMs), now);
    const { owner, reason } = sessionAttribution(session, { knownIds, index, scope });
    // DELETE first either way: a session reclassified as the gateway's by a later pass (its id
    // finally appears in the ledger) must lose the rows an earlier pass recorded for it.
    deleteRows.run(scope, scopeKey, engine, sessionId);
    if (owner === "gateway") {
      attributed[reason] = (attributed[reason] || 0) + 1;
      continue;
    }
    const buckets = foldTurnsIntoModels(session.buckets || []);
    // A transcript that records no API call spent nothing — an interrupted turn, an aborted
    // session, a test fixture. It is not outside usage; it is not usage. Counting it would put
    // hundreds of empty sessions behind a $0 figure and make the session count meaningless.
    if (!buckets.length) {
      attributed.empty = (attributed.empty || 0) + 1;
      continue;
    }
    attributed[reason] = (attributed[reason] || 0) + 1;
    outside += 1;
    const match = matchWorkdir(session.cwd, index);
    for (const bucket of buckets) {
      if (sinceBucket && String(bucket.bucket || "") < sinceBucket) continue;
      const model = String(bucket.model || "");
      const tokens = tokenColumns(engine, bucket.usage || {});
      const priced = model
        ? (engine === "codex" ? priceCodexTokens(bucket.usage, model, codexRates) : priceClaudeTokens(bucket.usage, model, claudeRates))
        : 0;
      insertRow.run({
        scope,
        scope_key: scopeKey,
        engine,
        session_id: sessionId,
        bucket: String(bucket.bucket || ""),
        model,
        origin: String(session.origin || "other"),
        cwd: String(session.cwd || ""),
        channel_id: match?.channelId || "",
        slug: match?.slug || (scope === "container" ? scopeKey : ""),
        turns: num(bucket.turns),
        requests: num(bucket.requests),
        ...tokens,
        cost_usd: priced,
        cost_estimated: 1,
        updated_ms: now,
      });
      rows += 1;
      cost += priced || 0;
    }
  }
  return { rows, cost, outside, attributed };
}

function knownFiles(db, scope, scopeKey, engine) {
  const out = {};
  try {
    for (const row of db.prepare("SELECT session_id, size, mtime_ms FROM external_usage_files WHERE scope = ? AND scope_key = ? AND engine = ?").all(scope, scopeKey, engine)) {
      out[row.session_id] = { size: row.size, mtimeMs: row.mtime_ms };
    }
  } catch {
    /* pre-28 database; treat everything as new */
  }
  return out;
}

// ── scopes ──────────────────────────────────────────────────────────────────────────────────────
// The container half runs the SAME scanner the daemon does, shipped as inline module source, so the
// side that owns the rootless HOME volume does the reading and the two can never drift. Mirrors
// createCodexUsageReader; the Claude reducer needs its module text the same way.
let claudeReducerSource;
async function scanInContainer(target, engine, args) {
  if (typeof target?.runtime?.inspectUsage !== "function") throw new Error("runtime cannot inspect usage");
  if (engine === "codex") {
    const source = await readFile(new URL("../engines/codex-usage.js", import.meta.url), "utf8");
    return target.runtime.inspectUsage(target, {
      source: `${source}\nprocess.stdout.write(JSON.stringify(await reduceCodexUsage(JSON.parse(process.argv[1]))));`,
      args: { ...args, operation: "external", stateDir: target.container?.codexHome || "" },
    });
  }
  claudeReducerSource ||= readFile(new URL("./claude-usage.js", import.meta.url), "utf8");
  return target.runtime.inspectUsage(target, {
    source: `${await claudeReducerSource}\nprocess.stdout.write(JSON.stringify(await reduceClaudeUsage(JSON.parse(process.argv[1]))));`,
    args: { ...args, operation: "scan", stateDir: target.container?.claudeConfigDir || "" },
  });
}

async function scanOneScope({ scope, scopeKey, target = null, stateDirs, index, limit, sinceMs, now, db }) {
  const result = { scope, scopeKey, engines: {}, errors: [] };
  // The ids the ledger can name outright. They are passed to the scanner as a pre-open skip list
  // (a gateway transcript is never even read) AND kept here, because sessionAttribution has to
  // recognise the same sessions when they arrive from a container's own copy of the scanner.
  const knownIds = gatewaySessionIds({ slug: scope === "container" ? scopeKey : "" });
  const skip = [...knownIds];
  for (const engine of ["claude", "codex"]) {
    const stateDir = stateDirs[engine];
    if (!stateDir && !target) continue;
    const known = knownFiles(db, scope, scopeKey, engine);
    const args = { known, skipSessions: skip, limit, sinceMs };
    try {
      const scan = target
        ? await scanInContainer(target, engine, args)
        : engine === "claude"
          ? await scanClaudeState(stateDir, args)
          : await scanCodexState(stateDir, args);
      const sessions = Array.isArray(scan?.sessions) ? scan.sessions : [];
      // One atomic unit per scope+engine: a scan writes a few hundred rows, and a partially applied
      // batch would leave bookmarks ahead of the rows they claim were recorded — the next pass would
      // then skip work it never actually persisted.
      //
      // A SAVEPOINT rather than BEGIN, because it has to work both ways round: standalone (the
      // daemon's own pass, where it starts and commits a transaction of its own) and nested inside
      // one (scripts/scan-external-usage.mjs previews a pass by running the REAL write path and
      // rolling the whole thing back). BEGIN inside BEGIN is an error, so the preview could not
      // have exercised the code it is previewing.
      db.exec("SAVEPOINT cg_external_scope");
      let saved;
      try {
        saved = saveScopeSessions(db, { scope, scopeKey, engine, sessions, index, knownIds, sinceMs, now });
        db.exec("RELEASE cg_external_scope");
      } catch (error) {
        try {
          db.exec("ROLLBACK TO cg_external_scope");
          db.exec("RELEASE cg_external_scope");
        } catch { /* savepoint already gone */ }
        throw error;
      }
      result.engines[engine] = {
        scanned: sessions.length,
        unchanged: scan?.unchanged?.length || 0,
        skipped: scan?.skipped?.length || 0,
        total: scan?.total || 0,
        truncated: Boolean(scan?.truncated),
        ...saved,
      };
    } catch (error) {
      result.errors.push(`${engine}: ${String(error?.message || error)}`);
    }
  }
  return result;
}

// Channels whose container is ALREADY running. A stopped one is skipped, not started: its
// transcripts are not going anywhere, and the next scan after someone uses the channel picks them
// up. resolveRuntime/prepareTarget are pure, and health() only inspects.
async function runningContainerScopes() {
  let channels = [];
  try {
    channels = await listChannels();
  } catch {
    return [];
  }
  const scopes = [];
  for (const channel of channels) {
    const slug = String(channel?.slug || "");
    if (!slug) continue;
    try {
      const target = resolveRuntime(slug, channelMeta(channel));
      if (target?.backend !== "container") continue;
      const health = await target.runtime.health(target);
      if (health?.state !== "running") continue;
      scopes.push({ scope: "container", scopeKey: slug, target });
    } catch {
      /* a channel whose runtime cannot even be described is not a scan target */
    }
  }
  return scopes;
}

/**
 * One full pass. Best-effort throughout: a scope that fails is reported and the rest still run,
 * because a dashboard missing one channel's outside usage is far better than one missing all of it.
 */
export async function scanExternalUsage({ limit = EXTERNAL_SCAN_FILE_LIMIT, includeContainers = true, now = Date.now(), scopes = null, rescan = false } = {}) {
  const startedMs = Date.now();
  const db = getDb();
  let index = [];
  try {
    index = buildWorkdirIndex(await listChannels());
  } catch {
    /* no channel index: outside usage is still counted, just not attributed to a conversation */
  }
  const targets = scopes || [
    { scope: "host", scopeKey: "", target: null },
    ...(includeContainers ? await runningContainerScopes() : []),
  ];
  const stateDirs = { claude: claudeStateDir(), codex: codexStateDir() };
  const sinceMs = externalTrackingSince({ now });
  // An explicit --rescan, or a scanner/rate change since the last completed pass. Either way the
  // bookmarks go once and the normal incremental drain does the rest.
  const stale = rescan ? "requested" : externalScanStaleReason(db);
  const reprocessing = stale ? forgetBookmarks(db, stale) : "";
  if (!metaGet(EXTERNAL_LOGIC_KEY)) metaSet(EXTERNAL_LOGIC_KEY, externalScanFingerprint());
  const results = [];
  for (const entry of targets) {
    results.push(
      await scanOneScope({
        ...entry,
        stateDirs: entry.target ? {} : stateDirs,
        index,
        limit,
        sinceMs,
        now,
        db,
      })
    );
  }
  // Merge the per-scope attribution tallies so one pass can say, in one line, how many sessions it
  // recognised as the gateway's own and by which evidence — the number an operator needs to trust
  // (or challenge) the outside figure.
  const attributed = {};
  for (const scope of results) {
    for (const engine of Object.values(scope.engines)) {
      for (const [reason, count] of Object.entries(engine.attributed || {})) attributed[reason] = (attributed[reason] || 0) + count;
    }
  }
  const summary = {
    startedAt: new Date(startedMs).toISOString(),
    since: sinceMs ? new Date(sinceMs).toISOString() : "",
    trackingStartedAt: externalTrackingStartedAt(),
    reprocessing,
    attributed,
    durationMs: Date.now() - startedMs,
    scopes: results,
    sessions: results.reduce((total, r) => total + Object.values(r.engines).reduce((s, e) => s + e.scanned, 0), 0),
    rows: results.reduce((total, r) => total + Object.values(r.engines).reduce((s, e) => s + e.rows, 0), 0),
    outside: results.reduce((total, r) => total + Object.values(r.engines).reduce((s, e) => s + e.outside, 0), 0),
    truncated: results.some((r) => Object.values(r.engines).some((e) => e.truncated)),
    errors: results.flatMap((r) => r.errors.map((message) => `${r.scope}${r.scopeKey ? `/${r.scopeKey}` : ""}: ${message}`)),
  };
  lastScan = summary;
  return summary;
}

let lastScan = null;
let timer = null;

export function externalUsageStatus() {
  return lastScan;
}

/**
 * Periodic rescan. The first pass is deferred rather than run at boot: a cold start already has
 * Slack, recovery and the skills catalog to get through, and outside usage is a reporting figure,
 * not something a turn waits on. A truncated pass reschedules itself promptly so a large backlog
 * drains instead of taking an hour per batch.
 */
export function startExternalUsageScan({ intervalMs = EXTERNAL_SCAN_INTERVAL_MS, firstDelayMs = 60_000, log = () => {} } = {}) {
  stopExternalUsageScan();
  const pass = async () => {
    try {
      const summary = await scanExternalUsage();
      if (summary.reprocessing) {
        log(`[usage] external scan: ${summary.reprocessing} — reprocessing this host's engine history`);
      }
      if (summary.rows || summary.errors.length) {
        log(`[usage] external scan: ${summary.sessions} session(s), ${summary.rows} row(s)${summary.truncated ? ", more pending" : ""}${summary.errors.length ? `, ${summary.errors.length} error(s)` : ""}`);
      }
      if (summary.errors.length) void logEvent("external_usage_scan_error", { errors: summary.errors.slice(0, 5) });
      schedule(summary.truncated ? 60_000 : intervalMs);
    } catch (error) {
      countDrop("external-usage", error);
      schedule(intervalMs);
    }
  };
  const schedule = (delay) => {
    timer = setTimeout(() => void pass(), delay);
    timer.unref?.();
  };
  schedule(firstDelayMs);
  return { stop: stopExternalUsageScan };
}

export function stopExternalUsageScan() {
  if (timer) clearTimeout(timer);
  timer = null;
}
