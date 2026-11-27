// The Slack half of code channels: the `agents.conversations.*` and `agents.sessions.*` calls that
// create a code channel, keep its context bar and artifact tabs current, and archive it. Every call
// uses the workspace BOT token (Slack accepts no other token type here) and is pinned to the code
// channel id the gateway registered — never an arbitrary id from the model. The daemon-side
// orchestration (what a code channel is to the gateway) is src/gateway/code-channels.js.
import path from "node:path";
import { resolveSlackConfig } from "../config/settings.js";
import { upsertChannelEntry, getChannelMeta, saveChannelMeta, patchChannelMeta } from "../config/store.js";
import { ensureChannelFolder } from "../gateway/folders.js";
import { logEvent } from "../util/logger.js";
import {
  CODE_CHANNEL_VIEW_MAX_BYTES, computeCodeChannelDiff, decideCodeChannelMode, describeRepository,
  inheritedCodeChannelMeta, isCodeChannelMeta, prepareCodeChannelWorktree, sanitizeTask,
} from "../gateway/code-channels.js";

const API = "https://slack.com/api";
export const CONTEXT_BAR_ICONS = Object.freeze(["branch", "folder", "hierarchy", "life-ring", "link", "globe", "terminal", "code", "search", "lock"]);
export const CODE_CHANNEL_VIEW_TYPES = Object.freeze(["html", "block_kit", "canvas", "pull_request", "diff"]);
const MAX_CONTEXT_ITEMS = 5;
const MAX_VIEWS = 5;

// JSON POST to a Slack Web API method with the bot token. Throws a plain Error whose `.code` is
// Slack's error string, so callers can map the few codes that mean "this workspace can't".
export async function slackApi(method, payload = {}) {
  const token = resolveSlackConfig().botToken || "";
  if (!token) throw Object.assign(new Error("Slack bot token isn't configured — an admin must set it in the gateway Settings."), { code: "not_configured" });
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw Object.assign(new Error(describeCodeChannelError(data.error, method)), { code: data.error || `http_${res.status}`, warnings: data.warnings });
  return data;
}

// What a Slack refusal means to a person, with the remedy where there is one.
export function describeCodeChannelError(code, method = "") {
  const table = {
    feature_disabled: "Slack Code is not enabled for this app or workspace yet (Slack answered feature_disabled). The app must be recognised as an agent-session app and the workspace must have code channels enabled; ask the workspace owner, then try again.",
    user_not_enabled: "the requester does not have Slack's code channels feature enabled on their account (user_not_enabled).",
    restricted_action: "the workspace does not allow this bot to create or archive channels (restricted_action) — a Slack admin must allow it.",
    missing_scope: "the Slack app is missing the code_channels:manage scope — paste the updated slack-app-manifest.json into the app and reinstall it.",
    origin_channel_externally_shared: "a code channel cannot be opened from a Slack Connect channel, a DM or a group DM.",
    invalid_origin_link: "Slack could not find the message this request started from.",
    not_agent_channel: "this is not a code channel.",
    not_authorized: "this bot is not the agent assigned to that code channel.",
    too_many_views: "the channel already has five artifact tabs (or already has a diff tab).",
    content_too_large: `the content is larger than Slack accepts (${CODE_CHANNEL_VIEW_MAX_BYTES} bytes).`,
    already_archived: "the channel is already archived.",
    invalid_pr_url: "that is not a valid https pull-request URL.",
    invalid_blocks: "Slack rejected the Block Kit blocks.",
    canvas_not_found: "that canvas is not accessible to the bot.",
    thread_ts_not_allowed: "a code channel has one session for the whole channel; no thread timestamp applies.",
    ratelimited: "Slack rate-limited the request; try again in a moment.",
  };
  return table[code] || `Slack ${method || "API"} failed: ${code || "unknown_error"}`;
}

export function isCodeChannelEligibilityError(code) {
  return ["feature_disabled", "user_not_enabled", "restricted_action", "missing_scope"].includes(String(code || ""));
}

// ── Low-level calls, each pinned to one channel id ──────────────────────────────────────────

