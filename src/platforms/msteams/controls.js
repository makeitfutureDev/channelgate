// Native Teams controls hold conversation/session authority server-side. Card data carries only
// an opaque, expiring state ID; editing the card payload cannot select another user's workspace.
import { randomUUID } from 'node:crypto';
import { getPublicUrl, canChangeChannelRuntime, getDefaultModel, getMentionReactions } from '../../config/settings.js';
import { modelsForEngine, effortsForModel, modelBelongsToEngine } from '../../engines/registry.js';
import { teamsWorkspaceContext } from './workspace-access.js';
import { listVisibleDirectory, normalizeRelativePath, canEditChannelFiles, readEditableFile, resolveVisiblePath, PREVIEW_BYTES, formatFileSize } from '../../slack/file-explorer.js';
import { createFileDownloadGrantUrl } from '../../web/file-download.js';
import { createFileEditorGrantUrl } from '../../web/file-editor.js';
import { createFileUploadGrantUrl } from '../../web/file-upload.js';
import { createTeamsFileConsent } from './file-consent.js';
import { createTeamsInteractionHandler, teamsCardErrorResponse } from './interactions.js';
import { handlePlatformApproval } from '../../slack/approvals.js';
import { acquireKeyedLock } from '../../util/keyed-lock.js';
import { buildTeamsSettings, createTeamsSettingsContext, handleTeamsSettings, teamsSettingsUi } from './settings.js';
import { generalRuntimeScopes } from './settings-general.js';
import { effectiveMeta } from '../../gateway/run.js';
import { teamsHelpText, createTeamsHelpCard } from './help.js';
import { settingsLauncher, filesLauncher, settingsDialogResponse } from './settings-dialog.js';
import { openConfinedFile } from '../../gateway/confined-file.js';
import { parseConversationId } from '../ids.js';

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
  // Teams ChoiceSets send no change events, so the card cannot narrow the model list on its own
  // when the engine changes. Like /settings → General, Load models repaints the card with the
  // chosen engine's models and efforts without saving; Apply saves. The engine whose models are
  // on the card is held server-side, and Apply must name that same engine.
  async function modelRuntime(state) {
    const context = await authorize(grant(state), { connector });
    state.meta = context.meta; state.authorIsAdmin = context.userIsAdmin;
    return generalRuntimeScopes({ meta: state.meta, entry: state.entry, sessionKey: state.sessionKey });
  }
  async function modelCard(state, stateId, { engine: requested = state.loadedEngine, draft = null, notice = '' } = {}) {
    const { thread: current, locked } = await modelRuntime(state);
    const summary = text(`Current engine: ${current.engine}; model: ${current.model || 'engine default'}; effort: ${current.values.effort || 'inherited default'}.`);
    if (!state.message.isDM && !canChangeChannelRuntime(state.authorIsAdmin)) {
      return card('Session model', [summary, text('Runtime changes in this conversation are restricted to administrators.')]);
    }
    const offered = value => current.engines.some(item => item.value === value);
    const engine = locked ? 'codex' : [requested, current.engine].find(offered) || current.engines[0]?.value;
    state.loadedEngine = engine;
    const ui = teamsSettingsUi(stateId);
    const models = [...modelsForEngine(engine)];
    // Keep the saved model and effort, or the ones chosen before Load models, while they still fit.
    const wanted = draft || (engine === current.engine ? current.values : {});
    const savedModel = wanted.model && wanted.model !== 'default' && modelBelongsToEngine(wanted.model, engine) ? wanted.model : '';
    if (savedModel && !models.some(item => item.value === savedModel)) models.push({ value: savedModel, label: `Current: ${savedModel}` });
    const efforts = [...new Set([...effortsForModel(engine), ...models.flatMap(item => effortsForModel(engine, item.value))])];
    const savedEffort = efforts.includes(wanted.effort) ? wanted.effort : '';
    const body = [summary, ...(notice ? [text(notice)] : []),
      text('Models are shown only for the selected engine. After changing Engine, use Load models, then choose model and effort and Apply to this session. Changes apply to the next turn. Use /settings → General for conversation defaults.'),
      ...(locked ? [text('Engine: Codex — locked to this conversation’s Codex login.')]
        : [ui.choice('engine', 'Engine', engine, current.engines), ui.buttons([ui.execute('Load models', 'model.load')])]),
      ui.choice('model', 'Model', savedModel || 'default', [{ label: 'Default model for selected engine', value: 'default' }, ...models]),
      ui.choice('effort', 'Effort', savedEffort || 'default', [{ label: 'Inherited default', value: 'default' }, ...efforts.map(value => ({ label: value, value }))])];
    // The action's engine is the locked card's only engine value; elsewhere the Engine input wins.
    return card('Session model', body, [ui.execute('Apply to this session', 'model.save', { engine })]);
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
    return card('Conversation files', body, actions);
  }
  async function fileDetails(state, relative, context, stateId) {
    const target = await resolveVisiblePath(context.root, relative, { kind: 'file' });
    const opened = await openConfinedFile(context.root, target.relative);
    let bytes;
    try {
      const buffer = Buffer.alloc(Math.min(PREVIEW_BYTES, opened.stat.size));
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally { await opened.handle.close(); }
    const body = [text(target.relative), text(formatFileSize(opened.stat.size))];
    const binary = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|gz|7z|png|jpe?g|gif|webp|mp[34]|wav)$/i.test(target.relative)
      || bytes.some(byte => byte < 9 || (byte > 13 && byte < 32));
    if (binary) body.push(text('This file has no text preview. Download it to open it in its application.'));
    else {
      body.push({ type: 'RichTextBlock', inlines: [{ type: 'TextRun', text: bytes.toString('utf8') || '(Empty file)', fontType: 'Monospace' }] });
      if (opened.stat.size > bytes.length) body.push(text(`Preview shows the first ${PREVIEW_BYTES.toLocaleString()} bytes; downloading returns the complete file.`));
    }
    const baseUrl = publicUrl();
    const input = { ...grant(state), baseUrl, relative: target.relative };
    const actions = baseUrl ? [link('Download file', createFileDownloadGrantUrl(input))] : [];
    if (!baseUrl) body.push(text('Set the gateway Public URL to enable downloads and browser editing.'));
    if (baseUrl && !binary && canEditChannelFiles(context.meta, { isAdminUser: context.userIsAdmin })) {
      try { const editable = await readEditableFile(context.root, target.relative); actions.push(link('Edit file', createFileEditorGrantUrl({ ...input, expectedHash: editable.hash }))); } catch { /* binary/protected/large files are download only */ }
    }
    actions.push(execute('Back to files', 'files.browse', stateId, { relative: target.relative.split('/').slice(0, -1).join('/') }));
    return card('File', body, actions);
  }
  const filesResponse = value => settingsDialogResponse(value, { title: 'Conversation files' });
  async function deliverCard(state, build) {
    const destination = state.message.rawConversationId;
    prune(); const id = randomUUID();
    state = { ...state, deliveryId: destination, inConversation: true, expires: now() + 15 * 60_000 };
    states.set(id, state);
    try {
      const payload = { card: await build(state, id), text: state.modelCommand ? 'Session model settings' : state.filesLauncher ? 'Conversation files' : 'Conversation settings' };
      const posted = state.replyCard ? await state.replyCard(payload)
        : await connector.postCard({ conversationId: destination, threadKey: state.message.threadKey, ...payload });
      state.messageId = posted?.messageId || '';
      if (!state.messageId) throw new Error('Teams returned no message identity for the file/settings controls.');
      return posted;
    }
    catch (error) { states.delete(id); throw error; }
  }
  async function shareFile({ channelId, slug, authorId, threadKey, relative }) {
    const parsed = parseConversationId(channelId);
    if (parsed.platform !== 'msteams' || !threadKey) throw new Error('A current Teams conversation is required.');
    if (!publicUrl()) throw new Error('Set the gateway Public URL to enable file downloads.');
    const context = await authorize({ channelId, slug, ownerId: authorId }, { connector });
    const target = await resolveVisiblePath(context.root, relative, { kind: 'file' });
    const state = { message: { conversationId: channelId, rawConversationId: parsed.id, userId: authorId, threadKey },
      entry: { slug }, sessionKey: threadKey, relative: target.relative, selectedFile: true, filesLauncher: true };
    return deliverCard(state, (_state, id) => filesLauncher(id, true));
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
        await deliverCard({ ...args, modelCommand: true }, modelCard);
      }
      catch (error) { await reply(`${error.message} You can change this session with /model <engine> <model|default> and /effort <level|default>.`); }
      return true;
    }
    const match = /^\/(settings|files|secrets|sendfile)(?:\s+(.*))?$/is.exec(message.text.trim());
    if (!match) return false;
    try {
      const command = match[1].toLowerCase();
      const recipient = message.raw?.activity?.recipient?.id;
      if (recipient && connector.botId && recipient !== connector.botId) {
        throw new Error('This command is addressed to a different bot. Check the Teams app registration and messaging endpoint.');
      }
      if (command === 'sendfile' && message.isDM) {
        if (!match[2]?.trim()) throw new Error('Use /sendfile followed by a workspace-relative file path.');
        await consent.send({ ...args, relative: normalizeRelativePath(match[2].trim()) });
        await reply('Accept or decline the file in this conversation.');
        return true;
      }
      const fileCommand = ['files', 'sendfile'].includes(command);
      if (command === 'sendfile' && !match[2]?.trim()) throw new Error('Use /sendfile followed by a workspace-relative file path.');
      const relative = fileCommand ? normalizeRelativePath(match[2]?.trim() || '') : '';
      await deliverCard({ ...args, settingsLauncher: !fileCommand, filesLauncher: fileCommand,
        relative, selectedFile: command === 'sendfile', tab: command === 'secrets' ? 'secrets' : 'general' },
        async (state, id) => {
          const context = await authorize(grant(state), { connector });
          if (fileCommand) {
            if (state.selectedFile) await resolveVisiblePath(context.root, relative, { kind: 'file' });
            return filesLauncher(id, state.selectedFile);
          }
          return settingsLauncher(id, state.entry.name);
        });
    } catch (error) { await reply(error.message); }
    return true;
  }
  const dispatchInvoke = createTeamsInteractionHandler({ dispatch: async interaction => {
    const taskInvoke = ['task/fetch', 'task/submit'].includes(interaction.invokeName);
    if (taskInvoke && !['settings.', 'files.'].some(prefix => interaction.action.startsWith(prefix))) throw new Error('Unsupported dialog action.');
    if (interaction.action === 'approval.respond') {
      const result = await approval({ ...interaction.data, conversationId: interaction.conversationId, messageId: interaction.responseMessageId, actorId: interaction.actorId });
      return response(card(result.ok ? 'Approval recorded' : 'Approval unavailable', [text(result.outcome || result.error || 'Handled.')]));
    }
    prune(); const state = states.get(interaction.data.stateId);
    if (!state || state.message.userId !== interaction.actorId || state.deliveryId !== interaction.nativeConversationId) throw new Error('These controls expired or belong to a different conversation/user. Reopen them.');
    const tenantId = state.message.raw?.tenantId;
    if ((state.settingsLauncher || state.settingsDialog || state.filesLauncher || state.filesDialog) && tenantId && interaction.tenantId !== tenantId) throw new Error('These controls belong to another tenant.');
    if (state.filesLauncher) {
      if (interaction.invokeName !== 'task/fetch' || interaction.action !== 'files.open') throw new Error('Open the files window first.');
      const context = await authorize(grant(state), { connector });
      const id = randomUUID();
      const dialog = { ...state, filesLauncher: false, filesDialog: true, inConversation: false,
        messageId: '', expires: now() + 15 * 60_000 };
      const result = filesResponse(state.selectedFile
        ? await fileDetails(dialog, state.relative, context, id) : await files(dialog, id, state.relative));
      prune(); states.set(id, dialog);
      return result;
    }
    if (state.settingsLauncher) {
      if (interaction.invokeName !== 'task/fetch' || interaction.action !== 'settings.open') throw new Error('Open the settings window first.');
      // Each opening gets separate private drafts/confirmations. The reusable chat launcher
      // never receives settings contents, even on clients using legacy Submit elsewhere.
      const id = randomUUID();
      const dialog = { ...state, settingsLauncher: false, settingsDialog: true, sharedSettings: false,
        inConversation: false, messageId: '', expires: now() + 15 * 60_000 };
      const result = settingsDialogResponse(await settings(dialog, id));
      prune(); states.set(id, dialog);
      return result;
    }
    if (state.settingsDialog && (interaction.invokeName !== 'task/submit' || !interaction.action.startsWith('settings.'))) throw new Error('Use the settings window.');
    if (state.filesDialog && (interaction.invokeName !== 'task/submit' || !interaction.action.startsWith('files.'))) throw new Error('Use the files window.');
    if (taskInvoke && !state.settingsDialog && !state.filesDialog) throw new Error('Invalid dialog window.');
    if (interaction.action.startsWith('settings.') && !state.settingsDialog) throw new Error('Open the settings window first.');
    if (interaction.action.startsWith('files.') && !state.filesDialog) throw new Error('Open the files window first.');
    if (interaction.action.startsWith('settings.')) {
      const release = await acquireKeyedLock('teams-settings-card', interaction.data.stateId);
      try {
        prune();
        if (states.get(interaction.data.stateId) !== state) throw new Error('These controls expired. Reopen them.');
        const ctx = createTeamsSettingsContext(state, { connector, authorize });
        const updated = await handleTeamsSettings(interaction.action, interaction.data, ctx, interaction.data.stateId);
        if (state.settingsDialog) return settingsDialogResponse(updated);
        // Updating the bot's stored card works for both Execute and Submit clients and avoids
        // depending on the client's user-specific Execute response replacing a shared message.
        if (state.inConversation && state.messageId) await connector.updateCard({ conversationId: state.deliveryId,
          messageId: state.messageId, card: updated, text: 'Conversation settings' });
        return response(updated);
      } finally { release(); }
    }
    const context = await authorize(grant(state), { connector });
    state.meta = context.meta; state.authorIsAdmin = context.userIsAdmin;
    if (interaction.action === 'files.browse') return filesResponse(await files(state, interaction.data.stateId, interaction.data.relative || '', Number(interaction.data.page) || 0));
    const repaintModel = async updated => {
      if (state.inConversation && state.messageId) await connector.updateCard({ conversationId: state.deliveryId,
        messageId: state.messageId, card: updated, text: 'Session model settings' });
      return response(updated);
    };
    if (interaction.action === 'model.load') {
      if (!state.message.isDM && !canChangeChannelRuntime(context.userIsAdmin)) throw new Error('Only administrators may change this conversation runtime.');
      const { engine, model: draftModel, effort } = interaction.data;
      if (typeof engine !== 'string' || !engine || engine.length > 64) throw new Error('Choose an engine first.');
      const scopes = await generalRuntimeScopes({ meta: state.meta, entry: state.entry, sessionKey: state.sessionKey });
      if (scopes.locked || !scopes.thread.engines.some(item => item.value === engine)) throw new Error('Choose an enabled engine.');
      const draft = engine === state.loadedEngine ? { model: String(draftModel || ''), effort: String(effort || '') } : {};
      return repaintModel(await modelCard(state, interaction.data.stateId, { engine, draft }));
    }
    if (interaction.action === 'model.save') {
      if (!state.message.isDM && !canChangeChannelRuntime(context.userIsAdmin)) throw new Error('Only administrators may change this conversation runtime.');
      if (!state.loadedEngine || typeof interaction.data.engine !== 'string') throw new Error('Reopen /model.');
      // Apply must name the engine whose models the card shows. A changed Engine without Load
      // models loads them instead of saving a model chosen from the other engine's list.
      if (interaction.data.engine !== state.loadedEngine) {
        const scopes = await generalRuntimeScopes({ meta: state.meta, entry: state.entry, sessionKey: state.sessionKey });
        if (scopes.locked || !scopes.thread.engines.some(item => item.value === interaction.data.engine)) throw new Error('Choose an enabled engine.');
        return repaintModel(await modelCard(state, interaction.data.stateId, { engine: interaction.data.engine, draft: {},
          notice: 'Engine changed, so its models were loaded and nothing was saved. Choose a model and effort, then Apply.' }));
      }
      if (['model', 'effort'].some(field => typeof interaction.data[field] !== 'string' || !interaction.data[field] || interaction.data[field].length > 128)) throw new Error('Select a model and effort before applying.');
      const engine = state.loadedEngine, model = interaction.data.model === 'default' ? '' : String(interaction.data.model || ''), effort = interaction.data.effort === 'default' ? '' : String(interaction.data.effort || '');
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
    const relative = normalizeRelativePath(interaction.data.relative || '');
    if (interaction.action === 'files.download') {
      return filesResponse(await fileDetails(state, relative, context, interaction.data.stateId));
    }
    const baseUrl = publicUrl(); if (!baseUrl) throw new Error('Set the gateway Public URL before opening browser files.');
    const input = { ...grant(state), baseUrl, relative };
    if (interaction.action === 'files.upload') {
      if (!canEditChannelFiles(context.meta, { isAdminUser: context.userIsAdmin })) throw new Error('This conversation is read-only for you.');
      return filesResponse(card('Upload files', [text('Files will be saved into this conversation workspace.')], [
        link('Open uploader', createFileUploadGrantUrl(input)), execute('Back to files', 'files.browse', interaction.data.stateId, { relative }),
      ]));
    }
    throw new Error('Unsupported Teams action.');
  } });
  async function onInvoke(activity) {
    if (activity.recipient?.id && connector.botId && activity.recipient.id !== connector.botId) {
      if (['task/fetch', 'task/submit'].includes(activity.name)) return teamsCardErrorResponse(activity, 403, 'Forbidden', 'Reopen settings with the bot installed in this conversation.');
      return response(card('Bot registration mismatch', [text('Reopen settings with the bot installed in this channel. An administrator must check its Teams app registration and messaging endpoint.')]));
    }
    if (activity.type === 'invoke' && activity.name === 'fileConsent/invoke') return consent.handle(activity);
    const result = await dispatchInvoke(activity);
    // Legacy Submit is a message activity: HTTP response cards are ignored by Teams clients.
    // Model cards update inside their authorized dispatcher; file/settings dialogs accept only
    // task invokes and never publish their contents through a legacy message replacement.
    if (activity.type === 'message' && result.body?.type === 'application/vnd.microsoft.card.adaptive') {
      return { status: 200, body: {} };
    }
    return result;
  }
  return { onCommand, onInvoke, shareFile, stop() { states.clear(); consent.stop(); } };
}
