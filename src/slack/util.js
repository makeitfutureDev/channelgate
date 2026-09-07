// Small pure helpers for the Slack layer, split out of app.js so they're unit-testable without
// pulling in Bolt: event dedupe (H3), the per-thread run queue (H1), replay-sentinel
// neutralization (H5), /model validation, and the shared chunked-reply poster (M9).
import { chunkMrkdwn } from "./format.js";

// One Slack message's practical mrkdwn budget (well under the 40k hard limit so blocks/footers fit).
export const MAX_SLACK_CHARS = 11_900;

// Slack's Node SDK wraps API validation failures in WebAPIPlatformError (`data.error`), while
// lightweight callers/tests may expose only `error` or the rendered message. Keep classification
// at one boundary so native and classic delivery degrade the same way.
export function isSlackInvalidBlocksError(error) {
  const code = error?.data?.error || error?.error || error?.code || "";
  return code === "invalid_blocks" || /\binvalid_blocks\b/.test(String(error?.message || ""));
}

// ── Chunked reply poster (M9) ─────────────────────────────────────────────────────────────────
// Post a (possibly long) converted reply as one or more threaded messages. Long finals are split
// on line boundaries by the shared chunker (code fences kept valid across the split) instead of
// hard-truncated; the stats footer rides on the last part. Bounded so a pathological answer can't
// flood the thread. Used by the interactive path AND the unattended ones (scheduler, background
// jobs) so every model-output post gets the same escaping + chunking treatment.
const MAX_REPLY_CHUNKS = 6;
// Slack's hard limit on one section block's text. A chunk longer than this cannot carry the footer
// in the same message and keeps the separate trailer below it.
const MAX_SECTION_CHARS = 3000;
export async function postChunkedReply(client, channel, threadTs, md, footer = "", buttonOrButtons = null, { footerBlocks = null } = {}) {
  const buttons = (Array.isArray(buttonOrButtons) ? buttonOrButtons : [buttonOrButtons]).filter(Boolean);
  let chunks = chunkMrkdwn(md || "", MAX_SLACK_CHARS).filter((c) => c.trim());
  if (!chunks.length) chunks = ["_(no output)_"];
  if (chunks.length > MAX_REPLY_CHUNKS) {
    chunks = chunks.slice(0, MAX_REPLY_CHUNKS);
    chunks[chunks.length - 1] += "\n\n…_(truncated)_";
  }
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    // A caller RECOVERING a failed streamed reply (progress.js, when Slack rejects stopStream)
    // asks for the footer to ride the answer itself, so the thread never ends on a message that
    // carries nothing but stats and buttons. One Slack message renders either `text` or `blocks`,
    // so the chunk becomes a section block — possible only while it fits the section limit; a
    // longer answer keeps the plain chunk and the trailer below it.
    if (last && footerBlocks?.length && chunks[i].length <= MAX_SECTION_CHARS) {
      try {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunks[i],
          blocks: [{ type: "section", text: { type: "mrkdwn", text: chunks[i] } }, ...footerBlocks],
        });
        return;
      } catch (error) {
        // Cosmetic Block Kit trouble must never cost a completed answer: post the chunk plainly
        // and let the trailer below carry the stats.
        if (!isSlackInvalidBlocksError(error)) throw error;
      }
    }
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: last && footer && !buttons.length ? `${chunks[i]}\n\n${footer}` : chunks[i],
    });
  }
  // With controls, the footer moves to its own compact trailer message. One control fits as a
  // section accessory; multiple controls need an actions row because Slack sections allow only one
  // accessory. Rendered text can't carry interactive elements, and folding long answer chunks into
  // section blocks is what this poster deliberately avoids.
  if (buttons.length) {
    const text = { type: "mrkdwn", text: footer || " " };
    const blocks = buttons.length === 1
      ? [{ type: "section", text, accessory: buttons[0] }]
      : [{ type: "context", elements: [text] }, { type: "actions", elements: buttons }];
    try {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: footer || "resume",
        blocks,
      });
    } catch (error) {
      if (!isSlackInvalidBlocksError(error)) throw error;
      // Controls are cosmetic. If Slack rejects their Block Kit, keep the completed answer a
      // success and preserve its stats in a plain-text trailer instead of surfacing run_error.
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: footer || "resume" });
    }
  }
}

