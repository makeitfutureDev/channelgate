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
/** @param {object | Array<object | null> | null} buttonOrButtons */
export async function postChunkedReply(client, channel, threadTs, md, footer = "", buttonOrButtons = null, { footerBlocks = null, answerBlocks = null } = {}) {
  const thread = threadTs ? { thread_ts: threadTs } : {};
  const buttons = (Array.isArray(buttonOrButtons) ? buttonOrButtons : [buttonOrButtons]).filter(Boolean);
  let previews = (Array.isArray(answerBlocks) ? answerBlocks : []).filter(Boolean);
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
    if (last && (footerBlocks?.length || previews.length) && chunks[i].length <= MAX_SECTION_CHARS) {
      const inlineFooter = footer && !buttons.length && !footerBlocks?.length
        ? [{ type: "context", elements: [{ type: "mrkdwn", text: footer.slice(0, MAX_SECTION_CHARS) }] }]
        : [];
      try {
        await client.chat.postMessage({
          channel,
          ...thread,
          text: chunks[i],
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: chunks[i] } },
            ...previews,
            ...(footerBlocks || []),
            ...inlineFooter,
          ],
        });
        previews = [];
        if (footerBlocks?.length || inlineFooter.length) return;
        continue;
      } catch (error) {
        // Cosmetic Block Kit trouble must never cost a completed answer: post the chunk plainly
        // and let the trailer below carry the stats.
        if (!isSlackInvalidBlocksError(error)) throw error;
        previews = [];
      }
    }
    await client.chat.postMessage({
      channel,
      ...thread,
      text: last && footer && !buttons.length ? `${chunks[i]}\n\n${footer}` : chunks[i],
    });
  }
  // A long final chunk cannot become a section block (Slack caps one at 3,000 characters). Keep
  // the answer as ordinary unfurled text, then attach its native previews in one compact message.
  if (previews.length) {
    try {
      await client.chat.postMessage({
        channel,
        ...thread,
        text: previews.length === 1 ? "Image preview" : "Image previews",
        blocks: previews,
      });
    } catch (error) {
      if (!isSlackInvalidBlocksError(error)) throw error;
    }
  }
  // With controls, the footer moves to its own compact trailer message. One control fits as a
  // section accessory; multiple controls need an actions row because Slack sections allow only one
  // accessory. Rendered text can't carry interactive elements, and folding long answer chunks into
  // section blocks is what this poster deliberately avoids.
  // A trailer without stats (an unattended answer posted without them) is the menu row alone.
  if (buttons.length) {
    const text = { type: "mrkdwn", text: footer };
    const blocks = buttons.length === 1
      ? [{ type: "section", text: footer ? text : { type: "mrkdwn", text: " " }, accessory: buttons[0] }]
      : [...(footer ? [{ type: "context", elements: [text] }] : []), { type: "actions", elements: buttons }];
    try {
      await client.chat.postMessage({
        channel,
        ...thread,
        text: footer || "Menu: Files, Variables, Settings",
        blocks,
      });
    } catch (error) {
      if (!isSlackInvalidBlocksError(error)) throw error;
      // Controls are cosmetic. If Slack rejects their Block Kit, keep the completed answer a
      // success and preserve its stats in a plain-text trailer instead of surfacing run_error.
      if (footer) await client.chat.postMessage({ channel, ...thread, text: footer });
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

export { createRunQueue, QUEUE_FULL } from "../gateway/thread-turn-queue.ts";

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
// model-id families (Claude: opus/sonnet/haiku aliases + claude-*; Codex: gpt-*, o<n>*, codex*;
// Qwen: the QwenCloud catalog's own families — qwen*/glm-*/deepseek-*/kimi-*/minimax-*/auto, which
// a live `/models` fetch can extend at any time, so the shape is a family match, not a fixed list).
const MODEL_RE = /^(?:best|fable|haiku|opusplan|opus|sonnet|(?:opus|sonnet)\[1m\]|claude-[a-z0-9][a-z0-9.[\]-]*|gpt-[a-z0-9][a-z0-9.-]*|o[0-9][a-z0-9.-]*|codex(?:-[a-z0-9.-]+)?|auto|qwen[0-9][a-z0-9._-]*|qwen-[a-z0-9._-]+|glm-[a-z0-9._-]+|deepseek-[a-z0-9._-]+|kimi-[a-z0-9._-]+|minimax-[a-z0-9._-]+|[a-z0-9._-]+\/[a-z0-9._:/-]+)$/;
export function isValidModel(value) {
  const v = String(value || "").trim().toLowerCase();
  // Bedrock model/inference-profile IDs are a different vocabulary, with version colons and
  // optional account ARNs. This is a shape gate; the selected adapter still validates ownership.
  if (v.length <= 2048 && /^(?:arn:aws(?:-us-gov)?:bedrock:[a-z0-9-]+:\d{12}:(?:application-)?inference-profile\/[a-z0-9._:-]+|(?:(?:us|eu|apac|global|us-gov)\.)?anthropic\.claude-[a-z0-9][a-z0-9.:_-]*(?:\[1m\])?)$/.test(v)) return true;
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