export async function createCodeChannel({ name, originChannelId, originMessageTs, sessionId, isPrivate }, { api = slackApi } = {}) {
  const payload = { session_id: sessionId };
  if (name) payload.name = name;
  if (originChannelId && originMessageTs) { payload.origin_channel_id = originChannelId; payload.origin_message_ts = originMessageTs; }
  if (typeof isPrivate === "boolean") payload.is_private = isPrivate;
  const data = await api("agents.conversations.create", payload);
  return String(data.channel_id || data.channel?.id || "");
}

export async function conversationInfo(channelId, { api = slackApi } = {}) {
  const data = await api("conversations.info", { channel: channelId });
  const c = data.channel || {};
  return { name: c.name ? `#${c.name}` : channelId, isPrivate: c.is_private === true, isCodeChannel: c.properties?.record_channel?.record_type === "agent_channel", properties: c.properties || {} };
}

// Code channel sessions are addressed by channel id alone (thread_ts is refused there).
export async function setCodeChannelStatus(channelId, status, { title = "", username = "" } = {}, { api = slackApi } = {}) {
  const payload = { channel_id: channelId, status };
  if (title) payload.title = title.slice(0, 200);
  if (username) payload.username = username.slice(0, 200);
  return api("agents.sessions.setStatus", payload);
}

export async function renameCodeChannel(channelId, title, { api = slackApi } = {}) {
  return api("agents.sessions.rename", { channel_id: channelId, title: String(title || "").trim().slice(0, 200) });
}

export function normalizeContextItems(items = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const key = String(raw?.key || "").trim().slice(0, 64);
    const label = String(raw?.label || "").replace(/\s+/g, " ").trim().slice(0, 128);
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const item = { key, label };
    if (CONTEXT_BAR_ICONS.includes(raw?.icon)) item.icon = raw.icon;
    const url = String(raw?.url || "").trim();
    if (/^https:\/\/\S+$/i.test(url) && url.length <= 2048) item.url = url;
    out.push(item);
    if (out.length >= MAX_CONTEXT_ITEMS) break;
  }
  return out;
}

export async function setCodeChannelContext(channelId, items, { api = slackApi } = {}) {
  return api("agents.conversations.setProperties", { channel_id: channelId, code_channel: { context_bar_items: normalizeContextItems(items) } });
}

/**
 * Upsert one artifact tab. `view` is { type, key, name, content, blocks, canvas_id, pr_url,
 * base_branch, head_branch }. Validates shape and size before Slack sees it.
 */
export async function setCodeChannelView(channelId, view = {}, { api = slackApi } = {}) {
  const type = String(view.type || "html");
  if (!CODE_CHANNEL_VIEW_TYPES.includes(type)) throw new Error(`Unknown view type "${type}". Use one of ${CODE_CHANNEL_VIEW_TYPES.join(", ")}.`);
  const payload = { channel_id: channelId, type };
  const key = String(view.key || view.view_key || "").trim().slice(0, 255);
  const name = String(view.name || "").trim().slice(0, 80);
  if (name) payload.name = name;
  if (type === "html" || type === "diff") {
    const content = String(view.content ?? "");
    if (!content.trim()) throw new Error(`A ${type} view needs non-empty content.`);
    if (Buffer.byteLength(content, "utf8") > CODE_CHANNEL_VIEW_MAX_BYTES) throw new Error(describeCodeChannelError("content_too_large"));
    payload.content = content;
    if (type === "html") {
      if (!key) throw new Error("An html view needs a stable `key` (a file name such as preview.html).");
      payload.view_key = key;
    } else {
      if (view.base_branch) payload.base_branch = String(view.base_branch).slice(0, 120);
      if (view.head_branch) payload.head_branch = String(view.head_branch).slice(0, 120);
    }
  } else if (type === "block_kit") {
    if (!key) throw new Error("A block_kit view needs a stable `key`.");
    if (!Array.isArray(view.blocks) || !view.blocks.length || view.blocks.length > 50) throw new Error("A block_kit view needs 1–50 blocks.");
    payload.view_key = key;
    payload.blocks = view.blocks;
  } else if (type === "canvas") {
    if (!key) throw new Error("A canvas view needs a stable `key`.");
    if (!/^F[A-Z0-9]+$/.test(String(view.canvas_id || ""))) throw new Error("A canvas view needs the canvas's F… id.");
    payload.view_key = key;
    payload.canvas_id = view.canvas_id;
    if (["read", "write", "comment"].includes(view.access_level)) payload.access_level = view.access_level;
  } else if (type === "pull_request") {
    const url = String(view.pr_url || view.url || "").trim();
    if (!/^https:\/\/\S+\/pull\/\d+|^https:\/\/\S+\/merge_requests\/\d+|^https:\/\/\S+\/pull-requests\/\d+/i.test(url)) throw new Error(describeCodeChannelError("invalid_pr_url"));
    payload.pr_url = url;
  }
  return api("agents.conversations.setView", payload);
}