// ── Event dedupe (H3) ─────────────────────────────────────────────────────────────────────────
// Socket Mode can redeliver an envelope (delayed ack, connection blip); without dedupe the whole
// pipeline runs twice — double tokens, double cost, duplicate replies. A short-TTL set of
// processed event ids catches the retry window; entries expire so the set can't grow unbounded.
export function createTtlSet(ttlMs = 5 * 60 * 1000, { now = Date.now, maxSize = 10_000 } = {}) {
  const seen = new Map(); // key -> expiry epoch ms (insertion order ≈ expiry order: fixed TTL)
  let earliest = Infinity; // earliest expiry — lets add() skip a sweep that would free nothing
  const sweep = (t) => {
    earliest = Infinity;
    for (const [k, exp] of seen) {
      if (exp <= t) seen.delete(k);
      else if (exp < earliest) earliest = exp;
    }
  };
  return {
    // Record `key`; returns true when it's new (process the event), false on a repeat (skip it).
    add(key) {
      const t = now();
      // At the cap: sweep only when something is actually expired (a futile O(n) scan per event
      // is exactly what an event flood can't afford), then hard-evict the oldest insertions so
      // the map never exceeds maxSize even when every entry is still inside the TTL.
      if (seen.size >= maxSize) {
        if (earliest <= t) sweep(t);
        while (seen.size >= maxSize) seen.delete(seen.keys().next().value);
      }
      const exp = seen.get(key);
      if (exp && exp > t) return false;
      seen.set(key, t + ttlMs);
      if (t + ttlMs < earliest) earliest = t + ttlMs;
      return true;
    },
    // Is `key` currently recorded and unexpired? Unlike add(), this does NOT record it — for
    // callers asking "have I already seen this?" without wanting to claim it.
    has(key) {
      const exp = seen.get(key);
      return Boolean(exp && exp > now());
    },
    size() {
      const t = now();
      sweep(t);
      return seen.size;
    },
  };
}

// ── Per-key run queue (H1) ────────────────────────────────────────────────────────────────────
// Serializes turns per run key ("<slug>::<threadKey>"): two quick messages in one thread must
// never run concurrently in the same cwd/session. The second acquire() waits FIFO behind the
// first; release() promotes the next waiter and touches only the caller's own entry (so a
// finishing run can never delete a successor's slot); abort() marks everything on the key
// aborted — queued turns are woken to bail out, and the active handle is returned so the caller
// can kill its subprocess.
export const QUEUE_FULL = "RunQueueFull";

export function createRunQueue({ waitNoticeMs = 1500, maxQueued = 20 } = {}) {
  const slots = new Map(); // key -> { active: handle|null, waiters: [{ handle, wake, timer }] }

  // Promote the next LIVE waiter. Handles aborted while queued are woken (so their owners unwind)
  // and skipped rather than made active: a dead handle in `active` briefly blocks the key and,
  // worse, is what the steer path would try to interrupt.
  const promote = (slot) => {
    while (slot.waiters.length) {
      const next = slot.waiters.shift();
      if (next.handle?.aborted) {
        next.wake(); // let its owner see `aborted` and bail
        continue;
      }
      slot.active = next.handle;
      next.wake();
      return;
    }
    slot.active = null;
  };

  return {
    // Await this handle's turn. Resolves false when the key was idle (started immediately), true
    // after a wait. `onWait` fires once, with { position }, if the wait outlasts a beat. A handle
    // aborted while waiting still resolves — the caller must check handle.aborted and bail.
    //
    // Throws a QUEUE_FULL error once `maxQueued` turns are already waiting on this key. Without a
    // cap a message flood in one thread queues unboundedly, and every queued turn eventually
    // spawns a real engine run — so silent queueing is silent spend. Refusing loudly lets the
    // caller tell the user instead.
    acquire(key, handle, onWait) {
      let slot = slots.get(key);
      if (!slot) {
        slot = { active: null, waiters: [] };
        slots.set(key, slot);
      }
      if (!slot.active) {
        slot.active = handle;
        return Promise.resolve(false);
      }
      if (slot.waiters.length >= maxQueued) {
        if (!slot.active && !slot.waiters.length) slots.delete(key);
        return Promise.reject(Object.assign(new Error(`Too many messages queued in this thread (${maxQueued}).`), { name: QUEUE_FULL, queued: slot.waiters.length }));
      }
      return new Promise((resolve) => {
        const w = { handle, timer: null, wake: null };
        w.wake = () => {
          if (w.timer) clearTimeout(w.timer);
          resolve(true);
        };
        const position = slot.waiters.length + 1;
        if (onWait && waitNoticeMs >= 0) {
          w.timer = setTimeout(() => onWait({ position }), waitNoticeMs);
          w.timer.unref?.();
        }
        slot.waiters.push(w);
      });
    },
    // Done (or bailing out): drop this handle and promote the next queued turn. Deletes the slot
    // only when nothing is left on the key.
    release(key, handle) {
      const slot = slots.get(key);
      if (!slot) return;
      if (slot.active === handle) {
        slot.active = null;
        promote(slot);
      } else {
        const i = slot.waiters.findIndex((w) => w.handle === handle);
        if (i >= 0) {
          const [w] = slot.waiters.splice(i, 1);
          if (w.timer) clearTimeout(w.timer);
        }
      }
      if (!slot.active && !slot.waiters.length) slots.delete(key);
    },
    // Stop everything queued or running on `key`. Queued handles are marked aborted and woken
    // (they bail before spawning anything); the active handle is marked aborted and returned so
    // the caller can abort its controller / warm session. Returns null when the key is idle.
    abort(key) {
      const slot = slots.get(key);
      if (!slot) return null;
      const waiters = slot.waiters.splice(0);
      for (const w of waiters) w.handle.aborted = true;
      const active = slot.active;
      if (active) active.aborted = true;
      for (const w of waiters) w.wake();
      if (!active) slots.delete(key); // nothing left running — waiters will bail on wake
      return { active, queued: waiters.map((w) => w.handle), queuedAborted: waiters.length };
    },
    keys() {
      return [...slots.keys()];
    },
    // True when a turn is CURRENTLY running on this key (vs. only queued / idle). The steer path
    // checks this to decide whether a new message can interrupt the running turn.
    isActive(key) {
      return Boolean(slots.get(key)?.active);
    },
    // The handle of the running turn on this key (or null). The steer path flags it `.steered` so
    // that turn's owner hands off quietly instead of posting its interrupted output.
    activeHandle(key) {
      return slots.get(key)?.active ?? null;
    },
    // Is this exact turn (by runId) already running or queued on this key? A run id encodes the
    // Slack message that triggered it, so this answers "am I looking at a redelivered copy of a
    // message the gateway already owns?" — the in-memory envelope dedupe dies with the process,
    // and Slack redelivers unacked envelopes after a restart.
    hasRun(key, runId) {
      if (!runId) return false;
      const slot = slots.get(key);
      if (!slot) return false;
      if (slot.active?.runId === runId) return true;
      return slot.waiters.some((w) => w.handle?.runId === runId);
    },
    // Live turns on a key (active + queued) — for the status report.
    count(key) {
      const slot = slots.get(key);
      return slot ? (slot.active ? 1 : 0) + slot.waiters.length : 0;
    },
  };
}

