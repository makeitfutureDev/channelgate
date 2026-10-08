// Native Teams controls hold conversation/session authority server-side. Card data carries only
// an opaque, expiring state ID; editing the card payload cannot select another user's workspace.
import { randomUUID } from 'node:crypto';
import { getPublicUrl, canChangeChannelRuntime, getDefaultModel, getMentionReactions } from '../../config/settings.js';
import { modelsForEngine, effortsForModel, modelBelongsToEngine, engineLabel } from '../../engines/registry.js';
import { teamsWorkspaceContext } from './workspace-access.js';
import { listVisibleDirectory, normalizeRelativePath, canEditChannelFiles, readEditableFile } from '../../slack/file-explorer.js';
import { createFileDownloadGrantUrl } from '../../web/file-download.js';
import { createFileEditorGrantUrl } from '../../web/file-editor.js';
import { createFileUploadGrantUrl } from '../../web/file-upload.js';
import { createTeamsFileConsent } from './file-consent.js';
import { createTeamsInteractionHandler, normalizeTeamsInteraction } from './interactions.js';
import { handlePlatformApproval } from '../../slack/approvals.js';
import { acquireKeyedLock } from '../../util/keyed-lock.js';
import { buildTeamsSettings, createTeamsSettingsContext, handleTeamsSettings, teamsSettingsUi } from './settings.js';
import { generalRuntimeScopes } from './settings-general.js';
import { effectiveMeta } from '../../gateway/run.js';
import { teamsHelpText, createTeamsHelpCard } from './help.js';

const card = (title, body = [], actions = []) => ({ type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: title, weight: 'Bolder', wrap: true }, ...body], actions });
const text = value => ({ type: 'TextBlock', text: String(value), wrap: true });
const execute = (title, verb, stateId, data = {}) => ({ type: 'Action.Execute', title, verb, data: { cgAction: verb, stateId, ...data }, fallback: { type: 'Action.Submit', title, data: { cgAction: verb, stateId, ...data } } });
const link = (title, url) => ({ type: 'Action.OpenUrl', title, url });
const response = value => ({ status: 200, body: { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value } });

