// Daemon settings managed from the admin UI, persisted to ~/.channelgate/config/settings.json
// (gitignored runtime dir). These override .env: at boot and after every save we copy them into
// process.env so the existing env-based readers (Slack tokens, keepalive, Composio URL) pick
// them up. Tokens are write-only via the API (masked on read), never logged.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { settingsFile } from "./paths.js";
import { writeSecretFile } from "./harden.js";
import { getDb } from "../db/index.js";
import { ENGINE_IDS, adapterOr } from "../engines/registry.js";
// The default container image ref lives with the image module (a dependency-free leaf) so the
// transactional updater can name the same image without importing this file's database layer.
import { CONTAINER_DEFAULT_IMAGE } from "../runtimes/container/image.js";

// settings.json key → environment variable it feeds.
const ENV_MAP = {
  slackBotToken: "SLACK_BOT_TOKEN",
  slackAppToken: "SLACK_APP_TOKEN",
  slackSigningSecret: "SLACK_SIGNING_SECRET",
  sessionKeepalive: "SESSION_KEEPALIVE",
  composioMcpUrl: "COMPOSIO_MCP_URL",
  toolboxMcpUrl: "TOOLBOX_MCP_URL",
  publicUrl: "GATEWAY_PUBLIC_URL",
  platformUrl: "CHANNELGATE_PLATFORM_URL",
};

export function getSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

// Operators commonly enter a tunnel hostname without a scheme. Browser-facing capabilities need
// an absolute URL, so make that convenient spelling canonical at the settings boundary. Preserve
// an explicitly selected scheme (notably http:// for local development) and remove trailing `/`.
export function normalizePublicUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Merge a partial patch into settings.json (only supplied, non-undefined keys change). The file's
// read-modify-write is serialized across BOTH processes (daemon + spawned MCP server) by holding
// the shared SQLite write lock (BEGIN IMMEDIATE) for its duration — two concurrent saves would
// otherwise each read the same base and silently drop the other's keys.
export function saveSettings(patch) {
  const db = getDb();
  mkdirSync(path.dirname(settingsFile()), { recursive: true }); // doesn't need the lock
  // The BEGIN IMMEDIATE lock intentionally spans the read-merge-write of settings.json: it is the
  // only cross-process mutex we have (daemon + MCP server), and the held work is a tiny sync
  // read+write (~ms, far under busy_timeout) on rare admin saves — bounded by design.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getSettings();
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      next[k] = k === "publicUrl" ? normalizePublicUrl(v) : v;
    }
    // 0600: this file holds the Slack tokens, the org Composio/Skills/Toolbox tokens, the run-API
    // key and the admin password.
    writeSecretFile(settingsFile(), JSON.stringify(next, null, 2) + "\n");
    db.exec("COMMIT");
    return next;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transaction already gone */
    }
    throw e;
  }
}

// Ambient (pre-override) value of each managed env var, captured the first time we touch it.
// Without this, clearing a UI setting would leave the previously-applied value live in
// process.env until the next restart (the old code only ever assigned, never removed).
const ambientEnv = new Map(); // envName → original process.env value (undefined = was unset)

// Push stored settings into process.env (UI-managed values win over .env). Cleared settings
// restore the ambient value from boot — or delete the variable if it never had one.
export function applySettingsToEnv() {
  const s = getSettings();
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    if (!ambientEnv.has(envName)) ambientEnv.set(envName, process.env[envName]);
    if (typeof s[key] === "string" && s[key] !== "") {
      process.env[envName] = s[key];
    } else {
      const original = ambientEnv.get(envName);
      if (original === undefined) delete process.env[envName];
      else process.env[envName] = original;
    }
  }
}

// Effective Slack config from settings.json, falling back to the ambient environment.
export function resolveSlackConfig() {
  const s = getSettings();
  return {
    botToken: s.slackBotToken || process.env.SLACK_BOT_TOKEN || "",
    appToken: s.slackAppToken || process.env.SLACK_APP_TOKEN || "",
    signingSecret: s.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || "",
  };
}

export function hasSlackConfig() {
  const c = resolveSlackConfig();
  return Boolean(c.botToken && c.appToken && c.signingSecret);
}

// ── Google Chat ─────────────────────────────────────────────────────────────
// A Chat app with a Cloud Pub/Sub connection: Google publishes the app's events to a topic we own
// and the daemon PULLS them, so there is no inbound endpoint and no tunnel — the same outbound-only
// posture as Slack's Socket Mode. Three values are needed: the service-account key (auth for both
// the Chat REST calls and the pull), the subscription to pull from, and — only for mention
// detection before the app has ever been mentioned — the app's own users/NNN id, which the
// transport learns by itself from the first membership event.
export function resolveGoogleChatConfig() {
  const s = getSettings();
  return {
    serviceAccountJson: s.googleChatServiceAccountJson || process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON || "",
    subscription: String(s.googleChatSubscription || process.env.GOOGLE_CHAT_SUBSCRIPTION || "").trim(),
    botUserId: String(s.googleChatBotUserId || process.env.GOOGLE_CHAT_BOT_USER_ID || "").trim(),
  };
}

