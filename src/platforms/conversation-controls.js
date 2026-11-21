import { assertEngineSelectable } from "../engines/selection.js";
// Authorized text controls and a process-local lane per conversation/session. Engine/session
// persistence stays in the existing gateway stores; the lane only owns live work and cancellation.
import { clearSession, getSessionEngine } from '../gateway/sessions.js';
import { resolveThreadEngine, getThreadEngine, getThreadModel, getThreadEffort, getThreadLicensePool, setThreadRuntimeOverrides, setThreadEffort } from '../gateway/thread-engine.js';
import { harnessOf, isEngineId, modelBelongsToEngine, effortBelongsToModel, effortsForModel, modelsForEngine } from '../engines/registry.js';
import { harnessLabel, isHarnessId } from '../engines/license-state.js';
import { getDefaultModel, getEngine, getEnginePool } from '../config/settings.js';
import { describeLicenseSelection, describeSelectionText, harnessSelection, licensePicker, resolveLicensePick, selectableHarnesses, selectableLicenses } from '../gateway/license-pool.js';
import { licenseListText, readLicenseChoice } from './license-choice.js';

// How a saved /model reply starts. The native pickers that drive /model and then /effort read it
// to tell a saved selection from a refusal, so the wording lives in one place.
export const SESSION_RUNTIME_SAVED = 'Session harness:';

