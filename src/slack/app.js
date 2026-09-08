// Slack Socket Mode gateway. Receives message events across DM / group DM / public & private
// channels, applies the gating rules (DM → no mention needed; everywhere else → require an
// explicit @bot mention), authorizes the author against the channel's allowedUsers, then runs
// the message through the gateway orchestrator and posts the reply in the thread.
import { hasComposioSdkEntitlement } from "../ee/composio-entitlement.js";
import { createFileFormNavigation } from "./file-form-navigation.js";
import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;

import { upsertChannelEntry, getChannelEntry, getChannelMeta, saveChannelMeta, patchChannelMeta, defaultChannelMeta, getUsers, isAdmin, isApproved, listChannels, getComposioToken, getToolboxToken } from "../config/store.js";
import { ensureChannelFolder, effectiveWorkDir } from "../gateway/folders.js";
import { effectiveMeta } from "../gateway/run.js";
import { modeLabel, isAuthorized, canManage, modeSettingsPatch } from "../gateway/modes.js";
// Re-exported: the authorization contract moved to gateway/modes.js (beside canManage).
export { isAuthorized };
import { requestApproval, handleApprovalClick, handleApprovalCommentSubmit, APPROVAL_ACTIONS, setApprovalClient } from "./approvals.js";
// Re-exported for existing importers (web/app.js, tests) — moved to slack/approvals.js.
export { requestApproval };
import { MODEL_WIZARD_SCOPE_CHANNEL_ACTION, MODEL_WIZARD_SCOPE_THREAD_ACTION, MODEL_WIZARD_ENGINE_CLAUDE_ACTION, MODEL_WIZARD_ENGINE_CODEX_ACTION, MODEL_WIZARD_ENGINE_RESET_ACTION, MODEL_WIZARD_BACK_ACTION_PATTERN, MODEL_PICKER_ACTION_PATTERN, EFFORT_PICKER_ACTION_PATTERN, ENGINE_PICKER_ACTION, MODEL_WIZARD_TEXT, modelWizardScopeBlocks, handleModelWizard, modelOptionsForEngine } from "./model-wizard.js";
// Re-exported for existing importers (tests) — moved to slack/model-wizard.js.
export { modelOptionsForEngine };
import { getSessionMap } from "../gateway/sessions.js";

import { logEvent } from "../util/logger.js";

import { clearUpdateMarker, formatUpdateResult, readTerminalUpdateMarker } from "../gateway/updater.js";

import { recordActivity, markDone, clearDone, applyDigestDoneReaction, removeDigestDoneReaction } from "../gateway/followups.js";
import { getActiveBackgroundJobs } from "../gateway/background.js";
import { findAckByMessage, deleteAck } from "../config/acks.js";

import { resolveSlackConfig, getContextWindow, getEngine, getDefaultModel, getEnabledEngines, getMentionReactions, getDefaultChannelAccess, applyChannelTemplate, getDefaultNudges, getFollowupDoneReactions, getFollowupRemindersEnabled, getComposioMode, getComposioSdkApiKey, getDefaultComposioToken, getDefaultToolboxToken, getOrgAccessGrants, canChangeChannelRuntime, getPublicUrl } from "../config/settings.js";
import { resolveAccessGrants } from "../gateway/access-grants.js";
import { assignTemplateToChannel, channelScopedSkills, channelSkillGrants, listTemplateSummaries, templateOfMeta } from "../gateway/skills/templates.js";
import { canSeeSkill, grantSkillsToChannel, revokeSkillsFromChannel } from "../gateway/skills/authoring.js";
import { listSkills } from "../gateway/skills/catalog.js";
import { engineLabel, effortBelongsToModel, effortsForModel, modelBelongsToEngine, modelsForEngine, requireAdapter } from "../engines/registry.js";
import { persistedSelectionForEngine, selectionFieldForEngine } from "../gateway/mcp-discovery.js";
import { resolveMakeToolboxUpdate } from "../gateway/make-toolbox.js";
import { logChannelPolicyChange } from "../config/channel-audit.js";

import { createTtlSet } from "./util.js";
import { refreshDirectory } from "./directory.js";
import { handleMemberLeftChannel, listConversationMemberIds, filterConversationHumanMemberIds, withChannelMembershipLock } from "./members.js";
import { checkBotScopes, formatScopeWarning, shouldNotify } from "./scope-check.js";
import { buildFileEditView, buildFilePreviewView, buildFilesLoadingView, buildFilesView, buildNewFileView, buildNewFolderView, canEditChannelFiles, createVisibleDirectory, createVisibleFile, FILES_ACTION_PATTERN, FILES_NEW_FILE_CONTENT_BLOCK_ID, FILES_NEW_FILE_CONTENT_INPUT_ACTION_ID, FILES_NEW_FILE_NAME_BLOCK_ID, FILES_NEW_FILE_NAME_INPUT_ACTION_ID, FILES_NEW_FOLDER_BLOCK_ID, FILES_NEW_FOLDER_INPUT_ACTION_ID, FILES_SHORTCUT_ID, normalizeNewFileName, normalizeNewFolderName, normalizeRelativePath, parseActionValue as parseFileActionValue, parseExplorerMetadata, resolveVisiblePath, writeEditableFile } from "./file-explorer.js";
import {
  buildSecretFormView, buildSecretsErrorView, buildSecretsView, parseActionValue as parseSecretActionValue,
  parseSecretsMetadata, readSecretForm, SECRETS_ACTION_PATTERN, SECRETS_ADD_ACTION_ID,
  SECRETS_FORM_CALLBACK_ID, SECRETS_NAME_BLOCK_ID, SECRETS_REMOVE_ACTION_PREFIX, SECRETS_SHORTCUT_ID,
  SECRETS_VALUE_BLOCK_ID,
} from "./secret-explorer.js";
import {
  buildCatalogManagerView, buildChannelSettingsErrorView, buildChannelSettingsView,
  buildConnectionsEditorView, buildRuntimeEditorView, buildTemplateEditorView, maskedCredential,
  parseActionValue as parseChannelSettingsActionValue, editorMetadata, parseEditorMetadata, parseSettingsMetadata,
  readConnectionsForm, readRuntimeForm, readTemplateForm,
  CHANNEL_SETTINGS_MODE_PREFIX, CHANNEL_SETTINGS_OPTION_PREFIX,
  CHANNEL_SETTINGS_ACTION_PATTERN, CHANNEL_SETTINGS_CLEAR_COMPOSIO_ACTION_ID,
  CHANNEL_SETTINGS_CLEAR_MAKE_ACTION_ID, CHANNEL_SETTINGS_CLEAR_TOOLBOX_ACTION_ID,
  CHANNEL_SETTINGS_CLOUD_ENGINE_PREFIX, CHANNEL_SETTINGS_CLOUD_MANAGE_ACTION_ID,
  CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX, CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX,
  CHANNEL_SETTINGS_CONNECTIONS_CALLBACK_ID, CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID,
  CHANNEL_SETTINGS_FALLBACK_ACTION_ID, CHANNEL_SETTINGS_RUNTIME_CALLBACK_ID,
  CHANNEL_SETTINGS_RUNTIME_EDIT_ACTION_ID, CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID,
  CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID, CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID,
  CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID, CHANNEL_SETTINGS_SKILL_PAGE_PREFIX,
  CHANNEL_SETTINGS_SKILL_TOGGLE_PREFIX, CHANNEL_SETTINGS_TEMPLATE_CALLBACK_ID,
  CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID, SETTINGS_DEFAULT_VALUE, SETTINGS_NONE_VALUE,
  CONNECTION_COMPOSIO_BLOCK_ID, CONNECTION_MAKE_KEY_BLOCK_ID, CONNECTION_MAKE_URL_BLOCK_ID,
  CONNECTION_TOOLBOX_BLOCK_ID, RUNTIME_EFFORT_BLOCK_ID, RUNTIME_ENGINE_BLOCK_ID,
  RUNTIME_MODEL_BLOCK_ID, TEMPLATE_BLOCK_ID,
} from "./channel-settings.js";
import { ACCESS_EDIT_ACTION_ID, ACCESS_CALLBACK_ID, ACCESS_MODE_BLOCK_ID, buildAccessEditorView, readAccessForm, accessSettingsPatch, assertAccessManager } from "./access-settings.js";
import { assertValidEnvName, assertValidEnvValue, listChannelEnv, patchChannelEnv } from "../config/channel-env.js";
import { cliEnvKeys, cliIntegrationIds } from "../config/cli-catalog.js";

import { uploadLocalFile } from "./upload.js";
import { BROWSER_EDIT_MAX_BYTES, BROWSER_EDIT_MAX_CHARS, createFileEditorGrantUrl } from "../web/file-editor.js";
import { createFileDownloadGrantUrl } from "../web/file-download.js";
import { createFileUploadGrantUrl } from "../web/file-upload.js";
import path from "node:path";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gatewayRoot } from "../config/paths.js";

import { buildResumeCommand, resumeButton, filesButton, secretsButton, settingsButton, footerButtons, footerText, footerBlocks } from "./footer.js";
import { setAssistantStatus, startProgress } from "./progress.js";
// Re-exported for existing importers (moved to slack/footer.js + slack/progress.js in the
// 2026-08 restructure split).
export { buildResumeCommand, resumeButton, filesButton, secretsButton, settingsButton, footerButtons, footerText, footerBlocks };
export { setAssistantStatus, startProgress };
import { processMessageEvent, runQueue, stopRunsInChannel, mentionsBot, stripMentions, isIgnorable, fetchThreadContext, deleteThreadMessages, ensureRegistered, ensureUserKnown, syncAllowedFromMembers, resolveConversation } from "./message-pipeline.js";
import { appContextForMessage, appContextObservedAt, appContextUserId, createAppContextStore } from "./app-context.js";
import { registerBusyThreadChoiceActions } from "./busy-thread-choice.js";
import { registerEngineSwitchChoiceActions } from "./engine-switch-choice.js";
import { composioHomeButtons, registerComposioHomeActions } from "./home-composio.js";
import { buildStatusReport } from "./status-controller.js";
// Re-exported for existing importers (tests) — moved to slack/message-pipeline.js.
export { stripMentions, isIgnorable, fetchThreadContext, deleteThreadMessages };

// Repo root (this file is src/slack/app.js).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Gateway version for the App Home footer — read once from package.json (never throws).
const GATEWAY_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version || "?"; }
  catch { return "?"; }
})();

// Processed Slack event ids. Socket Mode can redeliver an envelope (delayed ack, connection
// blip); without this the whole pipeline runs twice — double tokens, double cost, duplicate
// replies. The TTL comfortably covers Slack's retry window.
const seenEvents = createTtlSet(5 * 60 * 1000);

// Emoji reactions that cancel an in-flight run (works in the assistant DM where the composer is
// locked while the bot is responding — you can still react to a message).
const STOP_REACTIONS = new Set([
  "octagonal_sign", "stop_sign", "x", "no_entry", "no_entry_sign",
  "raised_hand", "hand", "raised_back_of_hand", "palm_up_hand", "no_good",
]);