// The service account's own address, parsed out of the stored key. Shown in the admin UI because
// it is the value a Workspace admin needs (the Chat app is configured to publish to a topic this
// identity may pull from) — and because it is the one part of a key file that is not a secret.
export function googleChatServiceAccountEmail() {
  const raw = resolveGoogleChatConfig().serviceAccountJson;
  if (!raw) return "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return String(parsed?.client_email || "");
  } catch {
    return "";
  }
}

export function hasGoogleChatConfig() {
  const c = resolveGoogleChatConfig();
  return Boolean(c.serviceAccountJson && c.subscription);
}

// ── Microsoft Teams ─────────────────────────────────────────────────────────
// An Azure Bot registration. Outbound needs the app id + secret (+ tenant for a single-tenant app);
// INBOUND needs a publicly reachable HTTPS endpoint, which is why `publicUrl` matters here — the
// messaging endpoint an operator registers in Azure is `<publicUrl>/api/teams/messages`.
export function resolveTeamsConfig() {
  const s = getSettings();
  return {
    appId: String(s.teamsAppId || process.env.TEAMS_APP_ID || "").trim(),
    appPassword: s.teamsAppPassword || process.env.TEAMS_APP_PASSWORD || "",
    tenantId: String(s.teamsTenantId || process.env.TEAMS_TENANT_ID || "").trim(),
  };
}

export function hasTeamsConfig() {
  const c = resolveTeamsConfig();
  return Boolean(c.appId && c.appPassword);
}

// The endpoint an operator pastes into the Azure bot registration. Empty when no public URL is
// configured — which is exactly the state in which Teams cannot receive anything, so the admin UI
// says so rather than showing a URL that will never be called.
export function teamsMessagingEndpoint() {
  const base = getPublicUrl();
  return base ? `${base}/api/teams/messages` : "";
}

// Public base URL the daemon is reachable at (e.g. https://gateway.makeitfuture.com). General
// daemon setting (not Slack-specific).
export function getPublicUrl() {
  const s = getSettings();
  return normalizePublicUrl(s.publicUrl || process.env.GATEWAY_PUBLIC_URL || "");
}

// Native Slack text streaming is the only in-progress display mode. Keep the exported shape for
// admin/API compatibility, but ignore legacy stored values from older installs.
export const PROGRESS_VIEWS = ["stream"];
export function getProgressView() {
  return "stream";
}

// Which CLI engine to drive: "claude" (default, full features) or "codex" (OpenAI Codex CLI;
// cold-resume only, no warm sessions / skills / exact-$ cost).
// Re-exported from the engine registry so there is ONE list of engines, not a copy per module.
export const ENGINES = ENGINE_IDS;

// Per-harness on/off switch. An admin turns off an engine they don't have set up (or don't want
// used) and it disappears from every selector AND from the failover graph. Stored as a sparse map
// keyed by engine id; a MISSING key means enabled, so an existing install (and any engine added
// later) keeps working without a migration.
// Fails OPEN: a stored map that disables everything would brick the gateway, so the getter treats
// "all engines off" as "all engines on" (the API route also refuses to save that state).
export function isEngineEnabled(engine) {
  const id = String(engine || "");
  if (!ENGINES.includes(id)) return false;
  const map = getSettings().engineEnabled;
  if (!map || typeof map !== "object") return true;
  if (!ENGINES.some((e) => map[e] !== false)) return true; // never lock every harness out
  return map[id] !== false;
}
export function getEnabledEngines() {
  return ENGINES.filter(isEngineEnabled);
}
// The stored map, normalized to an explicit boolean per known engine (what the admin UI renders).
export function getEngineEnabledMap() {
  return Object.fromEntries(ENGINES.map((id) => [id, isEngineEnabled(id)]));
}

export function getEngine() {
  const v = getSettings().engine;
  const configured = ENGINES.includes(v) ? v : "claude";
  // A disabled harness must not stay the gateway default just because it's the stored value —
  // resolve to the first enabled one instead of spawning a CLI the admin turned off.
  return isEngineEnabled(configured) ? configured : getEnabledEngines()[0] || configured;
}

// Gateway-wide default model, per engine. Used when a channel/DM/thread sets no model of its own,
// so every spawn gets an explicit --model / -m and NEVER inherits the admin's terminal-level model
// (what `/model` in an interactive Claude Code session writes to ~/.claude/settings.json). Empty =
// no flag, i.e. the CLI's own default — the pre-existing (leaky) behavior, kept as the fallback.
export function getDefaultModel(engine) {
  const s = getSettings();
  // Per-engine default model, looked up by the adapter's settings key rather than a binary
  // ternary that would silently hand a third engine Claude's default.
  const v = s[adapterOr(engine).defaultModelKey];
  return typeof v === "string" ? v.trim() : "";
}

// Who may use Slack's /model wizard in a CHANNEL (both channel-wide and thread-scoped picks).
// Everyone reaching this gate has already passed the channel's normal authorization policy, so
// "users" means every authorized channel user (approved members plus explicit guest grants).
// DMs deliberately stay outside this policy: approved users can customize their own DM runtime.
export const MODEL_CHANGE_ACCESS_MODES = ["admins", "users"];
export function getModelChangeAccess() {
  const v = getSettings().modelChangeAccess;
  return MODEL_CHANGE_ACCESS_MODES.includes(v) ? v : "admins";
}
export function canChangeChannelRuntime(isAdminUser = false) {
  return Boolean(isAdminUser) || getModelChangeAccess() === "users";
}

