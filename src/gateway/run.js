// Orchestrates a single authorized message end-to-end: provision the gated folder, resolve
// the thread session, build the per-run MCP config, decide admin escalation, and run the
// headless Claude subprocess. Mention-gating and allowedUsers authorization happen upstream
// (the Slack layer) — by the time we're here, the message is cleared to run.
import {
  getChannelEntry,
  getChannelMeta,
  defaultChannelMeta,
  getComposioToken,
  getToolboxToken,
  getUser,
  isAdmin,
  isApproved,
} from "../config/store.js";
import { ensureChannelFolder } from "./folders.js";
import { memorySnapshotPrefix } from "./channel-memory.js";
import { createSkillUsageRecorder } from "./skills/usage.js";
import { withTemplateSkills } from "./skills/templates.js";
import { resolveSession, resetSession, getSession, saveSession, sessionGeneration, dropMintedSession } from "./sessions.js";
import { carrySession } from "./session-carry.js";
import { buildEngineMcpRuntime } from "./run-engine-mcp.js";
import { composioIdentitiesForRun, composioIdentityPreamble } from "./mcp.js";
import { abortPooled } from "../engines/session-pool.js";
import { DEFAULT_SILENCE_WINDOWS } from "../engines/watchdog.js";
import { mintsOwnSessionId, usesMcpConfigFile, engineSupports, requireAdapter, fallbackTargets, engineLabel, engineCredentialState, engineTransientKinds } from "../engines/registry.js";
import { validateRunContext } from "../engines/contract.js";
import { getEngine, getDefaultModel, getDmTemplate, getEngineFallback, isEngineEnabled, getEnabledEngines, ENGINES, getComposioMode, getDefaultComposioToken, getDefaultToolboxToken, getOrgAccessGrants } from "../config/settings.js";
import { claudeTokenFingerprint, resolveContainerClaudeToken } from "./claude-token-relay.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { newRunId, runtimeSupports } from "../runtimes/contract.js";
import { getThreadEngine, getThreadClean, getThreadModel, getThreadEffort } from "./thread-engine.js";
import { PROFILE_FLAGS, canManage, normalizeModeMeta, authorModeMeta } from "./modes.js";
import { NETWORK_POLICY_ENFORCED } from "../engines/network-policy.js";
import { resolveSdkSession } from "../ee/composio-sdk.js";
import { requireComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { resolveCurrentModel } from "./model-info.js";
import { runtimeIdentityPreamble } from "./runtime-identity.js";
import { runtimeAccessPreamble } from "./runtime-access.js";
import { resolveMakeToolboxRuntime } from "./make-toolbox.js";
import { modelBelongsToEngine, effortBelongsToEngine } from "../engines/registry.js";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { gatewayRoot, runTmpDir, workspaceRoot } from "../config/paths.js";
import { randomUUID } from "node:crypto";
import { createSemaphore } from "../util/semaphore.js";
import { logEvent } from "../util/logger.js";
import { resolveRunAccessGrants, resolveRunUserIdentity, userOnlySkillGrants } from "./access-grants.js";
import { assertUserSkillOverlaySupported, createRunGrantArtifacts, refreshRuntimeReadPaths } from "./run-grant-artifacts.js";
import { isForceStopping } from "./shutdown.js";
import { allowedFsRoot } from "../web/security.js";
import { licenseAdmission } from "../ee/limits.js";
import { channelEnvFingerprint, resolveChannelEnv, safeSpawnEnv } from "../config/channel-env.js";
import { browserNamespaceFor } from "./browser-env.js";
import { serviceSecretValues } from "../engines/child-env.js";
import { createSecretRedactor, redactSecretValues, redactSecretFields } from "../util/redact.js";

// For a DM that selected an org template (user/admin), overlay the template's knobs onto its
// meta. "custom" DMs and regular channels use their own meta unchanged. Engine/model/effort are
// the exception: a runtime pick made IN the DM (the /model wizard writes meta.engine/model/effort)
// wins over the template's — otherwise the wizard would be a silent no-op in every template-managed
// DM. Empty = inherit the template, as before. Model/effort are engine-specific, so each resolves
// to the first candidate (own, then template) that actually belongs to the resolved engine — a
// stale value written under the other harness (own or template) is skipped, not spawned.
export function effectiveMeta(meta) {
  if (meta?.isDM && (meta.template === "user" || meta.template === "admin")) {
    const t = getDmTemplate(meta.template);
    const engine = (ENGINES.includes(meta.engine) ? meta.engine : "") || (ENGINES.includes(t.engine) ? t.engine : "") || getEngine() || "claude";
    return normalizeModeMeta({
      ...meta,
      skills: t.skills,
      skillTemplate: typeof t.skillTemplate === "string" ? t.skillTemplate : "",
      allowedMcps: t.allowedMcps,
      allowedCodexMcps: t.allowedCodexMcps,
      model: [meta.model, t.model].find((m) => m && modelBelongsToEngine(m, engine)) || "",
      effort: [meta.effort, t.effort].find((e) => e && effortBelongsToEngine(e, engine)) || "",
      adminMode: t.adminMode,
      allowBash: t.allowBash,
      allowNetwork: t.allowNetwork,
      autoMode: t.autoMode,
      cleanMode: t.cleanMode,
      engine: meta.engine || t.engine,
    });
  }
  return normalizeModeMeta(meta);
}

// True when an engine error means "the session you tried to resume no longer exists" (vs. a real
// failure) — so we can transparently start a fresh session instead of erroring out. Claude prints
// "No conversation found with session ID: …"; Codex's `exec resume` prints "no rollout found for
// thread id …"; we also match generic thread/session wording.
// When the engine driving a turn is at a usage/session/spend limit, the run comes back as a short
// limit notice that did zero work (no tokens). Detect that so we can transparently fall back to the
// OTHER harness. After a hit we route straight to the fallback for a cooldown window instead of
// re-probing the limited engine on every message.
// The cooldown is PER CHANNEL AND PER ENGINE (keyed `engine::slug`): one channel tripping the
// detector must not reroute every other channel for 15 minutes, and Claude being limited says
// nothing about Codex's quota.
// The wording varies by limit kind: a plan/rate limit says "…hit your session/usage/weekly limit",
// while a billing/credit exhaustion says "You've hit your monthly SPEND limit · raise it at
// claude.ai/settings/usage" (seen live), and Codex says "…purchase more credits". Match all of
// them — the 0-in/0-out token guard below is the real safety against a false positive (a genuine
// answer always does work).
const LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
// A provider that stayed unavailable through the in-place retries is an OUTAGE, not a quota: the
// channel's next turns go straight to the other harness for a few minutes, then try the primary
// again — long enough to ride out the blip, short enough that the thread comes home.
const TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000;

// Transient provider failures — a 5xx, "overloaded", a connection reset, or an unexplained 404 from
// the Codex backend (2026-09-03) — are retried IN PLACE: same engine, same prompt, a short pause in
// between. Two rules keep this safe: the failure must be replay-safe (the runner proved nothing of
// the turn reached anyone — no tool ran, no text streamed; the engines already retry mid-turn
// themselves, and a gateway replay after a tool call could repeat a side effect), and
// authentication / usage-limit failures are excluded (they have their own cross-engine failover,
// and repeating them only burns the pause). Both knobs are read PER TURN, like COMMAND_TIMEOUT and
// CG_MAX_SILENCE below: `.env` and settings.json reach process.env only after this module's import
// graph has evaluated (src/server.js), so an import-time read would see neither.
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
export function transientRetryAttempts() { return clampInt(process.env.CG_TRANSIENT_RETRY_ATTEMPTS, 2, 0, 5); }
// Milliseconds, or a duration the other knobs accept ("10s", "1m"); an unparseable value keeps the default.
export function transientRetryDelayMs() { return Math.min(120_000, Math.max(0, parseDurationMs(process.env.CG_TRANSIENT_RETRY_DELAY_MS, 10_000))); }

// The kind when this error is a transient, replay-safe provider failure of the engine that ran the
// turn — "" otherwise (including every authentication / usage-limit / model-rejection case, which
// belong to the failover and model-retry paths, and any error raised after a tool ran). Which kinds
// count is the engine's own fact (`transientKinds` in src/engines/adapters.js).
export function transientProviderFailure(error, engine = "") {
  const details = error?.details || {};
  const ran = String(engine || "");
  if (!ran || details.engine !== ran || details.providerError !== true || details.replaySafe !== true) return "";
  const kind = String(details.providerKind || "");
  return engineTransientKinds(ran).includes(kind) ? kind : "";
}

// A pause that ends early when the run is cancelled, so a stop button never waits out a retry.
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    // Deliberately NOT unref'd: the pause is live work for a turn that is still running, and an
    // unreferenced timer lets an otherwise idle process exit before the retry fires.
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener?.("abort", done); resolve(); }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}
const engineLimitedUntil = new Map(); // `${engine}::${slug}` -> epoch ms the cooldown ends
const engineAuthFailedUntil = new Map(); // engine -> epoch ms; a shared daemon credential is gateway-wide
// engine -> the credential fingerprint that FAILED. A cooldown remembers a broken credential, not
// a broken engine: once the operator replaces it (`codex login`), the fingerprint changes and the
// cooldown is dropped on the next turn instead of stranding every channel for the full window.
const engineAuthFailedFingerprint = new Map();

// ── Where a turn runs (src/runtimes/) ─────────────────────────────────────────────────────────
// resolveRuntime() is the ONE decision, taken once per turn, and every backend call downstream
// takes the RuntimeTarget it returns. This indirection is a test seam and nothing else:
// production always resolves for real, but a fake backend is the only way to prove the
// ensureUp/lease/credential contract without a container binary on the machine running the suite.
let runtimeResolver = resolveRuntime;
export function setRuntimeResolver(resolver = null) {
  runtimeResolver = typeof resolver === "function" ? resolver : resolveRuntime;
}

// The directory this turn's per-run, ENGINE-FACING files go in (the --mcp-config file today; the
// grant artifacts resolve the same way in run-grant-artifacts.js). Every channel turn gets its
// channel's artifact dir, which the backend bind-mounts at the identical absolute path — nothing under gatewayRoot() may be handed
// to a containerized engine, because that tree is never mounted.
export function runArtifactRoot(target = null) {
  return target?.artifactDir || runTmpDir();
}

// A missing engine credential for an isolated runtime is a CONFIGURATION problem, not an engine
// outage: failing over to the other harness would answer a question the operator did not ask and
// hide the one thing they need to fix. Fail closed before the spawn, with the backend's own words.
function assertRuntimeCredentials(target, engine) {
  // A backend may answer with an Error or with a plain sentence; both are the operator-facing text.
  const reported = target?.runtime?.credentialError?.(target, engine);
  const message = reported ? String(reported?.message || reported).trim() : "";
  if (!message) return;
  throw Object.assign(new Error(message), {
    details: { runtimeCredential: true, runtime: target.backend, engine },
  });
}

// Test seam: the cooldown maps are module state that would otherwise leak between cases.
export function resetEngineCooldowns() {
  engineLimitedUntil.clear();
  engineAuthFailedUntil.clear();
  engineAuthFailedFingerprint.clear();
}

// Does the engine's credential differ from the one that failed? Only a POSITIVE answer — the
// adapter can read the credential, calls it usable, and it is not the failed one — releases the
// cooldown. An engine with no probe, an unreadable credential, or the same bytes keeps waiting.
async function engineCredentialReplaced(engine) {
  const state = await engineCredentialState(engine).catch(() => null);
  if (!state?.known || !state.authenticated || !state.fingerprint) return false;
  return state.fingerprint !== (engineAuthFailedFingerprint.get(engine) || "");
}

async function rememberAuthFailure(engine) {
  const state = await engineCredentialState(engine).catch(() => null);
  // Independently authenticated channel CLIs have no shared service credential. One channel's
  // sign-in failure must never suppress that engine in every other conversation.
  if (!state?.known || !state.fingerprint) return;
  engineAuthFailedUntil.set(engine, Date.now() + LIMIT_COOLDOWN_MS);
  engineAuthFailedFingerprint.set(engine, state.fingerprint);
}

// One line for a turn the user pinned: nothing was switched, and here is how to switch it. Kept
// next to the failover state it explains — the Slack layer renders the same fact for a THROWN
// failure through engineSwitchHint (message-pipeline.js).
export function pinnedNoFailoverNote(engine, other = "") {
  const move = other ? ` — say \`${other}\` in this thread to move it` : "";
  return `⚠️ _This thread is pinned to ${engineLabel(engine)}, so it was not switched to another harness${move}._\n\n`;
}

export function isUsageLimited(result) {
  const t = `${result?.content || ""}`;
  if (!/(hit|reached)[^.\n]{0,40}(session|usage|weekly|account|spend|monthly|credit)\s+limit|usage limit reached|claude ai usage limit|spend limit|claude\.ai\/settings\/usage|codex\/settings\/usage|purchase more credits|out of (credit|credits)|insufficient (funds|credit|credits|balance)/i.test(t)) return false;
  const u = result?.usage || {};
  const inT = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outT = u.output_tokens ?? u.completion_tokens ?? 0;
  return inT === 0 && outT === 0; // a real limit rejection does no work
}

// A thrown provider failure is eligible for automatic cross-engine replay only when the runner
// proved the engine emitted NO tool call. This is deliberately conservative: even a read-looking
// tool may hide a mutation behind MCP, so any attempted tool disables replay. Availability/network/
// generic provider errors remain ordinary failures; only the operator-authorized authentication
// and usage-limit cases enter fallback.
// Engine-agnostic on purpose: the error must come from the engine that actually ran this turn,
// whichever that is — Claude and Codex fail over to each other through the same code path.
export function replaySafeFallbackKind(error, engine = "") {
  const details = error?.details || {};
  const ran = String(engine || "");
  if (!ran || details.engine !== ran || details.providerError !== true || details.replaySafe !== true) return "";
  return details.providerKind === "authentication" || details.providerKind === "usage_limit"
    ? details.providerKind
    : "";
}

