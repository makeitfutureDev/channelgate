// Settings + lifecycle admin routes: daemon settings (Slack tokens + options), on-demand
// secret reveal, gateway self-update, daemon restart/stop, Slack reconnect/disconnect, the
// filesystem browser, and UI reference data (/skills, /mcp/available). Split from admin.js;
// mounted by createAdminRouter so every URL is unchanged.
import { Router } from "express";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allowedFsRoot, resolveWithinRoot, pathWithin, hashPassword, verifyPassword } from "../security.js";
import { listAvailableSkills } from "../../gateway/folders.js";
import { requireAdapter } from "../../engines/registry.js";
import {
  getAdminPassword,
  settingsForApi,
  saveSettings,
  normalizePublicUrl,
  applySettingsToEnv,
  resolveSlackConfig,
  hasSlackConfig,
  ENGINES,
  getEngine,
  isEngineEnabled,
  getDmTemplates,
  CHANNEL_ACCESS_MODES,
  MODEL_CHANGE_ACCESS_MODES,
  DEFAULT_CODEX_RATES,
  DRIVE_SYNC_CONFLICTS,
  COMPOSIO_MODES,
  hasGoogleChatConfig,
  resolveGoogleChatConfig,
  hasTeamsConfig,
  resolveTeamsConfig,
  CONTAINER_CLIS,
  CONTAINER_IMAGE_RE,
  CONTAINER_MEMORY_RE,
  CONTAINER_CPUS_RE,
} from "../../config/settings.js";
import { platformUiManifest } from "../../platforms/registry.js";
import { isServiceAccountJson } from "../../gateway/drivesync.js";
import { parseServiceAccount } from "../../platforms/googlechat/auth.js";
import { isSubscriptionName } from "../../platforms/googlechat/pubsub.js";
import { logEvent } from "../../util/logger.js";
import { checkForUpdate, startUpdate } from "../../gateway/updater.js";
import { isValidModel } from "../../slack/util.js";
import { detectServiceManager, requestShutdown, restartExitCode } from "../../gateway/shutdown.js";
import { invalidateAllSessions, authEnabled } from "../auth.js";
import { readSecret } from "../secrets.js";
import { invalidModelOrEffort, cleanConversationTemplate, cleanDmTemplate, cleanAccessGrants } from "./helpers.js";
import { engineUiManifest } from "../../engines/registry.js";