// Cross-engine failover: when the engine driving a turn fails with an authentication or
// usage/spend-limit error BEFORE doing any work, transparently answer with the other enabled
// harness (a fresh turn on that engine) until the failed one recovers. Direction-agnostic —
// Claude→Codex and Codex→Claude are the same mechanism.
// `codexFallback` is the pre-rename key: honored when the generic one was never written, so an
// existing install keeps whatever the admin chose. Default on.
export function getEngineFallback() {
  const s = getSettings();
  const v = s.engineFallback === undefined ? s.codexFallback : s.engineFallback;
  return v === undefined ? true : Boolean(v);
}
// Deprecated alias — kept so nothing outside this module has to know about the rename.
export const getCodexFallback = getEngineFallback;
// HOW a replay-safe failure switches harness: "auto" — the turn is answered by the other harness
// without asking (today's behaviour); "ask" — the thread gets a message with buttons (switch / try
// again) and nothing runs until someone clicks. Only a live Slack turn can be asked; every other
// origin (schedules, background agents, continuations, the API) behaves as "auto".
export const ENGINE_FALLBACK_MODES = ["auto", "ask"];
export function getEngineFallbackMode() {
  const v = getSettings().engineFallbackMode;
  return ENGINE_FALLBACK_MODES.includes(v) ? v : "auto";
}

// Dollar cost is still recorded in the usage ledger and exposed through reporting APIs when this
// display preference is off. Missing stays enabled so existing installations keep today's footer.
export function getShowMessageCost() {
  const v = getSettings().showMessageCost;
  return v === undefined ? true : Boolean(v);
}

// Local voice transcription is optional for lightweight/server installs. Missing stays enabled so
// every existing gateway keeps its pre-setting behavior until an admin explicitly turns it off.
export function getWhisperEnabled() {
  const v = getSettings().whisperEnabled;
  return v === undefined ? true : Boolean(v);
}

// ── Container runtime (v0.8) ──────────────────────────────────────────────────────────────────
// Flat keys like every other setting (the secrets allowlist resolves top-level names). Read as one
// snapshot by resolveRuntime() and carried on the RuntimeTarget — backend modules never import
// this file (they sit below src/engines/ in the import graph).
export const CONTAINER_CLIS = Object.freeze(["auto", "podman", "docker"]);
export { CONTAINER_DEFAULT_IMAGE };
function settingInt(v, { min, max, fallback }) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
export function getContainerRuntime() {
  const s = getSettings();
  return {
    cli: CONTAINER_CLIS.includes(s.containerCli) ? s.containerCli : "auto",
    image: typeof s.containerImage === "string" && s.containerImage.trim() ? s.containerImage.trim() : CONTAINER_DEFAULT_IMAGE,
    idleMinutes: settingInt(s.containerIdleMinutes, { min: 1, max: 1440, fallback: 10 }),
    maxRunning: settingInt(s.containerMaxRunning, { min: 1, max: 500, fallback: 8 }),
    pidsLimit: settingInt(s.containerPidsLimit, { min: 64, max: 65536, fallback: 1024 }),
    memory: typeof s.containerMemory === "string" ? s.containerMemory.trim() : "",
    cpus: typeof s.containerCpus === "string" ? s.containerCpus.trim() : "",
    // Presence only — the value goes through getContainerClaudeOauthToken() at spawn time.
    hasClaudeOauthToken: Boolean(s.containerClaudeOauthToken),
    // Full-access (adminMode) channels get the gateway user's whole home directory mounted
    // read-write at its identical path (src/runtimes/container/lifecycle.js operatorHomeMounts).
    // Off by default: the confined work-folder-only admin channel is the product's posture; an
    // operator who wants an overseer channel that sees every agent and every repo switches it on.
    fullAccessHome: s.containerFullAccessHome === true,
  };
}
// The long-lived subscription token from `claude setup-token`, injected as CLAUDE_CODE_OAUTH_TOKEN
// into container runs (plan §11 item 1). Never listed; write-only from the API like the other tokens.
export function getContainerClaudeOauthToken() {
  return String(getSettings().containerClaudeOauthToken || "");
}
// `--memory 2g` / `--cpus 1.5` ride the container CLI's argv as single tokens, and `image` names a
// program to run. Validated at the ADMIN BOUNDARY (src/web/routes/settings.js) against these, so a
// pasted value can never carry a flag, a space, or a shell metacharacter into the run command.
export const CONTAINER_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/;
export const CONTAINER_MEMORY_RE = /^[0-9]+(\.[0-9]+)?[bkmgBKMG]?$/;
export const CONTAINER_CPUS_RE = /^[0-9]+(\.[0-9]+)?$/;

// Agent instruction files: when on, each channel folder gets a CLAUDE.md (the editable
// instructions, read by Claude) + an AGENTS.md symlink → CLAUDE.md (read by Codex), so the same
// instructions reach both engines and you can edit CLAUDE.md directly.
export function getAgentsFile() {
  const v = getSettings().agentsFile;
  return v === undefined ? true : Boolean(v);
}
export function getAgentsInstructions() {
  const v = getSettings().agentsInstructions;
  return typeof v === "string" ? v : "";
}