// A provider may reject a syntactically valid thread/channel/per-run model before generation
// starts (for example, a model unavailable to the authenticated Codex account). Retry once with
// the gateway default only when the runner positively classified that pre-work rejection. The
// requested model must match the failed spawn, and the default must be distinct and engine-valid;
// generic failures, partial output, and any tool attempt remain non-replayable.
export function replaySafeGatewayDefaultModel(error, { engine = "", model = "", defaultModel = "" } = {}) {
  const details = error?.details || {};
  const current = String(model || "").trim();
  const fallback = String(defaultModel || "").trim();
  if (!current || !fallback || current === fallback || !modelBelongsToEngine(fallback, engine)) return "";
  if (details.engine !== engine || details.providerError !== true || details.providerKind !== "model_rejected" || details.replaySafe !== true) return "";
  if (String(details.requestedModel || "").trim() !== current) return "";
  return fallback;
}

// The one sentence a substituted model gets — the primary retry and the cross-engine retry say it
// the same way. A silent substitution is the failure mode this exists to prevent: the channel's
// configured model is gone, every later turn will be answered by a different one, and only the
// person who can fix the setting is in a position to notice.
export function gatewayDefaultModelNote(rejectedModel, defaultModel) {
  return `⚠️ _${rejectedModel} was rejected before the turn started — using gateway default ${defaultModel}._\n\n`;
}

// A result that did literally NO work — empty content AND zero tokens in/out. The CLI can exit 0
// with such a result when a resume lands in a broken session state (e.g. a turn killed mid-write)
// or an API error gets swallowed into an empty result line. Callers must treat it as a FAILURE:
// posting "(no output)" as success hides a real problem (and starves the error/diagnosis path).
export function isEmptyResult(result) {
  if (`${result?.content || ""}`.trim()) return false;
  const u = result?.usage || {};
  const inT = (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outT = u.output_tokens ?? u.completion_tokens ?? 0;
  return inT === 0 && outT === 0;
}

// A turn that DID work but ended with no final message: tool calls ran, tokens were spent, and
// the engine still produced zero text. That is not an answer — it is a turn that was cut short
// (the harness aborted mid-turn, hit its own step ceiling, or dropped the reply), and delivering
// it as "(empty response)" hides both the fact and the reason. Distinct from isEmptyResult, which
// is the 0-token broken-session shape the resume-heal above repairs.
export function isAnswerlessResult(result) {
  if (`${result?.content || ""}`.trim()) return false;
  return !isEmptyResult(result);
}

// What to tell the person when a turn comes back answerless. The engine's OWN verdict leads
// (`endReason` is the CLI's result subtype — "error_during_execution", "error_max_turns", …), so
// the second occurrence is diagnosable from the thread instead of only from a server log. Two
// endings, two tones: a turn the harness ABORTED is a warning, while a turn that ended cleanly and
// simply never wrote a reply (the model's last act was a tool call — a posted chart, a saved file)
// is a fact, not an alarm. Both say the session is intact, because it is.
export function answerlessNotice(result) {
  const reason = String(result?.endReason || "").trim();
  const steps = Number(result?.toolUseCount) || 0;
  const ran = steps ? `${steps} tool call${steps === 1 ? "" : "s"} ran` : "no tools ran";
  const aborted = Boolean(result?.engineError) || (reason !== "" && reason !== "success");
  if (aborted) {
    // The harness's last words, when it left any. Already redacted and capped by the runner; kept
    // short here because this is a chat message, and quoted so it reads as the CLI's voice, not ours.
    const said = String(result?.diagnostic || "").trim().slice(0, 240);
    return (
      `⚠️ _The harness ended this turn without a final message${reason ? ` (\`${reason}\`)` : ""} — ${ran}. ` +
      "Whatever it did is kept in the session: reply here to continue it, or `/clear` to start fresh._" +
      (said ? `\n_Last output from the harness: \`${said}\`_` : "")
    );
  }
  return `_The turn finished without writing a reply — ${ran}. Reply here to continue in the same session._`;
}

// The prompt a session-heal retry runs with: the Slack thread transcript, a session-was-lost note,
// then the original turn text. Returns null when there's no transcript to inject (no fetcher was
// provided or the fetch came back empty) — the caller then retries with the bare turn text, which
// is today's behavior for non-Slack callers (background replays, schedules).
export function buildHealedPrompt(ctx, turnText) {
  if (!ctx) return null;
  return (
    ctx +
    "[Your previous session for this thread was lost (broken/expired session state) and a fresh " +
    "one was started. The transcript above is the conversation so far — treat it as your own " +
    "prior context, continue the SAME conversation, and handle the latest request below.]\n\n" +
    turnText
  );
}

// Which engine does an EXISTING thread's turn actually run on? A thread sticks to the engine that
// owns its session: flipping the channel/global harness must not force-reset a live conversation
// (a session id can't resume cross-engine, so a "switch" means a fresh session and losing the
// thread's context). Only an EXPLICIT ask for this thread/run — a "claude"/"codex" directive, the
// /model wizard's thread scope, or a per-run API engine override — switches it; the caller then
// starts the fresh session (and replays the thread transcript into it, like a session heal). The
// usage-limit Codex fallback is separate and untouched: it runs under a suffixed session key and
// never re-stamps the thread. New or unlabeled (pre-v4) sessions have nothing to stick to.
export function decideThreadEngine({ requested, sessionEngine, isNew, explicit }) {
  if (isNew || !sessionEngine || sessionEngine === requested) return { engine: requested, switch: false };
  return explicit ? { engine: requested, switch: true } : { engine: sessionEngine, switch: false };
}

export function isSessionNotFound(err) {
  // message + stderr only (not stdout) so the agent's own text can't trigger a false reset.
  const hay = `${err?.message || ""}\n${err?.details?.stderr || ""}`.toLowerCase();
  // Last two alternatives: Claude rejects a resume id it didn't mint — a MISSING uuid prints "No
  // conversation found…", but a MALFORMED one (e.g. a Codex thread_id fed to `claude -r` after a
  // harness switch) prints "--resume requires a valid session ID …/… is not a UUID". Treat both as
  // "unresumable" so the caller starts a fresh session instead of surfacing the error.
  return /no conversation found|conversation not found|session not found|no such (session|thread|conversation)|(session|thread)[^\n]*\bnot found|could not (find|resume)[^\n]*(session|thread|conversation)|unknown (session|thread)|no rollout found|rollout not found|failed to resolve rollout path[^\n]*file does not exist|--resume requires a valid session|is not a uuid|thread\/resume failed:\s*list_turns is not supported yet/.test(hay);
}

