// Exact, durable batch intent. Only the daemon executes a human-approved proposal.
import { getChannelEntry, getChannelMeta, isAdmin, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { effectiveWorkDir } from "./folders.js";
import { getSession, getSessionEngine, getSessionRuntime } from "./sessions.js";
import { getThreadSudo } from "./thread-engine.js";
import { engineSupports } from "../engines/registry.js";
import { platformOfConversation } from "../platforms/ids.js";
import { capabilitiesFor, platformOr, platformSupports } from "../platforms/registry.js";
import { liveConnector } from "../platforms/live.js";
import { RUN_ORIGINS } from "../engines/contract.js";
import { isCodeChannelMeta } from "./code-channels.js";

export const THREAD_FORK_ACTION = "thread_forks";
// The one origin a fork proposal may come from: the surface's own watched, authenticated
// foreground turn (`slack_foreground`, `googlechat_foreground`). Schedules, background agents,
// API runs, continuations and recovery never propose forks.
export function threadForkOrigin(platform) {
  const origin = `${platform}_foreground`;
  return RUN_ORIGINS.includes(origin) ? origin : "";
}
export function describeThreadForks(forks) {
  return `Create ${forks.length} separate threads in this conversation, inheriting the source context. Start one response in each.\n\n` +
    forks.map((fork, i) => `${i + 1}. ${fork.title}\n${fork.prompt}`).join("\n\n");
}
export function normalizeThreadForks(forks) {
  if (!Array.isArray(forks) || forks.length < 1 || forks.length > 10) throw new Error("Propose between 1 and 10 forks.");
  const normalized = forks.map(fork => {
    if (typeof fork?.title !== "string" || typeof fork?.prompt !== "string") throw new Error("Each fork needs a title and opening prompt.");
    const title = fork.title.trim(), prompt = fork.prompt.trim();
    if (!title || title.length > 100 || /[\r\n]/.test(title) || !prompt || prompt.length > 2000 || /```|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title + prompt)) {
      throw new Error("Use a one-line title (1–100 characters) and an opening prompt (1–2000 characters), without code fences or control characters.");
    }
    return { title, prompt };
  });
  if (describeThreadForks(normalized).length > 2400) throw new Error("Shorten the proposal: all titles and prompts together must fit the approval card (2400 characters).");
  return normalized;
}

export async function threadForkTarget(action) {
  const { channelId, slug, authorId, threadKey } = action;
  const platform = platformOfConversation(channelId), adapter = platformOr(platform);
  // A surface with threads in only some conversations (Google Chat: named threaded spaces, never
  // DMs or group chats) answers WHY a conversation cannot fork once it knows the conversation.
  const mixedThreading = capabilitiesFor(platform).mixedThreading === true;
  const ordinaryThread = () => Boolean(adapter.validDeliveryThread?.(threadKey, channelId));
  if (!platformSupports(platform, "threadForks") || (!mixedThreading && !ordinaryThread())) throw new Error(`Fork proposals need an ordinary ${adapter.label} thread.`);
  const entry = await getChannelEntry(channelId), meta = await getChannelMeta(slug);
  if (!entry || entry.slug !== slug || !meta || (meta.channelId && meta.channelId !== channelId)) throw new Error("The source conversation no longer matches this proposal.");
  if (mixedThreading) {
    if (entry.isDM || entry.type !== "channel") throw new Error(`${adapter.label} direct messages and group chats have no threads to fork into. ${platform === "msteams" ? "Use a Teams channel with reply chains." : "Use a named space that has threads."}`);
    if (!ordinaryThread()) throw new Error(`Fork proposals need an ordinary ${adapter.label} thread.`);
    // Whether the space itself is threaded is a live fact of the space, asked of its transport.
    const connector = liveConnector(platform);
    if (typeof connector?.threadForkRefusal !== "function") throw new Error(`${adapter.label} is not connected, so forks cannot be created right now.`);
    const refusal = await connector.threadForkRefusal(channelId);
    if (refusal) throw new Error(refusal);
  }
  const admin = await isAdmin(authorId);
  if (!isAuthorized(meta, authorId, Boolean(entry.isDM), { isAdminUser: admin, isApprovedUser: await isApproved(authorId) })) throw new Error("The requester is no longer authorized in this conversation.");
  if (isCodeChannelMeta(meta)) throw new Error("Code channels have one session; propose forks in an ordinary conversation.");
  if (await getThreadSudo(slug, threadKey)) throw new Error("A sudo thread cannot be forked into ordinary threads.");
  const sourceSessionId = await getSession(slug, threadKey), sourceEngine = await getSessionEngine(slug, threadKey);
  const runtime = await getSessionRuntime(slug, threadKey);
  if (!sourceSessionId || !engineSupports(sourceEngine, "nativeFork")) throw new Error("This thread needs a supported source session before it can be forked.");
  if (runtime?.backend !== "container") throw new Error("Run another turn in the channel container before proposing forks.");
  const sourceScope = runtime.scope || "admin";
  if (sourceScope !== (admin ? "admin" : "project")) throw new Error("Run a new turn under your own access level before forking this thread.");
  const workDir = effectiveWorkDir(slug, meta);
  if (action.sourceSessionId && (action.sourceSessionId !== sourceSessionId || action.sourceEngine !== sourceEngine || action.sourceScope !== sourceScope || action.workDir !== workDir)) {
    throw new Error("The source session, access level or working folder changed. Submit a fresh proposal.");
  }
  return { entry, meta, sourceSessionId, sourceEngine, sourceScope, workDir };
}

export async function prepareThreadForkApproval(ctx, { forks } = {}) {
  const platform = platformOfConversation(ctx.channelId);
  if (ctx.principalTrusted !== true || ctx.toolset !== "full" || !ctx.origin || ctx.origin !== threadForkOrigin(platform)) throw new Error(`Fork proposals are available only in a person's foreground ${platformOr(platform).label} turn.`);
  const action = { kind: THREAD_FORK_ACTION, channelId: ctx.channelId, slug: ctx.slug, authorId: ctx.createdBy, threadKey: ctx.threadKey, forks: normalizeThreadForks(forks) };
  const target = await threadForkTarget(action);
  return { ...action, sourceSessionId: target.sourceSessionId, sourceEngine: target.sourceEngine, sourceScope: target.sourceScope, workDir: target.workDir };
}

export async function executeThreadForkApproval(record, { runBatch } = {}) {
  try {
    const action = record?.action;
    if (record?.status !== "executing" || action?.kind !== THREAD_FORK_ACTION || action.channelId !== record.channelId || action.slug !== record.slug || action.authorId !== record.authorId || !action.sourceSessionId) throw new Error("Invalid saved fork approval.");
    normalizeThreadForks(action.forks);
    await threadForkTarget(action);
    const clicker = record.decidedBy === "link" ? action.authorId : record.decidedBy;
    if (clicker !== "admin UI" && clicker !== action.authorId && !(await isAdmin(clicker))) throw new Error("Only the requester or an admin can approve these forks.");
    if (typeof runBatch !== "function") throw new Error("The fork executor is unavailable.");
    return await runBatch(record);
  } catch (error) { return { ok: false, error: error.message }; }
}
