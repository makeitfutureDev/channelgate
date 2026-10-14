// Cards carry values only. The Google event supplies the actor/space; opaque state owns scope.
import { randomUUID } from 'node:crypto';
import { getPublicUrl } from '../../config/settings.js';
import { getChannelEntry, getChannelMeta, getUser, setUser } from '../../config/store.js';
import { acquireKeyedLock } from '../../util/keyed-lock.js';
import { normalizeRelativePath, listVisibleDirectory, resolveVisiblePath, canEditChannelFiles, readEditableFile, PREVIEW_BYTES, formatFileSize } from '../../slack/file-explorer.js';
import { effectiveMeta } from '../../gateway/run.js';
import { openConfinedFile } from '../../gateway/confined-file.js';
import { docxText, DOCX_MAX_FILE_BYTES } from '../../util/docx-text.js';
import { createFileDownloadGrantUrl } from '../../web/file-download.js';
import { createFileEditorGrantUrl, BROWSER_EDIT_MAX_CHARS, BROWSER_EDIT_MAX_BYTES } from '../../web/file-editor.js';
import { createFileUploadGrantUrl } from '../../web/file-upload.js';
import { createConversationSettingsGrantUrl } from '../../web/conversation-settings.js';
import { rememberReplySession } from '../reply-sessions.js';
import { googleChatWorkspaceContext } from './workspace-access.js';
import { isSpaceName, isMessageName, isThreadName } from './api.js';
import { chatText, chatButtons, chatAction, chatLink, chatCard, controlError, GoogleChatControlError } from './cards.js';
import { GOOGLE_CHAT_HELP_TEXT, createGoogleChatHelpCard } from './help.js';
import { buildGoogleChatSettings, handleGoogleChatSettings } from './settings.js';
import { verifyMenuAction } from './reply-menu.js';
import { handlePlatformApproval } from '../../slack/approvals.js';

const FORMS = /^(?:(?:channel|thread)_(?:engine|model|effort)|access_(?:mode|access|manageAccess|autoMode|cleanMode|allowNetwork|allowedUsers|managers)|skillTemplate|resumeCommand|scope|comment)$/;
export function googleChatActionData(event) {
  const fn = event.action?.function;
  if (typeof fn !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(fn)) throw new Error('Invalid card action.');
  const supplied = event.action?.parameters || {};
  const parameters = Array.isArray(supplied) ? Object.fromEntries(supplied.map(item => [item.key, item.value])) : supplied;
  if (Buffer.byteLength(JSON.stringify(parameters)) > 16_384) throw new Error('Invalid card values.');
  const data = Object.create(null);
  const reserved = new Set(['__proto__', 'constructor', 'prototype', 'actorId', 'userId', 'ownerId', 'channelId', 'conversationId', 'threadKey']);
  for (const [key, value] of Object.entries(parameters)) {
    if (reserved.has(key) || key === 'cgAction' || typeof value !== 'string' || value.length > 8000) continue;
    if (key === 'stateId') { data[key] = value; continue; }
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new Error('Invalid card parameter.'); }
    if (parsed !== null && !['string', 'number', 'boolean'].includes(typeof parsed)) throw new Error('Card values must be scalar.');
    data[key] = parsed;
  }
  const ignoreInputs = data.cgInputs === 'none';
  delete data.cgInputs;
  for (const [key, input] of Object.entries(ignoreInputs ? {} : event.formInputs || event.commonEventObject?.formInputs || {})) {
    if (!FORMS.test(key)) continue;
    const values = input?.stringInputs?.value;
    if (!Array.isArray(values) || values.length > 100 || values.some(value => typeof value !== 'string' || value.length > 8000)) throw new Error('Invalid card form.');
    data[key] = values.join(',');
  }
  return { action: fn, data };
}

// Deliberate guidance (ours, the shared file explorer's, the settings policy's) is shown to the
// requester. System and REST errors carry host paths or Google response bodies: never shown.
const GENERIC_FAILURE = 'Reopen the controls or retry the original request in this conversation to check your access and try again.';
export function googleChatControlMessage(error) {
  if (error instanceof GoogleChatControlError) return error.message;
  if (error?.code === 'ENOENT') return 'That file or folder was not found in this workspace.';
  if (!(error instanceof Error) || error.code || error.status || error.constructor !== Error) return GENERIC_FAILURE;
  const message = String(error.message || '');
  return message && message.length <= 300 && !/[\r\n]/.test(message) && !/^Google Chat /.test(message) ? message : GENERIC_FAILURE;
}