export function parseDurationMs(value, fallback = 10 * 60 * 1000) {
  if (!value) return fallback;
  const m = /^(\d+)(ms|s|m)?$/i.exec(String(value).trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  return unit === "m" ? n * 60_000 : unit === "s" ? n * 1_000 : n;
}
export const parseTimeoutMs = parseDurationMs;

export function progressReportIsVisible({ progressReport = false, clean = false } = {}) {
  return Boolean(progressReport) && !clean;
}

export function createScopedRunEventHandler(onEvent, options = {}) {
  const progressReportEnabled = progressReportIsVisible(options);
  return (event) => {
    if (!progressReportEnabled && event?.kind === "report_progress") return;
    return onEvent?.(event);
  };
}

// Warm-session keep-alive: how long a thread's Claude process stays alive idle before it is
// terminated (default 10 min, per the user's request for fast follow-ups). Set to 0 to disable
// warm sessions entirely (every message spawns a fresh one-shot process).
function keepAliveMs() {
  return parseDurationMs(process.env.SESSION_KEEPALIVE, 10 * 60 * 1000);
}

// Global cap on concurrent runs through runMessage (interactive turns plus background/schedule
// continuations — bg jobs and schedules have their own upstream caps, but they all funnel here).
// Without it a message burst spawns unbounded `claude`/`codex` processes. Configurable via
// MAX_CONCURRENT_RUNS (default 8). Lazily created so .env / settings.json are loaded first;
// excess runs queue FIFO rather than failing (the C4/H4 watchdogs keep slots from leaking).
//
// Two lanes, one pool: background-origin runs (schedules, background agents, continuations,
// recovery, diagnosis) can legitimately hold a slot for hours, so a deep queue of them used to
// starve live users — enough agent jobs took all the slots and every Slack turn parked behind
// work that might run for days. Background runs now clear a SECOND, smaller semaphore first
// (total − RESERVED_INTERACTIVE_RUNS, floor 1), so at most that many ever hold OR wait for a
// global slot; the reserved remainder is reachable only by interactive turns. FIFO within each
// class, and the starvation guarantee is structural: a background run can only be queued on the
// GLOBAL semaphore while it holds a lane slot, so at most `background` of them can ever sit ahead
// of an interactive turn — never the unbounded background backlog. Each of those is granted (and
// leaves the queue) as a slot frees, so an interactive turn's position strictly decreases and it
// always eventually runs.
const INTERACTIVE_RUN_ORIGINS = new Set(["slack_foreground", "googlechat_foreground", "msteams_foreground", "api_foreground"]);
let runSemaphore = null;
let backgroundRunSemaphore = null;

function runSlotCaps() {
  const n = Number.parseInt(process.env.MAX_CONCURRENT_RUNS ?? "", 10);
  const total = Number.isFinite(n) && n > 0 ? n : 8;
  const r = Number.parseInt(process.env.RESERVED_INTERACTIVE_RUNS ?? "", 10);
  const reserved = Number.isFinite(r) && r >= 0 ? r : 2;
  return { total, background: Math.max(1, total - reserved) };
}

function ensureRunSemaphores() {
  if (!runSemaphore) {
    const caps = runSlotCaps();
    runSemaphore = createSemaphore(caps.total);
    backgroundRunSemaphore = createSemaphore(caps.background);
  }
}

// Test seam: the semaphores are lazy module state sized from env on first use.
export function resetRunSlots() {
  runSemaphore = null;
  backgroundRunSemaphore = null;
}

// Observability (and a test seam): how many slots are held and how many runs are parked, per lane.
export function runSlotStats() {
  ensureRunSemaphores();
  return {
    active: runSemaphore.active,
    pending: runSemaphore.pending + backgroundRunSemaphore.pending,
    backgroundActive: backgroundRunSemaphore.active,
    backgroundPending: backgroundRunSemaphore.pending,
  };
}

// How many runs are still parked in the lane a waiter of this origin queues in — recomputed by the
// ticker below as that queue drains. An interactive turn never counts the background backlog,
// because it never sits behind it.
function pendingRunsFor(origin) {
  if (INTERACTIVE_RUN_ORIGINS.has(origin)) return runSemaphore?.pending ?? 0;
  return (runSemaphore?.pending ?? 0) + (backgroundRunSemaphore?.pending ?? 0);
}

export async function acquireRunSlot({ signal = null, onWait = null, origin = "" } = {}) {
  ensureRunSemaphores();
  if (INTERACTIVE_RUN_ORIGINS.has(origin)) return runSemaphore.acquire({ signal, onWait });
  // Background lane: clear the lane cap first, then take a global slot. Report the wait once,
  // from whichever stage actually queues first.
  let reported = false;
  const onWaitOnce = onWait
    ? (info) => {
        if (reported) return;
        reported = true;
        onWait(info);
      }
    : null;
  const releaseLane = await backgroundRunSemaphore.acquire({ signal, onWait: onWaitOnce });
  try {
    const releaseRun = await runSemaphore.acquire({ signal, onWait: onWaitOnce });
    return () => {
      releaseRun();
      releaseLane();
    };
  } catch (error) {
    releaseLane(); // aborted between stages — never strand the lane slot
    throw error;
  }
}

// How often a still-queued turn repeats its position, so a long wait keeps moving on screen
// instead of freezing on the first notice.
const QUEUE_REPORT_MS = 20_000;

// How long a runtime cold start may take before the turn says so. A warm channel starts in well
// under this, and announcing that would be noise; anything slower is a wait the user can see.
const RUNTIME_WARMUP_NOTICE_MS = 2_000;

// Park on the global run slot, keeping the user informed the whole time.
//
// The report comes from INSIDE acquire() — a turn that starts immediately never claims it queued,
// and one that does queue reports its real position. While it waits, the position is re-reported
// on a timer (the queue ahead of it shrinks, which is the useful signal), and the wait is
// cancellable: a stop leaves the queue instead of consuming a slot later just to throw.
async function acquireRunSlotWithStatus({ signal, onEvent, origin }) {
  let ticker = null;
  const report = (position, queuedForMs) => {
    try {
      onEvent?.({ kind: "run_queued", scope: "gateway", position, queuedForMs });
    } catch {
      /* a status callback must never block a run */
    }
  };
  try {
    const release = await acquireRunSlot({
      signal,
      origin,
      onWait: ({ position }) => {
        const startedAt = Date.now();
        report(position, 0);
        ticker = setInterval(() => {
          // `pending` shrinks as runs ahead finish, so recompute rather than repeating the
          // position we were given when we joined — from the lane this run actually waits in, so a
          // Slack turn never reports the background backlog it is not queued behind.
          const ahead = Math.min(position, pendingRunsFor(origin) + 1);
          report(ahead, Date.now() - startedAt);
        }, QUEUE_REPORT_MS);
        ticker.unref?.();
      },
    });
    return release;
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

function resolveTokenSource({ clean, channelToken, userToken, defaultToken, noOrg }) {
  if (clean) return { token: "", source: "clean" };
  if (channelToken) return { token: channelToken, source: "channel" };
  if (userToken) return { token: userToken, source: "user" };
  if (!noOrg && defaultToken) return { token: defaultToken, source: "org" };
  return { token: "", source: noOrg ? "none-no-org-default" : "none" };
}

// Composio is intentionally different from the other token-backed integrations: expose the active
// author's identity and the gateway's shared identity at the same time instead of choosing one.
// `composio-user` is personal-only; shared `composio` is channel-first, then org-default.
// A DM is a private, one-person conversation: there is no shared audience to act on behalf of, so
// the shared identity (channel token AND the org default) is suppressed there and only the
// author's personal `composio-user` is injected. Everything else keeps both identities.
export function resolveComposioConnections({ clean = false, userToken = "", channelToken = "", defaultToken = "", noOrg = false, isDM = false } = {}) {
  if (clean) {
    return {
      user: { token: "", source: "clean" },
      shared: { token: "", source: "clean" },
    };
  }
  const user = { token: userToken || "", source: userToken ? "user" : "none" };
  if (isDM) return { user, shared: { token: "", source: "none-dm" } };
  return {
    user,
    shared: channelToken
      ? { token: channelToken, source: "channel" }
      : !noOrg && defaultToken
        ? { token: defaultToken, source: "org" }
        : { token: "", source: noOrg ? "none-no-org-default" : "none" },
  };
}

export async function resolveComposioRuntime({
  clean = false,
  mode = "personal",
  workspaceId = "",
  channelId = "",
  authorId = "",
  threadKey = "",
  meta = {},
  authorIsAdmin = false,
  authorIsApproved = false,
  userToken = "",
  channelToken = "",
  defaultToken = "",
  noOrg = false,
  isDM = false,
  principalTrusted = true,
  resolveSdk = resolveSdkSession,
} = {}) {
  if (clean || mode !== "sdk") {
    const legacy = resolveComposioConnections({
      clean,
      userToken: principalTrusted ? userToken : "",
      channelToken,
      defaultToken,
      noOrg,
      isDM,
    });
    return {
      mode: mode === "sdk" ? "sdk" : "personal",
      user: { ...legacy.user, endpoint: null },
      shared: { ...legacy.shared, endpoint: null },
    };
  }

  requireComposioSdkEntitlement();
  const mayManageShared = principalTrusted && canManage(meta, {
    authorId,
    isAdminUser: authorIsAdmin,
    isApprovedUser: authorIsApproved,
  });
  const [userResult, sharedResult] = await Promise.allSettled([
    principalTrusted ? resolveSdk({
      workspaceId,
      kind: "user",
      id: authorId,
      threadKey,
      accessKind: "owner",
      manageConnections: true,
    }) : null,
    // Same rule as personal mode: a DM has no shared audience, so no channel session is minted.
    isDM
      ? null
      : resolveSdk({
        workspaceId,
        kind: "channel",
        id: channelId,
        threadKey,
        accessKind: mayManageShared ? "manager" : "member",
        manageConnections: mayManageShared,
      }),
  ]);

  return {
    mode: "sdk",
    user: !principalTrusted
      ? { token: "", source: "none-untrusted-principal", endpoint: null }
      : userResult.status === "fulfilled"
      ? { token: "", source: "sdk-user", endpoint: userResult.value }
      : { token: "", source: "sdk-unavailable", endpoint: null },
    shared: isDM
      ? { token: "", source: "none-dm", endpoint: null }
      : sharedResult.status === "fulfilled"
        ? { token: "", source: "sdk-channel", endpoint: sharedResult.value }
        : { token: "", source: "sdk-unavailable", endpoint: null },
  };
}

// Merge the HTTP run API's per-request overrides into the channel meta. An override may only
// REDUCE capability, never introduce adminMode: the run-API key is not an admin credential
// (web/auth.js) and that path's authorId is caller-supplied, so letting `mode:"full"` set
// adminMode would hand any key holder an unsandboxed run by naming a known admin's Slack id
// (those ids are public). A channel that is ALREADY adminMode keeps its own setting.
//
// It also never picks a runtime BACKEND. Which machine boundary a channel's turns run behind is
// durable configuration (an admin's per-channel pin plus the gateway default); letting a request
// body move a turn between backends would be an API caller choosing its own confinement. So
// `runtime` is not copied here, and runMessage resolves the backend from the CHANNEL's stored
// adminMode/runtime rather than from this overridden view.
export function applyRunOverrides(meta, overrides) {
  if (!overrides) return meta;
  const o = {};
  if (overrides.model) o.model = String(overrides.model);
  if (overrides.effort) o.effort = String(overrides.effort);
  if (overrides.engine && ENGINES.includes(overrides.engine)) o.engine = overrides.engine;
  if (overrides.mode && PROFILE_FLAGS[overrides.mode]) {
    const requested = PROFILE_FLAGS[overrides.mode];
    // Modes express capabilities, not independent booleans: Full and Auto also permit shell
    // tools. Intersect with the stored maximum, and keep clean mode sticky because disabling it
    // would restore connectors/skills that the channel deliberately removed.
    o.adminMode = Boolean(requested.adminMode && meta.adminMode);
    o.allowBash = Boolean(requested.allowBash && (meta.allowBash || meta.autoMode || meta.adminMode));
    o.autoMode = Boolean(requested.autoMode && (meta.autoMode || meta.adminMode));
    o.cleanMode = Boolean(meta.cleanMode || requested.cleanMode);
    o.profile = Object.entries(PROFILE_FLAGS).find(([, flags]) =>
      Object.keys(flags).every((key) => Boolean(o[key]) === flags[key]))?.[0] || "custom";
  }
  delete o.runtime; // a mode profile must never carry a backend pin into a run
  return { ...meta, ...o };
}

// Every run names its origin — the structural answer to "who set this turn in motion?"
// (the 2026-08 update plan (internal repo) A2). The old optional `unattended` boolean depended on every call site
// remembering to pass it; recovery, diagnosis, and both background paths forgot, and each of
// those could therefore inherit an admin's Full-mode escalation for a prompt no human was
// watching. Origin is mandatory: runMessage refuses to run without a known one. The list lives
// in ONE place (contract.js, frozen) — a divergent copy here once meant an origin admitted by
// this gate could still throw mid-turn at validateRunContext, after side effects.
import { RUN_ORIGINS, PRINCIPAL_KIND_BY_ORIGIN } from "../engines/contract.js";
export { RUN_ORIGINS };

// The ONLY origin that may escalate: a live Slack turn, authored by a Slack-authenticated human
// who is watching it run. Everything daemon-triggered (schedule/background/continuation/recovery/
// diagnosis) fires a prompt persisted earlier — injected content during an admin's turn must not
// become a silent full-machine run later. api_foreground stays out too: the run-API key
// authenticates the caller, not the author it names (see untrustedPrincipal below).
// Google Chat and Teams turns are deliberately NOT here. Both are authored by an authenticated
// human, but escalation's other half is an interactive permission prompt the author can answer, and
// neither surface has one wired yet (src/platforms/ingest.js). An admin-mode channel on those
// surfaces therefore runs at the folder's allowlist like everyone else, which fails closed. This
// set gains a platform when that platform gains an approval UI — never before.
const ESCALATABLE_ORIGINS = new Set(["slack_foreground"]);

// Escalation (--dangerously-skip-permissions + the bypass-allowing settings variant) requires an
// escalatable origin AND an adminMode channel AND an admin author — and is refused regardless for
// untrustedPrincipal: we never authenticated the author. Slack does that for us; the HTTP run
// API authenticates only the CALLER and takes `author` from the request body.
//
// Refused runs still work — they use the folder's permission allowlist like every other run.
// Unknown/missing origin fails closed here as a second layer even though runMessage already threw.
export function mayEscalate({ meta = {}, isAdminAuthor = false, untrustedPrincipal = false, origin = "" } = {}) {
  return ESCALATABLE_ORIGINS.has(origin) && Boolean(meta.adminMode) && Boolean(isAdminAuthor) && !untrustedPrincipal;
}

// Admin outranks auto. A run that may NOT escalate (any daemon origin, or a foreground turn that
// failed mayEscalate) but whose stored author is an admin in an adminMode channel is upgraded to
// the AUTO tier: writable work folder + auto-approved permission prompts. It is a tier, not an
// escalation — the permission bypass remains foreground-only (A2), untrusted principals never
// qualify, and a non-admin author in the same channel stays at the read floor.
export function adminUnattendedTier({ meta = {}, isAdminAuthor = false, untrustedPrincipal = false, dangerouslySkip = false } = {}) {
  return !dangerouslySkip && Boolean(meta.adminMode) && Boolean(isAdminAuthor) && !untrustedPrincipal;
}

function assertRuntimeCanStart() {
  if (isForceStopping()) {
    throw Object.assign(new Error("Gateway is completing a forced shutdown"), { name: "AbortError" });
  }
}

export async function runMessage({ channelId, authorId, workspaceId = "", text, threadKey, attachments = [], signal = null, onDelta, onEvent, onRuntimeResolved, sessionId: presetSessionId = "", overrides = null, getFallbackContext = null, preferCold = false, progressReport = false, untrustedPrincipal = false, origin = "", fallbackPolicy = "" }) {
  // Fail closed before anything else: a run with no declared origin is a programming error, not a
  // default-to-interactive.
  if (!RUN_ORIGINS.includes(origin)) throw new Error(`runMessage requires a valid origin (got ${JSON.stringify(origin)}); one of: ${RUN_ORIGINS.join(", ")}`);
  assertRuntimeCanStart();
  const entry = await getChannelEntry(channelId);
  if (!entry) throw new Error(`channel ${channelId} is not registered`);

  // Subagent completion is enforced mechanically, not by instruction: the per-channel lockdown
  // installs a Stop hook (folders.js → hooks/stop-subagents.mjs) that blocks a Claude turn from
  // ending while background Agent/Task subagents are running; Codex's own orchestrator already
  // joins subagents before a turn completes. Work meant to OUTLIVE the turn goes through the
  // daemon's run_in_background / run_agent_in_background tools, which re-invoke the thread.
  const turnText = String(text ?? "");

  // The channel tier is the assigned skill template's CURRENT skills plus the conversation's own
  // additions (skills/templates.js) — resolved live, so a template edit reaches every follower.
  const channelMeta = withTemplateSkills(effectiveMeta(
    (await getChannelMeta(entry.slug)) ??
      defaultChannelMeta({ channelId, name: entry.name, type: entry.type, isDM: entry.isDM })
  ));

  // Resolve the durable org+channel baseline separately from this run's trusted user tier. The
  // HTTP run API authenticates only its API key; its caller-supplied Slack author id must never
  // read a stored user record or inherit that person's grants.
  const runGrants = await resolveRunAccessGrants({
    organization: getOrgAccessGrants(),
    channel: channelMeta,
    authorId,
    untrustedPrincipal,
    loadUser: getUser,
  });
  let meta = { ...channelMeta, ...runGrants.effective };

  // Per-run overrides (the HTTP run API can pass engine/model/effort/mode per request). Applied
  // after effectiveMeta so they win over the channel/DM-template config, and before folder
  // provisioning + the clean check so `mode:lean`→cleanMode is honored everywhere. `mode` expands
  // to the capability flags.
  //
  // An override may only REDUCE capability, never introduce adminMode: the run-API key is not an
  // admin credential (web/auth.js), and `authorId` on that path is caller-supplied, so allowing
  // `mode:"full"` to set adminMode would let any key holder name an admin and get an unsandboxed
  // --dangerously-skip-permissions run. The channel's own stored adminMode still stands.
  meta = authorModeMeta(meta, { isAdminAuthor: !untrustedPrincipal && await isAdmin(authorId), untrustedPrincipal });
  meta = applyRunOverrides(meta, overrides);

  // Per-thread clean override (the "/clean" directive): this thread runs with channel-cleanMode
  // semantics regardless of the channel's own mode. Resolved here (not just in the Slack layer)
  // so folder provisioning, MCP config, and skills all see the same effective meta — and so
  // scheduler/background/recovery turns that land in a clean thread stay clean too.
  if (!meta.cleanMode && (await getThreadClean(entry.slug, threadKey))) meta = { ...meta, cleanMode: true };

  // Engine: an explicit per-run API override is the most specific ask and beats everything
  // (matching the model/effort override precedence below); otherwise the per-thread override (a
  // "claude"/"codex" directive or the /model wizard's thread scope) wins, then the channel's
  // engine, then the global default. For an EXISTING thread this is only the requested engine:
  // the session's own engine can still outrank a channel/global value (see decideThreadEngine).
  const threadEngine = overrides?.engine && ENGINES.includes(overrides.engine) ? "" : await getThreadEngine(entry.slug, threadKey);
  const channelEngine = ENGINES.includes(meta.engine) ? meta.engine : "";
  let engine = threadEngine || channelEngine || getEngine();
  // Explicit = the ask names an engine for THIS thread/run specifically (per-run API override or
  // per-thread directive/wizard). Channel/global values are defaults, not asks — an existing
  // thread outranks them and keeps running on the engine its session was born under (see
  // decideThreadEngine below).
  let engineExplicit = Boolean(threadEngine || (overrides?.engine && ENGINES.includes(overrides.engine)));
  // The same fact, captured BEFORE the disabled-harness substitution below can set the flag for
  // its own reasons: did a PERSON name this harness for this thread/run? It decides whether
  // automatic cross-engine failover is allowed to answer as the other harness (see below).
  const enginePinnedByUser = engineExplicit;

  // An admin turned this harness OFF in Settings. Every stored pointer to it — the global default,
  // a channel override, a thread's own "/codex" directive — becomes stale the moment that switch
  // flips, so substitute the first enabled engine rather than spawning a CLI that must not run.
  // Marked EXPLICIT so an existing thread doesn't stick to the disabled engine's session: it gets
  // a fresh session on the enabled harness with the thread transcript replayed into it.
  if (!isEngineEnabled(engine)) {
    const substitute = getEnabledEngines()[0] || "";
    if (substitute && substitute !== engine) {
      console.warn(`[gateway] ${entry.slug}/${threadKey}: harness ${engine} is disabled in settings — running on ${substitute}`);
      engine = substitute;
      engineExplicit = true;
    }
  }

  // ── License admission (src/ee/limits.js) ────────────────────────────────────────────────────
  // The last gate before this turn has ANY side effect: the folder is not provisioned, no session
  // is minted or reset, no engine is spawned, and nothing is billed. It sits here rather than
  // beside the run-slot semaphore below on purpose — a refused turn should not queue for a slot it
  // will never use, and it must not have provisioned a folder it will never run in.
  //
  // A refusal is NOT an error and NOT silence. It returns a normal-shaped result whose content is
  // the notice, so every origin delivers it on the same path a real answer takes: the Slack
  // pipeline posts it, deliverResult posts it for schedules/diagnosis/recovery, the background
  // agent reports it, and the run API returns it. That is deliberately ONE message — routing a
  // refusal through postNotice as well would double-post it in every one of those paths.
  //
  // The 80% warning rides on an ADMITTED turn: it is prefixed to the answer the user is already
  // getting, the same way the cross-engine failover note is, so it costs no extra message and
  // cannot be missed.
  const admission = licenseAdmission({ conversationId: channelId, origin });
  if (!admission.allowed) {
    await logEvent("license_run_refused", {
      channel: channelId,
      slug: entry.slug,
      author: authorId,
      threadKey,
      origin,
      reason: admission.reason,
      month: admission.month,
      runs: admission.runs,
      limits: admission.limits,
    });
    return {
      slug: entry.slug,
      cwd: "",
      model: "",
      engine,
      content: admission.notice,
      licenseRefused: true,
      licenseReason: admission.reason,
      licenseMonth: admission.month,
      sessionId: null,
      isNew: false,
      usage: {},
      costUSD: 0,
      durationMs: 0,
    };
  }
  const licenseWarning = admission.warning ? `${admission.warning}\n\n` : "";

  // Durable provisioning gets only org+channel access grants. User additions ride in isolated
  // run artifacts below; they must never rewrite the shared settings file or .claude/skills tree.
  const provisionMeta = { ...channelMeta, ...runGrants.shared };

  // ── Where this turn runs (src/runtimes/) ──────────────────────────────────────────────────
  // Resolved ONCE, here, and handed to everything downstream: the folder generator (policy only —
  // the container is the confinement), the MCP config builder (bridge vs stdio server), the engine
  // runner (spawn/probe/signal), the artifact paths, and the session/status stamps. Nothing below
  // asks "is this a container?" — it asks the target's declared capabilities.
  //
  // cleanMode is taken from the RUN meta on purpose — it changes the cwd the container mounts.
  const target = runtimeResolver(entry.slug, meta);
  const isolatedRuntime = runtimeSupports(target, "isolated");
  // The engine's own credential inside an isolated runtime: the container has no access to the
  // daemon's Claude state dir, so a setup-token — or a relay of the resolved login's current access
  // token, refreshed first — is what authenticates it (src/gateway/claude-token-relay.js).
  // A third outcome carries no token at all: the daemon authenticates with its own ANTHROPIC_API_KEY,
  // which already rides into the child through child-env.js's passthrough list.
  //
  // Resolved once per turn and memoized, because a cross-engine failover TO Claude needs the same
  // token and must not pay for (or race) a second refresh.
  let claudeRelayPromise = null;
  const claudeRelayOnce = () => (claudeRelayPromise ||= resolveContainerClaudeToken());
  // Fail closed: inside a container there is no other way in, so no token is a configuration
  // error the operator must see.
  const claudeCredentialFor = async (forEngine) => {
    if (forEngine !== "claude") return null;
    const relay = await claudeRelayOnce();
    if (relay.token || relay.source === "api-key") return relay;
    throw Object.assign(new Error(`This channel runs in a container, but ${relay.error}.`), {
      details: { runtimeCredential: true, runtime: target.backend, engine: forEngine },
    });
  };
  // Resolved AFTER the session decides which harness actually runs this turn (below): the engine
  // here is still the channel's, and a thread that stays on Claude while its channel moved to Codex
  // would otherwise spawn Claude with no token at all — inside a container that is "Not logged in"
  // (live, 2026-09-03: a Codex channel whose thread had started on Claude).
  // The stamp a session row carries so /status and /resume can name the environment it was minted
  // in. Host rows read "host"; a container row remembers the image and the create-time
  // fingerprint, so a recreated container is visibly a different environment.
  const runtimeStamp = JSON.stringify({
    backend: target.backend,
    fingerprint: target.runtime.fingerprint(target),
    image: target.container?.image || "",
  });
  // What the live surfaces need to say "this turn is running in a container": the heartbeat row's
  // suffix, the reply footer's image tag, the dashboard's active-run record. A declared capability
  // rather than a backend id, so no display layer has to know what backends exist.
  const runtimeSignal = Object.freeze({
    runtime: target.backend,
    isolated: isolatedRuntime,
    container: target.container?.name || "",
    image: target.container?.image || "",
  });

  const { cwd, settingsFile, adminSettingsFile } = await ensureChannelFolder(entry.slug, provisionMeta, { runMeta: meta, target });
  // A caller may pre-mint the session id (the HTTP run API does, so it can hand back a resume
  // command before the run finishes). Treat it as a NEW session — Claude then CREATES it via
  // --session-id instead of trying to resume a non-existent id — and persist it so later turns in
  // this thread resume the same conversation. Only pass this for a brand-new threadKey.
  // `sessionEngine` = the harness that owns the resolved session ("" for a pre-v4/legacy row, or a
  // brand-new one which is stamped with `engine` on mint). A new/preset session already runs under
  // `engine`, so default to it and only learn otherwise from an EXISTING row below.
  let sessionId, isNew, sessionEngine = engine, switchedEngine = false, sessionRuntime = "";
  // A /clear (or stop) that landed while the folder was being provisioned already terminalized
  // this turn — bail BEFORE touching the session table, or resolveSession's mint would put a live
  // (never-created) session id straight back on the thread the user just cleared.
  if (signal?.aborted) throw Object.assign(new Error("Run aborted before it started"), { name: "AbortError" });
  // /clear guard: capture the thread's clear-generation before the first session write. Every
  // later save/reset in this turn carries it, so a /clear that lands mid-run leaves a durable
  // tombstone — this run's late unwind (a subprocess that finished at the kill, a resume-heal
  // re-mint, the Codex-fallback save) is silently dropped instead of resurrecting the session.
  const sessionGen = sessionGeneration(entry.slug, threadKey);
  if (presetSessionId) {
    await saveSession(entry.slug, threadKey, presetSessionId, engine, sessionGen, runtimeStamp);
    sessionId = presetSessionId;
    isNew = true;
  } else {
    ({ sessionId, isNew, engine: sessionEngine, runtime: sessionRuntime } = await resolveSession(entry.slug, threadKey, engine, runtimeStamp));
    // The stored session was minted by a DIFFERENT engine than the one this turn resolved to.
    // A session id is engine-specific — Claude can't resume a Codex thread_id and vice-versa — so a
    // cross-engine resume is never attempted. Which side wins is decideThreadEngine's call: an
    // explicit per-thread/per-run ask switches (fresh session under the new engine, thread
    // transcript replayed into it below); a mere channel/global harness change does NOT — the
    // thread sticks to its own engine and resumes normally. Pre-v4 rows (engine '') are treated as
    // a match and left to the resume-not-found safety net below (then back-filled on success).
    const picked = decideThreadEngine({ requested: engine, sessionEngine, isNew, explicit: engineExplicit });
    if (picked.switch) {
      // Evict any warm process still bound to the old session id first, so the new --session-id
      // actually takes effect (the pool fingerprints on config, not the session id).
      console.warn(`[gateway] ${entry.slug}/${threadKey}: harness switched ${sessionEngine}→${engine} — starting a fresh ${engine} session`);
      abortPooled(`${entry.slug}::${threadKey}`);
      sessionId = await resetSession(entry.slug, threadKey, engine, sessionGen, runtimeStamp);
      isNew = true;
      switchedEngine = true;
    } else if (picked.engine !== engine) {
      console.log(`[gateway] ${entry.slug}/${threadKey}: channel harness is ${engine} but this thread started on ${picked.engine} — continuing on ${picked.engine}`);
      engine = picked.engine;
    }
  }

  // A row THIS turn minted carries its harness stamp before anything has run. If the turn dies
  // before its engine process ever starts, the stamp must not outlive it — see dropMintedSession.
  // `engineStarted` flips at the spawn; the two pre-spawn gates (the Claude relay just below, and
  // the backend credential/warm-up inside the main try) are what this exists for.
  const mintedThisTurn = isNew && !presetSessionId;
  let engineStarted = false;
  const dropUnusedSession = async () => {
    if (!mintedThisTurn || engineStarted) return;
    try {
      if (await dropMintedSession(entry.slug, threadKey, sessionId)) {
        console.log(`[gateway] ${entry.slug}/${threadKey}: dropped the ${engine} session minted for a turn that never started`);
      }
    } catch (e) {
      console.warn(`[gateway] ${entry.slug}/${threadKey}: could not drop the unused session: ${e?.message || e}`);
    }
  };

  // The Claude credential for the harness that will actually run — settled only now (see above).
  let claudeRelay;
  try {
    claudeRelay = await claudeCredentialFor(engine);
  } catch (error) {
    await dropUnusedSession();
    throw error;
  }
  const claudeOauthToken = claudeRelay?.token || "";
  // What the warm pool keys on: the login's SOURCE and the expiry of the token this turn was
  // handed, never the token text. A refresh moves the expiry, which retires a warm process still
  // holding the old token — it cannot refresh one itself, an env token has no refresh half.
  const claudeTokenFp = claudeTokenFingerprint(claudeRelay);

  // ── The thread's engine history follows it across runtime backends ────────────────────────────
  // The session row names WHERE the newest copy of this thread's engine-native history lives. When
  // that is not where this turn is about to run — the channel was containerized, or moved back to
  // the host — the resume would find nothing and the turn would be HEALED instead: a fresh session
  // with the chat transcript replayed, losing compactions, tool results and subagent transcripts.
  // So the files are carried across first, lazily and per session. Only for a resume: a new, preset
  // or engine-switched session has no history to carry. Never fatal — every failure inside falls
  // back to the heal that was already there. See gateway/session-carry.js.
  let sessionCarried = "";
  if (!presetSessionId && !isNew && !switchedEngine) {
    // Reading the other environment can mean a cold container start, and this is before the turn's
    // own warm-up notice is armed. A wait nobody can see is the failure mode the heartbeat rules
    // exist to prevent, so it gets the same "only once it is actually slow" line.
    const carryTimer = setTimeout(() => {
      try {
        onEvent?.({ kind: "notice", scope: "gateway", text: "Bringing this thread's history across to the new runtime…" });
      } catch { /* a status callback must never block a run */ }
    }, RUNTIME_WARMUP_NOTICE_MS);
    carryTimer.unref?.();
    let carried = null;
    try {
      carried = await carrySession({
        engine, sessionId, cwd, storedRuntime: sessionRuntime, target, slug: entry.slug, threadKey,
      });
    } finally {
      clearTimeout(carryTimer);
    }
    sessionCarried = carried?.direction || "";
    if (sessionCarried) {
      // Re-stamp the row NOW, not at the end of the turn. A Claude resume that goes well writes
      // nothing back to the session table (only a self-minting engine, a heal or a legacy back-fill
      // does), so a row left saying "host" would make the NEXT turn carry the stale host copy back
      // over the container copy this turn is about to extend — losing exactly the history the carry
      // exists to preserve. `sessionEngine` keeps the row's own engine label untouched; the /clear
      // generation guard still applies, so a clear that lands mid-run wins.
      await saveSession(entry.slug, threadKey, sessionId, sessionEngine, sessionGen, runtimeStamp);
    }
  }

  // Clean mode: run bare — inject NO MCP servers (not even the gateway control server), no
  // personal/shared Composio and Skills tokens, and strip the skills-favorites block. The goal is to load
  // as close to the model's base prompt as possible (no MCP tool schemas, no skills catalog).
  const clean = Boolean(meta.cleanMode);
  const userSkills = clean ? [] : userOnlySkillGrants(runGrants);

  // The channel's OWN environment secrets (config/channel-env.js) — its per-project CLI logins.
  // Resolved once per turn and handed to the engine as process environment: never a file the run
  // can read, never another channel's. Clean mode runs bare, so it gets none, for the same reason
  // it gets no MCP servers and no Composio tokens. A resolve FAILURE throws: a turn that quietly
  // ran without the credential looks like a deploy that did nothing.
  const channelEnv = clean ? {} : safeSpawnEnv(await resolveChannelEnv(meta));
  const channelEnvFp = channelEnvFingerprint(channelEnv);
  // Which browser daemon this channel's browser MCP server attaches to. Unconditional — clean
  // mode included: it injects no MCP servers, but the isolation must not depend on that staying
  // true, and a namespace costs nothing when nothing reads it. See gateway/browser-env.js.
  const browserNamespace = browserNamespaceFor({ platform: meta.platform, slug: entry.slug });
  // Write-only in the UI is not write-only at runtime — the agent can read its own environment and
  // a failing CLI will echo a token into its error line. Redact the values out of everything this
  // turn says, in the stream (holdback, so a value split across two deltas still matches) and in
  // the final content. Both must use the same values or finalize()'s streamed-prefix check breaks.
  const outputSecrets = [...Object.values(channelEnv), ...serviceSecretValues()];
  // Resolve integration credentials before constructing the streaming holdback. No engine has
  // started yet, so all values passed to either primary or fallback are covered from its first byte.
  let deltaRedactor;
  const scopedOnDelta = !onDelta ? onDelta : (text) => {
    deltaRedactor ||= createSecretRedactor(outputSecrets);
    const safe = deltaRedactor.push(text);
    if (safe) onDelta(safe);
  };
  const progressReportEnabled = progressReportIsVisible({ progressReport, clean });
  // Native `/loop` pacing (see engines/loop-wakeup.js). The harness's wakeup/cron timers cannot
  // outlive this process, so the daemon reads the model's LAST pacing decision off the stream and
  // hands it to the caller on the result; whoever owns a thread to post into decides whether to
  // arm it. Deliberately not forwarded to `onEvent`: it is control data for the daemon, not a row
  // for the Slack toolbox. Last call wins — a turn that schedules and then stops must end stopped.
  let loopWakeup = null;
  // Skill usage telemetry (skills/usage.js): every tool_use on the stream passes through the
  // recorder, which writes one row per skill fired in this run — exact for Claude's Skill tool,
  // inferred for a read of a SKILL.md. Best-effort by construction; it never throws into the run.
  const skillUsage = createSkillUsageRecorder({
    channelSlug: entry.slug,
    conversationId: channelId,
    userId: untrustedPrincipal ? "" : authorId,
    engine,
    sessionId,
    runId: randomUUID(),
    origin,
  });
  const scopedOnEvent = createScopedRunEventHandler((event) => {
    if (event?.kind === "loop_wakeup") {
      loopWakeup = redactSecretFields(event, outputSecrets);
      return undefined;
    }
    try {
      skillUsage.onEvent(event);
    } catch {
      /* telemetry must never affect the turn */
    }
    return onEvent?.(redactSecretFields(event, outputSecrets));
  }, { progressReport, clean });
  // The gateway's own statement about THIS turn, addressed to the reader rather than to the card:
  // a surface that streams its answer writes the message from the live stream, so a note the
  // orchestrator only prepends to the finished `content` is delivered to nobody. Emitted before
  // the engine that will answer is spawned (the note describes a decision already taken), so it
  // lands at the head of the answer; a surface with no stream ignores the event and renders the
  // same sentence from `content`.
  const announceAnswerNote = (text) => {
    try {
      onEvent?.({ kind: "answer_note", scope: "gateway", text: redactSecretValues(text, outputSecrets) });
    } catch {
      /* a status callback must never block a run */
    }
  };

  // Composio exposes TWO independent identities: active author (`composio-user`) plus the agent's
  // own account (`composio-agent`, backed by the channel token, else the org token). Personal mode resolves the existing user/channel→org tokens; SDK mode
  // resolves stable user/channel identities into per-thread sessions. Stored personal-mode tokens
  // are never mutated when SDK mode is active. Clean mode injects none.
  const noOrg = Boolean(meta.noDefaultTokens);
  const composioMode = getComposioMode();
  const effectiveWorkspaceId = String(workspaceId || process.env.CG_SLACK_TEAM_ID || "").trim();
  // The HTTP API authenticates its API key, not the caller-supplied Slack author id. Never use
  // that untrusted id to read a personal connector token or infer admin/approval state. Shared
  // channel/org identities remain available; the user identity is intentionally absent.
  const userIdentity = await resolveRunUserIdentity({
    authorId,
    untrustedPrincipal,
    needsApproval: composioMode === "sdk" && !clean,
    loadComposioToken: getComposioToken,
    loadToolboxToken: getToolboxToken,
    loadIsAdmin: isAdmin,
    loadIsApproved: isApproved,
  });
  const personalComposioToken = userIdentity.composioToken;
  const personalToolboxToken = userIdentity.toolboxToken;
  const authorIsAdmin = userIdentity.isAdmin;
  const authorIsApproved = userIdentity.isApproved;
  const composio = await resolveComposioRuntime({
    clean,
    mode: composioMode,
    workspaceId: effectiveWorkspaceId,
    channelId,
    authorId,
    threadKey,
    meta,
    authorIsAdmin,
    authorIsApproved,
    principalTrusted: !untrustedPrincipal,
    channelToken: meta.composioToken,
    userToken: personalComposioToken,
    defaultToken: getDefaultComposioToken(),
    noOrg,
    isDM: Boolean(meta.isDM || meta.type === "im"),
  });
  const toolbox = resolveTokenSource({ clean, channelToken: meta.toolboxToken, userToken: personalToolboxToken, defaultToken: getDefaultToolboxToken(), noOrg });
  const composioUserToken = composio.user.token;
  const composioToken = composio.shared.token;
  const composioUserEndpoint = composio.user.endpoint;
  const composioEndpoint = composio.shared.endpoint;
  const toolboxToken = toolbox.token;
  outputSecrets.push(composioUserToken, composioToken, toolboxToken);
  // The per-run half of the identity rule (CO-04: "check the calendar" with both identities present
  // read the SHARED one and posted a colleague's week into the channel, where the other harness
  // asked first). The managed instructions block carries the rule; this one line carries the fact
  // it applies to — WHICH identities this turn received — which only a per-run prompt can say,
  // since `composio-user` is per author. Empty when the run injects neither (clean mode, no tokens),
  // so a channel without Composio pays nothing for it.
  const composioIdentityPrefix = composioIdentityPreamble(composioIdentitiesForRun({
    clean,
    principalTrusted: !untrustedPrincipal,
    composioUserEndpoint,
    composioUserToken,
    composioEndpoint,
    composioToken,
  }));
  const { makeToolboxUrl, makeToolboxKey } = resolveMakeToolboxRuntime({
    makeToolboxUrl: meta.makeToolboxUrl,
    makeToolboxKey: meta.makeToolboxKey,
    clean,
  });
  outputSecrets.push(makeToolboxKey);
  // Engine homes are deliberately isolated. Resolve these once in the daemon and carry them into
  // the gateway MCP instead of letting its subprocess derive paths from the disposable HOME.
  const gatewayFsRoot = allowedFsRoot();
  const gatewayWorkspaceRoot = workspaceRoot();
  // Clean mode passes an EMPTY mcp config (with --strict below) so global servers are replaced by
  // nothing; otherwise build the per-run config (gateway + available token-backed integrations).
  const mcpRuntimeInput = {
    clean,
    composioUserEndpoint, composioEndpoint, composioUserToken, composioToken,
    toolboxToken, makeToolboxUrl, makeToolboxKey,
    channelId, slug: entry.slug, authorId, threadKey, origin,
    progressReport: progressReportEnabled,
    principalTrusted: !untrustedPrincipal,
    gatewayFsRoot, gatewayWorkspaceRoot,
  };
  // Minted LAZILY — after the run slot is admitted, never here. The gateway capability is a signed
  // grant with a six-hour TTL, and the queue ahead of this turn is unbounded: a turn parked behind
  // a long-running background job used to spawn on a claim that had already aged out, so its first
  // gateway MCP call failed as "expired" on a run that had not started yet. Minting at admission
  // starts the clock when the engine actually spawns — the same reason the token FILE below is
  // written post-admission. The fallback engine mints its own, at its own call time.
  let mcpConfigJson = "";
  let mcpConfigFingerprint = "";
  let gatewayCapability = "";
  const mintGatewayMcpRuntime = async () => {
    ({ mcpConfigJson, mcpConfigFingerprint, gatewayCapability } = await buildEngineMcpRuntime({ ...mcpRuntimeInput, engine, target, allowedMcps: meta[adapter.mcpMetaKey] || [] }));
  };

  // Strict (only the injected gateway/token-backed servers) when the channel picks no global MCP servers — keeps the
  // common case hermetic. When global servers ARE picked, go non-strict so they're reachable,
  // gated by the lockdown's allowedMcpServers allowlist. Clean mode is always strict (empty config).
  const strictMcp = true; // Every granted definition is explicit; never inherit ambient settings/MCPs.

  const dangerouslySkip = mayEscalate({ meta, isAdminAuthor: authorIsAdmin, untrustedPrincipal, origin });
  // Admin outranks auto: a non-escalated run whose STORED author is an admin in an adminMode
  // channel runs at the AUTO tier (writable work folder, auto-approved permission prompts)
  // instead of the read floor. This covers every daemon origin — background agents, their
  // continuations, schedules, recovery — which used to complete read-only in admin channels and
  // silently do nothing. A2 stands: these runs still NEVER get the permission bypass; the
  // unattended ceiling is auto, and only for the admin who authored the persisted prompt.
  const adminUnattended = adminUnattendedTier({ meta, isAdminAuthor: authorIsAdmin, untrustedPrincipal, dangerouslySkip });
  if (adminUnattended) meta = { ...meta, autoMode: true };
  // The bypass allowance rides per-spawn: only an escalated run gets the settings variant that
  // honors --dangerously-skip-permissions; the shared channel settings file always hard-disables
  // it, so a non-admin run (even in an adminMode channel) can never be escalated by the file.
  const sharedRunSettingsFile = dangerouslySkip && adminSettingsFile ? adminSettingsFile : settingsFile;

  // Model/effort precedence: per-thread override (the /model wizard's "just this thread" scope) →
  // channel/DM-template override → the gateway-wide default for this engine (Settings) → "" (no
  // --model flag, the CLI's own default). The gateway default keeps runs pinned even when the
  // admin's interactive terminal `/model` changes the CLI default. An explicit per-run API
  // override (already merged into meta above) beats the thread override — it's the most specific
  // ask — so the thread values are skipped when one was passed.
  const [threadModel, threadEffort] = await Promise.all([
    overrides?.model ? "" : getThreadModel(entry.slug, threadKey),
    overrides?.effort ? "" : getThreadEffort(entry.slug, threadKey),
  ]);
  // Spawn-time compatibility gate: whichever layer produced a value (thread override, channel
  // meta, template overlay, a stale legacy write), a model/effort that belongs to the OTHER
  // harness must never reach the CLI flags — it would break every turn. The first candidate in
  // precedence order that actually belongs to this engine wins; none → "" (the CLI's own default).
  const gatewayDefaultModel = getDefaultModel(engine);
  let model = [threadModel, meta.model, gatewayDefaultModel].find((m) => m && modelBelongsToEngine(m, engine)) || "";
  const effort = [threadEffort, meta.effort].find((e) => e && effortBelongsToEngine(e, engine)) || "";
  // Dashboard-only lifecycle signal: by this point the exact spawn engine/model are known. Keep it
  // best-effort so a display-layer callback can never prevent an engine run.
  try { onRuntimeResolved?.({ engine, model, ...runtimeSignal }); } catch { /* non-fatal */ }
  const timeoutMs = parseTimeoutMs(process.env.COMMAND_TIMEOUT);
  // How long a turn may stay SILENT in total before we treat it as wedged. COMMAND_TIMEOUT is now
  // only how often a quiet turn REPORTS itself (see engines/watchdog.js); this is the give-up
  // point. Defaults to 3 quiet windows.
  const maxSilenceMs = process.env.CG_MAX_SILENCE ? parseTimeoutMs(process.env.CG_MAX_SILENCE) : timeoutMs * DEFAULT_SILENCE_WINDOWS;
  // Non-bypass runs route permission prompts to our MCP tool, which surfaces Slack approval
  // buttons (Claude only; Codex has its own approval model). With dangerouslySkip there are no
  // prompts to route. Clean mode has no gateway MCP server, so the tool can't exist — non-allowlisted
  // tools are simply denied headless (only the lockdown's allow-list + admin bypass apply).
  const permissionPromptTool = dangerouslySkip || clean ? "" : "mcp__gateway__permission_prompt";
  // Compile intent into the selected engine's real confinement. Both Claude and Codex receive the
  // exact same normalized admin allowlist; each adapter must either enforce it inside the
  // container or fail closed before spawning.
  const adapter = requireAdapter(engine);
  assertUserSkillOverlaySupported(adapter, userSkills);
  const codexWritable = Boolean(meta.allowBash || meta.autoMode);
  const confinement = adapter.compileConfinement({ allowNetwork: Boolean(meta.allowNetwork), writable: codexWritable });
  const networkPolicy = confinement.network;
  if (!confinement.supported) {
    throw new Error(`${confinement.reason}. Turn network off or switch this thread to an engine that supports this policy.`);
  }
  const codexNetwork = networkPolicy.mode !== "off";
  const codexAutoApprove = Boolean(meta.autoMode);

  await logEvent("run_config", {
    channel: channelId,
    author: authorId,
    slug: entry.slug,
    threadKey,
    origin,
    engine,
    model,
    // WHERE it ran, and why that backend was chosen — the first question of any container
    // incident, and the only record of it once the turn is over.
    runtime: target.backend,
    runtimeReason: target.reason,
    // Only present when this turn's resume was preceded by a carry-over — the record that a
    // backend change did NOT cost the thread its engine history.
    ...(sessionCarried ? { sessionCarried } : {}),
    sessionEngine,
    isNewSession: isNew,
    clean,
    adminMode: Boolean(meta.adminMode),
    autoMode: Boolean(meta.autoMode),
    allowBash: Boolean(meta.allowBash),
    allowNetwork: Boolean(meta.allowNetwork),
    networkPolicy: networkPolicy.mode,
    // The compiled mode is what the engines are TOLD, not a boundary anything applies: the
    // container sits on the bridge network and no egress is policed per channel. Recorded next to
    // the mode so an operator reading `run_config` after an incident cannot mistake
    // `networkPolicy: "off"` for "this turn could not reach the internet".
    networkEnforced: NETWORK_POLICY_ENFORCED,
    dangerouslySkip,
    adminUnattended,
    codexWritable,
    codexNetwork,
    codexAutoApprove,
    composioMode: composio.mode,
    progressReport: progressReportEnabled,
    allowedMcpCount: clean ? 0 : (Array.isArray(meta.allowedMcps) ? meta.allowedMcps.length : 0),
    composioUser: composio.user.source,
    composio: composio.shared.source,
    toolbox: toolbox.source,
    makeToolbox: Boolean(makeToolboxUrl && makeToolboxKey),
  });

  // Tokens must never ride on argv — `ps` can read a process's args for its whole life (minutes,
  // for a warm session). The per-run MCP config (which embeds the author's tokens) is written to a
  // 0600 file and --mcp-config gets the PATH; the CLI reads it once at spawn, so deleting the
  // file when the run settles (the finally below) never affects a live process, warm or cold.
  //
  // It lives under the channel's own artifact dir — the one path both the daemon and THAT
  // channel's container can open — never the OS tmpdir or the gateway root: the daemon's tmpdir
  // and the gateway root are not mounted into any container, and a path shared between channels
  // would let one channel read a concurrent run's tokens. Codex gets its MCP config via -c
  // overrides and never uses this file. Written LAZILY below — after the run slot is acquired and
  // the cooldown reroute is decided — so a token file never sits on disk during a semaphore queue
  // wait or for a turn that ends up on Codex. runArtifactRoot(target) resolves the dir for every
  // target (the daemon-internal local runtime gets the gateway run-tmp dir).
  const mcpConfigFile = usesMcpConfigFile(engine) ? path.join(runArtifactRoot(target), `cg-mcp-${randomUUID()}.json`) : "";

  // Every Claude run gets a private settings copy because its explicit skill plugin lives under
  // the otherwise read-denied runtime root and needs one narrow read allowance.
  const needsClaudeSettings = engineSupports(engine, "settingsFile");
  const grantArtifacts = await createRunGrantArtifacts({
    slug: entry.slug,
    meta,
    userSkills,
    sharedSkills: clean ? [] : runGrants.shared.skills,
    // Gateway-generated operating skills remain part of every Slack turn, including clean mode;
    // clean only removes org/channel/user/library grants and MCPs. The artifact copier imports
    // fixed gateway-usage/channel-memory names from this directory, never arbitrary project skills.
    workspaceSkillsDir: path.join(cwd, ".claude", "skills"),
    // Channel-owned custom agents. `--setting-sources ""` hides `.claude/agents` from the CLI, so
    // the plugin is the only delivery path that keeps them working (see materializePlugin).
    workspaceAgentsDir: path.join(cwd, ".claude", "agents"),
    needsClaudeSettings,
    allowBypass: dangerouslySkip,
    // Decides both WHERE the artifacts land and WHICH of them exist: an isolated runtime gets no
    // host plumbing of any kind — everything lands under the channel's mounted artifact dir.
    target,
  });
  const runSettingsFile = grantArtifacts.settingsFile || sharedRunSettingsFile;
  const grantFingerprint = JSON.stringify({
    allowedMcps: clean ? [] : runGrants.effective.allowedMcps,
    userSkills,
  });

  // Recall at session start (Hermes' frozen-snapshot pattern): a FRESH session — first turn of a
  // thread, a heal, a cross-engine fallback — gets the channel's memory index in front of its
  // first message; a resumed session already carries it in its history. Empty when memory is off
  // for this run (clean mode included) or the channel has saved nothing yet.
  const memoryPrefix = await memorySnapshotPrefix(cwd, meta);
  const runOnce = async (sid, fresh, promptOverride = null, modelOverride = model) => {
    assertRuntimeCanStart();
    // The runtime facts belong to THIS attempt, including a model retry or session heal. Keep
    // them per-prompt even in clean mode: they expose no memory, optional skills or connectors.
    const prompt = (fresh ? memoryPrefix : "") + composioIdentityPrefix
      + runtimeIdentityPreamble({ engine, model: modelOverride, effort, fresh })
      + runtimeAccessPreamble(target, { clean })
      + (promptOverride ?? turnText);
    return adapter.run(validateRunContext({
      principal: { kind: untrustedPrincipal ? "daemon" : PRINCIPAL_KIND_BY_ORIGIN[origin] || "daemon", id: authorId },
      origin, cwd, prompt, session: { id: sid, fresh }, policy: confinement,
      // WHERE the runner spawns: it calls target.runtime.spawn/probe/signal instead of
      // child_process + kill(pid), and reads the container-only credential/artifact facts beside
      // it. Mirrored into the runtime bag below so an adapter can read either shape.
      target, claudeOauthToken, artifactDir: target.artifactDir,
      runtime: {
        target, claudeOauthToken, claudeTokenFingerprint: claudeTokenFp, artifactDir: target.artifactDir,
        preferCold, keepAliveMs: keepAliveMs(), poolKey: `${entry.slug}::${threadKey}`,
        mcpConfigFile, mcpConfigJson, mcpConfigFingerprint, strictMcp, dangerouslySkip, settingsFile: runSettingsFile,
        model: modelOverride, effort, permissionPromptTool, timeoutMs, maxSilenceMs, signal, onDelta: scopedOnDelta, onEvent: scopedOnEvent,
        channelEnv, channelEnvFingerprint: channelEnvFp, browserNamespace,
        writable: codexWritable, autoApprove: codexAutoApprove, clean,
        composioUserEndpoint, composioEndpoint, composioUserToken, composioToken, toolboxToken,
        makeToolboxUrl, makeToolboxKey, gatewayCapability, gatewayFsRoot, gatewayWorkspaceRoot, progressReport: progressReportEnabled,
        allowedMcps: clean ? [] : (meta[adapter.mcpMetaKey] || []),
        claudePluginDirs: grantArtifacts.claudePluginDirs,
        claudePluginEphemeral: grantArtifacts.claudePluginEphemeral,
        instructionFile: path.join(cwd, requireAdapter(engine).instructionFile),
        claudeHome: grantArtifacts.claudeHome,
        claudeConfigDir: grantArtifacts.claudeConfigDir,
        codexStateDir: grantArtifacts.codexStateDir,
        personalSkillCatalog: grantArtifacts.personalSkillCatalog,
        grantFingerprint,
        attachments,
      },
    }));
  };

  // The global run slot and the container lease this turn holds (acquired below, released in the
  // finally). Declared here because the retry pause hands both back for its length.
  let releaseRunSlot = null;
  let runtimeLease = null;
  // A retry pause is idle time: nothing is spawned, nothing streams. Give the slot and the lease
  // back for its length so other channels' turns are not queued behind a sleeping one, then queue
  // again like a new arrival (reported as run_queued, cancellable). The container may have been
  // idle-stopped or evicted while unleased, and spawn() does not self-heal, so ensureUp runs again
  // on the way back (a no-op while it is up; a ~0.2 s announced restart otherwise).
  const parkForRetry = () => {
    try { runtimeLease?.release(); } catch { /* never mask the retry */ }
    runtimeLease = null;
    const release = releaseRunSlot;
    releaseRunSlot = null;
    release?.();
  };
  const resumeFromRetry = async () => {
    releaseRunSlot = await acquireRunSlotWithStatus({ signal, onEvent, origin });
    if (signal?.aborted) throw Object.assign(new Error("Run aborted while queued"), { name: "AbortError" });
    assertRuntimeCanStart();
    runtimeLease = target.runtime.acquireLease(target, { kind: "run", id: newRunId("run") });
    await bringRuntimeUp();
  };

  // Run one attempt, and retry it in place on a transient, replay-safe provider failure — up to
  // transientRetryAttempts() more times, transientRetryDelayMs() apart, never past a cancel. The
  // result carries `transientRetries` when it took more than one attempt; an error that exhausted
  // the budget says so in its message, so the thread never sees a bare provider line that looks
  // unretried. `beforeRetry(n)` runs right before attempt n+1 — the hook a fresh session needs to
  // change its id (see remintFreshSession below).
  const withTransientRetry = async (engineName, attempt, { beforeRetry = null } = {}) => {
    const maxAttempts = transientRetryAttempts();
    const delayMs = transientRetryDelayMs();
    const delayLabel = delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`;
    let retries = 0;
    for (;;) {
      try {
        const out = await attempt();
        return retries && out && typeof out === "object" ? { ...out, transientRetries: retries } : out;
      } catch (err) {
        const kind = transientProviderFailure(err, engineName);
        if (!kind || retries >= maxAttempts || signal?.aborted) {
          if (retries) {
            err.details = { ...(err.details || {}), transientRetries: retries };
            // Only the failure that exhausted the budget was "retried": a different failure after
            // a transient one (a limit, a lost session) was not, and its line must not claim so.
            if (kind) err.message = `${err.message} — retried ${retries}× (${delayLabel} apart) before giving up`;
          }
          throw err;
        }
        retries += 1;
        console.warn(`[gateway] transient ${engineName} ${kind} failure in ${entry.slug} (${String(err.message).slice(0, 200)}) — retry ${retries}/${maxAttempts} in ${delayLabel}`);
        await logEvent("run_transient_retry", {
          channel: channelId, author: authorId, slug: entry.slug, threadKey, origin,
          engine: engineName, kind, attempt: retries, maxAttempts, delayMs,
          error: String(err.message).slice(0, 300),
        });
        // The pause is a waiting state, so it announces itself on the status line (same rule as the
        // queue and warm-up notices: silence that looks like death is the bug this prevents).
        try {
          onEvent?.({ kind: "notice", scope: "gateway", text: `${engineLabel(engineName)} hit a temporary provider error — retrying in ${delayLabel} (${retries}/${maxAttempts})` });
        } catch { /* a status callback must never block a run */ }
        const yielded = delayMs > 0 && Boolean(releaseRunSlot);
        if (yielded) parkForRetry();
        await sleepUnlessAborted(delayMs, signal);
        if (signal?.aborted) throw err;
        if (yielded) await resumeFromRetry(); // re-queued: run_queued if it waits; a cancel while queued aborts
        await beforeRetry?.(retries);
      }
    }
  };
  // The one-line notice a reply carries when the provider needed more than one attempt. An EMPTY
  // result stays empty: the caller's empty-result path must still see it as one, not as a reply
  // consisting of this notice.
  const transientRetryNote = (engineName, out) => (out?.transientRetries && !isEmptyResult(out)
    ? { ...out, content: `⚠️ _${engineLabel(engineName)} hit a temporary provider error — retried ${out.transientRetries}× before answering._\n\n${out.content || ""}` }
    : out);

  // A session heal (resume failed / resumed empty → fresh session) re-runs the SAME message, but
  // the fresh session has none of the thread's context: at the Slack layer the thread transcript
  // is only injected the very FIRST time the bot enters a thread, so a healed retry of "check
  // again" would run context-blind. Mirror the Codex-fallback pattern: prepend the lazily-fetched
  // thread transcript (when the caller provided a fetcher) plus a session-was-lost note, so the
  // healed session continues the conversation instead of starting amnesiac.
  const healedPrompt = async () => {
    if (!getFallbackContext) return null;
    const ctx = await getFallbackContext().catch(() => "");
    return buildHealedPrompt(ctx, turnText);
  };

  const baseMeta = {
    slug: entry.slug,
    cwd,
    model, // configured cascade: thread → channel/DM → gateway default ("" = engine default)
    // WHERE the turn ran, for the reply footer and any delivery surface that renders a result
    // without access to the target. A plain record on purpose: results cross the unattended
    // delivery boundary (slack/deliver.js) and must stay serializable.
    runtime: { backend: target.backend, isolated: isolatedRuntime, container: runtimeSignal.container, image: runtimeSignal.image },
    dangerouslySkip,
    composioMode: composio.mode,
    hasUserComposio: Boolean(composioUserToken || composioUserEndpoint),
    composioUserSource: composio.user.source,
    hasComposio: Boolean(composioToken || composioEndpoint),
    composioSource: composio.shared.source,
    usedChannelComposio: composio.shared.source === "channel", // a DM refuses it even when one is stored
    hasToolbox: Boolean(toolboxToken),
    usedChannelToolbox: !clean && Boolean(meta.toolboxToken),
    hasMakeToolbox: Boolean(makeToolboxUrl && makeToolboxKey),
  };

  // Cross-engine failover for when the engine driving this turn is rate-limited or can't
  // authenticate: it can't resume the failed engine's session, but its OWN thread is durable — the
  // fallback thread id is kept under a suffixed session key, so consecutive fallback turns resume
  // the same conversation instead of starting context-less each time (the primary key keeps
  // mapping to the original engine's session for when the cooldown ends). Fallback engine
  // unavailable → caller handles the thrown error.
  // Direction-agnostic: `engine` is whatever actually drives this turn, and the target is the first
  // ENABLED engine in its failover route — an admin who turned a harness off must not have it
  // resurrected as someone else's fallback.
  // …but a runtime the user PINNED is never quietly traded away. Picking a harness/model for a
  // thread (the /model wizard's "just this thread" scope, a `claude`/`codex` directive, or a
  // per-run API override) is a specific ask; answering it on the other harness — with a different
  // model, different tools, no memory of the pinned session — is not a smaller version of that
  // ask, it is a different one. Such a thread gets the real error plus the manual switch hint
  // instead. A CHANNEL or gateway default is not a pin: those are defaults, and failover is the
  // whole point of having them.
  // Only a model that actually applies to this engine counts — a stale override left behind for
  // the other harness never reaches the CLI, so it must not silently disable failover either.
  const modelPinnedByUser = [threadModel, overrides?.model].some((m) => m && modelBelongsToEngine(m, engine));
  const runtimePinned = enginePinnedByUser || modelPinnedByUser;
  const fallbackEngine = getEngineFallback() && !runtimePinned ? fallbackTargets(engine).find(isEngineEnabled) || "" : "";
  // `fallbackPolicy` is the caller's word on WHO decides a switch: "auto" (or nothing — every
  // unattended origin) switches here; "ask" (a watched Slack thread, Settings → engineFallbackMode)
  // throws the replay-safe failure back with `details.askFallback` so the thread gets a card with
  // buttons and nothing runs until someone clicks. `canAsk` — a person is watching, so a failure
  // both harnesses could not answer may also be handed back as a choice.
  const askFallback = Boolean(fallbackEngine) && fallbackPolicy === "ask";
  const canAsk = Boolean(fallbackEngine) && (fallbackPolicy === "ask" || fallbackPolicy === "auto");
  const fallbackOn = Boolean(fallbackEngine) && !askFallback;
  const runFallbackEngine = async (note, failureContext = "a usage/spend limit") => {
    const fallbackAdapter = requireAdapter(fallbackEngine);
    // Same fail-closed check the primary engine gets: an isolated runtime that cannot authenticate
    // the fallback harness either must say so, not spawn a CLI that will die on its first call.
    assertRuntimeCredentials(target, fallbackEngine);
    // Remint for the engine that will actually execute. The gateway MCP uses this signed engine
    // claim to choose allowedCodexMcps vs allowedMcps for mutations; reusing the failed engine's
    // token would cross that authority boundary even though a different runner executes.
    const fallbackMcpRuntime = await buildEngineMcpRuntime({ ...mcpRuntimeInput, engine: fallbackEngine, target, allowedMcps: meta[fallbackAdapter.mcpMetaKey] || [] });
    const fbKey = `${threadKey}::${fallbackEngine}-fallback`;
    const prior = await getSession(entry.slug, fbKey);
    // A FRESH fallback session can't resume the failed engine's conversation, so without help it
    // starts blind. Inject the Slack thread transcript (lazily fetched by the caller) so it can read
    // the thread and continue the SAME conversation. Skipped when a prior fallback session already
    // exists (the fallback kept the context across turns) or no fetcher was provided.
    let fbPrompt = turnText;
    if (!prior && getFallbackContext) {
      const ctx = await getFallbackContext().catch(() => "");
      if (ctx) {
        fbPrompt =
          ctx +
          `[The previous engine (${engineLabel(engine)}) could not finish this turn — ${failureContext}. ` +
          "You are continuing the SAME conversation shown above; use it as full context, then handle " +
          "the latest request below.]\n\n" +
          turnText;
      }
    }
    // This turn runs on the FALLBACK engine, so the resolved `model` above (picked for the engine
    // that just failed) must not apply — use the channel's own override only if it belongs to the
    // fallback's model family (a Claude model would be rejected by `codex -m`, and vice versa),
    // else that engine's gateway default.
    const fallbackGatewayDefaultModel = getDefaultModel(fallbackEngine);
    let fallbackModel = meta.model && modelBelongsToEngine(meta.model, fallbackEngine) ? meta.model : fallbackGatewayDefaultModel;
    let fallbackModelNote = "";
    try { onRuntimeResolved?.({ engine: fallbackEngine, model: fallbackModel, ...runtimeSignal }); } catch { /* non-fatal */ }
    const fallbackConfinement = fallbackAdapter.compileConfinement({ allowNetwork: Boolean(meta.allowNetwork), writable: codexWritable });
    if (!fallbackConfinement.supported) throw new Error(`${fallbackConfinement.reason}. ${fallbackAdapter.label} fallback was refused.`);
    // Failing over TO Claude needs Claude's credential, which the primary turn never resolved when
    // the primary engine was the other harness. Same memoized resolver, same container fail-closed.
    const fallbackRelay = await claudeCredentialFor(fallbackEngine);
    const fallbackClaudeToken = fallbackEngine === "claude" ? fallbackRelay?.token || "" : claudeOauthToken;
    const fallbackClaudeTokenFp = fallbackEngine === "claude" ? claudeTokenFingerprint(fallbackRelay) : claudeTokenFp;
    const exec = async (fbSid, fbFresh, modelOverride = fallbackModel) => {
      assertRuntimeCanStart();
      return fallbackAdapter.run(validateRunContext({
        principal: { kind: untrustedPrincipal ? "daemon" : PRINCIPAL_KIND_BY_ORIGIN[origin] || "daemon", id: authorId }, origin, cwd,
        prompt: (fbFresh ? memoryPrefix : "") + composioIdentityPrefix
          + runtimeIdentityPreamble({ engine: fallbackEngine, model: modelOverride, effort: "", fresh: fbFresh })
          + runtimeAccessPreamble(target, { clean }) + fbPrompt,
        session: { id: fbSid, fresh: fbFresh }, policy: fallbackConfinement,
        // The SAME runtime target: failing over to the other harness changes which CLI runs, not
        // which machine boundary the channel runs behind.
        target, claudeOauthToken: fallbackClaudeToken, artifactDir: target.artifactDir,
        runtime: { target, claudeOauthToken: fallbackClaudeToken, claudeTokenFingerprint: fallbackClaudeTokenFp, artifactDir: target.artifactDir,
          preferCold: true, keepAliveMs: 0, poolKey: `${entry.slug}::${fbKey}`, dangerouslySkip,
          writable: codexWritable, autoApprove: codexAutoApprove, clean, composioUserEndpoint, composioEndpoint,
          composioUserToken, composioToken, toolboxToken, makeToolboxUrl, makeToolboxKey,
          gatewayCapability: fallbackMcpRuntime.gatewayCapability, gatewayFsRoot, gatewayWorkspaceRoot, progressReport: progressReportEnabled, model: modelOverride, effort: "",
          attachments, signal, timeoutMs, maxSilenceMs, onDelta: scopedOnDelta, onEvent: scopedOnEvent,
          channelEnv, channelEnvFingerprint: channelEnvFp, browserNamespace,
          allowedMcps: clean ? [] : (meta[fallbackAdapter.mcpMetaKey] || []),
          claudePluginDirs: grantArtifacts.claudePluginDirs,
          claudePluginEphemeral: grantArtifacts.claudePluginEphemeral,
          instructionFile: path.join(cwd, fallbackAdapter.instructionFile),
          claudeHome: grantArtifacts.claudeHome,
          claudeConfigDir: grantArtifacts.claudeConfigDir,
          codexStateDir: grantArtifacts.codexStateDir,
          personalSkillCatalog: grantArtifacts.personalSkillCatalog,
          grantFingerprint },
      }));
    };
    const execWithSessionHeal = async (modelOverride) => {
      try {
        return await withTransientRetry(fallbackEngine, () => exec(prior || "", !prior, modelOverride));
      } catch (error) {
        if (!prior || !isSessionNotFound(error)) throw error;
        return withTransientRetry(fallbackEngine, () => exec("", true, modelOverride)); // stored fallback thread expired — start fresh once
      }
    };
    let cx;
    try {
      cx = await execWithSessionHeal(fallbackModel);
    } catch (err) {
      const defaultModel = replaySafeGatewayDefaultModel(err, {
        engine: fallbackEngine,
        model: fallbackModel,
        defaultModel: fallbackGatewayDefaultModel,
      });
      if (!defaultModel) throw err;
      const rejectedModel = fallbackModel;
      console.warn(`[gateway] ${fallbackEngine} fallback rejected model ${rejectedModel} before execution in ${entry.slug} — retrying with gateway default ${defaultModel}`);
      await logEvent("run_model_fallback", {
        channel: channelId,
        author: authorId,
        slug: entry.slug,
        threadKey,
        origin,
        engine: fallbackEngine,
        fromModel: rejectedModel,
        toModel: defaultModel,
        crossEngineFallback: true,
      });
      try { onRuntimeResolved?.({ engine: fallbackEngine, model: defaultModel, ...runtimeSignal }); } catch { /* non-fatal */ }
      // Told to the delivery layer BEFORE the retry spawns, because a Slack answer is written from
      // the live stream: a note added to the finished `content` below never reaches the message a
      // streamed turn produced. Nothing has streamed yet (the rejection landed before generation),
      // so it lands as the head of the answer. `content` keeps it too — for every surface that
      // has no stream to write into.
      announceAnswerNote(gatewayDefaultModelNote(rejectedModel, defaultModel));
      try {
        cx = await execWithSessionHeal(defaultModel);
        fallbackModel = defaultModel;
        fallbackModelNote = gatewayDefaultModelNote(rejectedModel, defaultModel);
      } catch (defaultModelError) {
        console.warn(`[gateway] gateway-default fallback model ${defaultModel} also failed (${defaultModelError.message}) — preserving the original model error`);
        err.details = { ...(err.details || {}), defaultModel, defaultModelError: defaultModelError.message };
        throw err;
      }
    }
    if (cx.sessionId) await saveSession(entry.slug, fbKey, cx.sessionId, fallbackEngine, sessionGen, runtimeStamp);
    cx = transientRetryNote(fallbackEngine, cx);
    // `fellBack`/`fallbackFrom` are the engine-agnostic truth; `fellBackToCodex` is the original
    // Claude→Codex-only flag, still emitted so existing consumers keep working.
    const fallbackResult = {
      ...baseMeta, ...cx,
      content: redactSecretValues(licenseWarning + (note || "") + fallbackModelNote + (cx.content || ""), outputSecrets),
      sessionId: cx.sessionId ?? null,
      engine: fallbackEngine,
      isNew: !prior,
      fellBack: true,
      fallbackFrom: engine,
      fellBackToCodex: fallbackEngine === "codex",
    };
    // `model` = the configured pick that governed the fallback (shown in the footer);
    // `runtimeModel` keeps the CLI-reported model for context-window/cost internals.
    return { ...redactSecretFields(fallbackResult, outputSecrets), loopWakeup, runtimeModel: resolveCurrentModel(fallbackResult), model: fallbackModel || resolveCurrentModel(fallbackResult) };
  };

  // Bring the run environment up, announcing the wait only once it is slow enough to be worth a
  // line. A cold start is the one wait in a turn that looks like nothing is happening: the engine
  // has not spawned, so there is no stream, no tool row, no token — and a warm channel (the normal
  // case, sub-second) stays quiet. Same rule as the queue notice: silence that looks like death is
  // the bug this prevents. Called once per turn, and again after a retry pause handed the lease back.
  async function bringRuntimeUp() {
    let warmupTimer = null;
    let warmupPosted = false;
    let warmupText = "Warming up the channel container…";
    const postWarmupNotice = (text = warmupText) => {
      warmupPosted = true;
      try { onEvent?.({ kind: "notice", scope: "gateway", text: redactSecretValues(text, outputSecrets) }); } catch { /* a status callback must never block a run */ }
    };
    try {
      const warmupStartedAt = Date.now();
      if (isolatedRuntime) {
        warmupTimer = setTimeout(() => postWarmupNotice(), RUNTIME_WARMUP_NOTICE_MS);
        warmupTimer.unref?.();
      }
      const warmup = await target.runtime.ensureUp(target, {
        // This turn's OWN lease (taken just above, so the idle reaper cannot stop the environment
        // between here and the spawn). The backend needs to know which lease is ours: counting it
        // as "a run is active inside" is what let a container keep serving turns after its
        // workspace mounts had gone stale, because every turn looked busy to itself.
        lease: runtimeLease,
        signal,
        // The backend's own words, subject to the same "only if it is actually slow" rule: before
        // the threshold they replace the default line rather than adding one, so a sub-second start
        // stays silent; after it, they are a live update on a wait the user can already see.
        announce: (text) => {
          const line = String(text || "").trim();
          if (!line) return;
          if (warmupPosted) postWarmupNotice(line);
          else warmupText = line;
        },
      });
      // A cold runtime probe settles the host-side HOME-volume path. Codex usage accounting must
      // see that settled path before it snapshots a resumed session, or the footer shows the
      // whole session's cumulative tokens/value instead of this message's delta.
      refreshRuntimeReadPaths(grantArtifacts, target);
      if (warmup?.created || warmup?.started) {
        console.log(`[gateway] ${entry.slug}: ${target.backend} runtime ${warmup.created ? "created" : "started"} in ${Date.now() - warmupStartedAt}ms`);
      }
    } finally {
      if (warmupTimer) clearTimeout(warmupTimer);
    }
  }

  // Park for a global run slot. Reports honestly (only if it actually queues) and stays
  // cancellable, so a stop while queued never burns the slot it was waiting for.
  try {
    releaseRunSlot = await acquireRunSlotWithStatus({ signal, onEvent, origin });
    // A stop that landed while this turn was parked on the semaphore must win BEFORE any side
    // effects — the caller already marked the handle aborted and posted "🛑 Stopped.".
    if (signal?.aborted) throw Object.assign(new Error("Run aborted while queued"), { name: "AbortError" });
    assertRuntimeCanStart();

    // ── Make the run environment ready ────────────────────────────────────────────────────────
    // Credentials first: a container with no engine token can never answer, and warming one up to
    // discover that wastes seconds and leaves the operator reading an engine error instead of the
    // configuration message. Then the LEASE (so the idle reaper cannot stop the environment out
    // from under a turn that is about to spawn in it), then ensureUp. Daemon-internal turns never come
    // through here (they spawn on the local runtime directly), which is why there is no branch.
    assertRuntimeCredentials(target, engine);
    runtimeLease = target.runtime.acquireLease(target, { kind: "run", id: newRunId("run") });
    await bringRuntimeUp();

    // If THIS engine was recently limited in THIS channel (or its credential failed gateway-wide),
    // skip it and use the fallback harness for the cooldown window instead of re-probing it.
    const limitKey = `${engine}::${entry.slug}`;
    if (fallbackOn) {
      const authUntil = engineAuthFailedUntil.get(engine) || 0;
      if (authUntil > Date.now() && !(await engineCredentialReplaced(engine))) {
        return await runFallbackEngine(
          `⚠️ _${engineLabel(engine)} authentication is unavailable right now — using ${engineLabel(fallbackEngine)}._\n\n`,
          "its authentication was unavailable before any tool call",
        );
      }
      if (authUntil) { engineAuthFailedUntil.delete(engine); engineAuthFailedFingerprint.delete(engine); }
      const until = engineLimitedUntil.get(limitKey) || 0;
      if (until > Date.now()) {
        return await runFallbackEngine(`⚠️ _${engineLabel(engine)} is at its usage limit right now — using ${engineLabel(fallbackEngine)}._\n\n`);
      }
      if (until) engineLimitedUntil.delete(limitKey); // expired — retry this engine and drop the entry
    }

    // An engine will actually spawn now — mint the signed gateway capability (its TTL starts here,
    // not at the head of a queue this turn may have sat in for hours) and materialize the
    // token-bearing config file built around it (see above). From here on the session row is the
    // engine's: a later failure keeps it (resume-heal, failover and /clear own that story).
    engineStarted = true;
    await mintGatewayMcpRuntime();
    if (mcpConfigFile) {
      await mkdir(path.dirname(mcpConfigFile), { recursive: true, mode: 0o700 });
      await writeFile(mcpConfigFile, mcpConfigJson, { mode: 0o600 });
    }

    // Resume by default; if the thread's stored session no longer exists, mint a fresh one and retry
    // once — so a deleted/expired session never hard-fails, it just starts a new conversation.
    let sid = sessionId;
    let fresh = isNew;
    let result;
    // A FRESH session is created by its id (`claude --session-id <sid>`), and the attempt that just
    // failed already wrote that id's transcript — the CLI refuses to create it twice ("Session ID …
    // is already in use"), so a retried fresh turn runs under a new id (persisted, so a concurrent
    // reply resumes the live one, not the dead file). A resume replays as-is, and a self-minting
    // engine (Codex) ignores the id on a fresh run. The warm process, if any, is bound to the old
    // id and is retired with it.
    const remintFreshSession = async () => {
      if (!fresh || mintsOwnSessionId(engine)) return;
      abortPooled(`${entry.slug}::${threadKey}`);
      sid = await resetSession(entry.slug, threadKey, engine, sessionGen, runtimeStamp);
    };
    const initialPromptOverride = switchedEngine ? await healedPrompt() : null;
    try {
      // An explicit engine switch starts a fresh session that can't carry the old conversation —
      // replay the thread transcript into it (same treatment as a session heal) so the new engine
      // continues the conversation instead of starting amnesiac.
      result = await withTransientRetry(engine, () => runOnce(sid, fresh, initialPromptOverride), { beforeRetry: remintFreshSession });
    } catch (err) {
      const defaultModel = replaySafeGatewayDefaultModel(err, { engine, model, defaultModel: gatewayDefaultModel });
      if (defaultModel) {
        const rejectedModel = model;
        console.warn(`[gateway] ${engine} rejected model ${rejectedModel} before execution in ${entry.slug} — retrying with gateway default ${defaultModel}`);
        await logEvent("run_model_fallback", {
          channel: channelId,
          author: authorId,
          slug: entry.slug,
          threadKey,
          origin,
          engine,
          fromModel: rejectedModel,
          toModel: defaultModel,
        });
        try { onRuntimeResolved?.({ engine, model: defaultModel, ...runtimeSignal }); } catch { /* non-fatal */ }
        // Same reason as the cross-engine path above: the answer the reader gets is STREAMED, so
        // the substitution has to be announced before the retry writes its first token — a prefix
        // on the finished content is only ever seen by a surface that renders that content.
        announceAnswerNote(gatewayDefaultModelNote(rejectedModel, defaultModel));
        try {
          // The rejected attempt already consumed a FRESH session's id (see remintFreshSession).
          await remintFreshSession();
          result = await withTransientRetry(engine, () => runOnce(sid, fresh, initialPromptOverride, defaultModel), { beforeRetry: remintFreshSession });
          model = defaultModel;
          result = {
            ...result,
            content: `${gatewayDefaultModelNote(rejectedModel, defaultModel)}${result.content || ""}`,
          };
        } catch (defaultModelError) {
          console.warn(`[gateway] gateway-default model ${defaultModel} also failed (${defaultModelError.message}) — preserving the original model error`);
          err.details = { ...(err.details || {}), defaultModel, defaultModelError: defaultModelError.message };
          throw err;
        }
      } else {
        // The failover cases: a replay-safe limit/credential failure, or a transient provider
        // failure that outlived every in-place retry (`transientRetries` proves the budget was
        // spent). Same rule for both — nothing of the turn ran — so the other harness may answer.
        const switchKind = replaySafeFallbackKind(err, engine) || (err?.details?.transientRetries ? transientProviderFailure(err, engine) : "");
        const fallbackKind = fallbackOn ? switchKind : "";
        // The failure WOULD have been failed over, and wasn't, because the user pinned this
        // runtime. Say so on the error rather than leaving a bare provider message that looks
        // like the gateway simply forgot to fail over.
        if (!fallbackKind && runtimePinned && switchKind) {
          err.details = { ...(err.details || {}), runtimePinned: true, pinnedEngine: engine, pinnedModel: model || "" };
        }
        // Ask mode: hand the decision to the person watching the thread. No cooldown is written —
        // "try again" must be a real re-probe, not a pre-decided switch.
        if (askFallback && switchKind) {
          err.details = { ...(err.details || {}), askFallback: { to: fallbackEngine, kind: switchKind } };
          throw err;
        }
        if (fallbackKind) {
          const retries = Number(err?.details?.transientRetries) || 0;
          const transient = fallbackKind !== "authentication" && fallbackKind !== "usage_limit";
          // An auth failure is a broken CREDENTIAL — shared by every channel on that engine, so its
          // cooldown is gateway-wide. A usage limit is a quota the daemon can't scope any better
          // than the channel that hit it. An outage gets the short cooldown.
          if (fallbackKind === "authentication") await rememberAuthFailure(engine);
          else engineLimitedUntil.set(limitKey, Date.now() + (transient ? TRANSIENT_COOLDOWN_MS : LIMIT_COOLDOWN_MS));
          console.warn(`[gateway] replay-safe ${engine} ${fallbackKind} failure in ${entry.slug} — falling back to ${fallbackEngine}`);
          try {
            return await runFallbackEngine(
              fallbackKind === "authentication"
                ? `⚠️ _${engineLabel(engine)} authentication failed — using ${engineLabel(fallbackEngine)}._\n\n`
                : transient
                  ? `⚠️ _${engineLabel(engine)} hit a temporary provider error — retried ${retries}× before giving up — using ${engineLabel(fallbackEngine)}._\n\n`
                  : `⚠️ _${engineLabel(engine)} hit its usage limit before any tool call — using ${engineLabel(fallbackEngine)}._\n\n`,
              fallbackKind === "authentication"
                ? "its authentication failed before any tool call"
                : transient
                  ? `its provider stayed unavailable through ${retries} retries, before any tool call`
                  : "it hit a usage limit before any tool call",
            );
          } catch (fallbackError) {
            // Both harnesses failed. Keep the original error authoritative (its details drive every
            // consumer), but say the whole story in one sentence, and — when a person is watching —
            // hand it back as a choice (try either harness again) instead of a dead end.
            console.warn(`[gateway] ${fallbackEngine} fallback also failed (${fallbackError.message}) — preserving the original ${engine} provider error`);
            err.details = {
              ...(err.details || {}),
              fallbackError: fallbackError.message,
              ...(canAsk ? { askFallback: { to: fallbackEngine, kind: fallbackKind, bothFailed: true } } : {}),
            };
            err.message = `${err.message} — ${engineLabel(fallbackEngine)} could not answer either: ${fallbackError.message}`;
            throw err;
          }
        } else if (!fresh && isSessionNotFound(err)) {
          console.warn(`[gateway] session ${sid} not resumable in ${entry.slug} — starting a fresh session`);
          sid = await resetSession(entry.slug, threadKey, engine, sessionGen, runtimeStamp);
          fresh = true;
          // Built once: every attempt replays the SAME turn (a re-fetch could come back empty and
          // silently run the bare text, context-blind).
          const healed = await healedPrompt();
          result = await withTransientRetry(engine, () => runOnce(sid, fresh, healed), { beforeRetry: remintFreshSession });
        } else {
          throw err;
        }
      }
    }

    // A RESUME that returns an empty result (0 tokens, no output) is a broken session state — most
    // often a turn SIGKILLed mid-write by a stop/restart, leaving a dangling tool_use in the
    // transcript. Functionally identical to isSessionNotFound: the old conversation is unusable.
    // Reset to a fresh session and re-run the same message ONCE, instead of hard-erroring (which
    // forces the user to /clear). Only when !fresh — a brand-new session returning empty is a real
    // failure the caller's own isEmptyResult check surfaces (and that check backstops a still-empty
    // fresh retry here, so there's no loop). abortPooled is required: the warm pool fingerprints on
    // cwd/token/config, NOT the session id, so without evicting it the retry would reuse the same
    // live process still bound to the old `-r <sid>` and ignore the fresh --session-id. It's a
    // harmless no-op for Codex (no warm pool).
    // …unless WE deliberately cut this turn short (interrupt-steer): the empty result is expected,
    // the session is healthy, and a newer message is already queued to resume it with this turn's
    // context. Healing it would needlessly evict the warm session and re-run the abandoned message.
    if (!fresh && !result.interrupted && isEmptyResult(result)) {
      console.warn(`[gateway] session ${sid} resumed empty in ${entry.slug} — resetting to a fresh session`);
      abortPooled(`${entry.slug}::${threadKey}`);
      sid = await resetSession(entry.slug, threadKey, engine, sessionGen, runtimeStamp);
      fresh = true;
      const healed = await healedPrompt(); // once — see the session-not-found heal above
      result = await withTransientRetry(engine, () => runOnce(sid, fresh, healed), { beforeRetry: remintFreshSession });
    }

    // Self-minting engines (Codex, OpenCode) return their own thread_id (result.sessionId) —
    // persist it over the locally-minted UUID so the next turn's resume actually finds the
    // thread. Stamp the row with THIS run's engine: a literal here silently migrates any other
    // self-minting engine's thread onto that engine on its second turn.
    if (mintsOwnSessionId(engine) && result.sessionId && result.sessionId !== sid) {
      await saveSession(entry.slug, threadKey, result.sessionId, engine, sessionGen, runtimeStamp);
    }

    // The engine exited 0 but its "answer" is a usage-limit notice that did no work → switch to the
    // fallback harness (and remember it for this channel+engine cooldown).
    // Same situation, arriving as a zero-token "answer" instead of a thrown error: the engine
    // exited 0 and its reply IS the limit notice. A pinned thread keeps that notice (nothing was
    // switched), but must be told why, or the silence reads as the failover being broken.
    // Ask mode: the limit-as-answer takes the same card path as a thrown limit — as a replay-safe
    // error (0 tokens, no tool: the runner proved it did nothing).
    if (askFallback && isUsageLimited(result)) {
      throw Object.assign(new Error(`${engineLabel(engine)} usage limit reached: ${String(result.content || "").replace(/\s+/g, " ").trim().slice(0, 300)}`), {
        details: { engine, providerError: true, providerKind: "usage_limit", replaySafe: true, toolUseCount: 0, askFallback: { to: fallbackEngine, kind: "usage_limit" } },
      });
    }
    if (!fallbackOn && runtimePinned && isUsageLimited(result)) {
      result = {
        ...result,
        content: `${pinnedNoFailoverNote(engine, fallbackTargets(engine).find(isEngineEnabled) || "")}${result.content || ""}`,
      };
    }
    if (fallbackOn && isUsageLimited(result)) {
      engineLimitedUntil.set(limitKey, Date.now() + LIMIT_COOLDOWN_MS);
      console.warn(`[gateway] ${engine} usage limit in ${entry.slug} — falling back to ${fallbackEngine} for ${LIMIT_COOLDOWN_MS / 60000}m`);
      try {
        return await runFallbackEngine(`⚠️ _${engineLabel(engine)} hit its usage limit — answered with ${engineLabel(fallbackEngine)}._\n\n`);
      } catch (e) {
        console.warn(`[gateway] ${fallbackEngine} fallback failed (${e.message}) — returning the limit notice`);
        // fall through to return the limited engine's own notice
      }
    }

    // Answerless turn: real work, no reply. Say so in the thread and record it, instead of letting
    // the delivery layer render a bare "(empty response)" that looks like the model chose silence.
    // Not an error path: the session is intact and the work is resumable, so the turn is delivered
    // with the notice as its content (a throw here would also discard the run's footer/usage).
    // Interrupt-steer is excluded — that empty result is one WE asked for.
    if (!result.interrupted && isAnswerlessResult(result)) {
      await logEvent("run_answerless", {
        channel: channelId,
        author: authorId,
        slug: entry.slug,
        threadKey,
        origin,
        engine,
        endReason: String(result.endReason || ""),
        engineError: Boolean(result.engineError),
        toolUseCount: Number(result.toolUseCount) || 0,
        durationMs: result.durationMs ?? null,
        // The CLI's stderr tail (already redacted + capped by the runner) — on an exit-0 abort
        // nothing else ever reads it, and it is usually the only statement of the real cause.
        diagnostic: String(result.diagnostic || ""),
      });
      result = { ...result, content: answerlessNotice(result), answerless: true };
    }

    // Say so when the provider needed more than one attempt — only now, after every check above
    // that judges the engine's OWN output (empty resume, limit-as-answer, answerless) has seen it
    // without this notice in front.
    result = transientRetryNote(engine, result);

    const finalSessionId = mintsOwnSessionId(engine) ? result.sessionId ?? sid : sid;
    // Back-fill the owning engine on a pre-v4/legacy session row (engine ''), so the NEXT harness
    // switch is caught by the clean reset-before-spawn path above instead of a failed cross-engine
    // resume. Only when the row was unlabeled AND we resumed it as-is this turn (a fresh mint/reset
    // already stamped `engine`); Codex's own id is persisted above only when it changed, so this
    // also labels a legacy Codex thread whose id round-tripped unchanged.
    if (sessionEngine === "" && !fresh && finalSessionId) {
      await saveSession(entry.slug, threadKey, finalSessionId, engine, sessionGen, runtimeStamp);
    }

    const finalResult = {
      ...baseMeta,
      ...result,
      // Count only — it drives whether the reply footer offers the 🔑 secrets button. Never names,
      // never values: this object is what gets rendered into Slack.
      channelSecretCount: Object.keys(channelEnv).length,
      sessionId: finalSessionId,
      engine,
      isNew: fresh,
    };
    // `model` on the result is what the reply footer shows: the configured cascade that governed
    // this turn — thread override → channel/DM model → gateway default (`model` above) — and only
    // when nothing is configured anywhere, the CLI-reported model (the engine's own default).
    // `runtimeModel` keeps the CLI-reported truth for context-window math and Codex cost rates.
    return {
      ...redactSecretFields(finalResult, outputSecrets),
      content: redactSecretValues(licenseWarning + (finalResult.content || ""), outputSecrets),
      loopWakeup,
      runtimeModel: resolveCurrentModel(finalResult),
      model: model || resolveCurrentModel(finalResult),
    };
  } catch (error) {
    // Died before the engine started (credential gate, lease, warm-up): the row minted for this
    // turn is dropped so the next message is a true first turn again.
    await dropUnusedSession();
    // A provider/CLI can echo a credential in its failure, which callers may post to the thread.
    // Preserve error identity and classification while making its public text safe.
    if (error && typeof error === "object") {
      if (typeof error.message === "string") error.message = redactSecretValues(error.message, outputSecrets);
      if (typeof error.stack === "string") error.stack = redactSecretValues(error.stack, outputSecrets);
      if (error.details) error.details = redactSecretFields(error.details, outputSecrets);
    }
    throw error;
  } finally {
    // Release whatever the streaming redactor was still holding back, exactly as the mention
    // holdback does — otherwise every answer in a channel with secrets loses its last few
    // characters from the live message.
    try {
      const tail = deltaRedactor?.flush() || "";
      if (tail && onDelta) onDelta(tail);
    } catch { /* the answer is already delivered; a flush failure must not mask the real outcome */ }
    // The turn no longer needs the run environment up. Releasing is also the activity stamp the
    // idle reaper counts from, so it must happen on every exit — answer, error, or stop.
    try { runtimeLease?.release(); } catch { /* a lease that cannot be released must not mask the turn's outcome */ }
    releaseRunSlot?.();
    // Best-effort: the config file only matters at spawn time. A leftover from a daemon crash
    // sits 0600 under the (read-denied) gateway root until the next boot sweeps it.
    if (mcpConfigFile) await rm(mcpConfigFile, { force: true }).catch(() => {});
    await grantArtifacts.cleanup().catch(() => {});
  }
}