// Decide whether a 🤖 reaction may engage this gateway inside an existing thread. A live session
// is the cheap ownership proof. Threads can also be ours WITHOUT ever minting a session — a
// reminder/daemon root, or a thread whose only turns so far were daemon-side commands (`/model`,
// `/help`, `/mode`, …), which answer in-thread without ever spawning an engine. So when there is
// no session, the fallback is "has this bot actually spoken in this thread": its own root, or any
// reply it posted. Anything else (another agent's thread, an unreadable thread, a lookup failure)
// stays fail-closed — an explicit @mention is still the way in.
const ENGAGE_SCAN_PAGE = 200; // Slack's recommended conversations.replies page size
const ENGAGE_SCAN_MAX_PAGES = 5; // bounded walk — a thread this long almost always has a session
export async function canEngageThreadByReaction(
  client,
  { channelId, threadTs, botUserId, hasSession = false },
) {
  if (hasSession) return true;
  if (!channelId || !threadTs || !botUserId) return false;
  try {
    let cursor = "";
    for (let page = 0; page < ENGAGE_SCAN_MAX_PAGES; page += 1) {
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: ENGAGE_SCAN_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      const messages = response?.messages || [];
      // `user === botUserId` is what our own chat.postMessage calls carry; a different app's
      // bot_message has a bot_id but no user, so it can never satisfy this.
      if (messages.some((message) => message?.user === botUserId)) return true;
      cursor = response?.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
    return false;
  } catch (error) {
    console.error(
      "[slack] thread ownership check failed:",
      String(error?.message || error).slice(0, 300),
    );
    return false;
  }
}

// Who does a follow-up observation belong to? Only the gateway's OWN posts map to botUserId —
// any other integration keeps its real identity (its `user`, or its `bot_id` when Slack sends
// no user). Collapsing every bot into botUserId made a foreign bot posting last read as "the
// gateway spoke last", minting false "the bot is waiting for you" reminders. Pure — exported for
// tests. (This is only follow-up ATTRIBUTION; whether a bot's post TRIGGERS a run is a separate
// decision made by isIgnorable/trustedBotApps in message-normalize.js, which this does not touch.)
export function followupIdentity(event, botUserId) {
  const isSelf = Boolean(botUserId) && event.user === botUserId;
  const isBot = Boolean(event.bot_id) || isSelf;
  const userId = isSelf ? botUserId : event.user || event.bot_id || "";
  return { userId, isBot, isSelf };
}

// Passive follow-up observation. Record every real message in a managed public/private channel
// (whether or not it mentions the bot) into the per-thread state used to build each person's
// "awaiting your reply" digest. Bot/automation posts (incl. our own) count only as "who spoke
// last", never as a participant — a thread the bot answered last owes nobody. Never touches DMs.
async function observeForFollowups(event, botUserId) {
  try {
    if (!getFollowupRemindersEnabled()) return;
    const type = event.channel_type;
    if (type !== "channel" && type !== "group") return; // public/private channels only — not DMs
    const sub = event.subtype;
    if (sub && !["file_share", "thread_broadcast", "bot_message", "me_message"].includes(sub)) return;
    const channelId = event.channel;
    if (!channelId) return;
    const entry = await getChannelEntry(channelId);
    if (!entry) return; // only channels the gateway already manages
    const { userId, isBot, isSelf } = followupIdentity(event, botUserId);
    if (!userId) return;
    // Mark this as an "AI turn" when the gateway itself posted (its own message → user===botUserId)
    // or when someone @mentioned the bot. Only threads with at least one AI turn ever get reminders.
    const aiTurn = isSelf || mentionsBot(event.text, botUserId);
    const threadTs = event.thread_ts ?? event.ts;
    const tsMs = Math.floor(Number(event.ts) * 1000);
    recordActivity({
      channelId,
      slug: entry.slug,
      channelName: entry.name,
      threadTs,
      userId,
      isBot,
      aiTurn,
      text: event.text,
      tsMs: Number.isFinite(tsMs) ? tsMs : undefined,
    });
  } catch {
    /* observation is best-effort — never let it disrupt message handling */
  }
}

// Slack spells a conversation's kind two ways: message events use channel/group/mpim/im, while
// membership events (member_joined_channel) use the single letters C/G. Only these two mean
// "public channel"; everything else — including a legacy entry whose type was never recorded — is
// treated as private so it can never leak by accident. store.upsertChannelEntry now agrees: it
// records "" for an unknown kind (never a manufactured "channel") and never overwrites a type it
// already knows, so a synthetic event can't relabel a private channel into this set.
const PUBLIC_CHANNEL_TYPES = new Set(["channel", "C"]);

// Synthetic events (a slash command, a 🤖 reaction, the App Home, a join backfill) are built by
// US, not delivered by Slack, so they carry no authoritative channel_type. Only the DM case is
// unambiguous from the id; for everything else return undefined and let resolveConversation read
// the real kind from conversations.info. Guessing "channel" here is what let one /model in a
// private channel relabel it public.
function syntheticChannelType(channelId) {
  return String(channelId || "").startsWith("D") ? "im" : undefined;
}

// App Home channel list: authorization decides who may USE a channel, but a PRIVATE channel's
// NAME is itself confidential — Slack only shows it to members. Mirror that: private entries stay
// in the list only when the viewing user is actually a member, and a failed lookup fails closed
// (the entry is hidden). Membership is cached briefly — App Home opens are low-frequency, but one
// open shouldn't re-page conversations.members for every channel the gateway manages.
const HOME_MEMBERS_TTL_MS = 60 * 1000;
// How many channel lines the App Home section renders. Also the probe budget (see below).
const HOME_CHANNEL_LIST_MAX = 25;
const homeMembersCache = new Map(); // channelId -> { at, ids }
// `limit` caps the number of VISIBLE entries collected, and the loop stops as soon as it is
// reached. Without it, a gateway managing hundreds of private channels probed membership for
// every single one on every Home open just to throw all but the first 25 away — a self-inflicted
// conversations.members rate-limit storm.
export async function homeVisibleChannels(client, channels, userId, { now = Date.now, cache = homeMembersCache, limit = Infinity } = {}) {
  const visible = [];
  for (const c of channels) {
    if (visible.length >= limit) break;
    if (!PUBLIC_CHANNEL_TYPES.has(c.type)) {
      let entry = cache.get(c.channelId);
      if (!entry || now() - entry.at > HOME_MEMBERS_TTL_MS) {
        try {
          entry = { at: now(), ids: await listConversationMemberIds(client, c.channelId) };
          cache.set(c.channelId, entry);
        } catch {
          continue; // can't verify membership → don't leak the private channel's name
        }
      }
      if (!entry.ids.includes(userId)) continue;
    }
    visible.push(c);
  }
  return visible;
}

// Stopping or inspecting runs controls OTHER users' work, so /stop, /status, and the 🛑 reaction
// must pass the same authorization gate as messages (admin/approved/guest-grant). Returns the
// channel entry when the user may act here, null otherwise (unregistered or unauthorized).
export async function authorizedControlEntry(channelId, userId) {
  const entry = await getChannelEntry(channelId);
  if (!entry) return null;
  const meta = await getChannelMeta(entry.slug);
  if (!meta) return null;
  const [adminUser, approvedUser] = await Promise.all([isAdmin(userId), isApproved(userId)]);
  if (!isAuthorized(meta, userId, Boolean(meta.isDM), { isAdminUser: adminUser, isApprovedUser: approvedUser })) return null;
  return entry;
}

// Shared by the file explorer and the secrets manager: same channel resolution, same
// authorization gate, same "are you still a member" re-check on a modal click. `purpose` only
// shapes the message a user reads — never the checks.
export async function fileExplorerContext(client, { channelId, userId, expectedSlug = "", verifyMembership = false, purpose = { expired: "This channel file explorer expired. Open it again with `/files`.", denied: "You're not authorized to browse files in this channel." } } = {}) {
  const entry = await getChannelEntry(channelId);
  if (!entry || (expectedSlug && entry.slug !== expectedSlug)) throw new Error(purpose.expired);
  const meta = await getChannelMeta(entry.slug);
  if (!meta) throw new Error("This channel isn't registered with the gateway yet.");
  const userIsAdmin = await isAdmin(userId);
  const userIsApproved = await isApproved(userId);
  if (!isAuthorized(meta, userId, Boolean(meta.isDM), { isAdminUser: userIsAdmin, isApprovedUser: userIsApproved })) {
    throw new Error(purpose.denied);
  }
  // A slash command / shortcut proves membership when the modal opens. Re-check modal clicks so a
  // user who has since left the channel cannot keep browsing through a stale open view.
  if (verifyMembership && !meta.isDM) {
    const members = await listConversationMemberIds(client, channelId);
    if (!members.includes(userId)) throw new Error("You are no longer a member of this channel.");
  }
  return { entry, meta, userIsAdmin, userIsApproved, root: effectiveWorkDir(entry.slug, meta) };
}

async function openFileExplorer(client, triggerId, { channelId, userId, threadTs = "", file = "" } = {}) {
  if (!(await getChannelEntry(channelId))) {
    await ensureRegistered(client, {
      channel: channelId,
      user: userId,
      channel_type: syntheticChannelType(channelId),
    });
  }
  await ensureUserKnown(client, userId);
  const { entry, meta, userIsAdmin, root } = await fileExplorerContext(client, { channelId, userId });
  const relativeFile = normalizeRelativePath(file || "");
  const parent = relativeFile ? path.posix.dirname(relativeFile) : "";
  const state = { channelId, slug: entry.slug, threadTs, ownerId: userId, relative: parent === "." ? "" : parent, page: 0 };
  const mayEdit = canEditChannelFiles(effectiveMeta(meta), { isAdminUser: userIsAdmin });
  // Consume Slack's short-lived trigger immediately; a very large host directory may take longer
  // to stat than the trigger window. Fill the already-open modal once the confined listing is ready.
  const opened = await client.views.open({ trigger_id: triggerId, view: buildFilesLoadingView(state, { channelName: entry.name }) });
  if (!opened?.view?.id) throw new Error("Slack opened the file explorer without returning a view id.");
  try {
    await client.views.update({
      view_id: opened.view.id,
      ...(opened.view.hash ? { hash: opened.view.hash } : {}),
      view: relativeFile
        ? await buildFilePreviewView(root, state, relativeFile, filePreviewOptions({ state, entry, mayEdit }))
        : await buildFilesView(root, state, fileExplorerViewOptions({ state, entry, mayEdit })),
    });
  } catch (e) {
    await client.views.update({ view_id: opened.view.id, view: fileExplorerErrorView(e.message) }).catch(() => {});
    throw e;
  }
  await logEvent("channel_files_opened", { channel: channelId, author: userId, slug: entry.slug });
}

// ── Channel secrets manager ─────────────────────────────────────────────────
// The Slack half of config/channel-env.js. It can list (masked) and write; it cannot read a
// value, and neither can anything else — see that module's header for why that is the whole
// design rather than a limitation of this view.
const SECRETS_PURPOSE = {
  expired: "This secrets manager expired. Open it again with `/secrets`.",
  denied: "You're not authorized to see this channel's secrets.",
};

export async function secretsContext(client, { channelId, userId, expectedSlug = "", verifyMembership = false } = {}) {
  const ctx = await fileExplorerContext(client, { channelId, userId, expectedSlug, verifyMembership, purpose: SECRETS_PURPOSE });
  // Authorized users can manage write-only credentials in every channel mode.
  return { ...ctx, mayEdit: true };
}

async function openSecretsManager(client, triggerId, { channelId, userId, threadTs = "" } = {}) {
  await ensureUserKnown(client, userId);
  const { entry, meta, mayEdit } = await secretsContext(client, { channelId, userId });
  const state = { channelId, slug: entry.slug, threadTs, ownerId: userId };
  await client.views.open({
    trigger_id: triggerId,
    view: buildSecretsView(listChannelEnv(meta), state, { channelName: entry.name, mayEdit }),
  });
  // The names are worth an audit line; there is no value to omit, because we never had one.
  await logEvent("channel_secrets_opened", { channel: channelId, author: userId, slug: entry.slug });
}

// ── Settings for authorized channel users ──────────────────────────────────
// Re-check access and membership on every interaction; Cloud MCP additionally requires admin.
const SETTINGS_PURPOSE = {
  expired: "This channel settings view expired. Open it again from a recent reply.",
  denied: "You're not authorized to view this channel's settings.",
};

export async function channelSettingsContext(client, { channelId, userId, expectedSlug = "", verifyMembership = false, cloudMcp = false, accessSettings = false } = {}) {
  const ctx = await fileExplorerContext(client, {
    channelId,
    userId,
    expectedSlug,
    verifyMembership,
    purpose: SETTINGS_PURPOSE,
  });
  if (accessSettings) assertAccessManager(ctx.meta, {
    authorId: userId, isAdminUser: ctx.userIsAdmin, isApprovedUser: ctx.userIsApproved,
  });
  if (cloudMcp && !ctx.userIsAdmin) throw new Error("Only administrators can manage Cloud MCP.");
  return ctx;
}

function channelSettingsSnapshot(meta = {}) {
  const effective = effectiveMeta(meta);
  const effectiveEngine = effective.engine || getEngine();
  const gatewayEngine = getEngine();
  const organization = getOrgAccessGrants();
  const channelTier = { ...effective, skills: channelSkillGrants(effective) };
  const shared = resolveAccessGrants({ organization, channel: channelTier });
  const template = templateOfMeta(effective);
  return {
    isDM: Boolean(meta.isDM),
    access: meta,
    mode: { adminMode: effective.adminMode, allowBash: effective.allowBash, autoMode: effective.autoMode, cleanMode: effective.cleanMode, allowNetwork: effective.allowNetwork },
    runtime: {
      configuredEngineId: effective.engine || "",
      configuredEngine: effective.engine ? engineLabel(effective.engine) : "",
      effectiveEngineId: effectiveEngine,
      effectiveEngine: engineLabel(effectiveEngine),
      gatewayEngineId: gatewayEngine,
      gatewayEngineLabel: engineLabel(gatewayEngine),
      configuredModel: effective.model || "",
      gatewayModel: getDefaultModel(effectiveEngine),
      configuredEffort: effective.effort || "",
    },
    connections: {
      composioMode: getComposioMode(),
      composioSdkReady: hasComposioSdkEntitlement() && Boolean(getComposioSdkApiKey()),
      composioChannel: maskedCredential(meta.composioToken),
      composioTokenLabel: String(meta.composioTokenLabel || ""),
      composioOrg: maskedCredential(getDefaultComposioToken()),
      toolboxChannel: maskedCredential(meta.toolboxToken),
      toolboxOrg: maskedCredential(getDefaultToolboxToken()),
      makeToolboxUrl: String(meta.makeToolboxUrl || ""),
      makeToolboxKey: maskedCredential(meta.makeToolboxKey),
      noDefaultTokens: Boolean(effective.noDefaultTokens),
    },
    cloudMcp: {
      claude: { channel: effective.allowedMcps || [], organization: organization.allowedMcps || [] },
      codex: { channel: effective.allowedCodexMcps || [], organization: organization.allowedCodexMcps || [] },
    },
    skills: {
      template: template?.name || effective.skillTemplate || "",
      additional: effective.skills || [],
      channel: channelTier.skills || [],
      organization: organization.skills || [],
      effective: shared.skills || [],
    },
    // listChannelEnv is the write-only subsystem's public shape: no value/ref can cross this line.
    secrets: listChannelEnv(meta),
  };
}

export function channelSettingsEditOptions(meta, userIsAdmin, { authorId = "", isApprovedUser = false } = {}) {
  return {
    canEnableAdmin: Boolean(userIsAdmin),
    canEditRuntime: true,
    canEditSecrets: true,
    canManageCloudMcp: Boolean(userIsAdmin),
    canEditAccess: !meta.isDM && canManage(meta, { authorId, isAdminUser: userIsAdmin, isApprovedUser }),
  };
}

function runtimeEditorData(meta, { engineChoice = "", modelChoice = "" } = {}) {
  const snapshot = channelSettingsSnapshot(meta);
  const runtime = snapshot.runtime;
  const chosen = engineChoice || runtime.configuredEngineId || SETTINGS_DEFAULT_VALUE;
  const actualEngine = chosen === SETTINGS_DEFAULT_VALUE ? runtime.gatewayEngineId : chosen;
  const wantedModel = modelChoice || runtime.configuredModel || SETTINGS_DEFAULT_VALUE;
  const selectedModel = wantedModel === SETTINGS_DEFAULT_VALUE || modelBelongsToEngine(wantedModel, actualEngine)
    ? wantedModel
    : SETTINGS_DEFAULT_VALUE;
  const actualModel = selectedModel === SETTINGS_DEFAULT_VALUE ? getDefaultModel(actualEngine) : selectedModel;
  runtime.gatewayModel = getDefaultModel(actualEngine);
  return {
    snapshot,
    engineChoice: chosen,
    modelChoice: selectedModel,
    engines: getEnabledEngines().map((id) => ({ label: engineLabel(id), value: id })),
    models: modelsForEngine(actualEngine),
    efforts: effortsForModel(actualEngine, actualModel).map((value) => ({ label: value === "xhigh" ? "XHigh" : value[0].toUpperCase() + value.slice(1), value })),
  };
}

export function runtimeSettingsPatch(form = {}, {
  gatewayEngine = getEngine(),
  enabledEngines = getEnabledEngines(),
} = {}) {
  const engine = form.engine === SETTINGS_DEFAULT_VALUE ? "" : String(form.engine || "");
  const actualEngine = engine || gatewayEngine;
  if (!enabledEngines.includes(actualEngine)) {
    const error = new Error("That engine is no longer enabled.");
    error.field = RUNTIME_ENGINE_BLOCK_ID;
    throw error;
  }
  const model = form.model === SETTINGS_DEFAULT_VALUE ? "" : String(form.model || "");
  if (model && !modelBelongsToEngine(model, actualEngine)) {
    const error = new Error("That model does not belong to the selected engine.");
    error.field = RUNTIME_MODEL_BLOCK_ID;
    throw error;
  }
  const effort = form.effort === SETTINGS_DEFAULT_VALUE ? "" : String(form.effort || "");
  if (effort && !effortBelongsToModel(effort, actualEngine, model || getDefaultModel(actualEngine))) {
    const error = new Error("That effort is not supported by the selected model.");
    error.field = RUNTIME_EFFORT_BLOCK_ID;
    throw error;
  }
  return { patch: { engine, model, effort }, actualEngine };
}

export function connectionSettingsPatch(current = {}, form = {}) {
  const errors = {};
  if (form.composioToken && form.composioToken.length < 6) errors[CONNECTION_COMPOSIO_BLOCK_ID] = "That doesn't look like a valid Composio token.";
  if (form.toolboxToken && form.toolboxToken.length < 6) errors[CONNECTION_TOOLBOX_BLOCK_ID] = "That doesn't look like a valid Toolbox token.";
  if (form.makeToolboxKey && form.makeToolboxKey.length < 6) errors[CONNECTION_MAKE_KEY_BLOCK_ID] = "That doesn't look like a valid Make MCP token.";
  if (Object.keys(errors).length) return { errors, patch: null, changed: [] };
  let make;
  try {
    make = resolveMakeToolboxUpdate(current, {
      makeToolboxUrl: form.makeToolboxUrl,
      makeToolboxKey: form.makeToolboxKey,
    });
  } catch (error) {
    return { errors: { [CONNECTION_MAKE_URL_BLOCK_ID]: String(error.message).slice(0, 150) }, patch: null, changed: [] };
  }
  const patch = { ...make };
  if (form.composioToken) patch.composioToken = form.composioToken;
  if (typeof form.composioTokenLabel === "string") patch.composioTokenLabel = form.composioTokenLabel.trim();
  if (form.toolboxToken) patch.toolboxToken = form.toolboxToken;
  const changed = [
    form.composioToken ? "Composio" : "",
    typeof patch.composioTokenLabel === "string" && patch.composioTokenLabel !== String(current.composioTokenLabel || "") ? "Composio label" : "",
    form.toolboxToken ? "Toolbox" : "",
    form.makeToolboxKey || form.makeToolboxUrl !== String(current.makeToolboxUrl || "") ? "Make MCP" : "",
  ].filter(Boolean);
  return { errors: {}, patch, changed };
}

export function cloudSelectionsAfterToggle(current = [], engine, key, { activate = false, selection = null } = {}) {
  const list = Array.isArray(current) ? current : [];
  const kept = list.filter((item) => cloudSelectionKey(engine, item) !== key);
  return activate && selection ? [...kept, selection] : kept;
}

function cloudSelectionKey(engine, entry = {}) {
  return engine === "codex"
    ? `${String(entry.kind || "")}:${String(entry.id || "")}`
    : String(entry.name || "").trim().toLowerCase();
}

async function cloudManagerItems(meta, engine) {
  const field = selectionFieldForEngine(engine);
  const direct = Array.isArray(meta?.[field]) ? meta[field] : [];
  const inherited = Array.isArray(getOrgAccessGrants()?.[field]) ? getOrgAccessGrants()[field] : [];
  const directKeys = new Set(direct.map((entry) => cloudSelectionKey(engine, entry)));
  const inheritedKeys = new Set(inherited.map((entry) => cloudSelectionKey(engine, entry)));
  const available = await requireAdapter(engine).discoverMcps();
  const rows = new Map();
  for (const entry of [...available, ...direct, ...inherited]) {
    const key = cloudSelectionKey(engine, entry);
    if (!key || rows.has(key)) continue;
    rows.set(key, {
      key,
      name: String(entry.name || entry.id || key),
      description: String(entry.description || entry.target || entry.kind || ""),
      connected: entry.connected !== false,
      direct: directKeys.has(key),
      inherited: inheritedKeys.has(key),
      active: directKeys.has(key) || inheritedKeys.has(key),
      source: entry,
    });
  }
  return [...rows.values()].sort((a, b) => Number(b.direct) - Number(a.direct) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

function skillManagerItems(meta, { userId = "", userIsAdmin = false } = {}) {
  const direct = new Set((meta?.skills || []).map((value) => String(value).toLowerCase()));
  const organization = new Set((getOrgAccessGrants().skills || []).map((value) => String(value).toLowerCase()));
  const scoped = new Set(channelScopedSkills(meta?.channelId).map((value) => value.toLowerCase()));
  const template = templateOfMeta(meta);
  const templateSummary = template ? listTemplateSummaries().find((entry) => entry.slug === template.slug) : null;
  const fromTemplate = new Set((templateSummary?.resolved || []).map((value) => String(value).toLowerCase()));
  const active = new Set([...direct, ...organization, ...scoped, ...fromTemplate]);
  const rows = new Map();
  for (const skill of listSkills({ viewer: userIsAdmin ? "*" : userId || "" })) {
    const key = skill.slug.toLowerCase();
    if (!canSeeSkill(skill, { userId, isAdmin: userIsAdmin, active: active.has(key) })) continue;
    if (skill.visibility === "personal") continue;
    rows.set(key, {
      key: skill.slug,
      name: skill.name || skill.slug,
      description: skill.description || "",
      direct: direct.has(key),
      inherited: organization.has(key),
      template: fromTemplate.has(key),
      scoped: scoped.has(key),
      active: active.has(key),
    });
  }
  // A hand-written or legacy direct grant may not be in the governed catalog. Keep it visible so
  // a manager can deactivate it instead of trapping an unrenderable grant in the channel record.
  for (const slug of meta?.skills || []) {
    const key = String(slug).toLowerCase();
    if (!key || rows.has(key)) continue;
    rows.set(key, { key: String(slug), name: String(slug), description: "Not currently in the catalog", direct: true, active: true });
  }
  return [...rows.values()].sort((a, b) => Number(b.direct) - Number(a.direct) || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

async function patchAuditedChannelSettings(entry, actor, patch) {
  let before = null;
  const after = await patchChannelMeta(entry.slug, (current) => {
    if (!current) return null;
    before = current;
    return typeof patch === "function" ? patch(current) : patch;
  });
  if (!after) throw new Error("This channel settings view expired. Open it again from a recent reply.");
  await logChannelPolicyChange({
    channelId: entry.channelId,
    slug: entry.slug,
    actor,
    before,
    after,
    source: "slack-settings",
  });
  await ensureChannelFolder(entry.slug, effectiveMeta(after));
  return after;
}

export async function handleAccessSettingsSubmission({ ack, body, view, client }, { save = saveAccessSettings, rootView = settingsRootView } = {}) {
  let state;
  let form;
  const clicker = body?.user?.id;
  try {
    state = parseEditorMetadata(view?.private_metadata);
    if (!clicker || state.ownerId !== clicker || state.view !== "access") throw new Error("This access editor expired. Open your own Settings.");
    form = readAccessForm(view);
  } catch (error) {
    await ack({ response_action: "errors", errors: { [ACCESS_MODE_BLOCK_ID]: String(error.message).slice(0, 150) } });
    return;
  }
  // Consume Slack's three-second submission window before any membership API calls or locks.
  await ack({ response_action: "update", view: {
    type: "modal", title: { type: "plain_text", text: "Channel access" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "plain_text", text: "Checking channel membership and saving access settings…" } }],
  } });
  try {
    const { entry, saved, userIsAdmin } = await save(client, state, clicker, form);
    await client.views.update({ view_id: view.id, view: await rootView(entry, saved, { ...state, tab: "access" }, userIsAdmin, {
      notice: "✅ Channel access settings saved. Changes apply to the next run.",
    }) });
  } catch (error) {
    await client.views.update({ view_id: view.id, view: buildChannelSettingsErrorView(
      `${error.message || "Couldn't finish updating access settings."} Reopen Settings to check the current values and try again.`,
    ) }).catch(() => {});
  }
}

// Serialize with member-left cleanup, verify selected humans, then re-read authorization and
// policy at the write boundary. Never accept arbitrary fields from a Slack submission.
export async function saveAccessSettings(client, state, userId, form) {
  if (state.ownerId !== userId) throw new Error("This access editor isn't yours.");
  return withChannelMembershipLock(state.channelId, async () => {
    const args = { channelId: state.channelId, userId, expectedSlug: state.slug, verifyMembership: true, accessSettings: true };
    const first = await channelSettingsContext(client, args);
    accessSettingsPatch(first.meta, form, { authorId: userId, isAdminUser: first.userIsAdmin, isApprovedUser: first.userIsApproved });
    const requested = [...new Set([...form.allowedUsers, ...form.managers])];
    const humans = await filterConversationHumanMemberIds(client, state.channelId, requested);
    if (requested.some((id) => !humans.includes(id))) throw new Error("Named users and managers must be current human members of this channel.");
    const { entry } = await channelSettingsContext(client, args);
    const [userIsAdmin, userIsApproved] = await Promise.all([isAdmin(userId), isApproved(userId)]);
    const actor = { authorId: userId, isAdminUser: userIsAdmin, isApprovedUser: userIsApproved };
    const saved = await patchAuditedChannelSettings({ ...entry, channelId: state.channelId }, userId, (current) => accessSettingsPatch(current, form, actor));
    return { entry, saved, userIsAdmin };
  });
}

async function settingsRootView(entry, meta, state, userIsAdmin, { tab = state.tab, notice = "" } = {}) {
  return buildChannelSettingsView(channelSettingsSnapshot(meta), { ...state, tab }, {
    channelName: entry.name,
    tab,
    notice,
    ...channelSettingsEditOptions(meta, userIsAdmin, { authorId: state.ownerId, isApprovedUser: await isApproved(state.ownerId) }),
  });
}

async function openChannelSettings(client, triggerId, { channelId, userId, threadTs = "", tab = "runtime" } = {}) {
  const { entry, meta, userIsAdmin } = await channelSettingsContext(client, {
    channelId,
    userId,
    verifyMembership: true,
  });
  const state = { channelId, slug: entry.slug, threadTs, ownerId: userId, tab };
  await client.views.open({
    trigger_id: triggerId,
    view: buildChannelSettingsView(channelSettingsSnapshot(meta), state, {
      channelName: entry.name,
      tab,
      ...channelSettingsEditOptions(meta, userIsAdmin, { authorId: state.ownerId, isApprovedUser: await isApproved(state.ownerId) }),
    }),
  });
  await logEvent("channel_settings_opened", { channel: channelId, author: userId, slug: entry.slug });
}

async function updateFileExplorerView(client, body, view) {
  await client.views.update({ view_id: body.view.id, ...(body.view.hash ? { hash: body.view.hash } : {}), view });
}

function fileExplorerViewOptions({ state, entry, mayEdit, notice = "" }) {
  const baseUrl = getPublicUrl();
  return {
    channelName: entry.name,
    notice,
    canUpload: mayEdit,
    ...(mayEdit && baseUrl
      ? {
          browserUploadUrl: createFileUploadGrantUrl({
            baseUrl,
            channelId: state.channelId,
            slug: entry.slug,
            ownerId: state.ownerId,
            relative: state.relative,
            threadTs: state.threadTs,
          }),
        }
      : {}),
  };
}

function filePreviewOptions({ state, entry, mayEdit, notice = "" }) {
  const baseUrl = getPublicUrl();
  return {
    notice,
    canEdit: mayEdit,
    ...(baseUrl
      ? {
          createDownloadUrl: ({ relative }) => createFileDownloadGrantUrl({
            baseUrl,
            channelId: state.channelId,
            slug: entry.slug,
            ownerId: state.ownerId,
            relative,
            threadTs: state.threadTs,
          }),
        }
      : {}),
    ...(mayEdit && baseUrl
      ? {
          browserEditLimits: { maxChars: BROWSER_EDIT_MAX_CHARS, maxBytes: BROWSER_EDIT_MAX_BYTES, label: "Browser editing" },
          createEditUrl: ({ relative, expectedHash }) => createFileEditorGrantUrl({
            baseUrl,
            channelId: state.channelId,
            slug: entry.slug,
            ownerId: state.ownerId,
            relative,
            expectedHash,
            threadTs: state.threadTs,
          }),
        }
      : {}),
  };
}

function fileExplorerErrorView(message) {
  return {
    type: "modal",
    callback_id: "cg_channel_files_modal",
    title: { type: "plain_text", text: "Channel files" },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `⚠️ ${String(message || "Couldn't browse files.").slice(0, 2800)}` } }],
  };
}

