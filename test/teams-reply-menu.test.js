// The Teams reply menu: 📂 Files · 🔑 Variables · ⚙️ Settings and per-file buttons under each
// answer. Buttons hold no server state, so they must survive restarts while still refusing a
// forged conversation, session, requester or path. No engine is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { replyMenuCard, menuActionData, verifyMenuAction, MAX_MENU_FILE_BUTTONS } = await import('../src/platforms/msteams/reply-menu.js');
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { createTeamsConnector } = await import('../src/platforms/msteams/connector.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { googleChatAdapter } = await import('../src/platforms/googlechat.js');
const { upsertChannelEntry, saveChannelMeta, defaultChannelMeta, setUser } = await import('../src/config/store.js');

const RAW = '19:menu-source@thread.v2';
const root = await mkdtemp(path.join(os.tmpdir(), 'teams-reply-menu-'));
await mkdir(path.join(root, 'docs'));
await writeFile(path.join(root, 'AGENTS.md'), '# Agents');
await writeFile(path.join(root, 'docs', 'guide.txt'), 'guide text');
await setUser('29:owner', { approved: true, isAdmin: true });
await setUser('29:other', { approved: true });
const entry = await upsertChannelEntry(`teams:${RAW}`, { name: 'Menu source', type: 'channel', isDM: false, platform: 'msteams' });
await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId: `teams:${RAW}`, name: 'Menu source', type: 'channel', isDM: false, platform: 'msteams' }), allowBash: true });

const menu = { conversationId: RAW, sessionKey: '1700000000001', authorId: '29:owner', files: [{ relative: 'AGENTS.md', name: 'AGENTS.md' }] };
const click = (data, { actor = '29:owner', conversation = `${RAW};messageid=1700000000001` } = {}) => ({
  type: 'invoke', name: 'task/fetch', id: 'invoke-1', replyToId: 'reply-1', from: { id: actor },
  conversation: { id: conversation, conversationType: 'channel' }, channelData: { tenant: { id: 'tenant-1' } },
  serviceUrl: 'https://smba.trafficmanager.net/teams/', value: { data },
});
const buttons = card => Object.fromEntries(card.actions.map(item => [item.title, item.data]));
function controlsFixture() {
  const seen = [];
  const controls = createTeamsControls({ connector: { api: { sendActivity: async () => ({ messageId: 'x' }) }, postCard: async () => ({ messageId: 'x' }) }, publicUrl: () => 'https://gateway.example',
    authorize: async grant => { seen.push(grant); return { root, meta: { allowBash: true }, userIsAdmin: grant.ownerId === '29:owner', entry }; } });
  return { controls, seen };
}
const dialog = result => { assert.equal(result.body.task?.type, 'continue', JSON.stringify(result.body)); return result.body.task.value.card.content; };
const refusal = result => { assert.equal(result.body.task?.value?.title, 'Action unavailable', JSON.stringify(result.body)); return JSON.stringify(result.body.task.value.card.content); };

test('the reply card puts the stats line above Files, Variables, Settings and capped file buttons', () => {
  const files = Array.from({ length: 6 }, (_, index) => ({ relative: `f${index}.md`, name: `f${index}.md` }));
  const card = replyMenuCard({ footer: 'Opus 5.5 · 12s', menu: { ...menu, files } });
  assert.equal(card.body.at(-1).text, 'Opus 5.5 · 12s');
  assert.deepEqual(card.actions.map(item => item.title), ['📂 Files', '🔑 Variables', '⚙️ Settings', ...files.slice(0, MAX_MENU_FILE_BUTTONS).map(file => `📄 ${file.name}`)]);
  for (const action of card.actions) {
    assert.equal(action.type, 'Action.Submit');
    assert.deepEqual(action.data.msteams, { type: 'task/fetch' });
  }
  assert.equal(replyMenuCard({ footer: 'stats only' }).actions, undefined, 'no menu means no buttons');
});

test('a sealed button verifies only with every field intact', () => {
  const data = menuActionData({ kind: 'file', conversationId: RAW, sessionKey: 's1', authorId: '29:owner', relative: 'AGENTS.md' });
  const { cgAction, msteams, ...fields } = data;
  assert.equal(cgAction, 'menu.file');
  assert.deepEqual(verifyMenuAction(cgAction, fields), { kind: 'file', conversationId: RAW, sessionKey: 's1', authorId: '29:owner', relative: 'AGENTS.md' });
  for (const [key, value] of [['c', '19:other@thread.v2'], ['t', 's2'], ['u', ''], ['p', '../outside'], ['k', 'files'], ['s', 'forged']]) {
    assert.equal(verifyMenuAction(cgAction, { ...fields, [key]: value }), null, `tampered ${key}`);
  }
  assert.equal(verifyMenuAction('menu.files', fields), null, 'a file button cannot be replayed as another kind');
});

