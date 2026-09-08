// Authorized text controls and a process-local lane per conversation/session. Engine/session
// persistence stays in the existing gateway stores; the lane only owns live work and cancellation.
import { clearSession } from '../gateway/sessions.js';
import { resolveThreadEngine, getThreadModel, getThreadEffort, setThreadEngine, setThreadModel, setThreadEffort } from '../gateway/thread-engine.js';
import { ENGINE_IDS, isEngineId, modelBelongsToEngine, effortBelongsToModel, effortsForModel, modelsForEngine } from '../engines/registry.js';
import { canChangeChannelRuntime, getDefaultModel } from '../config/settings.js';

export function createConversationControls() {
  const lanes = new Map();
  const keyFor = (message, sessionKey) => JSON.stringify([message.conversationId, sessionKey]);
  const laneFor = (key) => {
    if (!lanes.has(key)) lanes.set(key, { tail: Promise.resolve(), jobs: new Set(), clearing: false });
    return lanes.get(key);
  };
  return {
    async command({ message, sessionKey, slug, meta, authorIsAdmin, reply }) {
      // Reaction target text is content, never a second user's administrative command.
      if (message.trigger === 'reaction') return false;
      const match = /^\/(help|status|clear|stop|cancel|model|effort)(?:\s+(.*))?$/is.exec(message.text.trim());
      if (!match) return false;
      const [, name, raw = ''] = match;
      const command = name.toLowerCase();
      const arg = raw.trim();
      const key = keyFor(message, sessionKey);
      const lane = laneFor(key);
      const respond = async (text) => { await reply(text); return true; };
      try {
        if (command === 'help') return await respond('Commands: /help, /status, /stop (or /cancel), /clear, /model [engine] [model|default], /effort [level|default]. In a group chat, quote the message or bot reply to control its session and include the bot mention. A new unquoted group message starts a new session.');
        if (['stop', 'cancel', 'clear'].includes(command)) {
          if ([...lane.jobs].some((job) => job.author !== message.userId && !authorIsAdmin)) return await respond('Only the run author or an administrator may stop or clear another person’s active or queued work.');
          if (lane.clearing) return await respond('This session is already being cleared.');
          for (const job of lane.jobs) job.controller.abort();
          if (command !== 'clear') return await respond(lane.jobs.size ? 'Stop requested for this session’s active and queued work.' : 'No active work in this session.');
          lane.clearing = true;
          try {
            await reply('Clearing this session; waiting for its active work to stop…');
            // Bump before waiting as well as after: a late engine result must not resurrect it.
            await clearSession(slug, sessionKey);
            await lane.tail;
            await clearSession(slug, sessionKey);
            return await respond('Session cleared. Your next message in this session starts fresh.');
          } finally { lane.clearing = false; }
        }
        const engine = await resolveThreadEngine(slug, sessionKey, meta);
        const model = await getThreadModel(slug, sessionKey) || meta.model || getDefaultModel(engine);
        const effort = await getThreadEffort(slug, sessionKey) || meta.effort || '';
        if (command === 'status') return await respond(`Engine: ${engine}; model: ${model || 'engine default'}; effort: ${effort || 'engine default'}. ${lane.jobs.size ? `${lane.jobs.size} active/queued request(s).` : 'Idle.'}`);
        if (!arg) return await respond(command === 'model' ? `Engine: ${engine}; model: ${model || 'engine default'}. Engines: ${ENGINE_IDS.join(', ')}. Models: ${modelsForEngine(engine).map((item) => item.value).join(', ')}.` : `Effort: ${effort || 'engine default'}. Available: ${effortsForModel(engine, model).join(', ')}.`);
        if (!message.isDM && !canChangeChannelRuntime(authorIsAdmin)) return await respond('Runtime changes in this conversation are restricted to administrators.');
        if (lane.jobs.size || lane.clearing) return await respond('Wait for this session’s work to finish, or stop it, before changing its runtime.');
        if (command === 'effort') {
          const selected = arg === 'default' ? '' : arg.toLowerCase();
          if (!effortBelongsToModel(selected, engine, model)) return await respond(`Choose an effort from: ${effortsForModel(engine, model).join(', ')}, default.`);
          await setThreadEffort(slug, sessionKey, selected);
          return await respond(`Session effort: ${selected || 'inherited default'}.`);
        }
        const parts = arg.split(/\s+/);
        const selectedEngine = isEngineId(parts[0]) ? parts.shift() : engine;
        const selectedModel = parts.join(' ') === 'default' ? '' : parts.join(' ');
        if (parts.length > 1 || !modelBelongsToEngine(selectedModel, selectedEngine)) return await respond('Use /model [engine] [model|default] with a model belonging to that engine.');
        await setThreadEngine(slug, sessionKey, selectedEngine);
        await setThreadModel(slug, sessionKey, selectedModel);
        if (selectedEngine !== engine || !effortBelongsToModel(effort, selectedEngine, selectedModel)) await setThreadEffort(slug, sessionKey, '');
        return await respond(`Session engine: ${selectedEngine}; model: ${selectedModel || 'inherited default'}.`);
      } finally {
        if (!lane.jobs.size && !lane.clearing) lanes.delete(key);
      }
    },
    async execute({ message, sessionKey, queued, work }) {
      const key = keyFor(message, sessionKey);
      const lane = laneFor(key);
      if (lane.clearing) { await queued('This session is being cleared; send the message again after it finishes.'); return { skipped: 'clearing' }; }
      const controller = new AbortController();
      const job = { author: message.userId, controller };
      const predecessor = lane.tail;
      const position = lane.jobs.size;
      lane.jobs.add(job);
      let release;
      lane.tail = new Promise((resolve) => { release = resolve; });
      try {
        if (position) await queued(`Queued in this session (position ${position}).`);
        await predecessor;
        if (controller.signal.aborted) { await queued('Cancelled before starting.'); return { skipped: 'cancelled' }; }
        return await work(controller.signal);
      } finally {
        lane.jobs.delete(job);
        release();
        if (!lane.jobs.size && !lane.clearing) lanes.delete(key);
      }
    },
  };
}