// Create + start a Socket Mode app with the given config. Returns { app, botUserId, user, team }.
// Throws if tokens are missing or auth fails (the caller/manager surfaces the error).
export async function startSlack({ botToken, appToken, signingSecret } = {}) {
  if (!botToken || !appToken || !signingSecret) {
    throw new Error("missing Slack tokens (bot, app-level, signing secret all required)");
  }

  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Swallow async Bolt/socket errors into a log line instead of an unhandled rejection.
  app.error(async (err) => {
    console.error("[slack] app error:", err?.message || err);
  });

  // From here, any failure must tear the app down so no lingering socket client emits an
  // unhandled error later (a bad token must never crash the daemon).
  const finish = await connectAndWire(app).catch(async (err) => {
    try {
      await app.stop();
    } catch {
      /* never started / already stopped */
    }
    throw err;
  });
  return finish;
}

// Compare the installed app's live bot scopes to the manifest; on a newly-appeared gap, warn in
// the log and DM every admin the exact scopes to add. Best-effort and self-throttling.
async function verifyScopes(client) {
  const { botToken } = resolveSlackConfig();
  const { ok, missing, required, error } = await checkBotScopes(botToken);
  if (!ok) {
    console.warn(`[slack] scope check skipped: ${error}`);
    return;
  }
  const notify = shouldNotify(missing); // always records the current set (incl. the "all present" state)
  if (!missing.length) {
    console.log(`[slack] scope check: all ${required.length} bot scopes granted`);
    return;
  }
  console.warn(`[slack] ⚠️ missing bot scopes: ${missing.join(", ")} — add them to the app and reinstall`);
  await logEvent("scope_check_missing", { missing: missing.join(",") });
  if (notify) await notifyAdminsScopes(client, missing);
}

// DM every admin the "add these scopes + reinstall" message. Needs `im:write` to open the DM;
// if that itself is the missing scope the DM just fails (logged) and the console warning stands.
async function notifyAdminsScopes(client, missing) {
  const text = formatScopeWarning(missing);
  const users = await getUsers();
  const admins = Object.entries(users)
    .filter(([, u]) => u?.isAdmin)
    .map(([id]) => id);
  let sent = 0;
  for (const id of admins) {
    try {
      const open = await client.conversations.open({ users: id });
      const dm = open?.channel?.id;
      if (dm) {
        await client.chat.postMessage({ channel: dm, text });
        sent++;
      }
    } catch (e) {
      console.warn(`[slack] couldn't DM admin ${id} about missing scopes: ${e.message}`);
    }
  }
  await logEvent("scope_check_notified", { admins: sent, missing: missing.join(",") });
}