// Folder-scoped agent memory: when on, each channel folder gets a MEMORY.md the agent reads at
// the start of a task and updates as it learns durable facts about the channel. It lives INSIDE
// the channel folder (no cross-channel bleed) and is the confinement-safe substitute for Claude's
// global autoMemory (which stays off). Default on. Per-channel meta.memory can override.
export function getAgentMemory() {
  const v = getSettings().agentMemory;
  return v === undefined ? true : Boolean(v);
}

// Background memory review (gateway/memory-review.js): after a delivered foreground turn, a small
// reviewer run reads the thread and saves what the model itself did not. `memoryReviewEvery` is
// the per-channel turn interval between reviews (0 = off; a turn that looks like a correction or
// decision reviews regardless); `memoryReviewModel` is the Claude model/alias the reviewer runs
// on (a cheap one — it only extracts facts); `memoryReviewNotify` posts "🧠 Memory updated" in
// the thread when the review saved something, so a wrong save is visible and correctable.
export const DEFAULT_MEMORY_REVIEW_EVERY = 5;
export const DEFAULT_MEMORY_REVIEW_MODEL = "haiku";
export function getMemoryReviewEvery() {
  const v = getSettings().memoryReviewEvery;
  if (v === undefined || v === null || v === "") return DEFAULT_MEMORY_REVIEW_EVERY;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MEMORY_REVIEW_EVERY;
}
export function getMemoryReviewModel() {
  const v = getSettings().memoryReviewModel;
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_MEMORY_REVIEW_MODEL;
}
export function getMemoryReviewNotify() {
  const v = getSettings().memoryReviewNotify;
  return v === undefined ? true : Boolean(v);
}

// Scheduled two-way Google Drive sync (see gateway/drivesync.js). Dormant unless enabled AND a
// service-account key file is set AND rclone is installed. Auth is a Workspace service account; the
// key file is a PATH (not a secret) and the subject is an email — neither is masked.
export const DRIVE_SYNC_CONFLICTS = ["newer", "older", "larger", "path1", "path2"];
export function getDriveSyncEnabled() {
  return Boolean(getSettings().driveSyncEnabled);
}
export function getDriveSyncKeyFile() {
  const v = getSettings().driveSyncKeyFile;
  return typeof v === "string" ? v.trim() : "";
}
// The service-account key pasted into the UI (raw JSON). A write-only secret: stored here but never
// returned to the client (see settingsForApi, which exposes only hasKey + the client_email). The
// engine materializes it to a chmod-600 file (drivesync.resolveDriveSyncKeyFile).
export function getDriveSyncKeyJson() {
  const v = getSettings().driveSyncKeyJson;
  return typeof v === "string" ? v : "";
}
// The service account's email, parsed from the pasted key — surfaced to the UI so the admin knows
// which address to share Drive folders with. Empty when no JSON key is stored / it can't be parsed.
export function getDriveSyncKeyEmail() {
  const raw = getDriveSyncKeyJson();
  if (!raw) return "";
  try {
    return String(JSON.parse(raw).client_email || "");
  } catch {
    return "";
  }
}
export function getDriveSyncSubject() {
  const v = getSettings().driveSyncSubject; // optional domain-wide-delegation impersonation subject
  return typeof v === "string" ? v.trim() : "";
}
export function getDriveSyncIntervalMinutes() {
  const v = Number(getSettings().driveSyncIntervalMinutes);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 15;
}
export function getDriveSyncConflict() {
  const v = getSettings().driveSyncConflict;
  return DRIVE_SYNC_CONFLICTS.includes(v) ? v : "newer";
}
export function getDriveSyncRclonePath() {
  const v = getSettings().driveSyncRclonePath; // absolute path sidesteps the service unit's minimal PATH
  return typeof v === "string" && v.trim() ? v.trim() : "rclone";
}

// Codex blended $/1M-token rate used to ESTIMATE Codex run cost in the usage ledger (Codex reports
// no dollar cost). 0/unset → no estimate (cost left null, tokens still recorded). LEGACY fallback —
// the per-model rates below take precedence when a model matches.
export function getCodexRatePer1MTokens() {
  const v = Number(getSettings().codexRatePer1MTokens);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// Per-model Codex $/1M-token rates for the cost ESTIMATE (input / cached-input / output).
// Defaults verified against OpenAI's STANDARD API pricing table on 2026-08-16; admins can adjust
// them in Settings → Integrations. `cachedInput` prices the cached_input_tokens subset of input.
// Editable values are merged OVER these defaults, so a pricing change only needs the changed cell;
// the model list itself is fixed and intentionally small.
export const DEFAULT_CODEX_RATES = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6": { input: 5, cachedInput: 0.5, output: 30 }, // alias for gpt-5.6-sol
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 }, // the Codex CLI's own family
};

// The admin UI historically saved the complete displayed table, including untouched defaults.
// When OpenAI changes a default, an old full snapshot would therefore shadow the corrected code
// forever. Treat only the two exact retired defaults as inherited values; genuinely customized
// cells (anything else) remain authoritative. A subsequent Settings save persists the new table.
const RETIRED_CODEX_DEFAULTS = {
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6 },
};

