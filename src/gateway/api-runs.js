// HTTP run API: fire a headless run without a Slack message. `POST /api/runs` (see
// ../web/routes/runs.js) hands the parsed request here; startApiRun() provisions/resolves a gated
// folder, pre-mints a session, kicks the run through runMessage() in the background, and returns a
// job id + resume command immediately. GET /api/runs/:id reads the tracked status via getApiJob().
//
// Two shapes:
//  - no channel  → a dedicated auto-provisioned `api` folder; headless (result via status/webhook).
//  - channel given + Slack connected → runs as a REAL thread in that channel (a kickoff message
//    starts the thread, its ts is the session key), so the answer posts back and it's continuable
//    in Slack too. If the kickoff can't post, it falls back to a headless api-keyed thread.
//
// Jobs are tracked in memory AND persisted to the `api_jobs` table so GET keeps working after a
// restart. A row left running/queued when the daemon died is rehydrated on boot and run again
// against the stored prompt/attachments; Slack-backed jobs also resume visible progress in the
// original thread.
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import path from "node:path";
import {
  getChannelEntry,
  getChannelsIndex,
  upsertChannelEntry,
  getChannelMeta,
  saveChannelMeta,
  patchChannelMeta,
  defaultChannelMeta,
} from "../config/store.js";
import { runMessage, effectiveMeta } from "./run.js";
import { ATTACHMENT_MAX_BYTES, oversizeMessage, readBoundedBytes } from "../util/bounded-bytes.js";
import { ensureRealDir, writeNoFollow, writeStreamNoFollow } from "./safe-fs.js";
import { assertPublicHttpUrl, resolvePublicHttpUrl } from "../web/security.js";
import { resumeCommandFor } from "../engines/registry.js";
import { ensureChannelFolder, effectiveWorkDir } from "./folders.js";
import { getEngine, ENGINES, getProgressView } from "../config/settings.js";
import { recordUsage } from "./usage.js";
import { logEvent } from "../util/logger.js";
import { getDb, toJson, fromJson } from "../db/index.js";
import { getDirectory } from "../slack/directory.js";
import { mdToMrkdwn } from "../slack/format.js";
import { deliverResult } from "../slack/deliver.js";
import { startProgress } from "../slack/progress.js";
import { PROFILE_FLAGS } from "./modes.js";
import { postNotice } from "../platforms/notify.js";

// The synthetic channel used when no target channel is supplied. It shows up in the admin UI like
// any channel (so its mode/tools/tokens are configurable there) but has no real Slack id, so runs
// against it never post to Slack.
export const API_CHANNEL_ID = "cg-api";
export const API_SLUG = "api";

const MAX_INFLIGHT = 25; // reject new starts past this many concurrently-running API jobs (429)
// Cap for an inline base64 payload or a downloaded webhook-supplied fileUrl — the same ceiling every
// inbound attachment gets (util/bounded-bytes.js). A fileUrl body streams to disk under it; an
// inline payload is in practice bounded far lower by the JSON body limit of the admin app.
const MAX_FILE_BYTES = ATTACHMENT_MAX_BYTES;
const WEBHOOK_TIMEOUT_MS = 10_000;
const MEM_CAP = 500; // most-recent jobs kept in memory (terminal ones evicted first past this)
const DB_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune persisted jobs older than this on each start
const IDEM_TTL_MS = 15 * 60 * 1000; // an idempotencyKey dedupes repeat POSTs within this window
const LIST_MAX = 200; // hard cap on GET /api/runs page size
const MAX_RECOVER_ATTEMPTS = 2;
const MAX_KICKOFF_CHARS = 11_500;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// id -> job record (serializable; no handles). The DB row mirrors this for restart-durable reads.
const jobs = new Map();
// id -> AbortController for the live run (handles aren't serializable, so kept out of the record).
// Present only while a job is in flight; the stop endpoint aborts through it.
const controllers = new Map();

// `mode` accepts a capability profile (read/worker/auto/full/lean) or the friendly mode aliases.
const MODE_ALIASES = { bash: "worker", admin: "full", autonomous: "auto", clean: "lean" };
function normalizeMode(mode) {
  const m = String(mode || "").trim().toLowerCase();
  if (!m) return "";
  const canon = MODE_ALIASES[m] || m;
  return PROFILE_FLAGS[canon] ? canon : "invalid";
}

// ── Job persistence ───────────────────────────────────────────────────────────
function persist(job) {
  try {
    getDb()
      .prepare(
        "INSERT INTO api_jobs(id, status, created_ms, data) VALUES(?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data"
      )
      .run(job.id, job.status, job.createdMs, toJson(job));
  } catch {
    /* best-effort — status durability is a nicety, not a correctness requirement */
  }
}