// A reply footer belongs to the requester who caused that reply, but gateway admins must still
// be able to inspect its workspace files. Everyone else remains bound to their own controls.
export function canOpenMessageFileButton({ ownerId = "", clickerId = "", clickerIsAdmin = false } = {}) {
  return Boolean(clickerId && (clickerId === ownerId || clickerIsAdmin));
}

// Slack does not infer the source thread for an ephemeral posted from a Block Kit action. Carry
// the thread encoded into the button (falling back to the action's message envelope) explicitly.
export function fileButtonNoticePayload(body, command, clicker, text) {
  const channel = body?.channel?.id || command?.c || "";
  const threadTs = command?.t || body?.message?.thread_ts || body?.message?.ts || "";
  return {
    channel,
    user: clicker,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
  };
}

async function connectAndWire(app) {
  const auth = await app.client.auth.test();
  const botUserId = auth.user_id;
  const teamId = auth.team_id; // needed as recipient_team_id when streaming outside a DM
  // Agent split-view context is intentionally process-local, expiring, and keyed by BOTH
  // workspace + human user. It is only ever read by that same user's message.im event.
  const activeAppContexts = createAppContextStore();
  process.env.CG_SLACK_TEAM_ID = teamId || "";
  console.log(`[slack] connected as @${auth.user} (${botUserId}) in ${auth.team}`);

  // Verify the installed app still holds every bot scope the current build needs (runs on every
  // boot, so it also fires right after an `update_gateway` restart). Best-effort — never blocks
  // the connection. DMs admins once per change in the missing set so upgrades that add a scope
  // surface a clear "add these + reinstall" nudge without spamming on routine restarts.
  await verifyScopes(app.client).catch((e) => console.warn(`[slack] scope check error: ${e.message}`));

  // Warm the workspace user directory (name → id) so "@Display Name" in a reply becomes a real
  // <@UID> mention with no id lookup at generation time. Background — never blocks the connection.
  refreshDirectory(app.client).catch(() => {});

  // Expose this connection's client to the approval flow + register the approval button handlers.
  setApprovalClient(app.client);
  const handleFileExplorerAction = async ({ ack, body, action, client }) => {
    await ack();
    const clicker = body?.user?.id;
    const command = parseFileActionValue(action?.value);
    try {
      if (command.o === "open" || command.o === "open_file") {
        const clickerIsAdmin = clicker && command.u !== clicker ? await isAdmin(clicker) : false;
        if (!canOpenMessageFileButton({ ownerId: command.u, clickerId: clicker, clickerIsAdmin }) || !body?.trigger_id) {
          throw new Error("This file explorer button isn't for you.");
        }
        await openFileExplorer(client, body.trigger_id, {
          channelId: command.c,
          userId: clicker,
          threadTs: command.t || "",
          file: command.o === "open_file" ? command.p || "" : "",
        });
        return;
      }
      const state = parseExplorerMetadata(body?.view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This file explorer isn't yours. Open your own with `/files`.");
      const { entry, meta, userIsAdmin, root } = await fileExplorerContext(client, {
        channelId: state.channelId,
        userId: clicker,
        expectedSlug: state.slug,
        verifyMembership: true,
      });
      const mayEdit = canEditChannelFiles(effectiveMeta(meta), { isAdminUser: userIsAdmin });
      let view;
      if (command.o === "directory") {
        const nextState = { ...state, relative: command.p || "", page: 0 };
        view = await buildFilesView(root, nextState, fileExplorerViewOptions({ state: nextState, entry, mayEdit }));
      } else if (command.o === "page") {
        const nextState = { ...state, page: Math.max(0, Number(command.g) || 0) };
        view = await buildFilesView(root, nextState, fileExplorerViewOptions({ state: nextState, entry, mayEdit }));
      } else if (command.o === "browser_upload") {
        if (!mayEdit) throw new Error("Uploading is no longer enabled for you in this channel mode.");
        return; // Slack opens the URL; the browser route repeats every authorization check.
      } else if (command.o === "new_file") {
        if (!mayEdit) throw new Error("Creating files is available only in Worker or Auto mode. Full mode requires an admin.");
        if (!body?.trigger_id) throw new Error("Slack didn't provide a trigger for file creation. Reopen Files and try again.");
        await client.views.push({ trigger_id: body.trigger_id, view: buildNewFileView(state) });
        return;
      } else if (command.o === "new_folder") {
        if (!mayEdit) throw new Error("Creating folders is available only in Worker or Auto mode. Full mode requires an admin.");
        if (!body?.trigger_id) throw new Error("Slack didn't provide a trigger for folder creation. Reopen Files and try again.");
        await client.views.push({ trigger_id: body.trigger_id, view: buildNewFolderView(state) });
        return;
      } else if (command.o === "preview") {
        view = await buildFilePreviewView(root, state, command.p || "", filePreviewOptions({ state, entry, mayEdit }));
      } else if (command.o === "share") {
        const file = await resolveVisiblePath(root, command.p || "", { kind: "file" });
        const name = path.basename(file.relative);
        await uploadLocalFile({
          filePath: file.path,
          filename: name,
          title: name,
          channelId: state.channelId,
          threadTs: state.threadTs,
          comment: `Shared from this channel's workspace by <@${clicker}>.`,
        });
        await logEvent("channel_file_shared", {
          channel: state.channelId,
          author: clicker,
          slug: entry.slug,
          file: file.relative,
          bytes: file.stat.size,
        });
        view = await buildFilePreviewView(root, state, file.relative, filePreviewOptions({
          state,
          entry,
          mayEdit,
          notice: `✅ Shared ${name} ${state.threadTs ? "in this thread" : "in the channel"}.`,
        }));
      } else if (command.o === "send_dm") {
        const file = await resolveVisiblePath(root, command.p || "", { kind: "file" });
        const name = path.basename(file.relative);
        const opened = await client.conversations.open({ users: clicker });
        const dmChannelId = opened?.channel?.id;
        if (!dmChannelId) throw new Error("Slack couldn't open your DM with the bot.");
        await uploadLocalFile({
          filePath: file.path,
          filename: name,
          title: name,
          channelId: dmChannelId,
          comment: `Private copy of ${name} from <#${state.channelId}>.`,
        });
        await logEvent("channel_file_sent_to_user", {
          channel: state.channelId,
          author: clicker,
          slug: entry.slug,
          file: file.relative,
          bytes: file.stat.size,
        });
        view = await buildFilePreviewView(root, state, file.relative, filePreviewOptions({
          state,
          entry,
          mayEdit,
          notice: `✅ Sent the complete ${name} file to your Slack DM.`,
        }));
      } else if (command.o === "browser_download") {
        return; // Slack opens the URL; the browser route repeats every authorization check.
      } else if (command.o === "browser_edit") {
        if (!mayEdit) throw new Error("Editing is no longer enabled for you in this channel mode.");
        return; // Slack opens the button URL; the browser route repeats every security check.
      } else if (command.o === "edit") {
        if (!mayEdit) throw new Error("Editing is available only in Worker or Auto mode. Full mode requires an admin.");
        if (!body?.trigger_id) throw new Error("Slack didn't provide a trigger for the editor. Reopen the preview and try again.");
        await client.views.push({
          trigger_id: body.trigger_id,
          view: await buildFileEditView(root, state, command.p || ""),
        });
        return;
      } else {
        throw new Error("This file explorer control expired. Open it again with `/files`.");
      }
      await updateFileExplorerView(client, body, view);
    } catch (e) {
      console.warn(`[slack] file explorer error: ${e.message}`);
      if (body?.view?.id) {
        await updateFileExplorerView(client, body, fileExplorerErrorView(e.message)).catch(() => {});
      } else if ((body?.channel?.id || command?.c) && clicker) {
        await client.chat.postEphemeral(fileButtonNoticePayload(body, command, clicker, e.message)).catch(() => {});
      }
    }
  };
  app.action(FILES_ACTION_PATTERN, handleFileExplorerAction);
  app.shortcut(FILES_SHORTCUT_ID, async ({ ack, body, client }) => {
    await ack();
    const channelId = body?.channel?.id;
    const userId = body?.user?.id;
    const threadTs = body?.message?.thread_ts || body?.message?.ts || "";
    try {
      if (!channelId || !userId || !body?.trigger_id) throw new Error("Slack didn't provide a channel for this shortcut.");
      await openFileExplorer(client, body.trigger_id, { channelId, userId, threadTs });
    } catch (e) {
      console.warn(`[slack] file explorer shortcut error: ${e.message}`);
      if (channelId && userId) await client.chat.postEphemeral({ channel: channelId, user: userId, ...(threadTs ? { thread_ts: threadTs } : {}), text: e.message }).catch(() => {});
    }
  });
  const handleSecretsAction = async ({ ack, body, action, client }) => {
    await ack();
    const clicker = body?.user?.id;
    const command = parseSecretActionValue(action?.value);
    try {
      if (command.o === "open") {
        if (!clicker || command.u !== clicker || !body?.trigger_id) throw new Error("This secrets button isn't for you.");
        await openSecretsManager(client, body.trigger_id, { channelId: command.c, userId: clicker, threadTs: command.t || "" });
        return;
      }
      const state = parseSecretsMetadata(body?.view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This secrets manager isn't yours. Open your own with `/secrets`.");
      const { entry, mayEdit } = await secretsContext(client, {
        channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
      });
      if (!mayEdit) throw new Error("You can't change this channel's secrets.");
      if (action?.action_id === SECRETS_ADD_ACTION_ID) {
        await client.views.push({
          trigger_id: body.trigger_id,
          view: buildSecretFormView(state, { channelName: entry.name, suggested: cliEnvKeys(cliIntegrationIds()) }),
        });
        return;
      }
      if (String(action?.action_id || "").startsWith(SECRETS_REMOVE_ACTION_PREFIX)) {
        const name = String(command.n || "");
        const saved = await patchChannelMeta(entry.slug, (existing) => ({ env: patchChannelEnv(existing?.env, { remove: name }) }));
        await ensureChannelFolder(entry.slug, effectiveMeta(saved));
        await logEvent("channel_env_removed", { slug: entry.slug, name, actor: clicker });
        await updateFileExplorerView(client, body, buildSecretsView(listChannelEnv(saved), state, {
          channelName: entry.name, mayEdit, notice: `🗑️ Removed *${name}*. New runs in this channel no longer receive it.`,
        }));
      }
    } catch (e) {
      if (body?.view?.id) {
        await client.views.update({ view_id: body.view.id, view: buildSecretsErrorView(e.message) }).catch(() => {});
      } else if (body?.channel?.id && clicker) {
        await client.chat.postEphemeral({ channel: body.channel.id, user: clicker, text: e.message }).catch(() => {});
      }
    }
  };
  app.action(SECRETS_ACTION_PATTERN, handleSecretsAction);
  app.shortcut(SECRETS_SHORTCUT_ID, async ({ ack, body, client }) => {
    await ack();
    const channelId = body?.channel?.id;
    const userId = body?.user?.id;
    try {
      if (!channelId || !userId || !body?.trigger_id) throw new Error("Slack didn't provide a channel for this shortcut.");
      await openSecretsManager(client, body.trigger_id, { channelId, userId, threadTs: body?.message?.thread_ts || body?.message?.ts || "" });
    } catch (e) {
      console.warn(`[slack] secrets shortcut error: ${e.message}`);
      if (channelId && userId) await client.chat.postEphemeral({ channel: channelId, user: userId, text: e.message }).catch(() => {});
    }
  });

  const handleChannelSettingsAction = async ({ ack, body, action, client }) => {
    await ack();
    const clicker = body?.user?.id;
    const command = parseChannelSettingsActionValue(action?.value);
    const actionId = String(action?.action_id || "");
    try {
      if (command.o === "open") {
        if (!clicker || command.u !== clicker || !body?.trigger_id) throw new Error("This settings button isn't for you.");
        await openChannelSettings(client, body.trigger_id, {
          channelId: command.c,
          userId: clicker,
          threadTs: command.t || "",
        });
        return;
      }

      const isEditorAction = actionId === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID
        || actionId === CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID
        || actionId.startsWith(CHANNEL_SETTINGS_CLOUD_ENGINE_PREFIX)
        || actionId.startsWith(CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX)
        || actionId.startsWith(CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX)
        || actionId.startsWith(CHANNEL_SETTINGS_SKILL_TOGGLE_PREFIX)
        || actionId.startsWith(CHANNEL_SETTINGS_SKILL_PAGE_PREFIX);
      const state = isEditorAction
        ? parseEditorMetadata(body?.view?.private_metadata)
        : parseSettingsMetadata(body?.view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This channel settings view isn't yours. Open your own from a recent reply.");
      let { entry, meta, userIsAdmin } = await channelSettingsContext(client, {
        channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
        cloudMcp: actionId.startsWith("cg_channel_settings_cloud_"),
        accessSettings: actionId === ACCESS_EDIT_ACTION_ID || (command.o === "tab" && command.p === "access"),
      });
      const updateCurrent = (view) => client.views.update({
        view_id: body.view.id,
        ...(body.view.hash ? { hash: body.view.hash } : {}),
        view,
      });
      const requireTrigger = () => {
        if (!body?.trigger_id) throw new Error("Slack didn't provide a trigger for this editor. Reopen Settings and try again.");
        return body.trigger_id;
      };

      if (command.o === "tab") {
        const tab = String(command.p || "runtime");
        await updateCurrent(await settingsRootView(entry, meta, { ...state, tab }, userIsAdmin));
        return;
      }

      if (actionId === ACCESS_EDIT_ACTION_ID) {
        await client.views.push({
          trigger_id: requireTrigger(),
          view: buildAccessEditorView(meta, editorMetadata(state, { view: "access" })),
        });
        return;
      }

      if (actionId.startsWith(CHANNEL_SETTINGS_MODE_PREFIX) || actionId.startsWith(CHANNEL_SETTINGS_OPTION_PREFIX)) {
        if (!meta.isDM) throw new Error("Channel mode controls moved to Settings → Access. Reopen Settings.");
        let change;
        if (actionId.startsWith(CHANNEL_SETTINGS_MODE_PREFIX)) {
          change = { mode: actionId.slice(CHANNEL_SETTINGS_MODE_PREFIX.length) };
        } else {
          const key = { auto: "autoMode", lean: "cleanMode" }[actionId.slice(CHANNEL_SETTINGS_OPTION_PREFIX.length)];
          if (!key || typeof command.enabled !== "boolean") throw new Error("Invalid mode option.");
          change = { [key]: command.enabled };
        }
        meta = await patchAuditedChannelSettings(entry, clicker, (current) => {
          const baseline = effectiveMeta(current);
          const patch = modeSettingsPatch(baseline, change, { isAdminUser: userIsAdmin });
          // A DM following a template becomes custom when its own mode is edited.
          return current.isDM && ["user", "admin"].includes(current.template)
            ? { ...baseline, ...patch, template: "custom" }
            : patch;
        });
        await updateCurrent(await settingsRootView(entry, meta, state, userIsAdmin, { notice: "Mode updated. Applies to the next turn." }));
        return;
      }

      if (actionId === CHANNEL_SETTINGS_RUNTIME_EDIT_ACTION_ID) {
        const data = runtimeEditorData(meta);
        await client.views.push({
          trigger_id: requireTrigger(),
          view: buildRuntimeEditorView(data.snapshot.runtime, state, { channelName: entry.name, ...data }),
        });
        return;
      }

      if (actionId === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID || actionId === CHANNEL_SETTINGS_RUNTIME_MODEL_ACTION_ID) {
        const selected = String(action?.selected_option?.value || SETTINGS_DEFAULT_VALUE);
        const engineChoice = actionId === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID ? selected : state.engine;
        const modelChoice = actionId === CHANNEL_SETTINGS_RUNTIME_ENGINE_ACTION_ID ? SETTINGS_DEFAULT_VALUE : selected;
        const data = runtimeEditorData(meta, { engineChoice, modelChoice });
        await updateCurrent(buildRuntimeEditorView(data.snapshot.runtime, state, { channelName: entry.name, ...data }));
        return;
      }

      if (actionId === CHANNEL_SETTINGS_CONNECTIONS_EDIT_ACTION_ID) {
        await client.views.push({
          trigger_id: requireTrigger(),
          view: buildConnectionsEditorView(channelSettingsSnapshot(meta).connections, state, { channelName: entry.name }),
        });
        return;
      }

      if (actionId === CHANNEL_SETTINGS_FALLBACK_ACTION_ID) {
        meta = await patchAuditedChannelSettings(entry, clicker, { noDefaultTokens: !Boolean(command.enabled) });
        const notice = meta.noDefaultTokens
          ? "✅ Inherited organization/personal connection credentials are disabled for this channel."
          : "✅ Inherited connection credentials are enabled for this channel.";
        await updateCurrent(await settingsRootView(entry, meta, { ...state, tab: "mcp" }, userIsAdmin, { tab: "mcp", notice }));
        return;
      }

      if ([CHANNEL_SETTINGS_CLEAR_COMPOSIO_ACTION_ID, CHANNEL_SETTINGS_CLEAR_TOOLBOX_ACTION_ID, CHANNEL_SETTINGS_CLEAR_MAKE_ACTION_ID].includes(actionId)) {
        const patch = actionId === CHANNEL_SETTINGS_CLEAR_COMPOSIO_ACTION_ID
          ? { composioToken: "" }
          : actionId === CHANNEL_SETTINGS_CLEAR_TOOLBOX_ACTION_ID
            ? { toolboxToken: "" }
            : { makeToolboxUrl: "", makeToolboxKey: "" };
        meta = await patchAuditedChannelSettings(entry, clicker, patch);
        const connection = actionId === CHANNEL_SETTINGS_CLEAR_COMPOSIO_ACTION_ID ? "Composio token" : actionId === CHANNEL_SETTINGS_CLEAR_TOOLBOX_ACTION_ID ? "Toolbox token" : "Make MCP connection";
        await logEvent("channel_connection_removed", { channel: state.channelId, slug: entry.slug, connection, author: clicker });
        await updateCurrent(await settingsRootView(entry, meta, { ...state, tab: "mcp" }, userIsAdmin, { tab: "mcp", notice: `🗑️ Removed the channel's ${connection}.` }));
        return;
      }

      if (actionId === CHANNEL_SETTINGS_CLOUD_MANAGE_ACTION_ID) {
        const engine = meta.engine === "codex" ? "codex" : "claude";
        const loading = await client.views.push({
          trigger_id: requireTrigger(),
          view: buildCatalogManagerView([], state, { kind: "cloud", channelName: entry.name, engine, notice: "Loading the live MCP catalog…" }),
        });
        const loadingViewId = loading?.view?.id;
        if (!loadingViewId) throw new Error("Slack couldn't open the Cloud MCP manager. Reopen Settings and try again.");
        const items = await cloudManagerItems(meta, engine);
        await client.views.update({
          view_id: loadingViewId,
          view: buildCatalogManagerView(items, state, { kind: "cloud", channelName: entry.name, engine }),
        });
        return;
      }

      if (actionId.startsWith(CHANNEL_SETTINGS_CLOUD_ENGINE_PREFIX) || actionId.startsWith(CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX)) {
        const engine = command.e === "codex" ? "codex" : "claude";
        const page = actionId.startsWith(CHANNEL_SETTINGS_CLOUD_PAGE_PREFIX) ? Number(command.p) || 0 : 0;
        const items = await cloudManagerItems(meta, engine);
        await updateCurrent(buildCatalogManagerView(items, state, { kind: "cloud", channelName: entry.name, engine, page }));
        return;
      }

      if (actionId.startsWith(CHANNEL_SETTINGS_CLOUD_TOGGLE_PREFIX)) {
        const engine = command.e === "codex" ? "codex" : "claude";
        const field = selectionFieldForEngine(engine);
        const key = String(command.k || "");
        const activate = Boolean(command.a);
        let selection = null;
        if (activate) {
          const available = await requireAdapter(engine).discoverMcps();
          selection = available.find((item) => cloudSelectionKey(engine, item) === key);
          selection = persistedSelectionForEngine(engine, selection);
          if (!selection) throw new Error("That MCP capability is no longer available. Refresh the catalog and try again.");
        }
        meta = await patchAuditedChannelSettings(entry, clicker, (current) => {
          return { [field]: cloudSelectionsAfterToggle(current[field], engine, key, { activate, selection }) };
        });
        const items = await cloudManagerItems(meta, engine);
        const name = items.find((item) => item.key === key)?.name || key;
        await updateCurrent(buildCatalogManagerView(items, state, {
          kind: "cloud", channelName: entry.name, engine, page: state.page,
          notice: `${activate ? "✅ Activated" : "🗑️ Deactivated"} *${name}* for ${engineLabel(engine)}.`,
        }));
        return;
      }

      if (actionId === CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID || actionId.startsWith(CHANNEL_SETTINGS_SKILL_PAGE_PREFIX)) {
        const page = actionId.startsWith(CHANNEL_SETTINGS_SKILL_PAGE_PREFIX) ? Number(command.p) || 0 : 0;
        const items = skillManagerItems(meta, { userId: clicker, userIsAdmin });
        const view = buildCatalogManagerView(items, state, { kind: "skills", channelName: entry.name, page });
        if (actionId === CHANNEL_SETTINGS_SKILLS_MANAGE_ACTION_ID) await client.views.push({ trigger_id: requireTrigger(), view });
        else await updateCurrent(view);
        return;
      }

      if (actionId.startsWith(CHANNEL_SETTINGS_SKILL_TOGGLE_PREFIX)) {
        const key = String(command.k || "");
        const activate = Boolean(command.a);
        if (activate) {
          const skill = listSkills({ viewer: userIsAdmin ? "*" : clicker }).find((item) => item.slug.toLowerCase() === key.toLowerCase());
          const active = new Set(channelSkillGrants(meta).map((item) => item.toLowerCase()));
          if (!skill || skill.visibility === "personal" || !canSeeSkill(skill, { userId: clicker, isAdmin: userIsAdmin, active: active.has(skill.slug.toLowerCase()) })) {
            throw new Error("That skill is no longer available to this channel.");
          }
          await grantSkillsToChannel(entry.slug, [skill.slug]);
        } else {
          await revokeSkillsFromChannel(entry.slug, [key]);
        }
        meta = await getChannelMeta(entry.slug);
        await ensureChannelFolder(entry.slug, effectiveMeta(meta));
        await logEvent(activate ? "skill_granted" : "skill_revoked", { channel: state.channelId, slug: entry.slug, skills: [key], author: clicker });
        const items = skillManagerItems(meta, { userId: clicker, userIsAdmin });
        await updateCurrent(buildCatalogManagerView(items, state, {
          kind: "skills", channelName: entry.name, page: state.page,
          notice: `${activate ? "✅ Activated" : "🗑️ Deactivated"} *${key}*.`,
        }));
        return;
      }

      if (actionId === CHANNEL_SETTINGS_TEMPLATE_EDIT_ACTION_ID) {
        await client.views.push({
          trigger_id: requireTrigger(),
          view: buildTemplateEditorView(listTemplateSummaries(), meta.skillTemplate || "", state, { channelName: entry.name }),
        });
        return;
      }

      if (actionId === CHANNEL_SETTINGS_SECRETS_MANAGE_ACTION_ID) {
        const secretAccess = await secretsContext(client, {
          channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
        });
        if (!secretAccess.mayEdit) throw new Error("You can't change this channel's secrets in its current mode.");
        await client.views.push({
          trigger_id: requireTrigger(),
          view: buildSecretsView(listChannelEnv(meta), state, { channelName: entry.name, mayEdit: true }),
        });
        return;
      }

      throw new Error("This channel settings control expired. Open Settings again from a recent reply.");
    } catch (e) {
      console.warn(`[slack] channel settings error: ${e.message}`);
      if (body?.view?.id) {
        await client.views.update({
          view_id: body.view.id,
          ...(body.view.hash ? { hash: body.view.hash } : {}),
          view: buildChannelSettingsErrorView(e.message),
        }).catch(() => {});
      } else if ((body?.channel?.id || command?.c) && clicker) {
        await client.chat.postEphemeral(fileButtonNoticePayload(body, command, clicker, e.message)).catch(() => {});
      }
    }
  };
  app.action(CHANNEL_SETTINGS_ACTION_PATTERN, handleChannelSettingsAction);

  app.view(ACCESS_CALLBACK_ID, handleAccessSettingsSubmission);

  app.view(CHANNEL_SETTINGS_RUNTIME_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    let state;
    let form;
    try {
      state = parseEditorMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker || state.view !== "runtime") throw new Error("This runtime editor expired. Open Settings again.");
      form = readRuntimeForm(view);
    } catch (error) {
      await ack({ response_action: "errors", errors: { [RUNTIME_ENGINE_BLOCK_ID]: String(error.message).slice(0, 150) } });
      return;
    }
    try {
      const { entry, meta, userIsAdmin } = await channelSettingsContext(client, {
        channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
      });
      let resolved;
      try {
        resolved = runtimeSettingsPatch(form);
      } catch (error) {
        await ack({ response_action: "errors", errors: { [error.field || RUNTIME_ENGINE_BLOCK_ID]: String(error.message).slice(0, 150) } });
        return;
      }
      const { patch, actualEngine } = resolved;
      const { engine, model, effort } = patch;
      const saved = await patchAuditedChannelSettings(entry, clicker, patch);
      await logEvent("channel_runtime_updated", { channel: state.channelId, slug: entry.slug, engine: actualEngine, model: model || "default", effort: effort || "default", author: clicker });
      await ack({
        response_action: "update",
        view: await settingsRootView(entry, saved, { ...state, tab: "runtime" }, userIsAdmin, {
          tab: "runtime",
          notice: `✅ Runtime updated: *${engineLabel(actualEngine)}* · \`${model || getDefaultModel(actualEngine) || "engine default"}\` · \`${effort || "default effort"}\`.`,
        }),
      });
    } catch (error) {
      await ack({ response_action: "errors", errors: { [RUNTIME_ENGINE_BLOCK_ID]: String(error.message || "Couldn't update the runtime.").slice(0, 150) } });
    }
  });

  app.view(CHANNEL_SETTINGS_CONNECTIONS_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    let state;
    let form;
    try {
      state = parseEditorMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker || state.view !== "connections") throw new Error("This connection editor expired. Open Settings again.");
      form = readConnectionsForm(view);
    } catch (error) {
      await ack({ response_action: "errors", errors: { [CONNECTION_COMPOSIO_BLOCK_ID]: String(error.message).slice(0, 150) } });
      return;
    }
    try {
      const { entry, meta, userIsAdmin } = await channelSettingsContext(client, {
        channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
      });
      const resolved = connectionSettingsPatch(meta, form);
      if (Object.keys(resolved.errors).length) {
        await ack({ response_action: "errors", errors: resolved.errors });
        return;
      }
      const { patch, changed } = resolved;
      const saved = await patchAuditedChannelSettings(entry, clicker, patch);
      await logEvent("channel_connections_updated", { channel: state.channelId, slug: entry.slug, connections: changed, author: clicker });
      await ack({
        response_action: "update",
        view: await settingsRootView(entry, saved, { ...state, tab: "mcp" }, userIsAdmin, {
          tab: "mcp",
          notice: changed.length ? `✅ Updated connection settings: ${changed.join(", ")}.` : "No connection settings changed.",
        }),
      });
    } catch (error) {
      await ack({ response_action: "errors", errors: { [CONNECTION_COMPOSIO_BLOCK_ID]: String(error.message || "Couldn't update connection credentials.").slice(0, 150) } });
    }
  });

  app.view(CHANNEL_SETTINGS_TEMPLATE_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    let state;
    try {
      state = parseEditorMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker || state.view !== "template") throw new Error("This template editor expired. Open Settings again.");
      const { entry, meta, userIsAdmin } = await channelSettingsContext(client, {
        channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
      });
      const picked = readTemplateForm(view);
      const assigned = await assignTemplateToChannel(entry.slug, picked === SETTINGS_NONE_VALUE ? "" : picked);
      if (!assigned) throw new Error("That skill template is no longer available.");
      const saved = await getChannelMeta(entry.slug);
      await ensureChannelFolder(entry.slug, effectiveMeta(saved));
      await logEvent("skill_template_assigned", { channel: state.channelId, slug: entry.slug, template: assigned.template?.slug || "none", author: clicker });
      await ack({
        response_action: "update",
        view: await settingsRootView(entry, saved, { ...state, tab: "skills" }, userIsAdmin, {
          tab: "skills",
          notice: assigned.template ? `✅ This channel now follows the *${assigned.template.name}* skill template.` : "✅ The channel no longer follows a skill template.",
        }),
      });
    } catch (error) {
      await ack({ response_action: "errors", errors: { [TEMPLATE_BLOCK_ID]: String(error.message || "Couldn't update the template.").slice(0, 150) } });
    }
  });

  // Submitting the add/update form is the only moment a value exists in this process outside the
  // store. It is validated, written, and dropped — never put back into a view.
  app.view(SECRETS_FORM_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    let state;
    try {
      state = parseSecretsMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This secrets manager isn't yours. Open your own with `/secrets`.");
    } catch (e) {
      await ack({ response_action: "errors", errors: { [SECRETS_NAME_BLOCK_ID]: e.message.slice(0, 150) } });
      return;
    }
    const { name: typedName, value } = readSecretForm(view);
    // Validate each field against its own input so the error lands on the box that is wrong.
    // assertValidEnvName returns the CANONICAL (uppercase) name — use that from here on so the
    // stored key, the "added vs updated" check, the audit line and the confirmation all agree.
    const errors = {};
    let name = String(typedName || "").trim();
    try { name = assertValidEnvName(typedName); } catch (e) { errors[SECRETS_NAME_BLOCK_ID] = e.message.slice(0, 150); }
    try { assertValidEnvValue(value); } catch (e) { errors[SECRETS_VALUE_BLOCK_ID] = e.message.slice(0, 150); }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }
    try {
      const { entry, mayEdit } = await secretsContext(client, {
        channelId: state.channelId, userId: clicker, expectedSlug: state.slug, verifyMembership: true,
      });
      if (!mayEdit) throw new Error("You can't change this channel's secrets.");
      const existed = listChannelEnv(await getChannelMeta(entry.slug)).some((v) => v.name === name);
      const saved = await patchChannelMeta(entry.slug, (existing) => ({
        env: patchChannelEnv(existing?.env, { set: { name, value }, actor: `<@${clicker}>` }),
      }));
      await ensureChannelFolder(entry.slug, effectiveMeta(saved));
      await logEvent("channel_env_set", { slug: entry.slug, name, actor: clicker });
      // Replace the form with the refreshed (masked) list, so the writer sees the new last4 and
      // nothing else. A warm session started before this change is retired by its fingerprint.
      await ack({
        response_action: "update",
        view: buildSecretsView(listChannelEnv(saved), { ...state, editName: "" }, {
          channelName: entry.name,
          mayEdit,
          notice: `✅ ${existed ? "Updated" : "Added"} *${name}*. It reaches the next run in this channel.`,
        }),
      });
    } catch (e) {
      await ack({ response_action: "errors", errors: { [SECRETS_NAME_BLOCK_ID]: e.message.slice(0, 150) } });
    }
  });

  app.view("cg_channel_files_edit_modal", async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    const navigation = createFileFormNavigation({ ack, client, view });
    try {
      const state = parseExplorerMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This file editor isn't yours. Open your own with `/files`.");
      if (!state.editRelative || !state.editHash) throw new Error("This file editor expired. Reopen the file and try again.");
      const { entry, meta, userIsAdmin, root } = await fileExplorerContext(client, {
        channelId: state.channelId,
        userId: clicker,
        expectedSlug: state.slug,
        verifyMembership: true,
      });
      const mayEdit = canEditChannelFiles(effectiveMeta(meta), { isAdminUser: userIsAdmin });
      if (!mayEdit) throw new Error("Editing is no longer enabled in this channel mode.");
      const submittedContent = view?.state?.values?.file_content?.value?.value;
      const content = submittedContent == null ? "" : submittedContent;
      if (typeof content !== "string") throw new Error("Slack didn't return the edited file contents.");
      const saved = await writeEditableFile(root, state.editRelative, state.editHash, content);
      await logEvent("channel_file_edited", {
        channel: state.channelId,
        author: clicker,
        slug: entry.slug,
        file: saved.relative,
        bytes: saved.bytes.length,
      });
      await navigation.show(await buildFilePreviewView(root, state, saved.relative, filePreviewOptions({
        state,
        entry,
        mayEdit: true,
        notice: `✅ Saved ${path.basename(saved.relative)}.`,
      })));
    } catch (e) {
      console.warn(`[slack] file editor error: ${e.message}`);
      if (navigation.acknowledged) {
        await navigation.show(fileExplorerErrorView(e.message)).catch(() => {});
        return;
      }
      await ack({
        response_action: "errors",
        errors: { file_content: String(e.message || "Couldn't save this file.").slice(0, 500) },
      }).catch(() => {});
    }
  });
  app.view("cg_channel_files_new_file_modal", async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    const navigation = createFileFormNavigation({ ack, client, view });
    try {
      const state = parseExplorerMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This file dialog isn't yours. Open your own with `/files`.");
      const submittedName = view?.state?.values?.[FILES_NEW_FILE_NAME_BLOCK_ID]?.[FILES_NEW_FILE_NAME_INPUT_ACTION_ID]?.value;
      const submittedContent = view?.state?.values?.[FILES_NEW_FILE_CONTENT_BLOCK_ID]?.[FILES_NEW_FILE_CONTENT_INPUT_ACTION_ID]?.value;
      const fileName = normalizeNewFileName(submittedName);
      const initialContent = submittedContent == null ? "" : submittedContent;
      if (typeof initialContent !== "string") throw new Error("Slack didn't return the initial file contents.");

      const loadingEntry = await getChannelEntry(state.channelId);
      if (!loadingEntry || loadingEntry.slug !== state.slug) throw new Error("This channel file explorer expired. Open it again with `/files`.");
      await navigation.show(buildFilesLoadingView(state, { channelName: loadingEntry.name }));
      const { entry, meta, userIsAdmin, root } = await fileExplorerContext(client, {
        channelId: state.channelId,
        userId: clicker,
        expectedSlug: state.slug,
        verifyMembership: true,
      });
      const mayEdit = canEditChannelFiles(effectiveMeta(meta), { isAdminUser: userIsAdmin });
      if (!mayEdit) throw new Error("Creating files is no longer enabled in this channel mode.");
      const created = await createVisibleFile(root, state.relative, fileName, initialContent);
      await logEvent("channel_file_created", {
        channel: state.channelId,
        author: clicker,
        slug: entry.slug,
        file: created.relative,
        bytes: created.bytes.length,
      });
      await navigation.show(await buildFilePreviewView(root, state, created.relative, filePreviewOptions({
        state,
        entry,
        mayEdit: true,
        notice: `✅ Created ${created.name}.`,
      })));
    } catch (e) {
      console.warn(`[slack] file creation error: ${e.message}`);
      if (!navigation.acknowledged) {
        await ack({
          response_action: "errors",
          errors: { [FILES_NEW_FILE_NAME_BLOCK_ID]: String(e.message || "Couldn't create this file.").slice(0, 500) },
        }).catch(() => {});
        return;
      }
      await navigation.show(fileExplorerErrorView(e.message)).catch(() => {});
    }
  });
  app.view("cg_channel_files_new_folder_modal", async ({ ack, body, view, client }) => {
    const clicker = body?.user?.id;
    const navigation = createFileFormNavigation({ ack, client, view });
    try {
      const state = parseExplorerMetadata(view?.private_metadata);
      if (!clicker || state.ownerId !== clicker) throw new Error("This folder dialog isn't yours. Open your own with `/files`.");
      const submittedName = view?.state?.values?.[FILES_NEW_FOLDER_BLOCK_ID]?.[FILES_NEW_FOLDER_INPUT_ACTION_ID]?.value;
      const folderName = normalizeNewFolderName(submittedName);

      const loadingEntry = await getChannelEntry(state.channelId);
      if (!loadingEntry || loadingEntry.slug !== state.slug) throw new Error("This channel file explorer expired. Open it again with `/files`.");
      await navigation.show(buildFilesLoadingView(state, { channelName: loadingEntry.name }));
      const { entry, meta, userIsAdmin, root } = await fileExplorerContext(client, {
        channelId: state.channelId,
        userId: clicker,
        expectedSlug: state.slug,
        verifyMembership: true,
      });
      const mayEdit = canEditChannelFiles(effectiveMeta(meta), { isAdminUser: userIsAdmin });
      if (!mayEdit) throw new Error("Creating folders is no longer enabled in this channel mode.");
      const created = await createVisibleDirectory(root, state.relative, folderName);
      await logEvent("channel_folder_created", {
        channel: state.channelId,
        author: clicker,
        slug: entry.slug,
        folder: created.relative,
      });
      await navigation.show(await buildFilesView(root, { ...state, page: 0 }, fileExplorerViewOptions({
        state: { ...state, page: 0 },
        entry,
        mayEdit: true,
        notice: `✅ Created ${created.name}.`,
      })));
    } catch (e) {
      console.warn(`[slack] folder creation error: ${e.message}`);
      if (!navigation.acknowledged) {
        await ack({
          response_action: "errors",
          errors: { [FILES_NEW_FOLDER_BLOCK_ID]: String(e.message || "Couldn't create this folder.").slice(0, 500) },
        }).catch(() => {});
        return;
      }
      await navigation.show(fileExplorerErrorView(e.message)).catch(() => {});
    }
  });
  for (const a of APPROVAL_ACTIONS) app.action(a, handleApprovalClick);
  registerBusyThreadChoiceActions(app, processMessageEvent);
  registerEngineSwitchChoiceActions(app, processMessageEvent);
  // Indexed ids (`cg_model_pick_2`) are the per-choice buttons; the bare id is the retired
  // static_select, still clickable in Slack history. One pattern covers both.
  app.action(MODEL_PICKER_ACTION_PATTERN, handleModelWizard);
  app.action(EFFORT_PICKER_ACTION_PATTERN, handleModelWizard);
  app.action(MODEL_WIZARD_SCOPE_CHANNEL_ACTION, handleModelWizard);
  app.action(MODEL_WIZARD_SCOPE_THREAD_ACTION, handleModelWizard);
  app.action(/^cg_mw_engine_(?!reset$)[a-z0-9_-]+$/, handleModelWizard);
  app.action(MODEL_WIZARD_ENGINE_RESET_ACTION, handleModelWizard);
  // "← Back" on steps 2–4 and "Change again" on the done card — same handler, which reads the
  // destination step off the action_id.
  app.action(MODEL_WIZARD_BACK_ACTION_PATTERN, handleModelWizard);
  // The retired /engine dropdown may still sit in old Slack messages — ack it with a pointer
  // instead of leaving a dead control that errors in the client.
  app.action(ENGINE_PICKER_ACTION, async ({ ack, body, client }) => {
    await ack();
    const channel = body?.channel?.id || body?.container?.channel_id;
    const threadTs = body?.message?.thread_ts;
    if (!channel || !body?.user?.id) return;
    await client.chat
      .postEphemeral({ channel, user: body.user.id, ...(threadTs ? { thread_ts: threadTs } : {}), text: "This picker is from the retired `/engine` command — use `/model`, which now asks scope → harness → model → effort." })
      .catch(() => {});
  });
  app.view("cg_approval_comment_modal", handleApprovalCommentSubmit);

  // The 💻 "Resume in terminal" button → modal with the copyable command. The command lives in
  // the button's value (not the message text), so replies stay clean until someone needs it.
  app.action("resume_cmd_modal", async ({ ack, body, action, client }) => {
    await ack();
    let v = null;
    try {
      v = JSON.parse(action?.value || "");
    } catch {
      /* stale or foreign value — nothing to show */
    }
    const cmd = buildResumeCommand(v?.cwd, v?.sessionId, v?.engine);
    if (!cmd || !body?.trigger_id) return;
    await client.views
      .open({
        trigger_id: body.trigger_id,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Resume in terminal" },
          close: { type: "plain_text", text: "Close" },
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "Run this on the gateway machine to open this thread's session in your terminal:" } },
            { type: "section", text: { type: "mrkdwn", text: "```" + cmd + "```" } },
            { type: "context", elements: [{ type: "mrkdwn", text: "Paste the same line back as `/resume <command>` in this channel to continue that session from a Slack thread." }] },
          ],
        },
      })
      .catch((e) => console.warn("[slack] resume modal failed:", e.message));
  });

  // "Check status" button on a background job/agent's started message → ephemeral live status
  // (runtime + recent activity) for whoever clicked, without touching the thread for everyone.
  app.action("cg_bgjob_status", async ({ ack, body, action, client }) => {
    await ack();
    const channel = body?.channel?.id || body?.container?.channel_id;
    const userId = body?.user?.id;
    if (!channel || !userId) return;
    const threadTs = body?.message?.thread_ts;
    const inThread = threadTs ? { thread_ts: threadTs } : {};
    const jobId = String(action?.value || "");
    const st = getActiveBackgroundJobs?.()?.status(jobId);
    const fmtSpan = (ms) => (ms < 60_000 ? "under a minute" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${(ms / 86_400_000).toFixed(1)}d`);
    let text;
    if (!st) {
      // The in-memory record is deleted the moment the job finishes, but its log file survives —
      // keep the button useful after completion instead of a bare "not running".
      let tail = "";
      try {
        const entry = /^[a-f0-9-]{4,40}$/i.test(jobId) ? await getChannelEntry(channel) : null;
        if (entry) tail = readFileSync(path.join(gatewayRoot(), "logs", "bg", `${entry.slug}__${jobId}.log`), "utf8").trim().slice(-600);
      } catch {
        /* no log — fall through to the generic line */
      }
      text = tail
        ? `🏁 This job already finished — its result was posted in this thread.\nLast activity:\n\`\`\`${tail}\`\`\``
        : "This job is no longer running — it finished (or was interrupted). Its result is posted in this thread.";
    } else {
      const what = st.kind === "agent" ? "Background agent" : "Background job";
      // Last few activity lines only — enough to see it's alive, not a log dump.
      const recent = (st.tail || "").trim().split("\n").filter(Boolean).slice(-6).join("\n").slice(-600);
      // A finished job keeps its record until its continuation is actually delivered, so don't
      // report "still running" for work that is already done and only waiting on Slack.
      text =
        (st.finished
          ? `🏁 *${what}* \`${st.label}\` finished after ${fmtSpan(st.runtimeMs)} — I'm posting the follow-up in this thread now.`
          : `⏳ *${what}* \`${st.label}\` is still running — ${fmtSpan(st.runtimeMs)} elapsed (cap ${fmtSpan(st.maxMs)}).`) +
        (recent ? `\nRecent activity:\n\`\`\`${recent}\`\`\`` : "\nNo output yet.");
    }
    try {
      await client.chat.postEphemeral({ channel, user: userId, ...inThread, text });
    } catch (e) {
      // Ephemeral delivery can fail (scope/membership quirks). A dead-looking button is the bug —
      // fall back to a visible thread reply and log the real error instead of swallowing it.
      console.warn("[slack] bgjob status ephemeral failed:", e?.data?.error || e.message);
      if (threadTs) await client.chat.postMessage({ channel, thread_ts: threadTs, text: `<@${userId}> ${text}` }).catch(() => {});
    }
  });

  // Agent split-pane context changes are metadata only: no registration, authorization, Slack
  // reads, or engine work happens here. The inner event identifies the viewer; installation
  // authorizations are deliberately ignored, while empty/malformed contexts clear the viewer's
  // cached snapshot.
  app.event("app_context_changed", async ({ event, body }) => {
    const userId = appContextUserId(event, body, teamId);
    if (!userId) return;
    activeAppContexts.update({
      teamId,
      userId,
      context: event?.context,
      observedAt: appContextObservedAt(event, body),
    });
  });

  app.event("message", async ({ event: incoming, client, body }) => {
    let event = incoming;

    // Drop redelivered envelopes (Socket Mode retries on a delayed ack/reconnect) BEFORE any side
    // effect — a repeat would run the whole pipeline again: double tokens, duplicate replies.
    const eventKey = body?.event_id || `msg:${incoming.channel}:${incoming.event_ts || incoming.ts}:${incoming.subtype || ""}`;
    if (!seenEvents.add(eventKey)) return;

    // Slack attaches `app_context` to message.im when available; prefer that exact-turn snapshot.
    // The event-driven map is only a bounded fallback. Channel messages can never consume it.
    const activeViewContext = appContextForMessage(activeAppContexts, incoming, {
      teamId,
      observedAt: appContextObservedAt(incoming, body),
    });

    // Passive follow-up tracking: observe the raw inbound message (any author, mention or not)
    // before gating, so we can later tell each person which threads await their reply.
    observeForFollowups(incoming, botUserId).catch(() => {});

    // Edit-to-mention: if a message is edited to ADD an @mention it didn't have before, treat the
    // edited message as a fresh prompt. (Channels only — DMs already answer every message.)
    if (incoming.subtype === "message_changed") {
      const m = incoming.message || {};
      const prev = incoming.previous_message || {};
      if (incoming.channel_type === "im") return; // DMs don't need this
      if (m.bot_id || !m.user || m.user === botUserId) return;
      if (!mentionsBot(m.text, botUserId) || mentionsBot(prev.text, botUserId)) return; // only when newly added
      event = {
        channel: incoming.channel,
        channel_type: incoming.channel_type,
        user: m.user,
        text: m.text,
        ts: m.ts,
        thread_ts: m.thread_ts,
        files: m.files,
        blocks: m.blocks,
        attachments: m.attachments,
      };
    }

    await processMessageEvent(event, client, { botUserId, teamId, dedupeTrigger: true, activeViewContext });
  });

  // Some Slack installations deliver the mention envelope before a canonical `message` event, and
  // app_mention.files is optional. Let either envelope win; the message-level TTL above prevents a
  // double turn and canonical hydration supplies the complete file list.
  app.event("app_mention", async ({ event: incoming, client, body }) => {
    const eventKey = body?.event_id || `mention:${incoming.channel}:${incoming.event_ts || incoming.ts}`;
    if (!seenEvents.add(eventKey)) return;
    await processMessageEvent(incoming, client, { botUserId, teamId, dedupeTrigger: true });
  });

  // Agent (AI app) surface. The user's messages arrive as message.im and are handled above. We
  // offer top-of-Messages-tab suggested prompts (best-effort — no-ops without the agent feature),
  // derived from the channel's actual capabilities (its allowed MCP servers + enabled skills) so
  // the panel shows relevant starting points instead of two generic lines. Falls back to sensible
  // defaults when the channel has no specific capabilities.
  async function suggestedPromptsFor(channelId) {
    const prompts = [];
    try {
      const entry = channelId ? await getChannelEntry(channelId) : null;
      const meta = entry ? await getChannelMeta(entry.slug) : null;
      for (const m of (meta?.allowedMcps || []).slice(0, 3)) {
        const n = m.name;
        prompts.push({ title: `Use ${n}`, message: `Help me with a task using ${n}.` });
      }
      for (const s of (meta?.skills || []).slice(0, 2)) {
        prompts.push({ title: s.replace(/[-_]/g, " "), message: `Use the ${s} skill to help me.` });
      }
    } catch {
      /* fall through to defaults */
    }
    if (!prompts.length) {
      prompts.push(
        { title: "What can you do here?", message: "What can you help me with in this channel?" },
        { title: "Summarize a thread", message: "Summarize the latest discussion for me." }
      );
    }
    return prompts.slice(0, 4);
  }
  // In the Agent messaging experience the suggested prompts live at the TOP of the app's Messages
  // tab, not inside a thread — so thread_ts is no longer required (and there's no per-thread context
  // to bind to). We seed them from app_home_opened (tab="messages"), the event that replaces the
  // retired assistant_thread_started. thread_ts is kept optional purely so a legacy assistant_view
  // caller could still pass one; today nothing does.
  async function setSuggested(client, { channelId, threadTs } = {}) {
    if (!channelId) return;
    try {
      const params = {
        channel_id: channelId,
        title: "Ask ChannelGate",
        prompts: await suggestedPromptsFor(channelId),
      };
      if (threadTs) params.thread_ts = threadTs;
      await client.apiCall("assistant.threads.setSuggestedPrompts", params);
    } catch {
      /* agent/assistant feature not enabled / missing scope — ignore */
    }
  }
  // Note: assistant_thread_started / assistant_thread_context_changed are retired under agent_view.
  // Opening a DM now surfaces as app_home_opened with tab="messages" (handled below), and suggested
  // prompts are no longer per-thread, so those handlers are gone.

  // /stop slash command — sweeps EVERY in-flight run in this channel/DM. Slack does not include
  // thread_ts in slash-command payloads (Bolt's SlashCommand type has no such field), so /stop can
  // never be scoped to one thread — the in-thread paths are a plain `stop` message or a 🛑 reaction.
  // command.thread_ts is still forwarded defensively should Slack ever start sending it.
  app.command("/stop", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      const entry = await authorizedControlEntry(command.channel_id, command.user_id);
      const stopped = entry ? await stopRunsInChannel(client, command.channel_id, entry.slug, command.user_id, command.thread_ts ?? null) : 0;
      await respond({
        response_type: "ephemeral",
        text: stopped
          ? `🛑 Stopped ${stopped} run${stopped === 1 ? "" : "s"} in this channel.${stopped > 1 ? " _(To stop a single thread, send `stop` in that thread — mentioning me, unless it is a DM — or react 🛑.)_" : ""}`
          : "Nothing is running here right now.",
      });
    } catch (e) {
      console.error("[slack] /stop error:", e.message);
      await respond({ response_type: "ephemeral", text: "Couldn't stop — check the gateway logs." });
    }
  });

  // /status slash command — reports what the current channel is working on.
  app.command("/status", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      const entry = await authorizedControlEntry(command.channel_id, command.user_id);
      if (!entry) return respond({ response_type: "ephemeral", text: "This channel isn't registered with the gateway yet." });
      const report = await buildStatusReport(entry.slug, command.channel_id);
      await respond({ response_type: "ephemeral", text: report });
    } catch (e) {
      console.error("[slack] /status error:", e.message);
      await respond({ response_type: "ephemeral", text: "Couldn't build the status — check the gateway logs." });
    }
  });

  // Native Block Kit file browser. Slack slash commands only run at conversation top-level, so
  // this shares selected files into the channel; the message shortcut / `@bot /files` path carries
  // a thread_ts when users want the selected file posted inside a particular thread.
  app.command("/files", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      await openFileExplorer(client, command.trigger_id, {
        channelId: command.channel_id,
        userId: command.user_id,
        threadTs: command.thread_ts || "",
      });
    } catch (e) {
      console.error("[slack] /files error:", e.message);
      await respond({ response_type: "ephemeral", text: e.message || "Couldn't open this channel's files." });
    }
  });

  // Per-channel environment secrets. Lists what exists (names + last 4), and lets anyone who can
  // run commands here add or replace one. No path in or out of this modal reveals a value.
  app.command("/secrets", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      await openSecretsManager(client, command.trigger_id, {
        channelId: command.channel_id,
        userId: command.user_id,
        threadTs: command.thread_ts || "",
      });
    } catch (e) {
      console.error("[slack] /secrets error:", e.message);
      await respond({ response_type: "ephemeral", text: e.message || "Couldn't open this channel's secrets." });
    }
  });

  // The registered /model slash command opens the same wizard, as an ephemeral. Slack passes
  // thread_ts when the command is typed inside a thread, so the "just this thread" scope works
  // there too; at top level the scope step only offers the channel.
  app.command("/model", async ({ command, ack, respond, client }) => {
    await ack();
    try {
      const channelId = command.channel_id;
      const event = {
        channel: channelId,
        user: command.user_id,
        channel_type: syntheticChannelType(channelId),
      };
      const { meta } = await ensureRegistered(client, event);
      await ensureUserKnown(client, command.user_id);
      const userIsAdmin = await isAdmin(command.user_id);
      const userIsApproved = await isApproved(command.user_id);
      if (!isAuthorized(meta, command.user_id, Boolean(meta.isDM), { isAdminUser: userIsAdmin, isApprovedUser: userIsApproved })) {
        await respond({ response_type: "ephemeral", text: "You're not approved to change runtime settings here." });
        return;
      }
      if (!meta.isDM && !canChangeChannelRuntime(userIsAdmin)) {
        await respond({ response_type: "ephemeral", text: "Only admins can change the harness, model, or effort in a channel." });
        return;
      }
      const threadTs = command.thread_ts || "";
      await respond({ response_type: "ephemeral", text: MODEL_WIZARD_TEXT, blocks: modelWizardScopeBlocks({ threadTs, meta }) });
    } catch (e) {
      console.error("[slack] /model error:", e.message);
      await respond({ response_type: "ephemeral", text: "Couldn't open the model wizard — check the gateway logs." });
    }
  });

  // /engine and /effort are retired (folded into /model). The registrations stay so a Slack app
  // config that still lists them gets a pointer instead of a dispatch_failed error.
  const retiredCommand = (cmd) => async ({ ack, respond }) => {
    await ack();
    await respond({ response_type: "ephemeral", text: `\`${cmd}\` was removed — \`/model\` now does it all: scope (channel or just this thread) → harness (Claude/Codex) → model → effort.` });
  };
  app.command("/effort", retiredCommand("/effort"));
  app.command("/engine", retiredCommand("/engine"));

  // Reactions: a stop emoji (🛑 / ✋ / ❌ …) cancels the in-flight run; a configured "mention"
  // emoji (default 🤖) treats the reacted message as if the bot had been mentioned and runs it.
  app.event("reaction_added", async ({ event, client, body }) => {
    try {
      if (event.user === botUserId) return;
      // Same redelivery guard as the message handler (a repeat would re-run 🤖/stop/ack actions).
      const eventKey = body?.event_id || `rx:${event.event_ts}:${event.user}:${event.reaction}`;
      if (!seenEvents.add(eventKey)) return;
      const channelId = event.item?.channel;
      if (!channelId) return;

      // Reminder acknowledgment: a ✅ on a tracked reminder message resolves its escalation chain.
      // Checked BEFORE the follow-up branch below — both use ✅, but only a tracked reminder message
      // matches here, so this closes the ack first and returns rather than recording a follow-up.
      const ack = findAckByMessage(channelId, event.item?.ts);
      if (ack && event.reaction === ack.ackEmoji) {
        deleteAck(ack.id);
        await logEvent("ack_resolved", { id: ack.id, by: event.user });
        try {
          await client.chat.postMessage({ channel: channelId, thread_ts: ack.threadTs || event.item.ts, text: `✅ Acknowledged by <@${event.user}> — reminder closed.` });
        } catch {
          /* ignore */
        }
        return;
      }

      // ✅ on a thread marks it "done" for the reactor — clears it from their follow-up digest
      // until there's fresh activity. Reacting on the root or any reply resolves the whole thread.
      if (getFollowupDoneReactions().includes(event.reaction) && event.item?.type === "message") {
        // A scheduled DM digest is an aggregate snapshot: its ✅ dismisses every source thread
        // visibly listed in that exact message. Consume it before treating the DM itself as a
        // source thread.
        if (applyDigestDoneReaction(event.user, channelId, event.item.ts)) return;
        const res = await client.reactions.get({ channel: channelId, timestamp: event.item.ts, full: true }).catch(() => null);
        const threadTs = res?.message?.thread_ts ?? event.item.ts;
        markDone(event.user, channelId, threadTs);
        return;
      }

      if (STOP_REACTIONS.has(event.reaction)) {
        const entry = await authorizedControlEntry(channelId, event.user);
        if (!entry) return;
        // Scope the stop to the thread of the reacted message, not the whole channel. A reaction on
        // any message in a thread (root or reply) resolves to that thread's key; a reaction on a
        // top-level message uses its own ts.
        const res = await client.reactions.get({ channel: channelId, timestamp: event.item.ts, full: true }).catch(() => null);
        const threadKey = res?.message?.thread_ts ?? event.item.ts;
        await stopRunsInChannel(client, channelId, entry.slug, event.user, threadKey);
        return;
      }

      // Mention-by-reaction: react with a configured emoji (default robot_face) to have the bot act
      // on that message's content, as if the reactor had @mentioned it.
      if (getMentionReactions().includes(event.reaction) && event.item?.type === "message") {
        const res = await client.reactions.get({ channel: channelId, timestamp: event.item.ts, full: true }).catch(() => null);
        const msg = res?.message;
        if (!msg) return;
        if (msg.bot_id || msg.user === botUserId) return; // don't act on the bot's own messages

        // Multi-agent hygiene: with several Claude bots in a workspace, a 🤖 reaction must only
        // auto-engage THIS gateway for work it already owns. It acts on (a) DMs (1:1 with this bot),
        // (b) a brand-new top-level message not in any thread (starting fresh), or (c) a thread this
        // gateway already manages (a session exists or this bot authored the root). Inside a thread
        // another agent manages, the bare reaction is ignored — an explicit @mention is required.
        const isDM = String(channelId).startsWith("D");
        if (!isDM && msg.thread_ts) {
          const entry = await getChannelEntry(channelId);
          const sess = entry ? await getSessionMap(entry.slug) : {};
          const canEngage = await canEngageThreadByReaction(client, {
            channelId,
            threadTs: msg.thread_ts,
            botUserId,
            hasSession: Boolean(sess[msg.thread_ts]),
          });
          if (!canEngage) {
            console.log(`[slack] 🤖 in a thread this agent doesn't manage (${channelId}/${msg.thread_ts}) — ignoring; mention to engage`);
            return;
          }
        }
        const synthetic = {
          channel: channelId,
          channel_type: syntheticChannelType(channelId),
          user: event.user, // the reactor is the requester (authz + per-user tokens)
          text: msg.text || "",
          ts: msg.ts,
          thread_ts: msg.thread_ts, // reply in the reacted message's thread
          files: msg.files,
          blocks: msg.blocks,
          attachments: msg.attachments,
        };
        await processMessageEvent(synthetic, client, { botUserId, teamId, bypassMention: true });
      }
    } catch (e) {
      console.error("[slack] reaction_added error:", e.message);
    }
  });

  // Rendering the Home tab is its own function because the view is INTERACTIVE: connecting or
  // disconnecting a Composio key from Home changes the very connection lines it renders, so the
  // modal/button handlers re-publish through here.
  async function publishHomeTab(client, userId) {
    await ensureUserKnown(client, userId);
    const admin = await isAdmin(userId);
    const approved = await isApproved(userId);
    const role = admin ? "an *admin*" : approved ? "an *approved* user" : "*not yet approved* (an admin can approve you)";

    // Connection status distinguishes personal Composio from the shared org fallback. Only
    // ✅/⚪/❌ is ever rendered — never a token value. A channel token may replace the org source
    // during an actual channel run, but is not knowable from the global App Home.
    const [cTok, tTok] = await Promise.all([getComposioToken(userId), getToolboxToken(userId)]);
    const connLine = (label, mine, fallback, note) =>
      mine
        ? `✅ *${label}* — your account`
        : fallback
          ? `⚪ *${label}* — using the org default`
          : `❌ *${label}* — not connected${note ? ` (${note})` : ""}`;
    const composioMode = getComposioMode();
    const composioLines = composioMode === "sdk"
      ? (!hasComposioSdkEntitlement()
          ? ["❌ *Composio SDK (Enterprise · Beta)* — an active Enterprise license is required"]
          : getComposioSdkApiKey()
          ? [
              "✅ *Composio personal (`composio-user`)* — SDK (Enterprise · Beta) identity created for you at runtime",
              "✅ *Composio agent (`composio-agent`)* — SDK (Enterprise · Beta) identity created for each channel at runtime",
            ]
          : [
              "❌ *Composio personal (`composio-user`)* — SDK (Enterprise · Beta) mode is on, but its organization API key is missing",
              "❌ *Composio agent (`composio-agent`)* — SDK (Enterprise · Beta) mode is on, but its organization API key is missing",
            ])
      : [
          connLine("Composio personal (`composio-user`)", cTok, "", "connect it with the button below"),
          getDefaultComposioToken()
            ? "⚪ *Composio agent (`composio-agent`)* — organization default (a channel token takes precedence)"
            : "❌ *Composio agent (`composio-agent`)* — no organization default (a channel may still provide one)",
        ];
    const conns = [
      ...composioLines,
      connLine("Toolbox", tTok, getDefaultToolboxToken(), "admin tools"),
      "🛠 *Gateway control* — always on (schedules, channel admin, workdir)",
    ].join("\n");

    // Your skills: the personal tier of the grant union (skills only your own runs carry) plus the
    // organization tier everyone gets. Channel grants are per conversation and not knowable here.
    const homeUser = (await getUsers())[userId] || {};
    const personalSkills = Array.isArray(homeUser.skills) ? homeUser.skills : [];
    const orgSkills = Array.isArray(getOrgAccessGrants().skills) ? getOrgAccessGrants().skills : [];
    let favLines = personalSkills.length
      ? personalSkills.slice(0, 8).map((s) => `• *${s}*`).join("\n") + (personalSkills.length > 8 ? `\n_+ ${personalSkills.length - 8} more_` : "")
      : "_No personal skills yet — ask me \"add the X skill for me\" in any thread, or browse the catalog with \"list skills\"._";
    if (orgSkills.length) favLines += `\n_Organization-wide: ${orgSkills.length} skill(s) every conversation gets._`;

    // In-thread commands + the active engine / how to switch models.
    const commands = "`/help` · `/status` · `/files` · `/clear` · `/context` · `/mode` · `/model` · `/compact` · `/stop` · `/update` _(admin)_";
    const engineInfo =
      `• Default engine: *${getEngine()}* · context window ~${Math.round(getContextWindow() / 1000)}k tokens\n` +
      "• Switch runtime: `/model` — channel or one thread → harness (Claude/Codex) → model → effort _(channel access set in Settings)_";

    const all = await listChannels();
    const channels = all.filter((c) => !c.isDM && c.type !== "im");
    const authorized = channels.filter((c) => admin || approved || (c.meta?.allowedUsers || []).includes(userId));
    // Private channels appear only to their actual Slack members (see homeVisibleChannels) and
    // the header count reflects what THIS viewer sees — not the gateway's full roster. Only
    // HOME_CHANNEL_LIST_MAX lines are rendered, so stop probing membership one past that: the
    // extra entry is what distinguishes an exact count from the "25+" label, and everything
    // beyond it would be a conversations.members call whose answer is never displayed.
    const visible = await homeVisibleChannels(client, authorized, userId, { limit: HOME_CHANNEL_LIST_MAX + 1 });
    const moreThanShown = visible.length > HOME_CHANNEL_LIST_MAX;
    const visibleCount = moreThanShown ? `${HOME_CHANNEL_LIST_MAX}+` : String(visible.length);
    const mineList = visible
      .slice(0, HOME_CHANNEL_LIST_MAX)
      .map((c) => {
        const eng = c.meta?.engine ? ` · ${c.meta.engine}` : "";
        return `• *${c.name}* — ${modeLabel(c.meta || {})}${eng}`;
      })
      .join("\n");
    const port = process.env.PORT || 4747;

    const blocks = [
      { type: "header", text: { type: "plain_text", text: "ChannelGate", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `Hi <@${userId}> — you're ${role} on this gateway.` } },
      { type: "section", text: { type: "mrkdwn", text: "I'm Claude, running self-hosted in per-channel sandboxes. *DM me* (no mention needed) or *@mention me* in a channel. Use `/status` to see what a channel is working on, `/pending` for the threads I'm waiting on you for, or `/help` for all commands." } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Your connections* — the MCP tools you get when you run me\n${conns}` } },
      // Personal Composio key, set from a modal — the value never becomes a Slack message. Absent
      // in SDK mode, where the identity is minted per user at run time and there is nothing to set.
      ...composioHomeButtons({ hasToken: Boolean(cTok), enabled: composioMode !== "sdk" }),
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Your skills*\n${favLines}` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Commands* (type in a thread)\n${commands}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Engine & models*\n${engineInfo}` } },
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Channels I work in* (${visibleCount})\n${mineList || "_None yet — add me to a channel and @mention me._"}` } },
    ];
    const footer = [`ChannelGate v${GATEWAY_VERSION}`, `engine: ${getEngine()}`];
    if (admin) footer.push(`⚙️ Admin UI: http://localhost:${port}`);
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.join("  ·  ") }] });
    await client.views.publish({ user_id: userId, view: { type: "home", blocks } });
  }

  // App Home tab: an orientation dashboard — the viewer's access level, the channels the
  // bot manages, and a link to the admin UI. Never shows tokens or secrets.
  app.event("app_home_opened", async ({ event, client, body }) => {
    try {
      // Agent messaging experience: opening the Messages tab (a DM with the bot) is the signal that
      // replaces assistant_thread_started. Seed the top-of-tab suggested prompts and stop — there's
      // no Home view to publish for the Messages tab.
      if (event.tab === "messages") {
        // Slack calls this field `context` on app_home_opened. An omitted/empty value means there is
        // no active split view, so record a tombstone instead of retaining stale channel metadata.
        activeAppContexts.update({
          teamId,
          userId: event.user,
          context: Object.prototype.hasOwnProperty.call(event, "context") ? event.context : {},
          observedAt: appContextObservedAt(event, body),
        });
        await setSuggested(client, { channelId: event.channel });
        return;
      }
      if (event.tab && event.tab !== "home") return;
      await publishHomeTab(client, event.user);
    } catch (e) {
      console.error("[slack] app_home_opened error:", e.message);
    }
  });

  registerComposioHomeActions(app, { publishHome: publishHomeTab });

  // Removing a ✅ re-opens that thread in the reactor's follow-up digest (the inverse of marking
  // it done). Other removed reactions are acknowledged as no-ops.
  app.event("reaction_removed", async ({ event, client }) => {
    try {
      if (event.user === botUserId) return;
      const channelId = event.item?.channel;
      if (!channelId || event.item?.type !== "message") return;
      if (!getFollowupDoneReactions().includes(event.reaction)) return;
      // Reopen only done markers still owned by this digest reaction; a newer direct source-thread
      // dismissal survives. Unknown messages fall through to the existing direct-thread behavior.
      if (removeDigestDoneReaction(event.user, channelId, event.item.ts)) return;
      const res = await client.reactions.get({ channel: channelId, timestamp: event.item.ts, full: true }).catch(() => null);
      const threadTs = res?.message?.thread_ts ?? event.item.ts;
      clearDone(event.user, channelId, threadTs);
    } catch (e) {
      console.error("[slack] reaction_removed error:", e.message);
    }
  });
  app.event("member_left_channel", async ({ event }) => {
    try {
      if (await handleMemberLeftChannel(event)) {
        console.log(`[slack] removed departed member ${event.user} from ${event.channel} guest access`);
      }
    } catch (e) {
      console.error("[slack] member_left_channel error:", e.message);
    }
  });

  // Slack's "mention a bot that isn't in the channel → invite it" flow drops the original message:
  // the "@bot alive?" that triggered the invite was posted BEFORE we were a member, so it never
  // arrived as a `message` event and would otherwise go unanswered. On join we scan the channel's
  // very recent history for that pending @mention and answer it (once, the most recent one) so a
  // tag that pulls the bot into a channel gets a reply. Bounded by a short window so a later re-join
  // never resurrects an old mention, and skipped if we already own that thread (a session exists).
  const JOIN_PENDING_MENTION_WINDOW_MS = 15 * 60 * 1000;
  async function answerPendingJoinMention(client, channelId) {
    try {
      const oldest = String((Date.now() - JOIN_PENDING_MENTION_WINDOW_MS) / 1000);
      const r = await client.conversations.history({ channel: channelId, oldest, limit: 20 });
      // history is newest-first — the first real message that @mentions us is the one to answer.
      const target = (r.messages ?? []).find(
        (m) =>
          m.type === "message" &&
          !m.bot_id &&
          m.user &&
          m.user !== botUserId &&
          [undefined, "file_share", "thread_broadcast"].includes(m.subtype) &&
          mentionsBot(m.text, botUserId)
      );
      if (!target) return;
      // Don't re-answer a thread we already engaged (guards a leave/re-join within the window).
      const entry = await getChannelEntry(channelId);
      if (entry) {
        const sess = await getSessionMap(entry.slug).catch(() => ({}));
        if (sess[target.thread_ts ?? target.ts]) return;
      }
      console.log(`[slack] answering pending @mention on join in ${channelId} (ts ${target.ts})`);
      await processMessageEvent(
        {
          channel: channelId,
          channel_type: syntheticChannelType(channelId),
          user: target.user,
          text: target.text || "",
          ts: target.ts,
          thread_ts: target.thread_ts,
          files: target.files,
          blocks: target.blocks,
          attachments: target.attachments,
        },
        client,
        { botUserId, teamId, bypassMention: true }
      );
    } catch (e) {
      console.error("[slack] pending join-mention scan failed:", e.message);
    }
  }

  // When the bot is added to a channel, seed that channel's allowedUsers with its current
  // MakeItFuture members. When a MIF member later joins, add just them. Non-MIF members are
  // never added (only approved users on the MakeItFuture list).
  app.event("member_joined_channel", async ({ event, client }) => {
    try {
      if (event.user === botUserId) {
        // The bot joining is the canonical "join" moment — capture the org default access policy.
        const info = await resolveConversation(client, { channel: event.channel, channel_type: event.channel_type });
        const entry = await upsertChannelEntry(event.channel, info);
        // One transactional patch, not read-modify-write: this branch fires on every reconnect/
        // rejoin and used to race concurrent admin edits, clobbering them with a stale copy.
        // Join-time defaults apply ONLY when the channel has no meta yet.
        const meta = await patchChannelMeta(entry.slug, (current) => {
          if (current) return {};
          const fresh = applyChannelTemplate(defaultChannelMeta({ channelId: event.channel, ...info }));
          if (!fresh.isDM) fresh.access = getDefaultChannelAccess();
          fresh.nudges = getDefaultNudges(); // capture the org-default nudge at join
          return fresh;
        });
        await ensureChannelFolder(entry.slug, meta);
        await syncAllowedFromMembers(client, event.channel, entry.slug, meta);
        // If a tag pulled us in (Slack's invite-on-mention), answer that pending message.
        await answerPendingJoinMention(client, event.channel);
      } else {
        const entry = await getChannelEntry(event.channel);
        if (!entry) return;
        const users = await getUsers();
        if (!users[event.user]?.approved) return; // only MakeItFuture users
        const meta = await getChannelMeta(entry.slug);
        if (!meta || (meta.allowedUsers || []).includes(event.user)) return;
        if ((meta.access || "approved") !== "approved") return; // restrictive channel — don't auto-add
        const next = await patchChannelMeta(entry.slug, (current) => ({
          allowedUsers: [...new Set([...(current?.allowedUsers || []), event.user])],
        }));
        await ensureChannelFolder(entry.slug, next);
        console.log(`[slack] ${entry.slug}: added joining MakeItFuture member ${event.user}`);
      }
    } catch (e) {
      console.error("[slack] member_joined_channel error:", e.message);
    }
  });

  await app.start();
  console.log("[slack] Socket Mode gateway running.");

  // Candidate and rollback boots are not final outcomes. Keep watching the durable transaction
  // and report only once it reaches a matching terminal result.
  startUpdateConfirmationWatcher(app.client);

  return { app, botUserId, user: auth.user, team: auth.team, teamId };
}

let updateConfirmationTimer = null;
function startUpdateConfirmationWatcher(client) {
  if (updateConfirmationTimer) clearTimeout(updateConfirmationTimer);
  const poll = async () => {
    let delay = 2_000;
    try {
      const ready = readTerminalUpdateMarker();
      if (ready) {
        await client.chat.postMessage({
          channel: ready.marker.channelId,
          thread_ts: ready.marker.threadTs,
          client_msg_id: ready.marker.transactionId,
          text: formatUpdateResult(ready.transaction),
        });
        clearUpdateMarker(ready.marker.transactionId);
      }
    } catch (error) {
      delay = 5_000;
      console.warn(`[slack] update confirmation failed; will retry: ${error.message}`);
    }
    updateConfirmationTimer = setTimeout(poll, delay);
    updateConfirmationTimer.unref?.();
  };
  poll();
}
