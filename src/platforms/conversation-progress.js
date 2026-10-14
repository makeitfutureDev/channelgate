import { modelLabel } from "../gateway/model-info.js";
import { engineLabel } from "../engines/registry.js";

// Show identifiers only: tool arguments, results and reasoning payloads never belong in status.
function identifier(value) {
  return String(value || "").replace(/[^a-zA-Z0-9 ._:[\]-]/g, "").trim().slice(0, 160);
}

function toolName(name) {
  const value = identifier(name) || "tool";
  if (!value.startsWith("mcp__")) return value;
  const [server, ...tool] = value.slice(5).split("__");
  return [server, tool.join("__")].filter(Boolean).join(" · ");
}

// One write in flight and one coalesced latest status. Heartbeats continue every 30 seconds;
// phase changes arrive sooner, bounded by both a conservative floor and the surface edit budget.
// Stop discards queued status and drains the current write before the final answer can replace it.
export function createConversationProgress({ connector, message, placeholder, adapter, log = console, intervalMs = 30000, now = Date.now }) {
  // Teams keeps only its initial working placeholder, replaced by the final answer, and proves
  // liveness with its typing indicator. Detailed status must never become a separate reply block.
  // A working-style surface WITHOUT a typing indicator (Google Chat) keeps the same placeholder but
  // edits a compact heartbeat into it below: a static line would look exactly like a dead run.
  const working = connector.progressStyle === 'working';
  if (adapter.id === "msteams" || (working && typeof connector.typing === "function")) {
    let stopped = false;
    let pending = null;
    let timer = null;
    const controller = new AbortController();
    const typing = () => {
      if (stopped || pending || typeof connector.typing !== "function") return;
      pending = Promise.resolve().then(() => {
        if (!stopped) return connector.typing({ conversationId: message.rawConversationId,
          threadKey: message.threadKey, signal: controller.signal });
      }).catch(err => {
        if (!stopped) {
          // A client/tenant without typing support still has the visible working placeholder.
          log.warn?.(`[${adapter.id}] typing indicator unavailable: ${err?.message || err}`);
          stopped = true;
          if (timer) clearInterval(timer);
        }
      }).finally(() => { pending = null; });
    };
    if (typeof connector.typing === "function") {
      typing();
      // Typing is transient. Refresh without overlap and within the per-thread request budget.
      timer = setInterval(typing, 4000);
      timer.unref?.();
    }
    return { phase() {}, activity() {}, runtime() {}, event() {}, async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      controller.abort();
      await pending;
    } };
  }

  const started = now();
  const minGap = Math.max(3000, 1000 / (adapter.capabilities.editsPerSecond || 1));
  let lastActivity = started;
  let lastWrite = -Infinity;
  let state = "Working";
  let runtime = "";
  let pending = Promise.resolve();
  let updating = false;
  let stopped = false;
  let dirty = false;
  let scheduled = null;
  const agents = new Set();
  const aliases = new Map();

  const update = () => {
    if (stopped) return;
    // A working-style heartbeat only ever edits its own placeholder; it never posts a new block.
    if (working && !(placeholder?.messageId && adapter.capabilities.messageEdit)) return;
    dirty = true;
    if (updating || scheduled) return;
    const delay = minGap - (now() - lastWrite);
    if (delay > 0) {
      scheduled = setTimeout(() => { scheduled = null; update(); }, delay);
      scheduled.unref?.();
      return;
    }
    const elapsed = Math.floor((now() - started) / 1000), quiet = Math.floor((now() - lastActivity) / 1000);
    const text = working
      ? `⏳ Agent is working — ${state}${runtime ? ` · ${runtime}` : ""} · ${elapsed}s elapsed · last activity ${quiet}s ago${agents.size ? ` · ${agents.size} subagent(s) running` : ""}. Still connected.`
      : `${runtime ? `${runtime} · ` : ""}${state} — ${elapsed}s elapsed; last activity ${quiet}s ago; ${agents.size} subagent(s) running. Still connected.`;
    const chunk = adapter.formatOutbound(text).chunks[0] || { text };
    dirty = false;
    lastWrite = now();
    updating = true;
    pending = Promise.resolve().then(() => placeholder?.messageId && adapter.capabilities.messageEdit
      ? connector.edit({ conversationId: placeholder.conversationId || message.rawConversationId, messageId: placeholder.messageId, text: chunk.text, mentions: chunk.mentions || [] })
      : connector.post({ conversationId: message.rawConversationId, threadKey: placeholder?.threadKey || message.threadKey, text: chunk.text, mentions: chunk.mentions || [] }))
      .catch((err) => log.warn?.(`[${adapter.id}] progress update failed: ${err?.message || err}`))
      .finally(() => { updating = false; if (dirty) update(); });
  };
  const phase = (label) => {
    if (stopped) return;
    lastActivity = now();
    if (state === label) return;
    state = label;
    update();
  };
  const timer = setInterval(update, Math.max(30000, intervalMs));
  timer.unref?.();
  return {
    phase,
    activity() { phase("Working"); },
    runtime({ engine = "", model = "" } = {}) {
      if (stopped || (!engine && !model)) return;
      runtime = identifier(model ? modelLabel({ engine, model }) : `${engineLabel(engine) || engine} CLI default`);
      update();
    },
    event(event) {
      if (stopped) return;
      if (event?.kind === "agent_activity") {
        const identities = [event.id, ...(event.aliasIds || [])].filter(Boolean).map(String);
        const key = identities.map((id) => aliases.get(id)).find(Boolean) || identities[0] || String(event.name || "agent");
        for (const id of identities) aliases.set(id, key);
        if (event.status === "running") agents.add(key); else agents.delete(key);
      }
      if (event?.kind === "tool_use") phase(`Using ${toolName(event.name)}`);
      else if (event?.kind === "tool_result") phase(`${event.status === "failed" ? "Error in" : "Finished"} ${toolName(event.name)}`);
      else if (event?.kind === "thinking") phase("Thinking");
      else if (event?.kind === "run_queued") phase(`Waiting for a gateway run slot (position ${Number(event.position) || 1})`);
      else if (["notice", "quiet", "engine_note"].includes(event?.kind)) phase("Working; waiting for the engine");
      else if (event?.kind === "agent_activity") { phase("Working"); update(); }
      else lastActivity = now();
    },
    async stop() {
      stopped = true;
      dirty = false;
      clearInterval(timer);
      if (scheduled) clearTimeout(scheduled);
      scheduled = null;
      await pending;
    },
  };
}
