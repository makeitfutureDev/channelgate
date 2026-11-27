// The daemon owns one foreground turn per session until its adapter finishes delivery.
import { randomUUID } from "node:crypto";

export const QUEUE_FULL = "RunQueueFull";
export const DUPLICATE_REQUEST = "DuplicateTurnRequest";
export const duplicateRequest = () => Object.assign(new Error("This request already has a turn."), { name: DUPLICATE_REQUEST });

export interface TurnHandle {
  runId?: string;
  authorId?: string;
  channelId?: string;
  threadKey?: string;
  origin?: string;
  visible?: boolean;
  aborted?: boolean;
  recovery?: boolean;
  durable?: boolean;
  controller?: AbortController;
}
type State = "queued" | "active" | "finished" | "cancelled";
export interface TurnReceipts {
  claim(key: string, handle: TurnHandle, state: State): number;
  mark(key: string, handle: TurnHandle, state: State): void;
  cancel(key: string, handle: TurnHandle): void;
}
interface Entry {
  handle: TurnHandle;
  requestId: string;
  sequence: number | null;
  startedMs: number | null;
  wake?: (error?: unknown) => void;
}
interface Slot { active: Entry; queued: Entry[] }
function describe(entry: Entry) {
  const h = entry.handle;
  return {
    requestId: entry.requestId, authorId: h.authorId || "", channelId: h.channelId || "",
    threadKey: h.threadKey || "", origin: h.origin || "", visible: Boolean(h.channelId && h.threadKey && h.visible !== false),
    startedMs: entry.startedMs, sequence: entry.sequence,
  };
}
type Item = ReturnType<typeof describe>;
export interface ThreadSnapshot { active: Item | null; queued: Item[] }
export function createRunQueue({ waitNoticeMs = 1500, maxQueued = 20, receipts }: {
  waitNoticeMs?: number; maxQueued?: number; receipts?: TurnReceipts;
} = {}) {
  const slots = new Map<string, Slot>();
  const clearing = new Set<string>();
  const listeners = new Set<(key: string, snapshot: ThreadSnapshot) => void>();
  const entries = (key: string) => {
    const slot = slots.get(key);
    return slot ? [slot.active, ...slot.queued] : [];
  };
  const snapshot = (key: string): ThreadSnapshot => {
    const slot = slots.get(key);
    return { active: slot ? describe(slot.active) : null, queued: slot ? slot.queued.map(describe) : [] };
  };
  function changed(key: string) {
    if (!listeners.size) return;
    const view = snapshot(key);
    for (const listener of listeners) {
      try { listener(key, view); } catch (error) { console.warn("[turn-owner] observer failed", error); }
    }
  }
  function mark(key: string, entry: Entry, state: State) {
    if (entry.sequence !== null) receipts?.mark(key, entry.handle, state);
  }
  function cancelReceipt(key: string, entry: Entry) {
    if (entry.sequence !== null) receipts?.cancel(key, entry.handle);
  }
  function retire(key: string, entry: Entry) {
    // Even a failed terminal receipt must unwind its holder. Producer recovery checks its
    // own durable outcome. Promotion below requires a successful write before a runner wakes.
    try { mark(key, entry, entry.handle.aborted ? "cancelled" : "finished"); }
    catch (error) { console.warn("[turn-owner] failed to retire receipt", (error as Error).name); }
  }
  return {
    snapshot,
    isClearing: (key: string) => clearing.has(key),
    beginClear(key: string) { if (clearing.has(key)) return false; clearing.add(key); return true; },
    endClear(key: string) { clearing.delete(key); },
    waitForIdle(key: string): Promise<void> {
      if (!slots.has(key)) return Promise.resolve();
      return new Promise(resolve => {
        const listener = (changedKey: string, state: ThreadSnapshot) => {
          if (changedKey !== key || state.active) return;
          listeners.delete(listener);
          resolve();
        };
        listeners.add(listener);
      });
    },
    subscribe(listener: (key: string, snapshot: ThreadSnapshot) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    acquire(key: string, handle: TurnHandle, onWait?: (info: {position: number}) => void): Promise<boolean> {
      if (clearing.has(key)) return Promise.reject(Object.assign(new Error("This session is being cleared."), { name: "SessionClearing" }));
      const slot = slots.get(key);
      if (handle.runId && entries(key).some(e => e.requestId === handle.runId)) return Promise.reject(duplicateRequest());
      if (slot && slot.queued.length >= maxQueued) return Promise.reject(Object.assign(
        new Error(`Too many messages queued in this thread (${maxQueued}).`), { name: QUEUE_FULL, queued: slot.queued.length },
      ));
      let sequence = null;
      try {
        if (receipts && handle.durable && handle.runId) sequence = receipts.claim(key, handle, slot ? "queued" : "active");
      } catch (error) { return Promise.reject(error); }
      const entry: Entry = { handle, requestId: handle.runId || randomUUID(), sequence, startedMs: slot ? null : Date.now() };
      if (!slot) {
        slots.set(key, { active: entry, queued: [] });
        changed(key);
        return Promise.resolve(false);
      }
      const wait = new Promise<boolean>((resolve, reject) => {
        // Priority changes use prioritizeQueued. Ordinary admissions always append in FIFO order.
        const position = slot.queued.push(entry);
        const timer = onWait && waitNoticeMs >= 0 ? setTimeout(() => onWait({ position }), waitNoticeMs) : null;
        timer?.unref();
        entry.wake = error => {
          if (timer) clearTimeout(timer);
          if (error) reject(error); else resolve(true);
        };
      });
      changed(key);
      return wait;
    },
    release(key: string, handle: TurnHandle) {
      const slot = slots.get(key);
      if (!slot) return;
      if (slot.active.handle === handle) {
        retire(key, slot.active);
        slots.delete(key);
        for (let next = slot.queued.shift(); next; next = slot.queued.shift()) {
          if (next.handle.aborted) { retire(key, next); next.wake?.(); continue; }
          try { mark(key, next, "active"); }
          catch (error) { next.wake?.(error); continue; }
          next.startedMs = Date.now();
          slot.active = next;
          slots.set(key, slot);
          next.wake?.();
          break;
        }
      } else {
        const index = slot.queued.findIndex(entry => entry.handle === handle);
        if (index < 0) return;
        const [entry] = slot.queued.splice(index, 1);
        entry.handle.aborted = true;
        retire(key, entry);
        entry.wake?.();
      }
      changed(key);
    },
    stopActive(key: string, expectedRequestId: string) {
      const entry = slots.get(key)?.active;
      if (!entry || !expectedRequestId || entry.requestId !== expectedRequestId || entry.handle.aborted) return false;
      cancelReceipt(key, entry);
      entry.handle.aborted = true;
      entry.handle.controller?.abort();
      changed(key);
      return true;
    },
    abort(key: string) {
      const slot = slots.get(key);
      if (!slot) return null;
      const queued: TurnHandle[] = [];
      try {
        while (slot.queued.length) {
          const waiter = slot.queued[0];
          cancelReceipt(key, waiter);
          slot.queued.shift();
          waiter.handle.aborted = true;
          queued.push(waiter.handle);
          waiter.wake?.();
        }
        cancelReceipt(key, slot.active);
        slot.active.handle.aborted = true;
      } finally { changed(key); }
      return { active: slot.active.handle, queued, queuedAborted: queued.length };
    },
    keys: () => [...slots.keys()],
    isActive: (key: string) => slots.has(key),
    activeHandle: (key: string) => slots.get(key)?.active.handle ?? null,
    hasRun: (key: string, id: string) => Boolean(id && entries(key).some(e => e.requestId === id)),
    isQueued: (key: string, id: string) => Boolean(slots.get(key)?.queued.some(e => e.requestId === id && !e.handle.aborted)),
    cancelQueued(key: string, id: string) {
      const slot = slots.get(key);
      if (!slot) return false;
      const index = slot.queued.findIndex(e => e.requestId === id);
      if (index < 0) return false;
      const entry = slot.queued[index];
      cancelReceipt(key, entry);
      slot.queued.splice(index, 1);
      entry.handle.aborted = true;
      entry.wake?.();
      changed(key);
      return true;
    },
    prioritizeQueued(key: string, id: string) {
      const slot = slots.get(key);
      if (!slot) return false;
      const index = slot.queued.findIndex(e => e.requestId === id && !e.handle.aborted);
      if (index < 0) return false;
      slot.queued.unshift(slot.queued.splice(index, 1)[0]);
      changed(key);
      return true;
    },
    count: (key: string) => slots.has(key) ? 1 + slots.get(key)!.queued.length : 0,
    handles: (key: string) => entries(key).map(e => e.handle),
  };
}