function isExactRate(value, expected) {
  return value && expected && ["input", "cachedInput", "output"].every((key) => Number(value[key]) === expected[key]);
}

export function getCodexModelRates() {
  const stored = getSettings().codexModelRates || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const out = {};
  for (const [model, d] of Object.entries(DEFAULT_CODEX_RATES)) {
    const candidate = stored[model] || {};
    const s = isExactRate(candidate, RETIRED_CODEX_DEFAULTS[model]) ? {} : candidate;
    out[model] = { input: num(s.input, d.input), cachedInput: num(s.cachedInput, d.cachedInput), output: num(s.output, d.output) };
  }
  return out;
}

// Emoji reactions that act as an @mention: reacting with one on any message makes the bot
// respond to that message. Stored as Slack emoji names without colons (e.g. "robot_face").
// Default: robot_face (🤖). Admins can add others from Settings.
export function getMentionReactions() {
  const v = getSettings().mentionReactions;
  if (Array.isArray(v)) {
    const clean = v.map((s) => String(s).trim().replace(/^:|:$/g, "").toLowerCase()).filter(Boolean);
    if (clean.length) return clean;
  }
  return ["robot_face"];
}

// Org-level default access policy applied to each channel when the bot first joins/registers it.
// Captured onto the channel's meta at that moment (so changing this later only affects channels
// joined afterward; existing channels keep their stored value, missing = "approved"):
//   - "approved" → admins + all org-approved members (today's behavior)
//   - "admins"   → gateway admins only
//   - "none"     → nobody auto-granted; the channel is dormant until a user is explicitly added
//                  to that channel's allowedUsers (the manual override).
export const CHANNEL_ACCESS_MODES = ["approved", "admins", "none"];
export function getDefaultChannelAccess() {
  const v = getSettings().defaultChannelAccess;
  return CHANNEL_ACCESS_MODES.includes(v) ? v : "approved";
}

// Composio can operate in the existing independently supplied personal/shared-token mode, or in
// organization SDK mode. Missing defaults to personal so upgrades never change an installation's
// credential resolution. Switching this enum NEVER mutates either mode's stored credentials.
export const COMPOSIO_MODES = ["personal", "sdk"];
export function getComposioMode() {
  const v = getSettings().composioMode;
  return COMPOSIO_MODES.includes(v) ? v : "personal";
}
export function getComposioSdkApiKey() {
  const v = getSettings().composioSdkApiKey;
  return typeof v === "string" ? v.trim() : "";
}

// Org-level (gateway) default tokens. For shared Composio this follows the channel token; Toolbox
// uses the full channel → user → org chain (see src/gateway/run.js). Write-only via the admin API
// (masked on read), never logged.
export function getDefaultComposioToken() {
  const v = getSettings().defaultComposioToken;
  return typeof v === "string" ? v : "";
}
export function getDefaultToolboxToken() {
  const v = getSettings().defaultToolboxToken;
  return typeof v === "string" ? v : "";
}

// Skills platform (src/gateway/skills). A GitHub token for private skill repositories and API
// rate limits — daemon-side only, never in a channel folder or an MCP config; write-only via the
// admin API. The sync interval in minutes (0 = off) and the always-on context estimate above
// which a channel profile is flagged (resolve.js).
export function getSkillsGithubToken() {
  const v = getSettings().skillsGithubToken;
  return typeof v === "string" ? v.trim() : "";
}
// Write credential for the one configured Git publishing destination. Source credentials live
// on their own skill_sources rows; keeping this separate prevents an unrelated private source
// from silently receiving a token with write access to the publishing repository.
export function getSkillsPublishGithubToken() {
  const v = getSettings().skillsPublishGithubToken;
  return typeof v === "string" ? v.trim() : "";
}
export function getSkillsSyncIntervalMinutes() {
  const v = Number(getSettings().skillsSyncIntervalMinutes);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 24 * 60) : 60;
}
export function getSkillsContextWarnTokens() {
  const v = Number(getSettings().skillsContextWarnTokens);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 6000;
}
// Git publishing of authored/approved skills (src/gateway/skills/publish.js): the repository,
// branch and folder, and whether publishing is on. Empty repo = off.
export function getSkillsPublish() {
  const s = getSettings();
  const mode = s.skillsPublishMode === "off" ? "off" : "commit";
  return {
    repo: typeof s.skillsPublishRepo === "string" ? s.skillsPublishRepo.trim() : "",
    branch: typeof s.skillsPublishBranch === "string" && s.skillsPublishBranch.trim() ? s.skillsPublishBranch.trim() : "main",
    subpath: typeof s.skillsPublishSubpath === "string" ? s.skillsPublishSubpath.trim().replace(/^\/+|\/+$/g, "") : "skills",
    mode,
  };
}
// The shared secret GitHub signs push webhooks with (X-Hub-Signature-256). Write-only.
export function getSkillsWebhookSecret() {
  const v = getSettings().skillsWebhookSecret;
  return typeof v === "string" ? v.trim() : "";
}

