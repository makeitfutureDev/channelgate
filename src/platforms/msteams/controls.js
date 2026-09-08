// Native Teams controls hold conversation/session authority server-side. Card data carries only
// an opaque, expiring state ID; editing the card payload cannot select another user's workspace.
import { randomUUID } from 'node:crypto';
import { getPublicUrl, canChangeChannelRuntime, getDefaultModel } from '../../config/settings.js';
import { ENGINE_IDS, modelsForEngine, effortsForModel } from '../../engines/registry.js';
import { resolveThreadEngine, getThreadModel, getThreadEffort } from '../../gateway/thread-engine.js';
import { teamsWorkspaceContext } from './workspace-access.js';
import { listVisibleDirectory, normalizeRelativePath, canEditChannelFiles, readEditableFile } from '../../slack/file-explorer.js';
import { createFileDownloadGrantUrl } from '../../web/file-download.js';
import { createFileEditorGrantUrl } from '../../web/file-editor.js';
import { createFileUploadGrantUrl } from '../../web/file-upload.js';
import { createTeamsFileConsent } from './file-consent.js';
import { createTeamsInteractionHandler } from './interactions.js';
import { handlePlatformApproval } from '../../slack/approvals.js';

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
    const engine = await resolveThreadEngine(state.entry.slug, state.sessionKey, state.meta);
    const model = await getThreadModel(state.entry.slug, state.sessionKey) || state.meta.model || getDefaultModel(engine);
    const effort = await getThreadEffort(state.entry.slug, state.sessionKey) || state.meta.effort || '';
    const body = [text('These controls apply to this session. Channel settings and secrets open in the authenticated admin website.'),
      { type: 'Input.ChoiceSet', id: 'engine', label: 'Engine', value: engine, choices: ENGINE_IDS.map(value => ({ title: value, value })) },
      { type: 'Input.ChoiceSet', id: 'model', label: 'Model (choose an engine-compatible model)', value: model || 'default', choices: [{ title: 'Inherited default', value: 'default' }, ...ENGINE_IDS.flatMap(id => modelsForEngine(id).map(item => ({ title: `${id}: ${item.label || item.value}`, value: item.value })))] },
      { type: 'Input.ChoiceSet', id: 'effort', label: 'Effort', value: effort || 'default', choices: [{ title: 'Inherited default', value: 'default' }, ...[...new Set(ENGINE_IDS.flatMap(id => modelsForEngine(id).flatMap(item => effortsForModel(id, item.value))))].map(value => ({ title: value, value }))] }];
    const actions = [execute('Save session settings', 'model.save', stateId)];
    const base = publicUrl(); if (base) actions.push(link('Channel settings and secrets', `${base}/conversations`));
    return card('Session settings', body, actions);
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
    state = { ...state, deliveryId: destination, expires: now() + 15 * 60_000 };
    states.set(id, state);
    try { await connector.postCard({ conversationId: destination, threadKey: inConversation ? state.message.threadKey : undefined, card: await build(state, id), text: inConversation ? 'Session settings' : 'Private conversation controls' }); }
    catch (error) { states.delete(id); throw error; }
  }
  async function onCommand(args) {
    const { message, reply } = args;
    if (message.trigger === 'reaction') return false;
    if (message.text.trim().toLowerCase() === '/help') {
      await reply('Commands: /settings (native session form), /files [folder], /secrets (authenticated settings), /sendfile <path> (personal file consent), /status, /model, /effort, /stop, /cancel, /clear. In group chats, quote the original message or bot reply and mention the bot to control that session. Voice notes require local Whisper.');
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
      const inConversation = match[1].toLowerCase() === 'settings';
      await deliverCard(args, (state, id) => match[1].toLowerCase() === 'files' ? files(state, id, match[2] || '') : settings(state, id), inConversation);
      if (!inConversation && !message.isDM) await reply('I sent the controls to your personal chat.');
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
    if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') return consent.handle(activity);
    const result = await dispatchInvoke(activity);
    // Legacy Submit is a message activity: HTTP response cards are ignored by Teams clients.
    // Deliver the replacement explicitly, only to the already verified interaction conversation.
    if (activity.type === 'message' && result.body?.type === 'application/vnd.microsoft.card.adaptive') {
      const destination = String(activity.conversation.id).split(';messageid=')[0];
      const update = { conversationId: destination, messageId: activity.replyToId, card: result.body.value, text: 'Conversation controls' };
      if (update.messageId) await connector.updateCard(update);
      else await connector.postCard(update);
      return { status: 200, body: {} };
    }
    return result;
  }
  return { onCommand, onInvoke, stop() { states.clear(); consent.stop(); } };
}