export function createConversationControls() {
  const lanes = new Map();
  const keyFor = (message, sessionKey) => JSON.stringify([message.conversationId, sessionKey]);
  const laneFor = (key) => {
    if (!lanes.has(key)) lanes.set(key, { tail: Promise.resolve(), jobs: new Set(), clearing: false });
    return lanes.get(key);
  };
  return {
    // `picked` is the license step a native picker already ran for the harness its /model names
    // ({ license: "any" | id, also: [ids] }); typed text has no such step.
    async command({ message, sessionKey, slug, meta, authorIsAdmin, reply, pendingForSession = null, cancelPendingForSession = null, picked = null }) {
      // Reaction target text is content, never a second user's administrative command.
      const reactionStop = message.trigger === 'reaction' && message.reactionAction === 'stop';
      if (message.trigger === 'reaction' && !reactionStop) return false;
      const match = reactionStop ? ['', 'stop', ''] : /^\/(help|status|clear|stop|cancel|model|license|effort)(?:\s+(.*))?$/is.exec(message.text.trim());
      if (!match) return false;
      const [, name, raw = ''] = match;
      const command = name.toLowerCase();
      const arg = raw.trim();
      const key = keyFor(message, sessionKey);
      const lane = laneFor(key);
      const pending = await pendingForSession?.({ conversationId: message.conversationId, sessionKey }) || { count: 0, authors: [] };
      const respond = async (text) => { await reply(text); return true; };
      try {
        if (command === 'help') return await respond('Commands: /help, /status, /stop (or /cancel), /clear, /model [harness] [model|default], /license [any|name[, name…]|default], /effort [level|default]. In a group chat, quote the message or bot reply to control its session and include the bot mention. A new unquoted group message starts a new session.');
        if (['stop', 'cancel', 'clear'].includes(command)) {
          if (!authorIsAdmin && ([...lane.jobs].some(job => job.author !== message.userId)
            || pending.authors.some(author => author !== message.userId))) return await respond('Only the run author or an administrator may stop or clear another person’s active or queued work.');
          if (lane.clearing) return await respond('This session is already being cleared.');
          const cancelled = await cancelPendingForSession?.({ conversationId: message.conversationId, sessionKey, authorId: message.userId, authorIsAdmin });
          if (cancelled?.changed) return await respond('This session’s queue changed while checking it. Please repeat the command.');
          if (cancelled?.allowed === false) return await respond('Only the run author or an administrator may stop or clear another person’s active or queued work.');
          if (!authorIsAdmin && [...lane.jobs].some(job => job.author !== message.userId)) return await respond('Only the run author or an administrator may stop or clear another person’s active or queued work.');
          for (const job of lane.jobs) job.controller.abort();
          if (command !== 'clear') return await respond(lane.jobs.size || cancelled?.cancelled ? 'Stop requested for this session’s active and queued work.' : 'No active work in this session.');
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
        const [rawEngine, rawModel, rawEffort, rawPool] = await Promise.all([
          getThreadEngine(slug, sessionKey), getThreadModel(slug, sessionKey), getThreadEffort(slug, sessionKey), getThreadLicensePool(slug, sessionKey),
        ]);
        const expected = { engine: rawEngine, model: rawModel, effort: rawEffort };
        const engine = await resolveThreadEngine(slug, sessionKey, meta);
        // A selection is a license plus the licenses to move to when it fails, read from the level
        // that named it — the session's pin, else the conversation, else the gateway — in the
        // order a turn reads them (src/gateway/run.js).
        const inheritedPool = isEngineId(meta.engine) ? meta.licensePool : getEnginePool();
        const pool = rawEngine ? rawPool : inheritedPool;
        const harness = harnessOf(engine);
        const described = (selectedEngine = engine, selectedPool = pool) => describeSelectionText({ engine: selectedEngine, pool: selectedPool, meta }) || selectedEngine;
        const admit = async (selectedEngine) => assertEngineSelectable(selectedEngine, { channelId: meta.channelId || message.conversationId, meta });
        const busy = 'Wait for this session’s work to finish, or stop it, before changing its runtime.';
        const compatibleModel = (candidates, selectedEngine) => candidates.find(value => value && modelBelongsToEngine(value, selectedEngine)) || '';
        const model = compatibleModel([rawModel, meta.model, getDefaultModel(engine)], engine);
        const effort = [rawEffort, meta.effort].find(value => value && effortBelongsToModel(value, engine, model)) || '';
        const jobCount = lane.jobs.size + pending.count;
        if (command === 'status') return await respond(`Harness: ${described()}; model: ${model || 'engine default'}; effort: ${effort || 'engine default'}. ${jobCount ? `${jobCount} active/queued request(s).` : 'Idle.'}`);
        // The license step exists only when this harness has several licenses usable here.
        const picker = licensePicker({ harness, meta, engine, pool });
        const nothingToChoose = `${harnessLabel(harness)} has a single license here, so there is nothing to choose.`;
        const licenseList = `${harnessLabel(harness)} licenses here: ${licenseListText(picker.licenses)}.`;
        if (!arg) {
          if (command === 'model') return await respond(`Harness: ${described()}; model: ${model || 'engine default'}. Harnesses: ${selectableHarnesses(meta).map(id => `${harnessLabel(id)} (${id})`).join(', ')}. Models: ${modelsForEngine(engine).map((item) => item.value).join(', ')}.${picker.show ? ' Licenses: /license.' : ''}`);
          if (command === 'license') return await respond(picker.show
            ? `License selection: ${described()}. ${licenseList} Use /license any, /license <name, id or number>[, <more to move to when it fails>…], or /license default. When a license cannot answer, the turn moves to the next one.`
            : `License selection: ${described()}. ${nothingToChoose}`);
          return await respond(`Effort: ${effort || 'engine default'}. Available: ${effortsForModel(engine, model).join(', ')}.`);
        }
        if (jobCount || lane.clearing) return await respond(busy);
        if (command === 'effort') {
          const selected = arg === 'default' ? '' : arg.toLowerCase();
          if (!effortBelongsToModel(selected, engine, model)) return await respond(`Choose an effort from: ${effortsForModel(engine, model).join(', ')}, default.`);
          await setThreadEffort(slug, sessionKey, selected);
          return await respond(`Session effort: ${selected || 'inherited default'}.`);
        }
        const stillIdle = async () => {
          const currentPending = await pendingForSession?.({ conversationId: message.conversationId, sessionKey });
          return !(lane.jobs.size || lane.clearing || currentPending?.count);
        };
        if (command === 'license') {
          // `default` drops the session's pin: it follows the conversation again. Anything else
          // names licenses of the harness the session is on.
          const clearing = arg.toLowerCase() === 'default';
          let next = { engine: '', licensePool: '' };
          if (!clearing) {
            if (!picker.show) return await respond(nothingToChoose);
            const choice = readLicenseChoice(arg, picker.licenses);
            if (choice.error) return await respond(`${choice.error} ${licenseList}`);
            try { next = resolveLicensePick({ harness, meta, license: choice.license, also: choice.also }); } catch (error) { return await respond(error.message); }
            try { await admit(next.engine); } catch (error) { return await respond(error.message); }
          }
          // Without a pin the session keeps the engine its live session was born under, else the
          // conversation's (resolveThreadEngine's order below the pin).
          const minted = clearing ? await getSessionEngine(slug, sessionKey).catch(() => '') : '';
          const runs = next.engine || (isEngineId(minted) ? minted : isEngineId(meta.engine) ? meta.engine : getEngine());
          if (!await stillIdle()) return await respond(busy);
          // Model and effort stay only while they still belong to the license that will run.
          const keptModel = rawModel && modelBelongsToEngine(rawModel, runs) ? rawModel : '';
          const actualModel = compatibleModel([keptModel, meta.model, getDefaultModel(runs)], runs);
          const keptEffort = rawEffort && effortBelongsToModel(rawEffort, runs, actualModel) ? rawEffort : '';
          try { setThreadRuntimeOverrides(slug, sessionKey, { engine: next.engine, model: keptModel, effort: keptEffort, licensePool: next.licensePool }, { expected }); }
          catch (error) { return await respond(error.message); }
          return await respond(clearing ? `Session license: inherited default (${described(runs, inheritedPool)}).` : `Session license: ${described(next.engine, next.licensePool)}.`);
        }
        const parts = arg.split(/\s+/);
        // No harness word: the session stays on its selection and only the model changes. A harness
        // word is a bare harness pick (the conversation's own licenses for it); a license id pins
        // that one license.
        let selected = { engine, licensePool: describeLicenseSelection({ engine, pool }).pool };
        if (isHarnessId(parts[0])) {
          const wanted = parts.shift();
          if (!selectableLicenses(wanted, meta).length) {
            // No license of that harness can run here. Its own sign-in says why when it is the reason.
            try { await admit(wanted); } catch (error) { return await respond(error.message); }
            return await respond(`${harnessLabel(wanted)} has no license this conversation can use.`);
          }
          // A session somebody already pinned to a usable license of that harness keeps it: the
          // harness word names where it already is, not a request to trade its license for the
          // conversation's default one.
          const keepsPin = !picked && rawEngine && harnessOf(rawEngine) === wanted && selectableLicenses(wanted, meta).includes(rawEngine);
          try { selected = picked ? resolveLicensePick({ harness: wanted, meta, license: picked.license, also: picked.also }) : keepsPin ? { engine: rawEngine, licensePool: describeLicenseSelection({ engine: rawEngine, pool: rawPool }).pool } : harnessSelection(wanted, meta); }
          catch (error) { return await respond(error.message); }
        } else if (isEngineId(parts[0])) selected = { engine: parts.shift(), licensePool: '' };
        const selectedEngine = selected.engine;
        const selectedModel = parts.join(' ') === 'default' ? '' : parts.join(' ');
        if (parts.length > 1 || !modelBelongsToEngine(selectedModel, selectedEngine)) return await respond('Use /model [harness] [model|default] with a model belonging to that harness.');
        try { await admit(selectedEngine); } catch (error) { return await respond(error.message); }
        if (!await stillIdle()) return await respond(busy);
        const actualModel = compatibleModel([selectedModel, meta.model, getDefaultModel(selectedEngine)], selectedEngine);
        const selectedEffort = selectedEngine === engine && effortBelongsToModel(rawEffort, selectedEngine, actualModel) ? rawEffort : '';
        try { setThreadRuntimeOverrides(slug, sessionKey, { engine: selectedEngine, model: selectedModel, effort: selectedEffort, licensePool: selected.licensePool }, { expected }); }
        catch (error) { return await respond(error.message); }
        return await respond(`${SESSION_RUNTIME_SAVED} ${described(selectedEngine, selected.licensePool)}; model: ${selectedModel || 'inherited default'}.`);
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
