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
    dirty = true;
    if (updating || scheduled) return;
    const delay = minGap - (now() - lastWrite);
    if (delay > 0) {
      scheduled = setTimeout(() => { scheduled = null; update(); }, delay);
      scheduled.unref?.();
      return;
    }
    const text = `${runtime ? `${runtime} · ` : ""}${state} — ${Math.floor((now() - started) / 1000)}s elapsed; last activity ${Math.floor((now() - lastActivity) / 1000)}s ago; ${agents.size} subagent(s) running. Still connected.`;
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