// The month the license ledger is keyed on — UTC, never the daemon's local zone (a deployment in
// UTC+13 would otherwise roll its allowance a day early).
function utcMonthNow(at = Date.now()) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function createSettingsRouter({
  slack,
  transports = null,
  instanceId = "",
  startGatewayUpdate = startUpdate,
  restartCoordinator,
} = {}) {
  const router = Router();

  // ── Settings (Slack tokens + daemon options) ─────────────────────────────────
  router.get("/settings", (_req, res, next) => {
    try {
      const payload = { ...settingsForApi(), engines: engineUiManifest(), slack: slack?.snapshot?.() ?? { status: "disconnected", connected: false } };
      // Live connection state per non-Slack surface, next to its stored credentials. The manifest
      // comes from the platform registry so a newly added adapter appears here without another
      // edit in this file.
      payload.platforms = platformUiManifest().map((manifest) => ({
        ...manifest,
        connection: transports?.[manifest.id]?.snapshot?.() ?? { status: "disconnected", connected: false },
      }));
      res.json(payload);
    } catch (e) {
      next(e);
    }
  });

  // Reveal ONE stored secret, on demand. Listing endpoints return has*/last4 only; this is the
  // single way to see a value, and it costs a fresh password entry every time. Audit-logged with
  // what was revealed (never the value itself).
  router.post("/secrets/reveal", async (req, res, next) => {
    try {
      const { scope = "", field = "", id = "", password = "" } = req.body ?? {};
      // Re-authenticate even though a valid session got here: a borrowed session should not be
      // able to drain every credential silently. Skipped only when no password is configured at
      // all, in which case there is nothing to re-enter.
      if (authEnabled() && !(await verifyPassword(String(password), getAdminPassword()))) {
        await logEvent("secret_reveal_denied", { scope, field, id });
        return res.status(401).json({ error: "Wrong password" });
      }
      const value = await readSecret({ scope, field, id: String(id) });
      await logEvent("secret_revealed", { scope, field, id });
      res.json({ value });
    } catch (e) {
      if (/unknown scope|not revealable|unknown user/.test(e.message)) return res.status(400).json({ error: e.message });
      next(e);
    }
  });

  router.put("/settings", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const patch = {};
      // Tokens are write-only: only overwrite when a non-empty value is provided.
      if (typeof body.slackBotToken === "string" && body.slackBotToken) patch.slackBotToken = body.slackBotToken.trim();
      if (typeof body.slackAppToken === "string" && body.slackAppToken) patch.slackAppToken = body.slackAppToken.trim();
      if (typeof body.slackSigningSecret === "string" && body.slackSigningSecret) patch.slackSigningSecret = body.slackSigningSecret.trim();
      // Optional admin USER token (xoxp) for /delete — lets it remove non-bot messages too. Must
      // look like a user token: an xoxb here would silently degrade /delete back to bot-only.
      if (typeof body.slackAdminUserToken === "string" && body.slackAdminUserToken) {
        const v = body.slackAdminUserToken.trim();
        if (!v.startsWith("xoxp-")) return res.status(400).json({ error: "the admin user token must be a user token (xoxp-…)" });
        patch.slackAdminUserToken = v;
      }
      if (body.clearSlackAdminUserToken === true) patch.slackAdminUserToken = "";
      // ── Google Chat ──────────────────────────────────────────────────────────
      // The key is validated BEFORE it is stored: a pasted OAuth-client JSON or a truncated file
      // otherwise fails much later, inside a pull loop, as an opaque 400.
      if (typeof body.googleChatServiceAccountJson === "string" && body.googleChatServiceAccountJson.trim()) {
        const raw = body.googleChatServiceAccountJson.trim();
        try {
          parseServiceAccount(raw);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
        patch.googleChatServiceAccountJson = raw;
      }
      if (body.clearGoogleChatServiceAccountJson === true) patch.googleChatServiceAccountJson = "";
      if (typeof body.googleChatSubscription === "string") {
        const value = body.googleChatSubscription.trim();
        if (value && !isSubscriptionName(value)) {
          return res.status(400).json({ error: 'the subscription must look like "projects/<project>/subscriptions/<name>"' });
        }
        patch.googleChatSubscription = value;
      }
      if (typeof body.googleChatBotUserId === "string") {
        const value = body.googleChatBotUserId.trim();
        if (value && !/^users\/[A-Za-z0-9_-]+$/.test(value)) {
          return res.status(400).json({ error: 'the bot user id must look like "users/1234567890"' });
        }
        patch.googleChatBotUserId = value;
      }
      // ── Microsoft Teams ──────────────────────────────────────────────────────
      if (typeof body.teamsAppId === "string") {
        const value = body.teamsAppId.trim();
        if (value && !/^[A-Za-z0-9-]{8,64}$/.test(value)) return res.status(400).json({ error: "the Teams app id must be the Azure application (client) id" });
        patch.teamsAppId = value;
      }
      if (typeof body.teamsAppPassword === "string" && body.teamsAppPassword) patch.teamsAppPassword = body.teamsAppPassword.trim();
      if (body.clearTeamsAppPassword === true) patch.teamsAppPassword = "";
      if (typeof body.teamsTenantId === "string") patch.teamsTenantId = body.teamsTenantId.trim();
      if (typeof body.sessionKeepalive === "string") patch.sessionKeepalive = body.sessionKeepalive.trim();
      // Mode selection and credentials are deliberately independent: changing the mode never
      // clears either the existing personal/channel/org tokens or this organization SDK key.
      if (typeof body.composioMode === "string" && COMPOSIO_MODES.includes(body.composioMode)) patch.composioMode = body.composioMode;
      if (typeof body.composioSdkApiKey === "string" && body.composioSdkApiKey.trim()) patch.composioSdkApiKey = body.composioSdkApiKey.trim();
      if (body.clearComposioSdkApiKey === true) patch.composioSdkApiKey = "";
      if (typeof body.composioMcpUrl === "string") patch.composioMcpUrl = body.composioMcpUrl.trim();
      if (typeof body.skillsMcpUrl === "string") patch.skillsMcpUrl = body.skillsMcpUrl.trim();
      if (typeof body.toolboxMcpUrl === "string") patch.toolboxMcpUrl = body.toolboxMcpUrl.trim();
      if (typeof body.publicUrl === "string") patch.publicUrl = normalizePublicUrl(body.publicUrl);
      // Self-diagnosis target channel slug ("" turns the feature off).
      if (typeof body.errorDiagnosisChannel === "string") patch.errorDiagnosisChannel = body.errorDiagnosisChannel.trim();
      // Org-default access policy applied to each channel the bot newly joins.
      if (typeof body.defaultChannelAccess === "string" && CHANNEL_ACCESS_MODES.includes(body.defaultChannelAccess)) patch.defaultChannelAccess = body.defaultChannelAccess;
      // Emoji reactions that act as an @mention. Accept an array or a comma/space-separated string;
      // normalize to bare emoji names (strip colons, lowercase). Empty falls back to the default.
      if (body.mentionReactions !== undefined) {
        const arr = Array.isArray(body.mentionReactions) ? body.mentionReactions : String(body.mentionReactions).split(/[\s,]+/);
        patch.mentionReactions = arr.map((s) => String(s).trim().replace(/^:|:$/g, "").toLowerCase()).filter(Boolean);
      }
      // Trusted bot apps: Slack app/bot IDs allowed to drive runs despite carrying a bot_id.
      if (body.trustedBotApps !== undefined) {
        const arr = Array.isArray(body.trustedBotApps) ? body.trustedBotApps : String(body.trustedBotApps).split(/[\s,]+/);
        patch.trustedBotApps = arr.map((s) => String(s).trim()).filter(Boolean);
      }
      // Org-default Composio / Skills tokens (write-only; the final fallback when channel + user
      // have none). Set on a non-empty value; clear explicitly with the *Clear flags.
      if (typeof body.defaultComposioToken === "string" && body.defaultComposioToken) patch.defaultComposioToken = body.defaultComposioToken.trim();
      if (body.clearDefaultComposioToken === true) patch.defaultComposioToken = "";
      if (typeof body.defaultSkillsToken === "string" && body.defaultSkillsToken) patch.defaultSkillsToken = body.defaultSkillsToken.trim();
      if (body.clearDefaultSkillsToken === true) patch.defaultSkillsToken = "";
      if (typeof body.defaultToolboxToken === "string" && body.defaultToolboxToken) patch.defaultToolboxToken = body.defaultToolboxToken.trim();
      if (body.clearDefaultToolboxToken === true) patch.defaultToolboxToken = "";
      // Owner labels (who the shared org-default token authenticates as). Not secret — a plain
      // string that always round-trips; an empty string clears it.
      if (typeof body.defaultComposioTokenLabel === "string") patch.defaultComposioTokenLabel = body.defaultComposioTokenLabel.trim();
      if (typeof body.defaultSkillsTokenLabel === "string") patch.defaultSkillsTokenLabel = body.defaultSkillsTokenLabel.trim();
      if (typeof body.defaultToolboxTokenLabel === "string") patch.defaultToolboxTokenLabel = body.defaultToolboxTokenLabel.trim();
      if (body.accessGrants && typeof body.accessGrants === "object" && !Array.isArray(body.accessGrants))
        patch.accessGrants = cleanAccessGrants(body.accessGrants);
      // Per-harness on/off. Normalized to an explicit boolean per KNOWN engine (an unknown key is
      // dropped, not stored), and refused outright if it would leave the gateway with no engine to
      // run — that state has no valid interpretation, so it fails loudly here rather than silently
      // failing open at read time.
      if (body.engineEnabled && typeof body.engineEnabled === "object" && !Array.isArray(body.engineEnabled)) {
        const next = Object.fromEntries(ENGINES.map((id) => [
          id,
          typeof body.engineEnabled[id] === "boolean" ? body.engineEnabled[id] : isEngineEnabled(id),
        ]));
        if (!ENGINES.some((id) => next[id])) return res.status(400).json({ error: "at least one engine must stay enabled" });
        patch.engineEnabled = next;
      }
      if (typeof body.engine === "string" && ENGINES.includes(body.engine)) {
        // The default engine and the enable switches are saved in the SAME request, so validate the
        // engine against the state being written, not the state on disk.
        const enabledAfter = patch.engineEnabled ? patch.engineEnabled[body.engine] : isEngineEnabled(body.engine);
        if (!enabledAfter) return res.status(400).json({ error: `engine "${body.engine}" is disabled — enable it or pick another default` });
        patch.engine = body.engine;
      }
      if (typeof body.modelChangeAccess === "string" && MODEL_CHANGE_ACCESS_MODES.includes(body.modelChangeAccess)) patch.modelChangeAccess = body.modelChangeAccess;
      // Gateway default model per engine (blank clears → CLI default). Same isValidModel guard as
      // /model and the channel-meta routes — a typo'd id here would break EVERY defaulted run.
      for (const key of ["defaultClaudeModel", "defaultCodexModel"]) {
        if (typeof body[key] !== "string") continue;
        const v = body[key].trim();
        if (v && !isValidModel(v)) return res.status(400).json({ error: `unrecognized model "${v}"` });
        patch[key] = v;
      }
      // Cross-engine failover. `codexFallback` is the pre-rename key an older UI still sends; both
      // write the canonical one so the two can never disagree on disk.
      if (typeof body.engineFallback === "boolean") patch.engineFallback = body.engineFallback;
      else if (typeof body.codexFallback === "boolean") patch.engineFallback = body.codexFallback;
      if (typeof body.showMessageCost === "boolean") patch.showMessageCost = body.showMessageCost;
      if (typeof body.whisperEnabled === "boolean") patch.whisperEnabled = body.whisperEnabled;
      // ── Container runtime ───────────────────────────────────────────────────
      // The three free-text values (image, memory, cpus) are argv tokens for the container CLI, so
      // they are pattern-checked here rather than sanitized later — a rejected save is the only
      // honest answer for a value that would otherwise reach a command line.
      if (body.containerCli !== undefined) {
        if (!CONTAINER_CLIS.includes(body.containerCli)) return res.status(400).json({ error: `containerCli must be one of ${CONTAINER_CLIS.join(", ")}` });
        patch.containerCli = body.containerCli;
      }
      if (typeof body.containerImage === "string") {
        const image = body.containerImage.trim();
        if (image && !CONTAINER_IMAGE_RE.test(image)) return res.status(400).json({ error: "containerImage must be a plain image reference (e.g. channelgate/runtime:latest)" });
        patch.containerImage = image;
      }
      for (const [key, min, max] of [["containerIdleMinutes", 1, 1440], ["containerMaxRunning", 1, 500], ["containerPidsLimit", 64, 65536]]) {
        if (body[key] === undefined) continue;
        const n = Number(body[key]);
        if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ error: `${key} must be a number between ${min} and ${max}` });
        patch[key] = Math.floor(n);
      }
      if (typeof body.containerMemory === "string") {
        const v = body.containerMemory.trim();
        if (v && !CONTAINER_MEMORY_RE.test(v)) return res.status(400).json({ error: "containerMemory must look like 2g, 512m, or a byte count (blank = no limit)" });
        patch.containerMemory = v;
      }
      if (typeof body.containerCpus === "string") {
        const v = body.containerCpus.trim();
        if (v && !CONTAINER_CPUS_RE.test(v)) return res.status(400).json({ error: "containerCpus must be a number like 1 or 1.5 (blank = no limit)" });
        patch.containerCpus = v;
      }
      // The Claude subscription token for container runs (`claude setup-token` on the host). Same
      // write-only rule as every other credential: set on a value, cleared by an empty string or
      // the explicit flag, never echoed back by any listing.
      if (typeof body.containerClaudeOauthToken === "string") patch.containerClaudeOauthToken = body.containerClaudeOauthToken.trim();
      if (body.clearContainerClaudeOauthToken === true) patch.containerClaudeOauthToken = "";
      if (typeof body.agentsFile === "boolean") patch.agentsFile = body.agentsFile;
      if (typeof body.agentsInstructions === "string") patch.agentsInstructions = body.agentsInstructions;
      if (typeof body.agentMemory === "boolean") patch.agentMemory = body.agentMemory;
      // Background memory review: interval is a non-negative integer (0 = off), model a short
      // alias/id string (never a shell-relevant value — it rides argv as one token), notify a bool.
      if (body.memoryReviewEvery !== undefined && Number.isFinite(Number(body.memoryReviewEvery)) && Number(body.memoryReviewEvery) >= 0) patch.memoryReviewEvery = Math.floor(Number(body.memoryReviewEvery));
      if (typeof body.memoryReviewModel === "string" && /^[A-Za-z0-9._:-]{0,80}$/.test(body.memoryReviewModel.trim())) patch.memoryReviewModel = body.memoryReviewModel.trim();
      if (typeof body.memoryReviewNotify === "boolean") patch.memoryReviewNotify = body.memoryReviewNotify;
      // Scheduled Google Drive sync. Key file / subject are plain strings (a path + an email, not
      // secrets); interval floors at 1 minute; conflict policy is an enum.
      if (typeof body.driveSyncEnabled === "boolean") patch.driveSyncEnabled = body.driveSyncEnabled;
      if (typeof body.driveSyncKeyFile === "string") patch.driveSyncKeyFile = body.driveSyncKeyFile.trim();
      // Pasted service-account key JSON (write-only). Validate it's a real SA key before storing; a
      // bad paste 400s before any save. Never echoed back — only has-key + client_email are exposed.
      if (typeof body.driveSyncKeyJson === "string" && body.driveSyncKeyJson.trim()) {
        const check = isServiceAccountJson(body.driveSyncKeyJson);
        if (!check.ok) return res.status(400).json({ error: `Drive service-account key: ${check.error}` });
        patch.driveSyncKeyJson = body.driveSyncKeyJson.trim();
      }
      if (body.clearDriveSyncKeyJson === true) patch.driveSyncKeyJson = "";
      if (typeof body.driveSyncSubject === "string") patch.driveSyncSubject = body.driveSyncSubject.trim();
      if (typeof body.driveSyncRclonePath === "string") patch.driveSyncRclonePath = body.driveSyncRclonePath.trim();
      if (body.driveSyncIntervalMinutes !== undefined && Number.isFinite(Number(body.driveSyncIntervalMinutes)) && Number(body.driveSyncIntervalMinutes) >= 1) patch.driveSyncIntervalMinutes = Math.floor(Number(body.driveSyncIntervalMinutes));
      if (typeof body.driveSyncConflict === "string" && DRIVE_SYNC_CONFLICTS.includes(body.driveSyncConflict)) patch.driveSyncConflict = body.driveSyncConflict;
      if (body.codexRatePer1MTokens !== undefined && Number.isFinite(Number(body.codexRatePer1MTokens)) && Number(body.codexRatePer1MTokens) >= 0) patch.codexRatePer1MTokens = Number(body.codexRatePer1MTokens);
      // Per-model Codex $/1M rates (input/cachedInput/output). Shape-checked; only known models
      // are kept (the list is fixed — see DEFAULT_CODEX_RATES), negatives/garbage dropped to 0.
      if (body.codexModelRates && typeof body.codexModelRates === "object" && !Array.isArray(body.codexModelRates)) {
        const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
        const cleanRates = {};
        for (const model of Object.keys(DEFAULT_CODEX_RATES)) {
          const r = body.codexModelRates[model];
          if (r && typeof r === "object") cleanRates[model] = { input: num(r.input), cachedInput: num(r.cachedInput), output: num(r.output) };
        }
        patch.codexModelRates = cleanRates;
      }
      // Org DM templates (User/Admin) — edited under Settings → Access Templates, folded into this save.
      // Validate model/effort exactly like the per-channel/DM routes (bad values 400 before any save),
      // then shape-clean. Only a present side is replaced; a missing side keeps its stored value.
      if (body.dmTemplates && typeof body.dmTemplates === "object" && !Array.isArray(body.dmTemplates)) {
        for (const t of [body.dmTemplates.user, body.dmTemplates.admin]) {
          const bad = t && invalidModelOrEffort(t);
          if (bad) return res.status(400).json({ error: bad });
        }
        const cur = getDmTemplates();
        patch.dmTemplates = {
          user: body.dmTemplates.user ? cleanDmTemplate(body.dmTemplates.user) : cur.user,
          admin: body.dmTemplates.admin ? cleanDmTemplate(body.dmTemplates.admin) : cur.admin,
        };
      }
      if (body.channelTemplate && typeof body.channelTemplate === "object" && !Array.isArray(body.channelTemplate)) {
        const bad = invalidModelOrEffort(body.channelTemplate);
        if (bad) return res.status(400).json({ error: bad });
        patch.channelTemplate = cleanConversationTemplate(body.channelTemplate);
      }
      if (body.contextWindow !== undefined && Number.isFinite(Number(body.contextWindow)) && Number(body.contextWindow) > 0) patch.contextWindow = Number(body.contextWindow);
      if (body.scheduleMinIntervalMinutes !== undefined && Number.isFinite(Number(body.scheduleMinIntervalMinutes)) && Number(body.scheduleMinIntervalMinutes) >= 1) patch.scheduleMinIntervalMinutes = Math.floor(Number(body.scheduleMinIntervalMinutes));
      if (body.scheduleMaxPerChannel !== undefined && Number.isFinite(Number(body.scheduleMaxPerChannel)) && Number(body.scheduleMaxPerChannel) >= 1) patch.scheduleMaxPerChannel = Math.floor(Number(body.scheduleMaxPerChannel));
      if (body.noResponseReminderHours !== undefined && Number.isFinite(Number(body.noResponseReminderHours)) && Number(body.noResponseReminderHours) >= 1) patch.noResponseReminderHours = Number(body.noResponseReminderHours);
      // Org-default no-response nudge (on/off), captured onto new channels & DMs at join.
      if (typeof body.defaultNudges === "boolean") patch.defaultNudges = body.defaultNudges;
      // Personal pending-response follow-up digests.
      if (typeof body.followupRemindersEnabled === "boolean") patch.followupRemindersEnabled = body.followupRemindersEnabled;
      if (body.followupDigestHours !== undefined) {
        const arr = Array.isArray(body.followupDigestHours) ? body.followupDigestHours : String(body.followupDigestHours).split(/[\s,]+/);
        const clean = [...new Set(arr.map((h) => Math.floor(Number(h))).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))];
        if (clean.length) patch.followupDigestHours = clean;
      }
      if (typeof body.followupTimeZone === "string" && body.followupTimeZone.trim()) patch.followupTimeZone = body.followupTimeZone.trim();
      if (body.followupDoneReactions !== undefined) {
        const arr = Array.isArray(body.followupDoneReactions) ? body.followupDoneReactions : String(body.followupDoneReactions).split(/[\s,]+/);
        patch.followupDoneReactions = arr.map((s) => String(s).trim().replace(/^:|:$/g, "").toLowerCase()).filter(Boolean);
      }
      // Admin password (write-only): set when non-empty, or explicitly clear to open the UI.
      // Stored as an scrypt hash, never cleartext. Any change drops every existing session —
      // cookies minted under the old password must not outlive it.
      let passwordChanged = false;
      if (typeof body.adminPassword === "string" && body.adminPassword.length > 0) {
        patch.adminPassword = await hashPassword(body.adminPassword);
        passwordChanged = true;
      }
      if (body.clearAdminPassword === true) {
        patch.adminPassword = "";
        passwordChanged = true;
      }
      // HTTP run API key (write-only): the bearer credential for POST /api/runs. Set when non-empty,
      // or explicitly clear to disable header-key auth for the run API.
      if (typeof body.apiKey === "string" && body.apiKey.length > 0) patch.apiKey = body.apiKey.trim();
      if (body.clearApiKey === true) patch.apiKey = "";
      // ChannelGate license key (write-only, same shape as every other secret here) and the
      // platform base URL. A key that CHANGES invalidates the cached verification below: the cache
      // is bound to a key hash, and serving the previous tier under a new key is exactly the key
      // pooling LICENSE.md §3.2 forbids.
      let licenseKeyChanged = false;
      if (typeof body.licenseKey === "string" && body.licenseKey.trim()) {
        patch.licenseKey = body.licenseKey.trim();
        licenseKeyChanged = true;
      }
      if (body.clearLicenseKey === true) {
        patch.licenseKey = "";
        licenseKeyChanged = true;
      }
      // Empty = the compiled-in default (src/ee/tiers.js). Staging points it elsewhere.
      if (typeof body.platformUrl === "string") patch.platformUrl = body.platformUrl.trim().replace(/\/+$/, "");

      saveSettings(patch);
      applySettingsToEnv();
      if (passwordChanged) invalidateAllSessions();
      if (licenseKeyChanged) {
        const { onLicenseKeyChanged } = await import("../../ee/license.js");
        onLicenseKeyChanged();
      }

      // Reconnect Slack live if asked (or whenever tokens are now complete).
      let slackSnap = slack?.snapshot?.() ?? { status: "disconnected", connected: false };
      const wantConnect = body.connectSlack !== false; // default: try to (re)connect
      if (slack && wantConnect && hasSlackConfig()) {
        slackSnap = await slack.connect(resolveSlackConfig());
      }

      res.json({ ok: true, ...settingsForApi(), slack: slackSnap });
    } catch (e) {
      next(e);
    }
  });

  // ── License (src/ee/) ─────────────────────────────────────────────────────────────────────
  // Status for the admin License card. Carries no secret: the key itself is reachable only
  // through /api/secrets/reveal, and this returns hasLicenseKey + last4 like every listing.
  router.get("/license", async (_req, res, next) => {
    try {
      const { getLicenseStatus } = await import("../../ee/license.js");
      const { conversationUsage, usageTotals } = await import("../../ee/limits.js");
      const status = getLicenseStatus();
      res.json({ ...status, usage: { ...usageTotals({ month: utcMonthNow() }), conversations: conversationUsage({ limit: 20 }) } });
    } catch (e) {
      next(e);
    }
  });

  // "Verify now". Bounded by the platform timeout in src/ee/tiers.js, so a dead platform makes
  // this button slow-but-finite rather than a hung request.
  router.post("/license/verify", async (_req, res, next) => {
    try {
      const { verifyLicense, getLicenseStatus } = await import("../../ee/license.js");
      const result = await verifyLicense();
      await logEvent("license_verify", { outcome: result.outcome, state: result.state });
      res.json({ ok: true, outcome: result.outcome, detail: result.detail || "", ...getLicenseStatus() });
    } catch (e) {
      next(e);
    }
  });

  // Gateway self-update. `check` reports the running version + how many commits origin is ahead
  // (git fetch, bounded timeout — the UI calls it on load, not on a poll). `run` kicks the same
  // detached scripts/update.sh flow as the Slack update_gateway tool (see src/gateway/updater.js).
  // `run` returns this process's instance id so the UI can identify the replacement process even
  // when the restart is too quick to produce an observable failed health request.
  router.get("/update/check", async (_req, res, next) => {
    try {
      res.json(await checkForUpdate());
    } catch (e) {
      next(e);
    }
  });

  router.post("/update/run", async (_req, res, next) => {
    try {
      const started = startGatewayUpdate({ source: "admin-ui" });
      if (!started.ok) {
        const status = started.conflict ? 409 : 500;
        return res.status(status).json({
          ok: false,
          error: started.conflict
            ? "An update is already active."
            : started.error || started.transaction?.reason || "The update runner could not be started.",
          transaction: started.transaction || null,
        });
      }
      await logEvent("gateway_update_started", { via: "admin-ui" });
      res.status(202).json({
        ok: true,
        instanceId,
        transaction: started.transaction,
        message: "Update transaction started. Preflight checks run before any repository change.",
      });
    } catch (e) {
      next(e);
    }
  });

  // Restart the whole daemon only after the safe-restart coordinator observes an idle window.
  // The coordinator leaves Slack connected while active work drains, rechecks for up to five
  // minutes, and cancels instead of interrupting anything still running. launchd's KeepAlive
  // relaunches after shutdown (only when installed as the launchd service).
  router.post("/daemon/restart", (_req, res) => {
    if (!restartCoordinator) {
      return res.status(503).json({ ok: false, error: "Safe restart is unavailable." });
    }
    const result = restartCoordinator.request({ reason: "admin restart" });
    res.status(result.conflict ? 409 : 202).json(result);
  });

  router.get("/daemon/restart/status", (req, res) => {
    if (!restartCoordinator) {
      return res.status(503).json({ ok: false, error: "Safe restart is unavailable." });
    }
    const result = restartCoordinator.status(String(req.query.id || ""));
    res.status(result.ok ? 200 : 404).json(result);

  });

  // Stop the daemon: unload the launchd job so it does NOT respawn, then exit. After this the
  // admin UI is offline; start it again from a terminal (npm run service:install / npm start).
  router.post("/daemon/stop", (_req, res) => {
    res.json({ ok: true, message: "Stopping. Start again from a terminal (npm run service:install)." });
    setTimeout(() => {
      try {
        const uid = process.getuid?.();
        // Both labels: a machine upgraded from the pre-rename install may still be running under
        // the old one, and booting out only the new label would leave the job alive to respawn.
        if (uid != null) {
          for (const label of ["com.makeitfuture.channelgate", "com.makeitfuture.claude-gateway"]) {
            spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
          }
        }
      } catch {
        /* not launchd-managed */
      }
      requestShutdown({ slack, code: 0, reason: "admin stop" });
    }, 300);
  });

  // Connect / disconnect a non-Slack surface at runtime, exactly like the Slack pair above: saving
  // credentials should not need a daemon restart. Resolved through the registry rather than an
  // if/else per platform — an unknown id is a 404, never a silent no-op.
  const PLATFORM_CONFIG = {
    googlechat: { has: hasGoogleChatConfig, resolve: resolveGoogleChatConfig, missing: "Google Chat is not configured (service-account key + Pub/Sub subscription)" },
    msteams: { has: hasTeamsConfig, resolve: resolveTeamsConfig, missing: "Teams is not configured (Azure app id + client secret)" },
  };

  router.post("/platforms/:id/connect", async (req, res, next) => {
    try {
      const id = String(req.params.id || "");
      const manager = transports?.[id];
      const config = PLATFORM_CONFIG[id];
      if (!manager || !config) return res.status(404).json({ error: `unknown platform "${id}"` });
      if (!config.has()) return res.status(400).json({ error: config.missing });
      const snapshot = await manager.connect(config.resolve());
      await logEvent("platform_connect", { platform: id, status: snapshot.status });
      res.json({ ok: snapshot.connected, connection: snapshot });
    } catch (e) {
      next(e);
    }
  });

  router.post("/platforms/:id/disconnect", async (req, res, next) => {
    try {
      const id = String(req.params.id || "");
      const manager = transports?.[id];
      if (!manager) return res.status(404).json({ error: `unknown platform "${id}"` });
      const snapshot = await manager.disconnect();
      await logEvent("platform_disconnect", { platform: id });
      res.json({ ok: true, connection: snapshot });
    } catch (e) {
      next(e);
    }
  });

  router.post("/slack/reconnect", async (_req, res, next) => {
    try {
      if (!slack) return res.status(400).json({ error: "slack manager unavailable" });
      if (!hasSlackConfig()) return res.status(400).json({ error: "Slack tokens not set" });
      const snap = await slack.connect(resolveSlackConfig());
      res.json({ ok: true, slack: snap });
    } catch (e) {
      next(e);
    }
  });

  router.post("/slack/disconnect", async (_req, res, next) => {
    try {
      if (slack) await slack.disconnect();
      res.json({ ok: true, slack: slack?.snapshot?.() ?? { status: "disconnected", connected: false } });
    } catch (e) {
      next(e);
    }
  });

  // ── Filesystem browser (for the per-channel working-folder picker) ───────────
  // Local admin tool: lists subdirectories of a path so the UI can navigate the machine's
  // filesystem and pick a folder. Confined to the allowlisted root (the home dir by default;
  // settings `fsRoot` / CG_FS_ROOT to change) — paths are realpath-resolved first so `..` and
  // symlinks can't step outside it.
  router.get("/fs/list", async (req, res) => {
    try {
      const root = allowedFsRoot();
      const dir = resolveWithinRoot(root, req.query.path ? String(req.query.path) : root);
      if (!dir) return res.status(400).json({ error: `path is outside the allowed root (${root})` });
      const entries = await readdir(dir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      const parentOk = parent !== dir && pathWithin(root, parent);
      res.json({ path: dir, parent: parentOk ? parent : null, dirs, home: os.homedir() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Reference data for the UI ───────────────────────────────────────────────
  router.get("/skills", async (_req, res, next) => {
    try {
      res.json({ skills: await listAvailableSkills() });
    } catch (e) {
      next(e);
    }
  });

  // Optional capabilities available to the requested engine. Claude uses `claude mcp list`;
  // Codex uses its active app-server inventory so product-injected app families are included.
  // Gateway/Composio/Skills/Toolbox built-ins are excluded from this per-channel picker.
  router.get("/mcp/available", async (req, res, next) => {
    try {
      const engine = ENGINES.includes(req.query.engine) ? req.query.engine : getEngine();
      res.json({ engine, servers: await requireAdapter(engine).discoverMcps() });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