export function createTeamsControls({ connector, now = Date.now, authorize = teamsWorkspaceContext, approval = handlePlatformApproval, publicUrl = getPublicUrl } = {}) {
  const states = new Map();
  const consent = createTeamsFileConsent({ connector, now, authorizeWorkspace: ({ message, entry }) => authorize({ channelId: message.conversationId, ownerId: message.userId, slug: entry.slug }, { connector }) });
  const prune = () => { for (const [id, state] of states) if (state.expires < now()) states.delete(id); while (states.size > 500) states.delete(states.keys().next().value); };
  const grant = state => ({ channelId: state.message.conversationId, slug: state.entry.slug, ownerId: state.message.userId, threadTs: state.sessionKey });
  async function settings(state, stateId) {
    const ctx = createTeamsSettingsContext(state, { connector, authorize });
    await ctx.authorize();
    return buildTeamsSettings(ctx, stateId);
  }
  // Teams ChoiceSets send no change events, so one card cannot narrow the model list when the
  // engine changes. /model is two pages instead: 1. Engine → Next; 2. that engine's models and
  // efforts → Apply (← Back returns to page 1). The chosen engine is held server-side in the card
  // state, never read back from the page-2 submission.
  async function modelRuntime(state) {
    const context = await authorize(grant(state), { connector });
    state.meta = context.meta; state.authorIsAdmin = context.userIsAdmin;
    return generalRuntimeScopes({ meta: state.meta, entry: state.entry, sessionKey: state.sessionKey });
  }
  const modelSummary = current => text(`Current engine: ${current.engine}; model: ${current.model || 'engine default'}; effort: ${current.values.effort || 'inherited default'}.`);
  async function model(state, stateId) {
    const { thread: current, locked } = await modelRuntime(state);
    if (!state.message.isDM && !canChangeChannelRuntime(state.authorIsAdmin)) {
      return card('Session model', [modelSummary(current), text('Runtime changes in this conversation are restricted to administrators.')]);
    }
    // A conversation on its own Codex login has nothing to choose on page 1.
    if (locked) return modelPage(state, stateId, 'codex', { current, locked });
    const ui = teamsSettingsUi(stateId);
    const selected = current.engines.some(item => item.value === (state.pickedEngine || current.engine)) ? state.pickedEngine || current.engine : current.engines[0]?.value;
    return card('Session model — step 1 of 2', [modelSummary(current),
      text('Choose the engine, then Next to see only that engine’s models and effort levels. Use /settings → General for conversation defaults.'),
      ui.choice('engine', 'Engine', selected, current.engines)], [ui.execute('Next', 'model.next')]);
  }
  async function modelPage(state, stateId, engine, { current, locked }) {
    const ui = teamsSettingsUi(stateId);
    const models = [...modelsForEngine(engine)];
    const sameEngine = engine === current.engine;
    const savedModel = sameEngine && current.values.model && modelBelongsToEngine(current.values.model, engine) ? current.values.model : '';
    if (savedModel && !models.some(item => item.value === savedModel)) models.push({ value: savedModel, label: `Current: ${savedModel}` });
    const efforts = [...new Set([...effortsForModel(engine), ...models.flatMap(item => effortsForModel(engine, item.value))])];
    const savedEffort = sameEngine && efforts.includes(current.values.effort) ? current.values.effort : '';
    const body = [modelSummary(current), text(`Engine: ${engineLabel(engine)}${locked ? ' (locked to this conversation’s Codex login)' : ''}. Choose a model and effort, then Apply to this session. Changes apply to the next turn.`),
      ui.choice('model', 'Model', savedModel || 'default', [{ label: `${engineLabel(engine)} default`, value: 'default' }, ...models]),
      ui.choice('effort', 'Effort', savedEffort || 'default', [{ label: 'Inherited default', value: 'default' }, ...efforts.map(value => ({ label: value, value }))])];
    state.pickedEngine = engine;
    return card(locked ? 'Session model' : 'Session model — step 2 of 2', body, [
      ...(locked ? [] : [ui.execute('← Back', 'model.back', {}, 'none')]), ui.execute('Apply to this session', 'model.save', { engine })]);
  }
  async function files(state, stateId, relative = '', page = 0) {
    const context = await authorize(grant(state), { connector });
    const listing = await listVisibleDirectory(context.root, normalizeRelativePath(relative), { page, pageSize: 12 });
    const body = [text(`Folder: /${listing.relative} — page ${listing.page + 1}/${listing.totalPages}`)];
    for (const file of listing.entries.filter(item => item.accessible !== false)) {
      body.push({ type: 'ActionSet', actions: [execute(`${file.type === 'directory' ? '📁' : '📄'} ${file.name}`.slice(0, 80), file.type === 'directory' ? 'files.browse' : 'files.download', stateId, { relative: file.relative })] });
    }
    const actions = [execute('Root', 'files.browse', stateId)];
    if (listing.page) actions.push(execute('Previous', 'files.browse', stateId, { relative: listing.relative, page: listing.page - 1 }));
    if (listing.page + 1 < listing.totalPages) actions.push(execute('Next', 'files.browse', stateId, { relative: listing.relative, page: listing.page + 1 }));
    if (canEditChannelFiles(context.meta, { isAdminUser: context.userIsAdmin })) actions.push(execute('Upload files', 'files.upload', stateId, { relative: listing.relative }));
    return card('Conversation files (private)', body, actions);
  }
  async function deliverCard(state, build, inConversation = false) {
    const destination = inConversation || state.message.isDM ? state.message.rawConversationId : await connector.openDm(state.message.userId);
    if (!destination) throw new Error('Open a personal chat with the bot first; private controls could not be delivered.');
    prune(); const id = randomUUID();
    state = { ...state, deliveryId: destination, inConversation, expires: now() + 15 * 60_000 };
    states.set(id, state);
    try {
      const payload = { card: await build(state, id), text: state.modelCommand ? 'Session model settings' : inConversation ? 'Conversation settings' : 'Private conversation controls' };
      const posted = inConversation && state.replyCard ? await state.replyCard(payload)
        : await connector.postCard({ conversationId: destination, threadKey: inConversation ? state.message.threadKey : undefined, ...payload });
      state.messageId = posted?.messageId || '';
    }
    catch (error) { states.delete(id); throw error; }
  }
  async function onCommand(args) {
    const { message, reply } = args;
    if (message.trigger === 'reaction') return false;
    if (message.text.trim().toLowerCase() === '/help') {
      if (args.replyCard) {
        try {
          await args.replyCard({ card: createTeamsHelpCard(getMentionReactions('msteams')), text: 'Teams help' });
          return true;
        } catch { /* Keep the full, spaced guide available if native card delivery fails. */ }
      }
      await reply(teamsHelpText(getMentionReactions('msteams')));
      return true;
    }
    if (message.text.trim().toLowerCase() === '/model') {
      try {
        const recipient = message.raw?.activity?.recipient?.id;
        if (recipient && connector.botId && recipient !== connector.botId) throw new Error('This command is addressed to a different bot.');
        await deliverCard({ ...args, modelCommand: true }, model, true);
      }
      catch (error) { await reply(`${error.message} You can change this session with /model <engine> <model|default> and /effort <level|default>.`); }
      return true;
    }
    const match = /^\/(settings|files|secrets|sendfile)(?:\s+(.*))?$/is.exec(message.text.trim());
    if (!match) return false;
    try {
      if (match[1].toLowerCase() === 'sendfile') {
        if (!match[2]?.trim()) throw new Error('Use /sendfile followed by a workspace-relative file path.');
        await consent.send({ ...args, relative: normalizeRelativePath(match[2].trim()) });
        await reply('Check your personal chat to accept or decline the file.');
        return true;
      }
      const command = match[1].toLowerCase();
      // Settings stay with the conversation/session that opened them. File controls remain private.
      const inConversation = command !== 'files';
      const recipient = message.raw?.activity?.recipient?.id;
      if (inConversation && recipient && connector.botId && recipient !== connector.botId) {
        throw new Error('This command is addressed to a different bot. Check the Teams app registration and messaging endpoint.');
      }
      await deliverCard({ ...args, sharedSettings: inConversation && !message.isDM, tab: command === 'secrets' ? 'secrets' : '' },
        (state, id) => command === 'files' ? files(state, id, match[2] || '') : settings(state, id), inConversation);
      if (!message.isDM && !inConversation) await reply('I sent the controls to your personal chat.');
    } catch (error) { await reply(error.message); }
    return true;
  }
  const dispatchInvoke = createTeamsInteractionHandler({ dispatch: async interaction => {
    if (interaction.action === 'approval.respond') {
      const result = await approval({ ...interaction.data, conversationId: interaction.conversationId, messageId: interaction.responseMessageId, actorId: interaction.actorId });
      return response(card(result.ok ? 'Approval recorded' : 'Approval unavailable', [text(result.outcome || result.error || 'Handled.')]));
    }
    prune(); const state = states.get(interaction.data.stateId);
    if (!state || state.message.userId !== interaction.actorId || state.deliveryId !== interaction.nativeConversationId) throw new Error('These controls expired or belong to a different conversation/user. Reopen them.');
    if (interaction.action.startsWith('settings.')) {
      const release = await acquireKeyedLock('teams-settings-card', interaction.data.stateId);
      try {
        prune();
        if (states.get(interaction.data.stateId) !== state) throw new Error('These controls expired. Reopen them.');
        const ctx = createTeamsSettingsContext(state, { connector, authorize });
        const updated = await handleTeamsSettings(interaction.action, interaction.data, ctx, interaction.data.stateId);
        // Updating the bot's stored card works for both Execute and Submit clients and avoids
        // depending on the client's user-specific Execute response replacing a shared message.
        if (state.inConversation && state.messageId) await connector.updateCard({ conversationId: state.deliveryId,
          messageId: state.messageId, card: updated, text: 'Conversation settings' });
        return response(updated);
      } finally { release(); }
    }
    const context = await authorize(grant(state), { connector });
    state.meta = context.meta; state.authorIsAdmin = context.userIsAdmin;
    if (interaction.action === 'files.browse') return response(await files(state, interaction.data.stateId, interaction.data.relative || '', Number(interaction.data.page) || 0));
    const repaintModel = async updated => {
      if (state.inConversation && state.messageId) await connector.updateCard({ conversationId: state.deliveryId,
        messageId: state.messageId, card: updated, text: 'Session model settings' });
      return response(updated);
    };
    if (interaction.action === 'model.next' || interaction.action === 'model.back') {
      if (!state.message.isDM && !canChangeChannelRuntime(context.userIsAdmin)) throw new Error('Only administrators may change this conversation runtime.');
      if (interaction.action === 'model.back') return repaintModel(await model(state, interaction.data.stateId));
      const engine = interaction.data.engine;
      if (typeof engine !== 'string' || !engine || engine.length > 64) throw new Error('Choose an engine first.');
      const scopes = await generalRuntimeScopes({ meta: state.meta, entry: state.entry, sessionKey: state.sessionKey });
      if (!scopes.thread.engines.some(item => item.value === engine)) throw new Error('Choose an enabled engine.');
      return repaintModel(await modelPage(state, interaction.data.stateId, engine, { current: scopes.thread, locked: scopes.locked }));
    }
    if (interaction.action === 'model.save') {
      if (!state.message.isDM && !canChangeChannelRuntime(context.userIsAdmin)) throw new Error('Only administrators may change this conversation runtime.');
      // The page-2 card names its engine; it must still be the one this card's state holds.
      if (!state.pickedEngine || interaction.data.engine !== state.pickedEngine) throw new Error('Choose an engine and press Next first.');
      if (['model', 'effort'].some(field => typeof interaction.data[field] !== 'string' || !interaction.data[field] || interaction.data[field].length > 128)) throw new Error('Select a model and effort before applying.');
      const engine = state.pickedEngine, model = interaction.data.model === 'default' ? '' : String(interaction.data.model || ''), effort = interaction.data.effort === 'default' ? '' : String(interaction.data.effort || '');
      const { thread: current } = await generalRuntimeScopes({ meta: state.meta, entry: state.entry, sessionKey: state.sessionKey });
      const inheritedModel = effectiveMeta(state.meta).model;
      const actualModel = model || (modelBelongsToEngine(inheritedModel, engine) ? inheritedModel : '') || getDefaultModel(engine);
      if (!current.engines.some(item => item.value === engine) || (model && !modelBelongsToEngine(model, engine)) || (effort && !effortsForModel(engine, actualModel).includes(effort))) throw new Error('Select a compatible enabled engine, model, and effort.');
      if (states.get(interaction.data.stateId) !== state) throw new Error('These settings were already submitted. Reopen the controls.');
      states.delete(interaction.data.stateId);
      const replies = [];
      const command = async value => state.controls.command({ ...state, slug: state.entry.slug, message: { ...state.message, text: value }, reply: async value => replies.push(value) });
      await command(`/model ${engine} ${model || 'default'}`);
      // A busy-lane refusal must not be followed by another mutation.
      if (replies.at(-1)?.startsWith('Session engine:')) await command(`/effort ${effort || 'default'}`);
      return repaintModel(card('Session settings', replies.map(text)));
    }
    const baseUrl = publicUrl(); if (!baseUrl) throw new Error('Set the gateway Public URL before opening browser files.');
    const relative = normalizeRelativePath(interaction.data.relative || '');
    const input = { ...grant(state), baseUrl, relative };
    if (interaction.action === 'files.upload') {
      if (!canEditChannelFiles(context.meta, { isAdminUser: context.userIsAdmin })) throw new Error('This conversation is read-only for you.');
      return response(card('Upload files', [text('Files will be saved into this conversation workspace.')], [link('Open uploader', createFileUploadGrantUrl(input))]));
    }
    if (interaction.action === 'files.download') {
      const actions = [link('Download file', createFileDownloadGrantUrl(input))];
      if (canEditChannelFiles(context.meta, { isAdminUser: context.userIsAdmin })) {
        try { const editable = await readEditableFile(context.root, relative); actions.push(link('Edit file', createFileEditorGrantUrl({ ...input, expectedHash: editable.hash }))); } catch { /* binary/protected/large files are download only */ }
      }
      return response(card('File', [text(relative)], actions));
    }
    throw new Error('Unsupported Teams action.');
  } });
  async function onInvoke(activity) {
    if (activity.recipient?.id && connector.botId && activity.recipient.id !== connector.botId) {
      return response(card('Bot registration mismatch', [text('Reopen settings with the bot installed in this channel. An administrator must check its Teams app registration and messaging endpoint.')]));
    }
    if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') return consent.handle(activity);
    // Only an existing private card owned by this actor can receive a legacy replacement.
    // Capture its server-held destination before dispatch, which may consume the state.
    let privateSubmitState;
    if (activity.type === 'message') {
      try {
        const interaction = normalizeTeamsInteraction(activity);
        const state = states.get(interaction.data.stateId);
        if (state && !state.inConversation && state.expires >= now()
          && state.message.userId === interaction.actorId && state.deliveryId === interaction.nativeConversationId) {
          privateSubmitState = state;
        }
      } catch { /* Invalid submissions have no card-update authority. */ }
    }
    const result = await dispatchInvoke(activity);
    // Legacy Submit is a message activity: HTTP response cards are ignored by Teams clients.
    // Shared settings update inside their authorized dispatcher; private cards use stored IDs.
    if (activity.type === 'message' && result.body?.type === 'application/vnd.microsoft.card.adaptive') {
      if (privateSubmitState?.messageId && privateSubmitState.expires >= now()) {
        await connector.updateCard({ conversationId: privateSubmitState.deliveryId,
          messageId: privateSubmitState.messageId, card: result.body.value, text: 'Conversation controls' });
      }
      return { status: 200, body: {} };
    }
    return result;
  }
  return { onCommand, onInvoke, stop() { states.clear(); consent.stop(); } };
}