export function createGoogleChatControls({ connector, authorize = googleChatWorkspaceContext, publicUrl = getPublicUrl, now = Date.now, log = console } = {}) {
  const states = new Map();
  const prune = () => { for (const [id, state] of states) if (state.expires <= now()) states.delete(id); while (states.size >= 500) states.delete(states.keys().next().value); };
  const grant = state => ({ channelId: state.message.conversationId, slug: state.entry.slug, ownerId: state.message.userId, threadTs: state.sessionKey });
  const ownerResource = state => state.message.raw?.senderName || state.message.userId;
  const linkBase = () => { const base = publicUrl(); if (!base) throw controlError('Set the gateway Public URL to enable browser downloads and private settings.'); return base; };
  async function rememberIdentity(userId, resource) {
    if (!resource || !/^users\/[A-Za-z0-9_-]+$/.test(resource) || !await getUser(userId)) return;
    await setUser(userId, { googleChatUserName: resource });
  }
  const fileAction = (label, action, id, data) => chatAction(label, `files.${action}`, id, data);
  async function files(state, id, context) {
    const listing = await listVisibleDirectory(context.root, normalizeRelativePath(state.relative || ''), { page: state.page || 0, pageSize: 12 });
    const widgets = [chatText(`Folder: /${listing.relative} — page ${listing.page + 1}/${listing.totalPages}`)];
    for (const item of listing.entries.filter(item => item.accessible !== false)) widgets.push(chatButtons([
      fileAction(`${item.type === 'directory' ? '📁' : '📄'} ${item.name}`, item.type === 'directory' ? 'browse' : 'preview', id, { relative: item.relative }),
    ]));
    const actions = [fileAction('Root', 'browse', id, { relative: '' })];
    if (listing.page) actions.push(fileAction('Previous', 'browse', id, { relative: listing.relative, page: listing.page - 1 }));
    if (listing.page + 1 < listing.totalPages) actions.push(fileAction('Next', 'browse', id, { relative: listing.relative, page: listing.page + 1 }));
    if (canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) actions.push(fileAction('Upload files', 'upload', id, { relative: listing.relative }));
    widgets.push(chatButtons(actions));
    return chatCard('Conversation files', widgets);
  }
  async function preview(state, id, context) {
    const target = await resolveVisiblePath(context.root, normalizeRelativePath(state.relative), { kind: 'file' });
    const opened = await openConfinedFile(context.root, target.relative);
    let bytes, document = null;
    try {
      const wholeDoc = /\.docx$/i.test(target.relative) && opened.stat.size <= DOCX_MAX_FILE_BYTES;
      const buffer = Buffer.alloc(wholeDoc ? opened.stat.size : Math.min(PREVIEW_BYTES, opened.stat.size));
      const result = await opened.handle.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, result.bytesRead);
      if (wholeDoc) { try { document = docxText(bytes); } catch { /* Download remains available. */ } }
    } finally { await opened.handle.close(); }
    const widgets = [chatText(target.relative), chatText(formatFileSize(opened.stat.size))];
    const binary = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|gz|7z|png|jpe?g|gif|webp|mp[34]|wav)$/i.test(target.relative) || bytes.some(byte => byte < 9 || byte > 13 && byte < 32);
    if (document !== null) widgets.push(chatText('Word text preview — formatting, images and layout are not shown. Download to open in Word.'), chatText((document || '(No document text)').slice(0, 2000)));
    else if (!binary) widgets.push(chatText(bytes.toString('utf8').replace(/\uFFFD$/, '').slice(0, 2000)), ...(opened.stat.size > 2000 ? [chatText('Preview truncated. Download the complete file.')] : []));
    else widgets.push(chatText('Download this document to open it in its application.'));
    const actions = [fileAction('Back to files', 'browse', id, { relative: target.relative.split('/').slice(0, -1).join('/') })];
    const baseUrl = publicUrl();
    if (baseUrl) {
      const input = { ...grant(state), relative: target.relative, baseUrl };
      actions.push(chatLink('Download', createFileDownloadGrantUrl(input)));
      if (!binary && canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) {
        try {
          const editable = await readEditableFile(context.root, target.relative, { maxChars: BROWSER_EDIT_MAX_CHARS, maxBytes: BROWSER_EDIT_MAX_BYTES, label: 'Browser editing' });
          actions.push(chatLink('Edit in browser', createFileEditorGrantUrl({ ...input, expectedHash: editable.hash })));
        } catch { widgets.push(chatText('This file is available for download; browser editing is unavailable.')); }
      }
    } else widgets.push(chatText('An administrator must set the gateway Public URL to enable downloads and browser editing.'));
    widgets.push(chatButtons(actions));
    return chatCard('File preview', widgets);
  }
  async function open(state, kind) {
    prune(); const id = randomUUID();
    state = { ...state, expires: now() + 15 * 60_000, kind, messageId: '' };
    await rememberIdentity(state.message.userId, state.message.raw?.senderName);
    const context = await authorize(grant(state), { connector });
    state.meta = context.meta;
    const card = kind === 'file' ? await preview(state, id, context) : kind === 'files' ? await files(state, id, context)
      : await buildGoogleChatSettings(state, id, { connector, authorize });
    states.set(id, state);
    try {
      const sent = await connector.postCard({ conversationId: state.message.rawConversationId, threadKey: state.message.threadKey,
        card, text: kind === 'file' || kind === 'files' ? 'Conversation files' : 'Conversation settings', privateTo: ownerResource(state) });
      state.messageId = sent?.messageId || '';
      rememberReplySession(state.message.conversationId, state.messageId, state.sessionKey);
      return sent;
    } catch (error) { states.delete(id); throw error; }
  }
  async function onCommand(args) {
    const command = /^\/(help|settings|model|files|sendfile|secrets)(?:\s+(.*))?$/is.exec(args.message.text.trim());
    if (!command || args.message.trigger === 'reaction') return false;
    const name = command[1].toLowerCase();
    if (name === 'model' && command[2]?.trim()) return false;
    if (name === 'help') {
      try { if (!args.replyCard) throw new Error('Cards unavailable'); await args.replyCard({ card: createGoogleChatHelpCard(), text: 'Google Chat help' }); }
      catch { await args.reply(GOOGLE_CHAT_HELP_TEXT); }
      return true;
    }
    try {
      if (name === 'sendfile' && !command[2]?.trim()) throw controlError('Use /sendfile followed by a workspace-relative file path.');
      await open({ ...args, tab: name === 'secrets' ? 'secrets' : 'general', relative: normalizeRelativePath(command[2]?.trim() || '') },
        name === 'sendfile' ? 'file' : name === 'files' ? 'files' : 'settings');
    } catch (error) { await args.reply(googleChatControlMessage(error)); }
    return true;
  }
  async function onCard(event) {
    // Fail closed: none of a forged form's identity/session fields can become a grant.
    if (!isSpaceName(event.rawConversationId) || event.conversationId !== `gchat:${event.rawConversationId}` || !event.userId
      || !isMessageName(event.messageId) || !event.messageId.startsWith(`${event.rawConversationId}/messages/`)
      || event.threadKey && (!isThreadName(event.threadKey) || !event.threadKey.startsWith(`${event.rawConversationId}/threads/`))) return;
    let release;
    try {
      const { action, data } = googleChatActionData(event);
      if (action === 'approval.respond') {
        const result = await handlePlatformApproval({ ...data, conversationId: event.conversationId, messageId: event.messageId, actorId: event.userId });
        // Teams answers the clicker with the shared policy's reason; the card itself stays live for
        // whoever may still decide it, so a refusal is private and never edits the shared card.
        if (!result.ok) throw controlError(`Approval unavailable: ${result.error || 'this request cannot be decided here.'}`);
        await connector.updateCard({ conversationId: event.rawConversationId, messageId: event.messageId,
          card: chatCard('Approval recorded', [chatText(result.outcome || 'Handled.')]), text: 'Approval recorded' });
        return;
      }
      if (action.startsWith('menu.')) {
        const sealed = verifyMenuAction(action, data);
        if (!sealed || sealed.conversationId !== event.rawConversationId || sealed.authorId && sealed.authorId !== event.userId) throw controlError('These buttons belong to the original requester and conversation.');
        const entry = await getChannelEntry(event.conversationId);
        const meta = entry && await getChannelMeta(entry.slug);
        if (!entry || !meta) throw controlError('Conversation no longer exists.');
        return await open({ message: { ...event, isDM: Boolean(meta.isDM), raw: { senderName: event.raw?.senderName || event.userResourceName || '' } },
          entry, meta, sessionKey: sealed.sessionKey, tab: sealed.kind === 'secrets' ? 'secrets' : 'general', relative: sealed.relative }, sealed.kind === 'file' ? 'file' : sealed.kind === 'files' ? 'files' : 'settings');
      }
      release = await acquireKeyedLock('googlechat-controls', data.stateId || '');
      prune(); const state = states.get(data.stateId);
      if (!state || state.message.userId !== event.userId || state.message.conversationId !== event.conversationId || state.messageId !== event.messageId) throw controlError('These controls expired or belong to another requester. Reopen them.');
      const context = await authorize(grant(state), { connector });
      state.meta = context.meta;
      let card;
      if (action === 'settings.private') {
        const url = createConversationSettingsGrantUrl({ ...grant(state), baseUrl: linkBase(), tab: data.page === 'mcp' ? 'mcp' : 'secrets' });
        card = chatCard('Private settings', [chatText('Enter credentials only in this private browser form.'), chatButtons([chatLink('Open private settings', url), chatAction('Back to settings', 'settings.page', data.stateId, { page: data.page === 'mcp' ? 'mcp' : 'secrets' })])]);
      } else if (action.startsWith('settings.')) card = await handleGoogleChatSettings(action, data, state, data.stateId, { connector, authorize });
      else if (action === 'files.browse' || action === 'files.preview') {
        state.relative = normalizeRelativePath(data.relative || '');
        if (data.page != null && (!Number.isSafeInteger(data.page) || data.page < 0)) throw controlError('Invalid file page.');
        state.page = data.page || 0;
        card = action === 'files.preview' ? await preview(state, data.stateId, context) : await files(state, data.stateId, context);
      } else if (action === 'files.upload') {
        if (!canEditChannelFiles(effectiveMeta(context.meta), { isAdminUser: context.userIsAdmin })) throw controlError('This workspace is read-only for you.');
        const relative = normalizeRelativePath(data.relative || '');
        await resolveVisiblePath(context.root, relative, { kind: 'directory' });
        card = chatCard('Upload files', [chatText('Files will be saved into this conversation workspace.'), chatButtons([
          chatLink('Open uploader', createFileUploadGrantUrl({ ...grant(state), baseUrl: linkBase(), relative })), fileAction('Back to files', 'browse', data.stateId, { relative }),
        ])]);
      } else throw new Error('Unsupported card action.');
      await connector.updateCard({ conversationId: event.rawConversationId, messageId: state.messageId, card, text: 'Conversation controls' });
    } catch (error) {
      log.warn?.('[googlechat] card action could not be completed');
      await connector.postCard({ conversationId: event.rawConversationId, threadKey: event.threadKey,
        privateTo: event.userResourceName || event.raw?.senderName || event.userId,
        card: chatCard('Action unavailable', [chatText(googleChatControlMessage(error))]), text: 'Action unavailable' }).catch(() => {});
    } finally { release?.(); }
  }
  async function shareFile({ channelId, slug, authorId, threadKey, relative }) {
    if (!channelId.startsWith('gchat:') || !threadKey) throw controlError('A current Google Chat conversation is required.');
    const entry = await getChannelEntry(channelId), meta = entry && await getChannelMeta(entry.slug);
    if (!entry || entry.slug !== slug || !meta) throw controlError('Conversation no longer exists.');
    linkBase();
    const user = await getUser(authorId);
    return open({ message: { conversationId: channelId, rawConversationId: channelId.slice(6), userId: authorId,
      threadKey: isThreadName(threadKey) ? threadKey : '', isDM: Boolean(meta.isDM), raw: { senderName: user?.googleChatUserName || '' } }, entry, meta, sessionKey: threadKey, relative: normalizeRelativePath(relative) }, 'file');
  }
  return { onCommand, onCard, shareFile, recordUser: message => rememberIdentity(message.userId, message.raw?.senderName), stop() { states.clear(); } };
}
