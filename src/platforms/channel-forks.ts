import { randomUUID } from "node:crypto";
import { getUser } from "../config/store.js";
import { parseModelShortcut } from "../config/model-shortcuts.js";
import { threadForkTarget } from "../gateway/thread-fork-approvals.js";
import { transitionApprovalRequest } from "../gateway/approval-requests.js";
import { setThreadRuntimeOverrides } from "../gateway/thread-engine.js";
import { recordPlatformThreadMessage } from "../gateway/platform-threads.js";
import { abortPooled } from "../engines/session-pool.js";
import { assertEngineSelectable } from "../engines/selection.js";
import { isForceStopping } from "../gateway/shutdown.js";
import { ForkBatch, type ForkRequest } from "../gateway/fork-batch.ts";
import { resolveForkSettings } from "../gateway/fork-settings.ts";
import { formatThreadExcerpt } from "./thread-hydration.js";
import { parseConversationId } from "./ids.js";

interface Source { channelId: string; slug: string; authorId: string; threadKey: string }
interface SourceSnapshot extends Source { sourceSessionId: string; sourceEngine: string; sourceScope: string; workDir: string }
interface Job { source: Source; forks: ForkRequest[]; approvalId?: string }
export interface ForkDescriptor { id: string; sourceSessionId: string; sourceThreadKey: string; cutoff: string; clean: boolean; source?: SourceSnapshot }
interface Root { messageId: string; threadKey: string; raw?: object }
export interface ForkTurn {
  conversationId: string; conversationName: string; threadKey: string; messageId: string;
  authorId: string; authorName: string; author: Record<string, unknown>; text: string; fork: ForkDescriptor;
}
interface Message { threadKey: string; conversationId: string; userId: string; text: string; trigger: string }
interface Command { message: Message; sessionKey: string; entry: {slug: string}; reply: (text: string) => Promise<unknown> }
interface Connector {
  holdSession?: (key: { conversationId: string; sessionKey: string }) => () => void;
  readHistory?: (key: { conversationId: string; threadKey: string; limit: number }) => Promise<unknown[]>;
}
interface Surface {
  platform: string; name: string; place: string; connector: Connector;
  conversation: { execute: (options: {message: {conversationId: string; userId: string}; sessionKey: string; queued: () => Promise<void>;
    work: (signal: AbortSignal) => Promise<unknown>}) => Promise<unknown> };
  post: (id: string, thread: string, text: string) => Promise<{messageId: string; threadKey?: string}>;
  root: (id: string, posted: {messageId: string; threadKey?: string}) => Root | null;
  validMessage: (id: string, messageId: string) => boolean;
  link: (id: string, threadKey: string) => string;
  ready: () => boolean;
  enqueue: (turn: ForkTurn) => void;
  log?: Pick<Console,"error"|"warn">;
  now?: () => number;
}

const oneLine = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
const errorText = (error: unknown) => oneLine(error instanceof Error ? error.message : error);
const label = (value: string) => oneLine(value).replaceAll("[", "(").replaceAll("]", ")");
const link = (text: string, url?: string) => url ? `[${label(text)}](${url})` : label(text);
const laneKey = (id: string, thread: string) => JSON.stringify([id, thread]);