// Organization-wide skill/connector grants. Unlike tokens these are not a fallback: they are the
// first tier of a live org + channel + user union resolved on every run (access-grants.js).
export function getOrgAccessGrants() {
  const value = getSettings().accessGrants;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// Optional Slack ADMIN USER token (xoxp-…) for /delete. A bot token can only delete the bot's own
// messages; chat.delete with a workspace admin's user token can also delete other people's
// (workspace preferences permitting). Only ever used by the org-admin-gated /delete command —
// never handed to a run or an MCP config. Write-only via the admin API (masked on read).
export function getSlackAdminUserToken() {
  const v = getSettings().slackAdminUserToken;
  return typeof v === "string" ? v : "";
}

// Apps/integrations allowed to drive runs even though their messages carry a bot_id. Normally
// every bot message is ignored (reply-loop prevention); a message whose Slack app_id OR bot_id is
// on this list is let through — it must STILL contain a real @mention and come from an approved
// `user`, so there's no loop risk (the gateway's own posts use a different app_id). Stored as
// Slack app/bot IDs (e.g. "A07FPU6DA9E" for a Make.com scenario). Default: none.
export function getTrustedBotApps() {
  const v = getSettings().trustedBotApps;
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

// Slug of the channel that receives an automatic self-diagnosis thread when a run errors
// ("" = feature off). Point it at the dev channel whose work folder is the gateway repo itself
// (e.g. "gateway-slack") so the diagnosis run can read the source it is diagnosing.
export function getErrorDiagnosisChannel() {
  const s = getSettings();
  return String(s.errorDiagnosisChannel || process.env.ERROR_DIAGNOSIS_CHANNEL || "").trim();
}

// Scheduler guardrails. The minimum interval (minutes) a recurring cron may fire at — schedules
// that would fire more often are rejected (default 60, i.e. at most hourly). Plus a ceiling on how
// many enabled schedules one channel may have. Both adjustable from Settings.
export function getScheduleMinIntervalMinutes() {
  const v = Number(getSettings().scheduleMinIntervalMinutes);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 60;
}
export function getScheduleMaxPerChannel() {
  const v = Number(getSettings().scheduleMaxPerChannel);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 20;
}

// Hours of silence before an opt-in channel's thread gets a single "no-response" nudge. Default 24.
export function getNoResponseReminderHours() {
  const v = Number(getSettings().noResponseReminderHours);
  return Number.isFinite(v) && v >= 1 ? v : 24;
}

// Org-level default for the no-response nudge, captured onto a channel's/DM's meta.nudges when the
// bot first registers it (so changing this later only affects conversations added afterward; the
// "reset all" button pushes it onto existing ones). Default off — nudges stay opt-in unless an
// admin turns this on.
export function getDefaultNudges() {
  return Boolean(getSettings().defaultNudges);
}

// Personal "pending-response" follow-up digests. When on (default), each approved user gets a DM
// at the configured hours listing the threads (in channels the bot is in) that are awaiting their
// reply — a thread they took part in where someone else spoke last and they haven't ✅'d it.
export function getFollowupRemindersEnabled() {
  const v = getSettings().followupRemindersEnabled;
  return v === undefined ? true : Boolean(v);
}
// Local hours (in the configured timezone) at which the digest fires. Default 08:00 and 14:00.
export function getFollowupDigestHours() {
  const v = getSettings().followupDigestHours;
  if (Array.isArray(v)) {
    const clean = [...new Set(v.map((h) => Math.floor(Number(h))).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))];
    if (clean.length) return clean;
  }
  return [8, 14];
}
// IANA timezone the digest hours are interpreted in. Default Europe/Bucharest.
export function getFollowupTimeZone() {
  const v = getSettings().followupTimeZone;
  return typeof v === "string" && v.trim() ? v.trim() : "Europe/Bucharest";
}
// Reactions that mark a thread "done" (clears it from your follow-ups). Default ✅ and ✔️.
export function getFollowupDoneReactions() {
  const v = getSettings().followupDoneReactions;
  if (Array.isArray(v)) {
    const clean = v.map((s) => String(s).trim().replace(/^:|:$/g, "").toLowerCase()).filter(Boolean);
    if (clean.length) return clean;
  }
  return ["white_check_mark", "heavy_check_mark"];
}

// Model context window (tokens) used to show "ctx N%" in replies. Default 200k.
export function getContextWindow() {
  const v = Number(getSettings().contextWindow);
  return Number.isFinite(v) && v > 0 ? v : 200_000;
}

// Org-level conversation templates. The channel template is copied once when a non-DM is first
// registered; DM templates remain live selections that DMs resolve on every run.
const DM_TEMPLATE_DEFAULT = { skills: [], skillTemplate: "", allowedMcps: [], allowedCodexMcps: [], model: "", effort: "", adminMode: false, allowBash: false, allowNetwork: false, autoMode: false, cleanMode: false, engine: "" };
const CHANNEL_TEMPLATE_DEFAULT = { ...DM_TEMPLATE_DEFAULT, allowBash: true, allowNetwork: true, autoMode: true };
export function getChannelTemplate() {
  const t = getSettings().channelTemplate;
  return { ...CHANNEL_TEMPLATE_DEFAULT, ...(t && typeof t === "object" && !Array.isArray(t) ? t : {}) };
}
export function applyChannelTemplate(meta) {
  if (meta?.isDM) return meta;
  // Templates store canonical flags, not a profile label. Removing the base record's explicit
  // "read" marker lets channelProfile() derive the selected profile from the copied flags.
  return { ...meta, ...getChannelTemplate(), profile: undefined };
}
export function getDmTemplates() {
  const t = getSettings().dmTemplates || {};
  return {
    user: { ...DM_TEMPLATE_DEFAULT, ...(t.user || {}) },
    admin: { ...DM_TEMPLATE_DEFAULT, ...(t.admin || {}) },
  };
}
export function getDmTemplate(name) {
  return getDmTemplates()[name] || DM_TEMPLATE_DEFAULT;
}

// Admin UI password: a UI-managed value (settings.json) takes precedence over ADMIN_PASSWORD
// from the environment, so it can be changed from Settings without editing .env. Empty = open.
export function getAdminPassword() {
  const s = getSettings();
  if (typeof s.adminPassword === "string" && s.adminPassword) return s.adminPassword;
  return process.env.ADMIN_PASSWORD || "";
}

// HTTP run API key: a bearer credential for POST /api/runs + GET /api/runs/:id, so an automation
// (Make.com, a cron, …) can fire runs without an admin session cookie. UI-managed (settings.json)
// wins over CG_API_KEY in the environment. Empty = the run API accepts only an admin session (and,
// on a loopback bind with no admin password, the usual local-open default).
export function getApiKey() {
  const s = getSettings();
  if (typeof s.apiKey === "string" && s.apiKey) return s.apiKey;
  return process.env.CG_API_KEY || "";
}

// License key (src/ee/license.js). Stored here rather than in src/ee/ so that settingsForApi and
// the secrets allowlist can read it without importing the proprietary directory — the RULE, though,
// has exactly one home: UI-managed settings.json wins, CHANNELGATE_LICENSE_KEY is the bootstrap
// source for a container that has never had an admin session. Never returned by a listing (only
// hasLicenseKey/licenseKeyLast4 below) and revealable one at a time via /api/secrets/reveal.
export function getLicenseKey() {
  const s = getSettings();
  if (typeof s.licenseKey === "string" && s.licenseKey.trim()) return s.licenseKey.trim();
  return String(process.env.CHANNELGATE_LICENSE_KEY || "").trim();
}

function last4(v) {
  return v ? String(v).slice(-4) : "";
}

// Admin view for the UI. Deliberately carries NO secret values — only has*/last4 for display.
// Returning every token here made the blast radius of any admin-surface weakness the whole
// workspace's credentials at once. The UI fetches one value at a time from POST
// /api/secrets/reveal, which re-prompts for the admin password (see src/web/secrets.js).
export function settingsForApi() {
  const c = resolveSlackConfig();
  const s = getSettings();
  return {
    tokens: {
      hasBotToken: Boolean(c.botToken),
      botTokenLast4: last4(c.botToken),
      hasAppToken: Boolean(c.appToken),
      appTokenLast4: last4(c.appToken),
      hasSigningSecret: Boolean(c.signingSecret),
      hasAdminUserToken: Boolean(getSlackAdminUserToken()),
      adminUserTokenLast4: last4(getSlackAdminUserToken()),
    },
    sessionKeepalive: s.sessionKeepalive ?? process.env.SESSION_KEEPALIVE ?? "10m",
    composioMode: getComposioMode(),
    hasComposioSdkApiKey: Boolean(getComposioSdkApiKey()),
    composioSdkApiKeyLast4: last4(getComposioSdkApiKey()),
    composioMcpUrl: s.composioMcpUrl ?? process.env.COMPOSIO_MCP_URL ?? "https://connect.composio.dev/mcp",
    toolboxMcpUrl: s.toolboxMcpUrl ?? process.env.TOOLBOX_MCP_URL ?? "https://www.skillsmanager.uk/toolbox",
    publicUrl: getPublicUrl(),
    progressView: getProgressView(),
    mentionReactions: getMentionReactions(),
    trustedBotApps: getTrustedBotApps(),
    defaultChannelAccess: getDefaultChannelAccess(),
    hasDefaultComposioToken: Boolean(getDefaultComposioToken()),
    defaultComposioTokenLast4: last4(getDefaultComposioToken()),
    defaultComposioTokenLabel: s.defaultComposioTokenLabel || "",
    hasDefaultToolboxToken: Boolean(getDefaultToolboxToken()),
    defaultToolboxTokenLast4: last4(getDefaultToolboxToken()),
    defaultToolboxTokenLabel: s.defaultToolboxTokenLabel || "",
    hasSkillsGithubToken: Boolean(getSkillsGithubToken()),
    skillsGithubTokenLast4: last4(getSkillsGithubToken()),
    hasSkillsPublishGithubToken: Boolean(getSkillsPublishGithubToken()),
    skillsPublishGithubTokenLast4: last4(getSkillsPublishGithubToken()),
    skillsSyncIntervalMinutes: getSkillsSyncIntervalMinutes(),
    skillsContextWarnTokens: getSkillsContextWarnTokens(),
    skillsPublishRepo: getSkillsPublish().repo,
    skillsPublishBranch: getSkillsPublish().branch,
    skillsPublishSubpath: getSkillsPublish().subpath,
    skillsPublishMode: getSkillsPublish().mode,
    hasSkillsWebhookSecret: Boolean(getSkillsWebhookSecret()),
    skillsWebhookSecretLast4: last4(getSkillsWebhookSecret()),
    // Google Chat + Teams credentials follow the same write-only rule as the Slack tokens: the
    // listing says whether a value EXISTS and its last four characters, never the value. A
    // service-account key is a private key — only its client_email is echoed, because that is the
    // identity an operator has to share with their Workspace admin.
    googleChat: {
      hasServiceAccount: Boolean(resolveGoogleChatConfig().serviceAccountJson),
      serviceAccountEmail: googleChatServiceAccountEmail(),
      subscription: resolveGoogleChatConfig().subscription,
      botUserId: resolveGoogleChatConfig().botUserId,
      configured: hasGoogleChatConfig(),
    },
    teams: {
      appId: resolveTeamsConfig().appId,
      hasAppPassword: Boolean(resolveTeamsConfig().appPassword),
      appPasswordLast4: last4(resolveTeamsConfig().appPassword),
      tenantId: resolveTeamsConfig().tenantId,
      configured: hasTeamsConfig(),
      // What the operator must paste into the Azure bot registration. Empty when no public URL is
      // set, which is exactly when Teams cannot receive anything.
      messagingEndpoint: teamsMessagingEndpoint(),
    },
    accessGrants: getOrgAccessGrants(),
    engine: getEngine(),
    defaultClaudeModel: getDefaultModel("claude"),
    defaultCodexModel: getDefaultModel("codex"),
    modelChangeAccess: getModelChangeAccess(),
    engineEnabled: getEngineEnabledMap(),
    engineFallback: getEngineFallback(),
    engineFallbackMode: getEngineFallbackMode(),
    codexFallback: getEngineFallback(), // legacy key — same value, kept for older API clients

    showMessageCost: getShowMessageCost(),
    whisperEnabled: getWhisperEnabled(),
    // Container runtime (v0.8). Non-secret values verbatim; the Claude token follows the same
    // write-only rule as every other credential here — has*/last4 only, fetched one at a time from
    // POST /api/secrets/reveal.
    ...(() => {
      const c = getContainerRuntime();
      return {
        containerCli: c.cli,
        containerImage: c.image,
        containerIdleMinutes: c.idleMinutes,
        containerMaxRunning: c.maxRunning,
        containerPidsLimit: c.pidsLimit,
        containerMemory: c.memory,
        containerCpus: c.cpus,
        containerFullAccessHome: c.fullAccessHome,
        hasContainerClaudeOauthToken: c.hasClaudeOauthToken,
        containerClaudeOauthTokenLast4: last4(getContainerClaudeOauthToken()),
      };
    })(),
    agentsFile: getAgentsFile(),
    agentsInstructions: getAgentsInstructions(),
    agentMemory: getAgentMemory(),
    memoryReviewEvery: getMemoryReviewEvery(),
    memoryReviewModel: getMemoryReviewModel(),
    memoryReviewNotify: getMemoryReviewNotify(),
    driveSyncEnabled: getDriveSyncEnabled(),
    driveSyncKeyFile: getDriveSyncKeyFile(),
    hasDriveSyncKeyJson: Boolean(getDriveSyncKeyJson()), // the raw key is NEVER returned to the client
    driveSyncKeyEmail: getDriveSyncKeyEmail(),
    driveSyncSubject: getDriveSyncSubject(),
    driveSyncIntervalMinutes: getDriveSyncIntervalMinutes(),
    driveSyncConflict: getDriveSyncConflict(),
    driveSyncRclonePath: getDriveSyncRclonePath(),
    codexRatePer1MTokens: getCodexRatePer1MTokens(),
    codexModelRates: getCodexModelRates(),
    scheduleMinIntervalMinutes: getScheduleMinIntervalMinutes(),
    scheduleMaxPerChannel: getScheduleMaxPerChannel(),
    noResponseReminderHours: getNoResponseReminderHours(),
    defaultNudges: getDefaultNudges(),
    followupRemindersEnabled: getFollowupRemindersEnabled(),
    followupDigestHours: getFollowupDigestHours(),
    followupTimeZone: getFollowupTimeZone(),
    followupDoneReactions: getFollowupDoneReactions(),
    contextWindow: getContextWindow(),
    channelTemplate: getChannelTemplate(),
    dmTemplates: getDmTemplates(),
    hasAdminPassword: Boolean(getAdminPassword()),
    hasApiKey: Boolean(getApiKey()),
    apiKeyLast4: last4(getApiKey()),
    // License: the KEY itself never rides this response (src/web/secrets.js reveals it one at a
    // time, behind a fresh password). The card's live status comes from GET /api/license.
    hasLicenseKey: Boolean(getLicenseKey()),
    licenseKeyLast4: last4(getLicenseKey()),
    platformUrl: s.platformUrl ?? process.env.CHANNELGATE_PLATFORM_URL ?? "",
  };
}
