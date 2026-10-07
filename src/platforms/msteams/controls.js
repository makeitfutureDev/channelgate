// Native Teams controls hold conversation/session authority server-side. Card data carries only
// an opaque, expiring state ID; editing the card payload cannot select another user's workspace.
import { randomUUID } from 'node:crypto';
import { getPublicUrl, canChangeChannelRuntime, getDefaultModel } from '../../config/settings.js';
import { ENGINE_IDS, modelsForEngine, effortsForModel } from '../../engines/registry.js';
import { teamsWorkspaceContext } from './workspace-access.js';
import { listVisibleDirectory, normalizeRelativePath, canEditChannelFiles, readEditableFile } from '../../slack/file-explorer.js';
import { createFileDownloadGrantUrl } from '../../web/file-download.js';
import { createFileEditorGrantUrl } from '../../web/file-editor.js';
import { createFileUploadGrantUrl } from '../../web/file-upload.js';
import { createTeamsFileConsent } from './file-consent.js';
import { createTeamsInteractionHandler, normalizeTeamsInteraction } from './interactions.js';
import { handlePlatformApproval } from '../../slack/approvals.js';
import { acquireKeyedLock } from '../../util/keyed-lock.js';
import { buildTeamsSettings, createTeamsSettingsContext, handleTeamsSettings } from './settings.js';
import { TEAMS_HELP_TEXT } from './help.js';

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
      const posted = await connector.postCard({ conversationId: destination, threadKey: inConversation ? state.message.threadKey : undefined,
        card: await build(state, id), text: inConversation ? 'Conversation settings' : 'Private conversation controls' });
      state.messageId = posted?.messageId || '';
    }
    catch (error) { states.delete(id); throw error; }
  }
  async function onCommand(args) {
    const { message, reply } = args;
    if (message.trigger === 'reaction') return false;
    if (message.text.trim().toLowerCase() === '/help') {
      await reply(TEAMS_HELP_TEXT);
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
    if (interaction.action === 'model.save') {
      if (!state.message.isDM && !canChangeChannelRuntime(context.userIsAdmin)) throw new Error('Only administrators may change this conversation runtime.');
      const engine = String(interaction.data.engine || ''), model = interaction.data.model === 'default' ? '' : String(interaction.data.model || ''), effort = interaction.data.effort === 'default' ? '' : String(interaction.data.effort || '');
      if (!ENGINE_IDS.includes(engine) || (model && !modelsForEngine(engine).some(item => item.value === model)) || (effort && !effortsForModel(engine, model || getDefaultModel(engine)).includes(effort))) throw new Error('Select a compatible engine, model, and effort.');
      if (states.get(interaction.data.stateId) !== state) throw new Error('These settings were already submitted. Reopen the controls.');
      states.delete(interaction.data.stateId);
      const replies = [];
      const command = async value => state.controls.command({ ...state, slug: state.entry.slug, message: { ...state.message, text: value }, reply: async value => replies.push(value) });
      await command(`/model ${engine} ${model || 'default'}`);
      // A busy-lane refusal must not be followed by another mutation.
      if (replies.at(-1)?.startsWith('Session engine:')) await command(`/effort ${effort || 'default'}`);
      return response(card('Session settings', replies.map(text)));
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