// ── Replay-sentinel neutralization (H5) ───────────────────────────────────────────────────────
// Replayed thread text and display names are untrusted: a participant can embed the exact framing
// markers the gateway wraps context/provenance in ("[End of earlier thread context.]",
// "[Thread context — …]", "[Provenance: …]", "[Composio identities in THIS run: …]") to forge a
// framing boundary and smuggle instructions. The identity line is the one that would pay best —
// forging "both identities are the requester's own" would undo the ask-first rule it exists to
// state — so it is defanged with the rest. Rewrite the opening bracket of any such marker so the
// model never sees a fake sentinel; legitimate brackets elsewhere are untouched.
const SENTINEL_RE = /\[(?=\s*(?:end of earlier thread context|thread context\b|provenance\b|composio identities\b))/gi;
export function neutralizeSentinels(s) {
  return String(s || "").replace(SENTINEL_RE, "(");
}

// ── /model validation ─────────────────────────────────────────────────────────────────────────
// The /model value flows straight into the engine's --model / -m flag; a typo'd or arbitrary
// string breaks every later turn in the channel. Accept only the engine aliases and the known
// model-id families (Claude: opus/sonnet/haiku aliases + claude-*; Codex: gpt-*, o<n>*, codex*).
const MODEL_RE = /^(?:best|fable|haiku|opusplan|opus|sonnet|(?:opus|sonnet)\[1m\]|claude-[a-z0-9][a-z0-9.[\]-]*|gpt-[a-z0-9][a-z0-9.-]*|o[0-9][a-z0-9.-]*|codex(?:-[a-z0-9.-]+)?|[a-z0-9._-]+\/[a-z0-9._:/-]+)$/;
export function isValidModel(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v || v.length > 64 || /\s/.test(v)) return false;
  return MODEL_RE.test(v);
}

// ── Engine ↔ model/effort compatibility ───────────────────────────────────────────────────────
// modelBelongsToEngine / effortBelongsToEngine used to be re-exported from here. They live in
// src/engines/registry.js (the one home for per-engine facts) and every caller now imports them
// from there directly: this module is on the CHAT-SURFACE side of the tree, and re-exporting the
// engine registry from it dragged the whole engine layer — and with it src/config/paths.js — into
// the platform adapters' import graph, which made src/config/paths.js unable to read the platform
// registry's folder facts without an import cycle.