test('Files and file buttons open the existing private file windows for the requester', async () => {
  const { controls, seen } = controlsFixture();
  const card = replyMenuCard({ menu });
  const listing = dialog(await controls.onInvoke(click(buttons(card)['📂 Files'])));
  assert.match(JSON.stringify(listing), /AGENTS\.md/);
  assert.deepEqual(seen[0], { channelId: `teams:${RAW}`, slug: entry.slug, ownerId: '29:owner', threadTs: '1700000000001' });
  const preview = dialog(await controls.onInvoke(click(buttons(card)['📄 AGENTS.md'])));
  assert.match(JSON.stringify(preview), /# Agents/);
  assert.ok(preview.actions.some(item => item.title === 'Back to files'));
  // The opened window keeps working through the ordinary dialog state.
  const back = preview.actions.find(item => item.title === 'Back to files').data;
  const browse = await controls.onInvoke({ ...click(back), name: 'task/submit' });
  assert.match(JSON.stringify(dialog(browse)), /docs/);
});

test('Variables and Settings open the settings window on the matching tab', async () => {
  const { controls } = controlsFixture();
  const card = replyMenuCard({ menu });
  const secrets = JSON.stringify(dialog(await controls.onInvoke(click(buttons(card)['🔑 Variables']))));
  const settings = JSON.stringify(dialog(await controls.onInvoke(click(buttons(card)['⚙️ Settings']))));
  assert.notEqual(secrets, settings);
  assert.match(settings, /Menu source/);
});

test('buttons survive a restart because they hold no server state', async () => {
  const card = replyMenuCard({ menu });
  const { controls } = controlsFixture();
  controls.stop();
  const fresh = controlsFixture();
  assert.match(JSON.stringify(dialog(await fresh.controls.onInvoke(click(buttons(card)['📂 Files'])))), /AGENTS\.md/);
});

test('another person, another conversation or a forged button is refused before any workspace access', async () => {
  const { controls, seen } = controlsFixture();
  const card = replyMenuCard({ menu });
  assert.match(refusal(await controls.onInvoke(click(buttons(card)['📂 Files'], { actor: '29:other' }))), /person who asked/);
  assert.match(refusal(await controls.onInvoke(click(buttons(card)['📂 Files'], { conversation: '19:elsewhere@thread.v2' }))), /different conversation/);
  const forged = { ...buttons(card)['📄 AGENTS.md'], p: 'docs/guide.txt' };
  assert.match(refusal(await controls.onInvoke(click(forged))), /different conversation/);
  const legacy = await controls.onInvoke({ ...click(buttons(card)['📂 Files']), type: 'message', name: undefined });
  assert.equal(legacy.body.task, undefined, 'legacy Submit never receives a file window');
  assert.equal(seen.length, 0);
});

test('an unbound automation menu opens for whoever clicks, with that person\'s own access', async () => {
  const { controls, seen } = controlsFixture();
  const card = replyMenuCard({ menu: { ...menu, authorId: '' } });
  assert.match(JSON.stringify(dialog(await controls.onInvoke(click(buttons(card)['📂 Files'], { actor: '29:other' })))), /AGENTS\.md/);
  assert.equal(seen[0].ownerId, '29:other');
});

test('the Teams connector sends the menu with the stats line on posts and edits', async () => {
  const sent = [];
  const api = { sendActivity: async (id, activity) => { sent.push(activity); return { messageId: 'm1' }; },
    updateActivity: async (id, messageId, activity) => { sent.push(activity); } };
  const connector = createTeamsConnector({ auth: { token: async () => 't' }, api, capabilities: {}, botId: '28:bot' });
  assert.equal(connector.replyMenu, true);
  await connector.post({ conversationId: RAW, text: 'answer', footer: 'stats', menu });
  await connector.edit({ conversationId: RAW, messageId: 'm1', text: 'answer', menu });
  await connector.post({ conversationId: RAW, text: 'plain' });
  assert.deepEqual(sent[0].attachments[0].content.actions.map(item => item.title).slice(0, 3), ['📂 Files', '🔑 Variables', '⚙️ Settings']);
  assert.equal(sent[0].attachments[0].content.body.at(-1).text, 'stats');
  assert.equal(sent[1].attachments[0].content.actions.length, 4);
  assert.equal(sent[2].attachments?.length || 0, 0);
});

test('ingest attaches the requester-bound menu and referenced files only for connectors that render it', async () => {
  await setUser('ana@example.com', { name: 'Ana Pop', approved: true });
  const make = replyMenu => {
    const edited = [], posted = [];
    return { edited, posted, platform: 'googlechat', capabilities: googleChatAdapter.capabilities, ...(replyMenu ? { replyMenu: true } : {}),
      async post(payload) { posted.push(payload); return { messageId: `m${posted.length}`, conversationId: payload.conversationId, threadKey: payload.threadKey || '' }; },
      async edit(payload) { edited.push(payload); }, async directory() { return { map: new Map(), maxWords: 1 }; } };
  };
  const message = makeInbound({ platform: 'googlechat', conversationId: 'spaces/MENU1', conversationName: 'Ops', kind: 'channel',
    userId: 'ana@example.com', userName: 'Ana Pop', text: 'review it', mentionsBot: true });
  const run = async () => ({ content: 'Updated `AGENTS.md` and `docs/guide.txt`; see `npm test`.', cwd: root, engine: 'claude' });
  const withMenu = make(true);
  await createIngest({ connector: withMenu, run, log: { info() {}, warn() {}, error() {} } })(message);
  const delivered = [...withMenu.edited, ...withMenu.posted].find(item => item.menu);
  assert.ok(delivered, 'the answer carries the menu');
  assert.equal(delivered.menu.conversationId, 'spaces/MENU1');
  assert.equal(delivered.menu.authorId, 'ana@example.com');
  assert.ok(delivered.menu.sessionKey);
  assert.deepEqual(delivered.menu.files.map(file => file.relative), ['AGENTS.md', 'docs/guide.txt']);
  const without = make(false);
  await createIngest({ connector: without, run, log: { info() {}, warn() {}, error() {} } })(message);
  assert.ok([...without.edited, ...without.posted].every(item => !item.menu));
});
