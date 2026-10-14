import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createGoogleChatControls, googleChatActionData } = await import('../src/platforms/googlechat/controls.js');
const { replyMenuCard, menuActionData, verifyMenuAction } = await import('../src/platforms/googlechat/reply-menu.js');
const { googleChatWorkspaceContext } = await import('../src/platforms/googlechat/workspace-access.js');
const { setUser, getUser, upsertChannelEntry, saveChannelMeta, getChannelMeta, patchChannelMeta } = await import('../src/config/store.js');
const { getThreadEngine } = await import('../src/gateway/thread-engine.js');
const { formatChatOutbound } = await import('../src/platforms/format/gchat.js');
const { createConversationProgress } = await import('../src/platforms/conversation-progress.js');
const { modelsForEngine } = await import('../src/engines/registry.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'chat-controls-'));
await mkdir(path.join(root, 'docs'));
await writeFile(path.join(root, 'docs', 'guide.txt'), 'Example <text> preview');
await writeFile(path.join(root, 'large.txt'), 'a'.repeat(5500));
await writeFile(path.join(root, 'binary.pdf'), Buffer.from([0, 1, 2, 3]));
await symlink('/etc/passwd', path.join(root, 'outside.txt'));
let index = 0;
const buttons = card => card.sections.flatMap(section => section.widgets).flatMap(widget => widget.buttonList?.buttons || []);
const byAction = (card, action) => buttons(card).find(button => button.onClick?.action?.function === action);
async function fixture({ admin = true, mode = 'worker' } = {}) {
  const i = ++index, owner = `owner${i}@example.com`, raw = `spaces/control${i}`, channelId = `gchat:${raw}`;
  await setUser(owner, { approved: true, isAdmin: admin, googleChatUserName: `users/owner${i}` });
  const entry = await upsertChannelEntry(channelId, { name: 'Chat controls', platform: 'googlechat', type: 'channel', isDM: false });
  await saveChannelMeta(entry.slug, { channelId, platform: 'googlechat', access: 'approved', manageAccess: 'admins', mode, allowBash: mode === 'worker', engine: 'claude' });
  const posts = [], updates = [], grants = [];
  let authorized = true, now = 1000;
  const authorize = async grant => {
    grants.push(grant);
    if (!authorized) throw new Error('Revoked');
    return { root, entry, meta: await getChannelMeta(entry.slug), userIsAdmin: admin, userId: owner, members: [{ id: owner, name: 'Owner' }] };
  };
  const connector = { botUserId: 'users/bot', api: { listMembers: async () => [{ id: `users/owner${i}`, name: 'Owner' }] },
    postCard: async payload => { const result = { ...payload, messageId: `${raw}/messages/p${posts.length}` }; posts.push(result); return result; },
    updateCard: async payload => updates.push(payload) };
  const controls = createGoogleChatControls({ connector, authorize, now: () => now, publicUrl: () => 'https://gateway.example', log: { warn() {} } });
  const message = { conversationId: channelId, rawConversationId: raw, userId: owner, threadKey: `${raw}/threads/original`, raw: { senderName: `users/owner${i}` }, text: '/files' };
  const command = text => controls.onCommand({ message: { ...message, text }, entry, meta: {}, sessionKey: 'source-session', reply: async text => posts.push({ text }) });
  const click = (button, extra = {}, form = {}) => controls.onCard({ ...message,
    messageId: posts.find(post => post.card)?.messageId, action: button.onClick.action, formInputs: form, ...extra });
  return { controls, connector, posts, updates, grants, command, click, message, owner, entry, raw, revoke: () => { authorized = false; }, expire: () => { now += 16 * 60_000; } };
}
test('sealed reply menu survives new controls and rejects every changed authority field', () => {
  const fields = menuActionData({ kind: 'file', conversationId: 'spaces/source', sessionKey: 'original', authorId: 'owner', relative: 'docs/guide.txt' });
  assert.ok(verifyMenuAction('menu.file', fields));
  for (const [key, value] of [['k', 'files'], ['c', 'spaces/other'], ['u', 'other'], ['t', 'elsewhere'], ['p', '../secret'], ['s', 'forged']]) assert.equal(verifyMenuAction('menu.file', { ...fields, [key]: value }), null);
  const card = replyMenuCard({ footer: 'compact stats', menu: { conversationId: 'spaces/source', files: Array.from({ length: 6 }, (_, i) => ({ relative: `${i}.txt`, name: `${i}.txt` })) } });
  assert.equal(buttons(card).length, 6);
  assert.match(JSON.stringify(card.sections[0].widgets[0]), /compact stats/);
});
test('private file browsing, escaped preview, binary guidance and full browser edit limit', async () => {
  const f = await fixture();
  await f.command('/files docs');
  const first = f.posts[0];
  assert.equal(first.privateTo, f.message.raw.senderName);
  assert.equal(first.threadKey, f.message.threadKey);
  await f.click(byAction(first.card, 'files.preview'));
  const preview = f.updates.at(-1).card;
  assert.match(JSON.stringify(preview), /Example &lt;text&gt; preview/);
  assert.ok(buttons(preview).some(button => button.text === 'Download'));
  assert.ok(buttons(preview).some(button => button.text === 'Edit in browser'));
  assert.equal(f.grants.at(-1).threadTs, 'source-session');
  await f.command('/sendfile large.txt');
  assert.ok(buttons(f.posts.at(-1).card).some(button => button.text === 'Edit in browser'), 'files over the Slack modal limit remain editable in browser');
  await f.command('/sendfile binary.pdf');
  assert.ok(!buttons(f.posts.at(-1).card).some(button => button.text === 'Edit in browser'));
  await f.command('/sendfile outside.txt');
  assert.ok(!f.posts.at(-1).card, 'symlink escape never produces a preview/download');
});
test('wrong requester, space, source message, expired state and revoked access cannot repaint controls', async () => {
  const f = await fixture();
  await f.command('/files docs');
  const open = byAction(f.posts[0].card, 'files.preview');
  for (const extra of [{ userId: 'other@example.com' }, { conversationId: 'gchat:spaces/other', rawConversationId: 'spaces/other', messageId: 'spaces/other/messages/m', threadKey: '' }, { messageId: `${f.raw}/messages/other` }]) await f.click(open, extra);
  assert.equal(f.updates.length, 0);
  f.revoke(); await f.click(open);
  assert.equal(f.updates.length, 0);
  const expired = await fixture(); await expired.command('/files'); expired.expire(); await expired.click(byAction(expired.posts[0].card, 'files.preview'));
  assert.equal(expired.updates.length, 0);
});
test('read-only workspace never offers editing or uploads and rejects crafted upload action', async () => {
  const f = await fixture({ admin: false, mode: 'read' });
  await f.command('/files');
  assert.ok(!byAction(f.posts[0].card, 'files.upload'));
  const rootAction = byAction(f.posts[0].card, 'files.browse');
  await f.click({ onClick: { action: { ...rootAction.onClick.action, function: 'files.upload' } } });
  assert.equal(f.updates.length, 0);
  await f.command('/sendfile large.txt');
  assert.ok(!buttons(f.posts.at(-1).card).some(button => button.text === 'Edit in browser'));
});
test('old reply menu opens controls privately for only its sealed requester and source session', async () => {
  const f = await fixture();
  const menu = replyMenuCard({ menu: { conversationId: f.raw, sessionKey: 'original-session', authorId: f.owner } });
  const button = byAction(menu, 'menu.files');
  const event = { ...f.message, messageId: `${f.raw}/messages/answer`, action: button.onClick.action };
  await f.controls.onCard({ ...event, userId: 'another@example.com' });
  assert.equal(f.grants.length, 0);
  f.controls.stop(); await f.controls.onCard(event);
  assert.match(JSON.stringify(f.posts.at(-1).card), /large\.txt/);
  assert.equal(f.grants.at(-1).threadTs, 'original-session');
});
test('settings actions retain typed values, form selections and the source runtime scope', async () => {
  const f = await fixture(); await f.command('/model');
  const button = byAction(f.posts[0].card, 'settings.runtime.apply');
  const parsed = googleChatActionData({ action: button.onClick.action, formInputs: { channel_engine: { stringInputs: { value: ['codex'] } }, actorId: { stringInputs: { value: ['intruder'] } }, stateId: { stringInputs: { value: ['forged'] } } } });
  assert.equal(parsed.data.channel_engine, 'codex'); assert.equal(parsed.data.actorId, undefined); assert.notEqual(parsed.data.stateId, 'forged');
  await f.click(button, {}, { channel_engine: { stringInputs: { value: ['codex'] } }, channel_model: { stringInputs: { value: [modelsForEngine('codex')[0].value] } }, channel_effort: { stringInputs: { value: ['high'] } } });
  assert.equal((await getChannelMeta(f.entry.slug)).engine, 'codex');
  assert.equal(await getThreadEngine(f.entry.slug, 'source-session'), '');
});
test('membership and policy are repeated after roster I/O, including email-resource aliases', async () => {
  const f = await fixture();
  const context = await googleChatWorkspaceContext({ channelId: f.message.conversationId, slug: f.entry.slug, ownerId: f.owner }, { connector: f.connector });
  assert.equal(context.members[0].id, f.owner);
  f.connector.api.listMembers = async () => { await patchChannelMeta(f.entry.slug, { access: 'none' }); await setUser(f.owner, { isAdmin: false }); return [{ id: f.message.raw.senderName, name: 'Owner' }]; };
  await assert.rejects(googleChatWorkspaceContext({ channelId: f.message.conversationId, slug: f.entry.slug, ownerId: f.owner }, { connector: f.connector }), /no longer allowed/);
});
test('working-only progress adds no detailed replies and authenticated requester mention is inserted last', async () => {
  let writes = 0;
  const progress = createConversationProgress({ connector: { progressStyle: 'working', post: async () => writes++, edit: async () => writes++ }, adapter: { id: 'googlechat', capabilities: { editsPerSecond: 1 } }, message: {}, placeholder: {}, log: {} });
  progress.runtime({ engine: 'codex' }); progress.event({ type: 'tool_start', name: 'private tool' }); progress.phase('Working'); await progress.stop();
  assert.equal(writes, 0);
  const rendered = formatChatOutbound('Result <users/intruder>', { requester: { id: 'owner@example.com' } });
  assert.ok(!rendered.text.includes('<users/intruder>'));
  assert.ok(rendered.chunks.at(-1).text.endsWith('<users/owner@example.com>'));
});

test('unapproved intake records only trusted Chat identity so managers can select a scoped guest', async () => {
  const { createIngest } = await import('../src/platforms/ingest.js');
  const f = await fixture();
  f.connector.recordUser = f.controls.recordUser;
  f.connector.post = async () => ({ messageId: `${f.raw}/messages/refused` });
  const ingest = createIngest({ connector: { ...f.connector, platform: 'googlechat' }, run: async () => assert.fail('unapproved author must not run'), log: { info() {} } });
  const result = await ingest({ ...f.message, platform: 'googlechat', kind: 'channel', isDM: false, attachments: [], mentionsBot: true,
    messageId: `${f.raw}/messages/guest`, text: 'hello', userId: 'newguest@example.com', userName: 'Guest', raw: { senderName: 'users/newguest' } });
  assert.equal(result.skipped, 'unauthorized');
  assert.equal((await getUser('newguest@example.com')).googleChatUserName, 'users/newguest');
  f.connector.api.listMembers = async () => [{ id: f.message.raw.senderName, name: 'Owner' }, { id: 'users/newguest', name: 'Guest' }, { id: 'users/unknown', name: 'Unknown' }];
  const current = await googleChatWorkspaceContext({ channelId: f.message.conversationId, ownerId: f.owner, slug: f.entry.slug }, { connector: f.connector });
  assert.ok(current.members.some(member => member.id === 'newguest@example.com' && member.selectable));
  assert.ok(current.members.some(member => member.id === 'users/unknown' && !member.selectable));
});