// Trim the in-memory map and prune old persisted rows. Cheap; called once per start.
function houseKeep() {
  if (jobs.size > MEM_CAP) {
    // Evict terminal jobs first (oldest → newest); the DB still answers GET for them.
    const terminal = [...jobs.values()].filter((j) => isTerminal(j.status)).sort((a, b) => a.createdMs - b.createdMs);
    for (const j of terminal) {
      if (jobs.size <= MEM_CAP) break;
      jobs.delete(j.id);
    }
  }
  try {
    getDb().prepare("DELETE FROM api_jobs WHERE created_ms < ?").run(Date.now() - DB_TTL_MS);
  } catch {
    /* best-effort */
  }
}

function isTerminal(status) {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "stopped";
}

// Find a prior job created under the same idempotency key within the TTL window (memory first, then
// the durable rows so a retry that spans a restart still dedupes). Returns the job record or null.
function findByIdempotencyKey(key) {
  if (!key) return null;
  const cutoff = Date.now() - IDEM_TTL_MS;
  for (const j of jobs.values()) if (j.idempotencyKey === key && j.createdMs >= cutoff) return j;
  try {
    const rows = getDb().prepare("SELECT data FROM api_jobs WHERE created_ms >= ? ORDER BY created_ms DESC").all(cutoff);
    for (const r of rows) {
      const j = fromJson(r.data, null);
      if (j && j.idempotencyKey === key) return j;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

// The shape POST returns (also reused for an idempotent hit on an existing job).
function startShape(job, reused = false) {
  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    engine: job.engine,
    slug: job.slug,
    channelId: job.slackThread ? job.channelId : null,
    slackThread: Boolean(job.slackThread),
    sessionId: job.sessionId,
    resumeCommand: job.resumeCommand,
    reused,
  };
}

// ── Read a job (memory first, then the durable row) ────────────────────────────
export function getApiJob(id) {
  const mem = jobs.get(id);
  if (mem) return mem;
  let row;
  try {
    row = getDb().prepare("SELECT data FROM api_jobs WHERE id = ?").get(id);
  } catch {
    return null;
  }
  if (!row) return null;
  const job = fromJson(row.data, null);
  if (!job) return null;
  return job;
}

// Recent jobs, newest first, from the durable table (survives restarts). The live in-memory record
// (freshest status) wins per id; a persisted running/queued row with no live job reads as interrupted.
export function listApiJobs({ status = "", limit = 50 } = {}) {
  const n = Math.max(1, Math.min(LIST_MAX, Number(limit) || 50));
  let rows;
  try {
    rows = getDb().prepare("SELECT id, data FROM api_jobs ORDER BY created_ms DESC LIMIT ?").all(n * 3);
  } catch {
    return [];
  }
  const out = [];
  for (const r of rows) {
    const job = jobs.get(r.id) || fromJson(r.data, null);
    if (!job) continue;
    if (status && job.status !== status) continue;
    out.push(job);
    if (out.length >= n) break;
  }
  return out;
}

// Stop an in-flight run. Only works while the job is live in THIS process (a controller exists) — a
// restart-interrupted job has no controller. Aborts the run's signal; the driver settles it to
// "stopped". Returns { ok, code?, jobId?, status?, error? }.
export function stopApiRun(id) {
  const job = jobs.get(String(id || ""));
  if (!job) {
    const known = getApiJob(id); // persisted-but-not-live → give a precise status
    if (!known) return { ok: false, code: 404, error: "No such run." };
    return { ok: false, code: 409, error: `Run is already ${known.status}.` };
  }
  if (isTerminal(job.status)) return { ok: false, code: 409, error: `Run is already ${job.status}.` };
  job.stopRequested = true;
  controllers.get(job.id)?.abort();
  return { ok: true, jobId: job.id, status: "stopping" };
}

// Rehydrate API jobs that were queued/running when the previous daemon exited. Unlike interactive
// Slack turns, these rows stay in api_jobs; recovery claims them by loading each row into memory and
// starting a fresh background driver. Slack-backed jobs resume in the original thread when Slack is
// connected. Headless jobs resume silently and finish through status/webhook.
export async function recoverApiRuns({ slack, driver = runInBackground } = {}) {
  let stale = [];
  try {
    stale = getDb()
      .prepare("SELECT data FROM api_jobs WHERE status IN ('running', 'queued') ORDER BY created_ms")
      .all()
      .map((r) => fromJson(r.data, null))
      .filter(Boolean);
  } catch {
    return;
  }
  if (!stale.length) return;
  await logEvent("api_run_recover_begin", { count: stale.length }).catch(() => {});
  const slackState = slack?.snapshot?.() || {};
  const connectedClient = slackState.connected ? slack.getClient?.() ?? null : null;
  for (const rec of stale) {
    const job = { ...rec, status: "running", stopRequested: false };
    const attempts = (Number(job.recoveryAttempts) || 0) + 1;
    const client = job.slackThread && connectedClient ? connectedClient : null;
    if (attempts > MAX_RECOVER_ATTEMPTS) {
      job.status = "failed";
      job.completedMs = Date.now();
      job.error = "The daemon restarted repeatedly while this API run was in flight; recovery stopped. Start a new run.";
      job.recoveryAttempts = attempts;
      persist(job);
      await logEvent("api_run_recover_giveup", { id: job.id, slug: job.slug, attempts }).catch(() => {});
      if (client) {
        client.chat
          .postMessage({
            channel: job.channelId,
            thread_ts: job.threadKey,
            text: `⚠️ API run \`${job.id}\` was interrupted repeatedly by gateway restarts and has stopped retrying.`,
          })
          .catch(() => {});
      }
      await fireWebhook(job);
      continue;
    }

    const attachmentPath = job.attachmentPath || (Array.isArray(job.attachments) ? job.attachments[0] : null) || null;
    const textForRun = job.textForRun || buildTextForRun({ msg: job.message || "", authorId: job.author || "api", attachmentPath });
    if (!textForRun || (job.hasAttachment && !attachmentPath && (!Array.isArray(job.attachments) || !job.attachments.length))) {
      job.status = "failed";
      job.completedMs = Date.now();
      job.error = "Could not recover this API run because its persisted request payload is incomplete.";
      job.recoveryAttempts = attempts;
      persist(job);
      await logEvent("api_run_recover_error", { id: job.id, slug: job.slug, error: job.error }).catch(() => {});
      await fireWebhook(job);
      continue;
    }

    job.textForRun = textForRun;
    job.attachmentPath = attachmentPath;
    job.attachments = Array.isArray(job.attachments) ? job.attachments : attachmentPath ? [attachmentPath] : [];
    job.recoveryAttempts = attempts;
    job.startedMs = Date.now();
    job.completedMs = null;
    job.error = null;
    jobs.set(job.id, job);
    const controller = new AbortController();
    controllers.set(job.id, controller);
    persist(job);
    await logEvent("api_run_recover", { id: job.id, slug: job.slug, channel: job.slackThread ? job.channelId : "", attempts }).catch(() => {});
    driver(job, {
      textForRun,
      attachmentPath,
      client,
      teamId: slackState.teamId || null,
      overrides: job.overrides || null,
      signal: controller.signal,
      recovering: true,
    });
  }
  await logEvent("api_run_recover_done", { count: stale.length }).catch(() => {});
}

// ── Channel resolution ─────────────────────────────────────────────────────────
// Provision the synthetic API channel on first use (safe defaults: read-only profile, no admin
// escalation). Idempotent.
async function ensureApiChannel() {
  const existing = await getChannelEntry(API_CHANNEL_ID);
  if (!existing) {
    await upsertChannelEntry(API_CHANNEL_ID, { name: "API runs", type: "channel", isDM: false });
  }
  const entry = (await getChannelEntry(API_CHANNEL_ID)) || { slug: API_SLUG, name: "API runs", type: "channel", isDM: false };
  // Transactional create-if-missing (patch(null) seeds defaults; an existing row is untouched).
  await patchChannelMeta(entry.slug, (current) => (current ? null : defaultChannelMeta({ channelId: API_CHANNEL_ID, name: "API runs", type: "channel", isDM: false })));
  return { channelId: API_CHANNEL_ID, ...entry };
}

// Resolve a caller-supplied channel reference (a Slack channel id, a folder slug, or a channel
// name with/without a leading #) to a registered channel entry. null when nothing matches.
async function resolveChannel(ref) {
  const r = String(ref || "").trim();
  if (!r) return null;
  const byId = await getChannelEntry(r);
  if (byId) return { channelId: r, ...byId };
  const index = await getChannelsIndex();
  for (const [cid, e] of Object.entries(index)) if (e.slug === r) return { channelId: cid, ...e };
  const norm = r.replace(/^#/, "").toLowerCase();
  for (const [cid, e] of Object.entries(index)) {
    if (String(e.name || "").replace(/^#/, "").toLowerCase() === norm) return { channelId: cid, ...e };
  }
  return null;
}

// ── Attachment handling ──────────────────────────────────────────────────────────
const safeName = (n) => (String(n || "").replace(/[/\\]/g, "_").replace(/^\.+/, "").trim() || "upload");

// Cap a downloaded body at MAX_FILE_BYTES, enforced while streaming (util/bounded-bytes.js) —
// a declared Content-Length is never trusted on its own. Kept as a named export here because it
// is the API layer's documented boundary (and is covered by test/api-boundaries.test.js).
export const boundedResponseBytes = (res, maxBytes = MAX_FILE_BYTES) => readBoundedBytes(res, maxBytes);

// One HTTP(S) request that connects ONLY to the addresses the SSRF check already vetted: the
// core `lookup` override serves the pinned records and never touches DNS again, while TLS keeps
// validating the certificate against the original hostname (SNI unchanged). Response is wrapped
// fetch-shaped (status/ok/headers.get/web-stream body) for boundedResponseBytes and callers.
function pinnedRequest(url, { method = "GET", headers = {}, body, signal } = {}, addresses) {
  if (!Array.isArray(addresses) || !addresses.length) {
    return Promise.reject(new Error("refusing to request without SSRF-vetted addresses"));
  }
  return new Promise((resolve, reject) => {
    const make = url.protocol === "https:" ? httpsRequest : httpRequest;
    const lookup = (hostname, options, cb) => {
      if (options?.all) return cb(null, addresses);
      cb(null, addresses[0].address, addresses[0].family);
    };
    const req = make(url, { method, headers, lookup, signal }, (res) => {
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: {
          get(name) {
            const v = res.headers[String(name || "").toLowerCase()];
            return v == null ? null : Array.isArray(v) ? v.join(", ") : String(v);
          },
        },
        body: Readable.toWeb(res),
      });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Fetch an already-untrusted URL without letting the runtime auto-follow redirects. Every target
// is DNS-resolved and SSRF-checked immediately before the request, and the connection is PINNED
// to the vetted records (no second resolve — the rebinding TOCTOU stays closed). POST follows
// browser semantics: 301/302/303 become GET; 307/308 retain the body. Credentials never survive
// an origin change.
export async function fetchPublicUrl(input, init = {}, maxRedirects = 3, { fetchImpl = pinnedRequest, validate = resolvePublicHttpUrl } = {}) {
  // Injectable seams: a test `validate` may return a bare URL (no pinning info) — the default
  // fetchImpl refuses that pairing rather than re-resolving.
  const resolveTarget = async (value) => {
    const v = await validate(value);
    return v instanceof URL ? { url: v, addresses: null } : v;
  };
  let target = await resolveTarget(input);
  let request = { ...init, redirect: "manual" };
  for (let hops = 0; ; hops++) {
    const res = await fetchImpl(target.url, request, target.addresses);
    if (!REDIRECT_CODES.has(res.status)) return { res, url: target.url };
    const location = res.headers.get("location");
    if (!location) return { res, url: target.url };
    if (hops >= maxRedirects) throw new Error("followed too many redirects");
    await res.body?.cancel?.().catch(() => {});
    const previousOrigin = target.url.origin;
    target = await resolveTarget(new URL(location, target.url).href);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && String(request.method || "GET").toUpperCase() === "POST")) {
      const headers = { ...(request.headers || {}) };
      delete headers["content-type"];
      delete headers["Content-Type"];
      request = { ...request, method: "GET", headers };
      delete request.body;
    }
    if (target.url.origin !== previousOrigin && request.headers) {
      // A redirect to another origin must not carry ambient credentials a caller attached.
      const headers = { ...request.headers };
      for (const name of Object.keys(headers)) {
        if (["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase())) delete headers[name];
      }
      request = { ...request, headers };
    }
  }
}

// Materialize the optional file into the folder's uploads/ dir; returns its absolute path (or null).
// Supports an inline base64 payload ({ file: { name, dataBase64 } } / dataBase64 + fileName) and a
// fileUrl the daemon downloads. `cwd` is an agent-writable workspace, so every path component is
// recreated as a REAL directory and the bytes land via an exclusive no-follow temp + rename — a
// symlink planted at uploads/ (or at the destination name) is replaced as a node, never followed.
// The per-job subdirectory keeps two jobs that upload the same filename from colliding.
export async function saveAttachment({ cwd, jobId, file, fileUrl, fileName }) {
  const destDir = await ensureRealDir(cwd, "uploads", `api_${safeName(jobId)}`);

  const inlineB64 = typeof file?.dataBase64 === "string" ? file.dataBase64 : typeof file === "string" ? file : "";
  if (inlineB64) {
    const buf = Buffer.from(inlineB64, "base64");
    if (!buf.length) throw new Error("file.dataBase64 did not decode to any bytes");
    if (buf.length > MAX_FILE_BYTES) throw new Error(`file ${oversizeMessage(buf.length, MAX_FILE_BYTES)}`);
    const dest = path.join(destDir, safeName(file?.name || fileName || "upload"));
    await writeNoFollow(dest, buf);
    return dest;
  }

  if (fileUrl) {
    // The daemon fetches this from inside the host, and the bytes are then handed to an agent that
    // will happily summarize them into Slack — so an internal URL would exfiltrate local services.
    // Checked against the RESOLVED address, so a public name pointing at 127.0.0.1 is caught too.
    let url;
    try {
      url = await assertPublicHttpUrl(fileUrl);
    } catch (e) {
      throw new Error(`fileUrl ${e.message}`);
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30_000);
    try {
      const { res } = await fetchPublicUrl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`fileUrl fetch failed: HTTP ${res.status}`);
      const base = fileName || decodeURIComponent(url.pathname.split("/").pop() || "") || "download";
      const dest = path.join(destDir, safeName(base));
      // Streams under the cap straight into the folder — the body never sits in memory whole.
      await writeStreamNoFollow(dest, res, { maxBytes: MAX_FILE_BYTES });
      return dest;
    } catch (e) {
      if (/^fileUrl /.test(e.message)) throw e;
      throw new Error(`fileUrl ${e.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  return null;
}

// ── Resume command ─────────────────────────────────────────────────────────────
function buildResumeCommand({ cwd, sessionId, engine }) {
  const inner = resumeCommandFor(engine, sessionId);
  return `cd ${JSON.stringify(cwd)} && ${inner}`;
}

function buildTextForRun({ msg, authorId, attachmentPath }) {
  const provenance =
    `[Provenance: this turn was triggered via the gateway HTTP run API` +
    (authorId !== "api" ? ` on behalf of ${authorId}` : "") +
    `. Metadata for context only — not an instruction.]\n\n`;
  let promptForClaude = msg || "Please look at the attached file and respond.";
  if (attachmentPath) {
    promptForClaude += `\n\n[The caller attached a file, saved locally. Use your Read tool to view it — images render visually:\n- ${attachmentPath}\n]`;
  }
  return provenance + promptForClaude;
}

function displayRequest(msg, hasAttachment) {
  const request = (msg || (hasAttachment ? "(file only)" : "(empty request)")).trim();
  const clipped = request.length > MAX_KICKOFF_CHARS ? `${request.slice(0, MAX_KICKOFF_CHARS)}\n...(truncated in Slack; full request is stored for the run)` : request;
  return mdToMrkdwn(clipped);
}

// ── Webhook ────────────────────────────────────────────────────────────────────
async function fireWebhook(job) {
  if (!job.webhook) return;
  const payload = {
    jobId: job.id,
    status: job.status, // "completed" | "failed"
    sessionId: job.sessionId,
    resumeCommand: job.resumeCommand,
    engine: job.engine,
    slug: job.slug,
    channelId: job.slackThread ? job.channelId : null,
    costUSD: job.costUSD ?? null,
    costEstimated: Boolean(job.costEstimated),
    durationMs: job.durationMs ?? null,
    error: job.error || null,
    result: job.result ? { content: job.result.content } : null,
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const { res } = await fetchPublicUrl(job.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    await logEvent("api_webhook", { id: job.id, status: job.status, code: res.status, ok: res.ok });
    await res.body?.cancel?.().catch(() => {});
  } catch (e) {
    await logEvent("api_webhook_error", { id: job.id, error: e.message }).catch(() => {});
  } finally {
    clearTimeout(t);
  }
}

// ── Start reservations ─────────────────────────────────────────────────────────
// A job only lands in `jobs` after several awaits (webhook DNS check, channel resolution, an
// attachment download, the Slack kickoff post). Reading `jobs` to answer "was this key already
// used?" and "how many runs are in flight?" therefore raced itself: two same-key POSTs each saw no
// prior job and each started a paid run, and 25 simultaneous POSTs each read inflight = 0. Both
// facts are now claimed SYNCHRONOUSLY — no await between the check and the claim — and released on
// every failure path, so the window has no gap to race through.
const pendingStarts = new Map(); // idempotency key -> promise of the outcome of the start holding it
let reservedStarts = 0; // claims made but not yet represented by a record in `jobs`

function countInflight() {
  let inflight = reservedStarts;
  for (const j of jobs.values()) if (j.status === "running" || j.status === "queued") inflight++;
  return inflight;
}

// ── Start a run ────────────────────────────────────────────────────────────────
// Returns { ok:true, jobId, status, sessionId, resumeCommand, engine, slug, channelId, slackThread }
// or { ok:false, code, error }. The run itself proceeds in the background.
export async function startApiRun(input = {}) {
  const { message, file, fileUrl, engine: engineIn, model, effort, mode, idempotencyKey } = input;
  const msg = String(message ?? "").trim();
  const hasFile = Boolean((typeof file?.dataBase64 === "string" && file.dataBase64) || (typeof file === "string" && file) || fileUrl);
  if (!msg && !hasFile) return { ok: false, code: 400, error: "Provide a `message` (and/or a file)." };

  // Per-request overrides (win over the channel/DM config for this one run). Validated before the
  // reservation below so a malformed request never consumes an in-flight slot.
  const engineOv = engineIn ? String(engineIn).trim().toLowerCase() : "";
  if (engineOv && !ENGINES.includes(engineOv)) return { ok: false, code: 400, error: `engine must be one of: ${ENGINES.join(", ")}` };
  const modeOv = mode ? normalizeMode(mode) : "";
  if (modeOv === "invalid") return { ok: false, code: 400, error: "mode must be one of: read, worker, auto, full, lean (aliases: bash→worker, admin→full)" };
  const overrides =
    engineOv || model || effort || modeOv
      ? { engine: engineOv || undefined, model: model ? String(model) : undefined, effort: effort ? String(effort) : undefined, mode: modeOv || undefined }
      : null;

  // Idempotency: a repeat POST carrying the same key within the TTL returns the ORIGINAL job
  // instead of starting a second run (dedupes automation retries). The caller invents the key —
  // any unique-per-logical-request string (e.g. a Make.com execution id); no job id needed up front.
  const idemKey = idempotencyKey ? String(idempotencyKey).slice(0, 200) : "";
  if (idemKey) {
    const existing = findByIdempotencyKey(idemKey);
    if (existing) return startShape(existing, true);
    // A same-key POST is mid-start: share its outcome instead of racing a duplicate run.
    const pending = pendingStarts.get(idemKey);
    if (pending) return await pending;
  }
  // Backpressure: bound concurrently-running API jobs (runMessage's own semaphore bounds spawns).
  if (countInflight() >= MAX_INFLIGHT) return { ok: false, code: 429, error: `Too many API runs in flight (${MAX_INFLIGHT}). Retry shortly.` };
  reservedStarts += 1;
  let settle = () => {};
  if (idemKey) pendingStarts.set(idemKey, new Promise((resolve) => { settle = resolve; }));

  let outcome;
  try {
    outcome = await startClaimedRun(input, { msg, hasFile, idemKey, overrides, engineOv });
  } catch (e) {
    releaseStart(idemKey, settle, { ok: false, code: 500, error: e.message });
    throw e;
  }
  // Released only here: on success the record is already in `jobs` (so it counts itself), and on
  // failure the key is free for an honest retry. Waiters on the same key see a reused job.
  releaseStart(idemKey, settle, outcome.ok ? { ...outcome, reused: true } : outcome);
  return outcome;
}

function releaseStart(idemKey, settle, outcome) {
  reservedStarts = Math.max(0, reservedStarts - 1);
  if (idemKey) pendingStarts.delete(idemKey);
  settle(outcome);
}

// The claimed half: everything from here down may await freely, because the idempotency key and the
// in-flight slot are already held by the caller above.
async function startClaimedRun({ author, channel, file, fileUrl, fileName, webhook, slack, driver = runInBackground }, { msg, hasFile, idemKey, overrides, engineOv }) {
  if (webhook) {
    // Resolved-address check, not just a scheme check: this POST leaves from inside the host, so
    // an internal target would make the run API a proxy into the private network (including the
    // gateway's own admin API on loopback).
    try {
      await assertPublicHttpUrl(webhook);
    } catch (e) {
      return { ok: false, code: 400, error: `webhook ${e.message}.` };
    }
  }

  const authorId = (String(author || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64)) || "api";

  // Resolve the target folder.
  let entry;
  if (channel) {
    entry = await resolveChannel(channel);
    if (!entry) return { ok: false, code: 400, error: `Unknown channel "${channel}". Pass a registered Slack channel id, folder slug, or channel name.` };
  } else {
    entry = await ensureApiChannel();
  }
  const slug = entry.slug;

  const meta = effectiveMeta((await getChannelMeta(slug)) ?? defaultChannelMeta({ channelId: entry.channelId, name: entry.name, type: entry.type, isDM: entry.isDM }));
  await ensureChannelFolder(slug, meta); // idempotent — writes the lockdown + uploads root exists
  const cwd = effectiveWorkDir(slug, meta);

  const jobId = randomUUID().slice(0, 12);

  // Optional attachment.
  let attachmentPath = null;
  if (hasFile) {
    try {
      attachmentPath = await saveAttachment({ cwd, jobId, file, fileUrl, fileName });
    } catch (e) {
      return { ok: false, code: 400, error: `File could not be saved: ${e.message}` };
    }
  }

  // Real-channel runs post to Slack as their own thread (so the answer lands there and it stays
  // continuable in Slack). The kickoff message ts becomes the session key. Falls back to a headless
  // api-keyed thread if Slack isn't connected or the post fails.
  const client = slack?.snapshot?.().connected ? slack.getClient?.() ?? null : null;
  const canSlack = Boolean(channel) && entry.channelId !== API_CHANNEL_ID && client;
  let threadKey = `api:${jobId}`;
  let slackThread = false;
  if (canSlack) {
    try {
      const kickoffText = `🚀 API run started (job \`${jobId}\`)` + (authorId !== "api" ? ` for <@${authorId}>` : "") + `\n\n*Request:*\n${displayRequest(msg, hasFile)}`;
      const kickoff = await postNotice(client, { conversationId: entry.channelId, text: kickoffText });
      if (kickoff?.messageId) {
        threadKey = kickoff.messageId;
        slackThread = true;
      }
    } catch (e) {
      await logEvent("api_slack_kickoff_failed", { id: jobId, slug, error: e.message }).catch(() => {});
    }
  }

  const presetSessionId = randomUUID();
  const engine = engineOv || (ENGINES.includes(meta.engine) ? meta.engine : "") || getEngine();
  const resumeCommand = buildResumeCommand({ cwd, sessionId: presetSessionId, engine });

  const textForRun = buildTextForRun({ msg, authorId, attachmentPath });

  const now = Date.now();
  const job = {
    id: jobId,
    status: "running",
    message: msg,
    slug,
    channelId: entry.channelId,
    threadKey,
    author: authorId,
    engine,
    sessionId: presetSessionId,
    resumeCommand,
    cwd,
    slackThread,
    hasAttachment: Boolean(attachmentPath),
    attachmentPath,
    attachments: attachmentPath ? [attachmentPath] : [],
    textForRun,
    webhook: webhook ? String(webhook) : "",
    idempotencyKey: idemKey,
    overrides: overrides || null,
    stopRequested: false,
    recoveryAttempts: 0,
    createdMs: now,
    startedMs: now,
    completedMs: null,
    costUSD: null,
    costEstimated: false,
    durationMs: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, job);
  const controller = new AbortController();
  controllers.set(jobId, controller);
  persist(job);
  houseKeep();
  await logEvent("api_run_start", { id: jobId, slug, channel: slackThread ? entry.channelId : "", author: authorId, hasFile: Boolean(attachmentPath) });

  // Drive the run in the background — the HTTP handler returns immediately. `driver` is injectable
  // for the same reason recoverApiRuns takes one: admission can then be tested without a subprocess.
  driver(job, { textForRun, attachmentPath, client: slackThread ? client : null, teamId: slack?.snapshot?.().teamId || null, overrides, signal: controller.signal });

  return startShape(job);
}

// What this run COST, for the caller-facing surfaces (GET /api/runs/:id, the `api_run_done` event
// and the webhook). Claude reports a real dollar amount; Codex reports none at all, and publishing
// `null` for it told API callers a run was free while the usage ledger was independently storing a
// priced estimate for the very same run (QA API-001). So: the engine's own figure when there is
// one, otherwise the figure the ledger just settled on — flagged `estimated`, the same distinction
// the ledger keeps. `null` survives only when nothing anywhere knows.
export function settleRunCost(result = {}, ledger = null) {
  if (result?.costUSD != null) return { costUSD: result.costUSD, estimated: false };
  if (ledger?.costUSD != null) return { costUSD: ledger.costUSD, estimated: Boolean(ledger.costEstimated) };
  return { costUSD: null, estimated: false };
}

// The floating driver: run, record the outcome, post to Slack (thread runs only), fire the webhook.
async function runInBackground(job, { textForRun, attachmentPath, client, teamId = null, overrides, signal, recovering = false }) {
  const attachments = Array.isArray(job.attachments) ? job.attachments : attachmentPath ? [attachmentPath] : [];
  let status = null;
  try {
    const dir = client ? await getDirectory(client).catch(() => null) : null;
    if (client) {
      if (recovering) {
        await client.chat
          .postMessage({
            channel: job.channelId,
            thread_ts: job.threadKey,
            text: "🔁 I was interrupted by a gateway restart while working on this API run — picking it back up now…",
          })
          .catch(() => {});
      }
      status = startProgress(getProgressView(), client, job.channelId, job.threadKey, {
        isDM: false,
        authorId: job.author,
        teamId,
        dir,
      });
    }

    const result = await runMessage({
      channelId: job.channelId,
      authorId: job.author,
      workspaceId: teamId || process.env.CG_SLACK_TEAM_ID || "",
      text: textForRun,
      threadKey: job.threadKey,
      attachments,
      sessionId: job.sessionId,
      overrides,
      signal,
      // The API key authenticates the CALLER, not `job.author` — never escalate on its say-so.
      // Both origins here are non-escalatable, so both guards hold this line. A boot-time replay
      // declares `recovery` honestly: nobody is watching it, and origin is an audit field first.
      untrustedPrincipal: true,
      origin: recovering ? "recovery" : "api_foreground",
      progressReport: Boolean(status && client && !recovering),
      onDelta: status?.onDelta,
      onEvent: status?.onEvent,
    });

    // A stop that landed while the run was finishing: honor the intent — mark stopped, suppress the
    // answer (don't post/return it), but still bill what it cost.
    if (job.stopRequested) {
      job.status = "stopped";
      job.completedMs = Date.now();
      const ledger = await recordUsage({ channelId: job.channelId, slug: job.slug, authorId: job.author, engine: result.engine, taskKind: "api", result }).catch(() => null);
      const cost = settleRunCost(result, ledger);
      job.costUSD = cost.costUSD;
      job.costEstimated = cost.estimated;
      job.durationMs = result.durationMs ?? null;
      persist(job);
      await logEvent("api_run_stopped", { id: job.id, slug: job.slug, costUSD: cost.costUSD, costEstimated: cost.estimated });
      await status?.stop?.();
      return;
    }

    job.status = "completed";
    job.completedMs = Date.now();
    // Take the engine + session actually used (Codex mints its own thread id), so the resume
    // command and session id are accurate on completion even if the engine differed from the guess.
    job.engine = result.engine || job.engine;
    if (result.sessionId) job.sessionId = result.sessionId;
    if (result.cwd) job.cwd = result.cwd;
    job.resumeCommand = buildResumeCommand({ cwd: job.cwd, sessionId: job.sessionId, engine: job.engine });
    // Bank the usage BEFORE persisting the job: the ledger is what prices a Codex run, and its
    // answer is the cost this job publishes (see settleRunCost).
    const ledger = await recordUsage({ channelId: job.channelId, slug: job.slug, authorId: job.author, engine: result.engine, taskKind: "api", result }).catch(() => null);
    const cost = settleRunCost(result, ledger);
    job.costUSD = cost.costUSD;
    job.costEstimated = cost.estimated;
    job.durationMs = result.durationMs ?? null;
    job.result = { content: result.content || "", costUSD: cost.costUSD, costEstimated: cost.estimated, durationMs: result.durationMs ?? null, usage: result.usage || null };
    persist(job);

    await logEvent("api_run_done", { id: job.id, slug: job.slug, costUSD: cost.costUSD, costEstimated: cost.estimated, durationMs: result.durationMs });

    if (client) {
      try {
        if (status?.ownsFinal) {
          await status.finalize(result);
        } else {
          await status?.stop?.();
          await deliverResult(client, { channel: job.channelId, threadKey: job.threadKey, result, dir, footer: true });
        }
      } catch (e) {
        await logEvent("api_slack_post_error", { id: job.id, error: e.message }).catch(() => {});
      }
    }
  } catch (err) {
    // A user stop aborts the run's signal, which surfaces here as an AbortError — record it as
    // stopped, not failed.
    if (job.stopRequested || err.name === "AbortError") {
      job.status = "stopped";
      job.completedMs = Date.now();
      persist(job);
      await status?.stop?.();
      await logEvent("api_run_stopped", { id: job.id, slug: job.slug }).catch(() => {});
    } else {
      job.status = "failed";
      job.completedMs = Date.now();
      job.error = err.message;
      persist(job);
      await logEvent("api_run_error", { id: job.id, slug: job.slug, error: err.message }).catch(() => {});
      if (client) {
        await status?.stop?.();
        postNotice(client, { conversationId: job.channelId, threadKey: job.threadKey, text: `⚠️ API run \`${job.id}\` failed: ${err.message}` }).catch(() => {});
      }
    }
  } finally {
    controllers.delete(job.id);
    await fireWebhook(job);
  }
}
