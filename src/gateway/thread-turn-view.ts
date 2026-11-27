// Activity adds these fields only after the viewer's access to the native thread is established.
import type { PendingTurn } from "../platforms/pending-activity.ts";
import { platformOfConversation } from "../platforms/ids.js";
import { slackThreadFor } from "../slack/thread-keys.js";
import { notifyThreadChanged } from "./thread-changes.js";
import { runQueue, turnReceipt } from "./thread-turn-owner.ts";
import type { ThreadSnapshot } from "./thread-turn-queue.ts";

type Item = NonNullable<ThreadSnapshot["active"]>;
type Thread = { channelId: string; threadTs: string };
type ThreadTurns = { active: Item | null; queued: Item[] };
type ViewerTurn = { origin: string; mine: boolean };
type ActivityFields = {
  status?: "working";
  workingSinceMs?: number;
  turnState?: { active: ViewerTurn | null; queued: ViewerTurn[]; label: string; detail: string };
};
const address = (channelId: string, threadTs: string) => JSON.stringify([channelId, threadTs]);

function visibleTurnThread(turn: Item | null): Thread | null {
  if (!turn?.visible || !turn.channelId) return null;
  const threadTs = platformOfConversation(turn.channelId) === "slack" ? slackThreadFor(turn.threadKey) : turn.threadKey;
  return threadTs ? { channelId: turn.channelId, threadTs } : null;
}

// The durable intake row is written before admission and stays present while the request is
// queued. It is eligible for recovery but must not start Activity's running clock.
export function inactiveActivityRecord(id: string, record: { slug?: string; threadKey?: string; replySaved?: boolean; recoveryPending?: boolean } | null) {
  if (record?.replySaved || record?.recoveryPending) return true;
  if (!record?.slug || !record.threadKey) return false;
  const key = `${record.slug}::${record.threadKey}`;
  return runQueue.isQueued(key, id) || turnReceipt(key, id)?.state === "cancelled";
}

export function* activeNativeTurns() {
  for (const key of runQueue.keys()) {
    const { active } = runQueue.snapshot(key);
    const thread = visibleTurnThread(active);
    if (thread && active) yield { channelId: thread.channelId, threadKey: thread.threadTs, startedAt: active.startedMs };
  }
}

function visitTurns(snapshot: ThreadSnapshot, visit: (item: Item, thread: Thread, active: boolean) => void) {
  for (const item of [snapshot.active, ...snapshot.queued]) {
    const thread = visibleTurnThread(item);
    if (item && thread) visit(item, thread, item === snapshot.active);
  }
}

// Broadcast only an invalidation hint. Keep the preceding native addresses so finishing or
// cancelling the last request also wakes subscribers to the thread it just left.
const previous = new Map<string, Map<string, Thread>>();
function changed(key: string, snapshot: ThreadSnapshot) {
  const before = previous.get(key);
  const next = new Map<string, Thread>();
  visitTurns(snapshot, (_item, thread) => next.set(address(thread.channelId, thread.threadTs), thread));
  if (next.size) previous.set(key, next);
  else previous.delete(key);
  for (const thread of new Map([...(before || []), ...next]).values()) notifyThreadChanged(thread);
}
runQueue.subscribe(changed);
for (const key of runQueue.keys()) changed(key, runQueue.snapshot(key));

const sourceLabels: Record<string, string> = {
  voice_call: "Voice", api_foreground: "API", slack_foreground: "Slack",
  googlechat_foreground: "Google Chat", msteams_foreground: "Teams", agent_message: "Agent",
  continuation: "Continuation", recovery: "Recovery", loop_tick: "Loop",
};
function source(item: Item) {
  if (Object.hasOwn(sourceLabels, item.origin)) return item.origin;
  return "chat";
}

// Index the currently owned turns once per feed snapshot. No addresses or owner IDs are emitted
// for threads missing from the viewer's authorized feed, even if they're active on the daemon.
export function activityTurnProjection(pending: PendingTurn[] = []) {
  const threads = new Map<string, ThreadTurns>();
  const requestIds = new Set<string>();
  for (const key of runQueue.keys()) {
    visitTurns(runQueue.snapshot(key), (item, thread, active) => {
      requestIds.add(item.requestId);
      const id = address(thread.channelId, thread.threadTs);
      const view = threads.get(id) || { active: null, queued: [] as Item[] };
      if (active) {
        if (!view.active || Number(item.startedMs) < Number(view.active.startedMs)) view.active = item;
      } else view.queued.push(item);
      threads.set(id, view);
    });
  }
  for (const item of pending) {
    const key = address(item.channelId, item.threadKey);
    const view = threads.get(key) || { active: null, queued: [] as Item[] };
    if (requestIds.has(item.requestId)) continue;
    requestIds.add(item.requestId);
    view.queued.push({ ...item, visible: true, sequence: null, startedMs: null });
    threads.set(key, view);
  }
  return (channelId: string, threadTs: string, viewer: string, status: string): ActivityFields => {
    const view = threads.get(address(channelId, threadTs));
    if (!view) return {};
    const describe = (item: Item) => ({ origin: source(item), mine: item.authorId === viewer });
    const active = view.active ? describe(view.active) : null;
    const queued = view.queued.map(describe);
    const name = (item: ViewerTurn) => (sourceLabels[item.origin] || "Chat") + (item.mine ? " (yours)" : "");
    const label = [active && name(active), queued.length && `${queued.length} queued`].filter(Boolean).join(" · ");
    const detail = queued.map((item, i) => `${i + 1}. ${name(item)}`).join("\n");
    return {
      ...(view.active && !["done", "later", "waiting"].includes(status) ? { status: "working", workingSinceMs: view.active.startedMs ?? undefined } : {}),
      turnState: { active, queued, label, detail },
    };
  };
}