export function parseChannelFork(text: string, name: string, place: string) {
  const match = /^\/fork(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
  if (!match) return null;
  const task = (match[1] || "").trim();
  if (!task) return { error: `Use \`/fork <new message>\` in a thread of ${place} that already has a Claude or Codex answer. The new thread starts from a copy of this thread’s session.` };
  if (parseModelShortcut(task)) return { error: `Model shortcuts are not available for \`/fork\` in ${name} yet. Send \`/fork <new message>\`, then change the new thread’s runtime there with \`/model\`.` };
  if (task.length > 2000) return { error: "Keep a `/fork` message under 2000 characters; the new thread can continue from there." };
  return { task };
}

// Channel surfaces share the source reservation, session snapshot, durable admission and child
// ownership. Their adapters supply wire identifiers, formatting, remote addressing and queue input.
export function channelForks(surface: Surface) {
  const { connector, now = Date.now, log = console } = surface;
  const copying = new Map<string, () => void>();
  const starting = new Set<string>();
  const logFailure = (what: string, error: unknown) => log.warn?.(`[${surface.platform}] ${what}: ${errorText(error)}`);

  async function createAll({ source, forks, approvalId }: Job, signal: AbortSignal) {
    const { channelId, slug, threadKey: sourceKey, authorId } = source;
    const id = parseConversationId(channelId).id;
    const persist = (rows: ForkBatch["rows"]) => {
      if (!approvalId) return;
      for (const state of ["consumed", "executing"]) {
        try { if (transitionApprovalRequest(approvalId, state, state, { forks: rows })) return; }
        catch (error) { logFailure("fork journal failed", error); return; }
      }
    };
    const batch = new ForkBatch(forks, persist);
    const stopped = () => signal.aborted || isForceStopping();
    let failed = "";
    try {
      if (stopped()) throw new Error("The forks were stopped before creation.");
      const target = await threadForkTarget(source);
      await assertEngineSelectable(target.sourceEngine, { channelId, meta: target.meta });
      abortPooled(`${slug}::${sourceKey}`);
      const settings = await resolveForkSettings({ slug, threadKey: sourceKey, engine: target.sourceEngine, meta: target.meta });
      const cutoff = new Date(now()).toISOString(), sourceUrl = surface.link(id, sourceKey);
      const user = await getUser(authorId);
      const authorName = oneLine(user?.name) || authorId;
      const conversationName = oneLine(target.entry?.name || target.meta?.name) || id;
      await batch.start({
        stopped, authorize: () => threadForkTarget(source),
        create: async (fork, { created, startTurn }) => {
          const title = `↪️ ${label(authorName)} Fork: ${label(fork.title)}`;
          const posted = await surface.post(id, "", title);
          const root = surface.root(id, posted);
          if (!root || root.threadKey === sourceKey) throw new Error(`${surface.name} did not return a new thread for the fork; creation is uncertain. Do not retry automatically.`);
          const thread = root.threadKey;
          created(thread, surface.link(id, thread));
          const key = laneKey(channelId, thread);
          starting.add(key);
          try {
            try {
              recordPlatformThreadMessage({ slug, threadKey: thread, message: {
                platform: surface.platform, conversationId: channelId, rawConversationId: id, kind: "channel", isDM: false,
                userId: authorId, messageId: root.messageId, threadKey: thread, text: oneLine(`↪️ ${authorName} Fork: ${fork.title}`).slice(0, 160),
                raw: root.raw,
              } });
            } catch (error) { logFailure("fork Activity index failed", error); }
            setThreadRuntimeOverrides(slug, thread, settings);
            const request = await surface.post(id, thread, `↪️ Fork of ${link("this thread", sourceUrl)} — opening request from ${label(authorName)}:\n\n${fork.prompt}`);
            if (!surface.validMessage(id, request?.messageId)) throw new Error(`${surface.name} did not return the fork request message; its first response was not started.`);
            const snapshot: SourceSnapshot = { channelId, threadKey: sourceKey, slug, authorId, sourceEngine: target.sourceEngine,
              sourceScope: target.sourceScope, sourceSessionId: target.sourceSessionId, workDir: target.workDir };
            const descriptor = { id: randomUUID(), source: snapshot, sourceSessionId: String(target.sourceSessionId), sourceThreadKey: sourceKey, cutoff, clean: settings.clean };
            startTurn(copied => {
              copying.set(descriptor.id, copied);
              try {
                surface.enqueue({ conversationId: id, conversationName, threadKey: thread, messageId: request.messageId, authorId,
                  authorName, author: user || {}, text: fork.prompt, fork: descriptor });
              } catch (error) { copying.delete(descriptor.id); throw error; }
            });
          } finally { starting.delete(key); }
        },
      });
    } catch (error) {
      failed = errorText(error);
      // The initial admission failed before any remote child was attempted.
      for (const row of batch.rows) if (row.status === "pending") { row.status = "failed"; row.error = failed.slice(0, 200); }
      persist(batch.rows);
    } finally {
      try {
        const rows = batch.rows, first = rows[0];
        let summary;
        if (failed) summary = `${approvalId ? "The approved forks" : "The fork"} could not be created: ${failed} Nothing was created.`;
        else if (approvalId) summary = `Created ${rows.filter(row => row.threadKey).length}/${rows.length} forks:\n` +
          rows.map((row, i) => `${i + 1}. ${link(row.title, row.url)} — ${row.error || (row.status === "starting" ? "first response requested" : row.status)}`).join("\n");
        else if (first.threadKey && !first.error) summary = `↪️ Fork started in ${link("a new thread", first.url)}.`;
        else summary = `The fork could not be completed: ${first.error || first.status}.${first.url ? ` Its thread: ${link("fork", first.url)}.` : ""}`;
        await surface.post(id, sourceKey, summary).catch(error => logFailure("fork index not posted", error));
      } finally { await batch.waitForCopies(); }
    }
  }

  function start(job: Job, announcement?: Promise<unknown>) {
    const { channelId, threadKey, authorId } = job.source;
    const release = connector.holdSession?.({ conversationId: channelId, sessionKey: threadKey });
    let entered = false;
    void surface.conversation.execute({
      message: { conversationId: channelId, userId: authorId }, sessionKey: threadKey, queued: async () => {},
      work: async signal => { entered = true; await announcement; return createAll(job, signal); },
    }).then(async () => {
      if (!entered) await surface.post(parseConversationId(channelId).id, threadKey, `${job.approvalId ? "The approved forks were" : "The fork was"} stopped before creation. Nothing was created.`);
    }).catch(error => logFailure("fork run failed", error)).finally(release);
  }

  async function runApproved(record: { id: string; action: Source & { forks: ForkRequest[] } }) {
    if (!surface.ready()) throw new Error(`${surface.name} is not connected.`);
    const { action } = record;
    const announcement = surface.post(parseConversationId(action.channelId).id, action.threadKey, `⏳ Approved ${action.forks.length} fork${action.forks.length === 1 ? "" : "s"}. Waiting for the source turn to finish before copying its context.`).catch(() => {});
    // Reserve before awaiting the remote notice; a later message must not pass an approved fork.
    start({ source: action, approvalId: record.id, forks: action.forks }, announcement);
    await announcement;
    return { ok: true, completed: true, label: "thread forks", message: "The forks start once the source turn finishes; the index of new threads is posted in this thread." };
  }

  async function command({ message, sessionKey, entry, reply }: Command) {
    if (message.trigger === "reaction") return false;
    const parsed = parseChannelFork(message.text, surface.name, surface.place);
    if (!parsed) return false;
    if (!parsed.task) { await reply(parsed.error || "A fork needs an opening request."); return true; }
    const source = { channelId: message.conversationId, slug: entry.slug, authorId: message.userId, threadKey: sessionKey };
    try { await threadForkTarget(source); }
    catch (error) { await reply(`Can't fork this thread: ${errorText(error)}`); return true; }
    if (!surface.ready()) { await reply(`${surface.name} is not connected, so the fork was not created.`); return true; }
    const line = oneLine(parsed.task);
    start({ source, forks: [{ prompt: parsed.task, title: line.length > 100 ? `${line.slice(0, 99)}…` : line }] });
    return true;
  }

  async function guard({ message, sessionKey, reply }: Command) {
    if (!starting.has(laneKey(message.conversationId, sessionKey))) return false;
    await reply("This fork is still starting. Please send your next message after its first reply.");
    return true;
  }

  function settle(id: string) {
    copying.get(id)?.();
    copying.delete(id);
  }

  async function runChild<M extends Message, R>(ingest: (message: M, options: object) => Promise<R>, message: M,
    options: { fork: ForkDescriptor }) {
    const { fork } = options;
    try {
      // Queued children can survive a restart or an access change. Recheck the source snapshot
      // before reading its native session. Older saved Google Chat requests predate this field.
      if (fork.source) {
        try { await threadForkTarget(fork.source); }
        catch (error) {
          await surface.post(parseConversationId(message.conversationId).id, message.threadKey,
            `The fork's first response could not start: ${errorText(error)}`);
          return;
        }
      }
      return await ingest(message, { ...options, fork: {
        sourceSessionId: fork.sourceSessionId, onSourceForked: () => settle(fork.id),
        fallbackContext: fork.clean ? null : async () => {
          if (!connector.readHistory) return "";
          const rows = await connector.readHistory({ conversationId: message.conversationId, threadKey: fork.sourceThreadKey, limit: 30 });
          return formatThreadExcerpt(rows, { label: surface.name, triggerTime: fork.cutoff });
        },
      } });
    } finally { settle(fork.id); }
  }

  return { runApproved, command, guard, runChild, settle };
}