export async function listCodeChannelViews(channelId, { api = slackApi } = {}) {
  const data = await api("agents.conversations.listViews", { channel_id: channelId });
  return Array.isArray(data.views) ? data.views : [];
}

export async function archiveCodeChannelApi(channelId, summaryMessageTs = "", { api = slackApi } = {}) {
  const payload = { channel_id: channelId };
  if (summaryMessageTs) payload.summary_message_ts = summaryMessageTs;
  return api("agents.conversations.archive", payload);
}

export async function postCodeChannelMessage(channelId, text, { blocks = null, api = slackApi } = {}) {
  const payload = { channel: channelId, text: String(text || "").slice(0, 3900) };
  if (blocks) payload.blocks = blocks;
  const data = await api("chat.postMessage", payload);
  return String(data.ts || "");
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────

// The context bar a fresh code channel gets: the folder, the task branch, the repository.
export async function defaultContextItems(cc, originDir) {
  const items = [{ key: "folder", label: path.basename(originDir || "") || "workspace", icon: "folder" }];
  if (cc?.mode === "worktree" && cc.branch) items.push({ key: "branch", label: cc.branch, icon: "branch" });
  if (cc?.mode === "worktree") {
    const repo = await describeRepository(originDir);
    if (repo.url) items.push({ key: "repo", label: repo.label, icon: "code", url: repo.url });
  }
  return items;
}

/**
 * Open a code channel for a task: create it in Slack (origin-linked, so its members may join and
 * Slack names it after the request when no name is given), register it as a CHILD of the origin
 * conversation, create the task worktree when the origin folder is a repository, mark the session
 * active, and pin the context bar. Returns what the approval card and the kickoff need.
 */
export async function openCodeChannel({
  originChannelId, originSlug, originEntry, originMeta, originDir, originThreadTs, originMessageTs,
  requesterId, name = "", task = "", mode = "auto", isPrivate, teamId = "",
}, { api = slackApi } = {}) {
  const sessionId = `cgcc:${originChannelId}:${originThreadTs || originMessageTs || Date.now()}`;
  const decision = decideCodeChannelMode(originDir, mode);
  const channelId = await createCodeChannel({
    name: String(name || "").trim().slice(0, 80),
    originChannelId,
    originMessageTs: originMessageTs || originThreadTs,
    sessionId,
    isPrivate,
  }, { api });
  let info;
  try {
    info = await conversationInfo(channelId, { api });
  } catch {
    info = { name: name ? `#${name}` : channelId, isPrivate: Boolean(isPrivate) };
  }
  const entry = await upsertChannelEntry(channelId, { name: info.name, type: info.isPrivate ? "group" : "channel", isDM: false, platform: "slack" });
  let worktree = { ok: false, error: "" };
  if (decision.mode === "worktree") worktree = await prepareCodeChannelWorktree({ root: originDir, slug: entry.slug });
  const cc = {
    originChannelId,
    originSlug,
    originThreadTs: originThreadTs || "",
    originMessageTs: originMessageTs || originThreadTs || "",
    sessionId,
    createdBy: requesterId,
    createdAt: new Date().toISOString(),
    teamId: teamId || "",
    task: sanitizeTask(task),
    mode: decision.mode,
    worktree: worktree.ok ? worktree.worktree : "",
    branch: worktree.ok ? worktree.branch : "",
    baseRef: worktree.ok ? worktree.baseRef : "",
    worktreeError: decision.mode === "worktree" && !worktree.ok ? String(worktree.error || "").slice(0, 300) : "",
    archivedAt: "",
  };
  const existing = await getChannelMeta(entry.slug);
  const meta = inheritedCodeChannelMeta(originMeta, {
    channelId, name: entry.name, type: entry.type, platform: "slack", codeChannel: { ...(existing?.codeChannel || {}), ...cc },
  });
  await saveChannelMeta(entry.slug, meta);
  await ensureChannelFolder(entry.slug, meta);
  const items = await defaultContextItems(cc, originDir);
  await Promise.allSettled([
    setCodeChannelStatus(channelId, "active", { title: name || cc.task.slice(0, 120) }, { api }),
    setCodeChannelContext(channelId, items, { api }),
  ]);
  void logEvent("code_channel_opened", { channel: originChannelId, author: requesterId, slug: originSlug, codeChannel: channelId, codeSlug: entry.slug, mode: cc.mode, branch: cc.branch, worktreeOk: worktree.ok });
  return { channelId, slug: entry.slug, name: entry.name, meta, mode: cc.mode, branch: cc.branch, worktree: cc.worktree, worktreeError: cc.worktreeError, note: decision.note || "" };
}

// The last diff each code channel published, so an unchanged tree is not re-sent every turn.
const publishedDiffs = new Map();

/**
 * Publish the task worktree's current diff to the channel's Code tab (upserted; Slack keeps one
 * diff view per channel). Quiet when nothing changed or the channel works in place.
 */
export async function refreshCodeChannelDiff(meta, { api = slackApi, force = false } = {}) {
  if (!isCodeChannelMeta(meta) || meta.codeChannel.mode !== "worktree" || !meta.codeChannel.worktree || meta.codeChannel.archivedAt) return { ok: false, skipped: true };
  const cc = meta.codeChannel;
  const result = await computeCodeChannelDiff({ worktree: cc.worktree, baseRef: cc.baseRef || "HEAD", branch: cc.branch });
  if (!result.ok) return result;
  if (!result.diff.trim()) return { ok: true, skipped: true, empty: true };
  const fingerprint = `${result.diff.length}:${hash(result.diff)}`;
  if (!force && publishedDiffs.get(meta.channelId) === fingerprint) return { ok: true, skipped: true, unchanged: true };
  try {
    await setCodeChannelView(meta.channelId, { type: "diff", content: result.diff, base_branch: result.base, head_branch: result.head }, { api });
    publishedDiffs.set(meta.channelId, fingerprint);
    return { ok: true, files: result.files };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code };
  }
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Archive a code channel: post the wrap-up (when given) so Slack can share it back into the origin
 * thread, close the session, archive, and record it on the channel's meta. The worktree stays on
 * disk — its branch may hold unmerged commits.
 */
export async function archiveCodeChannel({ slug, meta, summary = "" }, { api = slackApi } = {}) {
  if (!isCodeChannelMeta(meta)) throw new Error(describeCodeChannelError("not_agent_channel"));
  const channelId = meta.channelId;
  let summaryTs = "";
  if (String(summary || "").trim()) summaryTs = await postCodeChannelMessage(channelId, summary, { api });
  await setCodeChannelStatus(channelId, "closed", {}, { api }).catch(() => {});
  await archiveCodeChannelApi(channelId, summaryTs, { api });
  await patchChannelMeta(slug, (current) => current ? { codeChannel: { ...(current.codeChannel || {}), archivedAt: new Date().toISOString() } } : null);
  publishedDiffs.delete(channelId);
  void logEvent("code_channel_archived", { channel: meta.codeChannel.originChannelId, codeChannel: channelId, slug, summary: Boolean(summaryTs) });
  return { ok: true, channelId, summaryTs };
}

export function __resetCodeChannelState() {
  publishedDiffs.clear();
}

export { MAX_VIEWS as CODE_CHANNEL_MAX_VIEWS };
