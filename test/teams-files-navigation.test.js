// Teams Files window navigation (ported from the stale PR #157): Parent folder and Refresh,
// an empty-page notice, return paths that keep the listing page, and an upload card that names
// the destination folder chosen in the window. Real workspace authorization and the real browser
// uploader; no engine is invoked, so every case is engine-independent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { teamsWorkspaceContext } = await import('../src/platforms/msteams/workspace-access.js');
const { createFileUploadRouter } = await import('../src/web/file-upload.js');
const { upsertChannelEntry, saveChannelMeta, patchChannelMeta, setUser } = await import('../src/config/store.js');

let sequence = 0;
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(nodes)];
const actions = card => nodes(card).filter(node => typeof node.type === 'string' && node.type.startsWith('Action.'));
const action = (card, title) => actions(card).find(item => item.title === title);
const titles = card => card.actions.map(item => item.title);
const continued = result => {
  assert.equal(result.status, 200);
  assert.equal(result.body.task?.type, 'continue');
  assert.equal(result.body.task.value.title, 'Conversation files');
  return result.body.task.value.card.content;
};
const denied = result => { assert.equal(result.status, 200); assert.equal(result.body.task?.type, 'message'); };
const folderLine = card => card.body[1].text;

async function fixture(t, { publicUrl = () => 'https://gateway.example', write = true } = {}) {
  const serial = ++sequence, owner = `29:nav-${serial}`, tenant = `tenant-nav-${serial}`;
  const nativeId = `19:nav-${serial}@thread.v2`, channelId = `teams:${nativeId}`;
  const entry = await upsertChannelEntry(channelId, { name: `Navigation ${serial}`, platform: 'msteams', type: 'mpim' });
  await saveChannelMeta(entry.slug, { channelId, platform: 'msteams', access: 'approved', allowBash: write });
  await setUser(owner, { approved: true });
  const root = path.join(process.env.CG_WORKSPACE_DIR, 'teams', entry.slug);
  mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'hello.txt'), 'hello');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const posted = [], updated = [];
  const connector = { botId: '28:nav-bot', api: { listMembers: async () => [{ id: owner }], sendActivity: async () => assert.fail('No file consent') },
    postCard: async payload => { posted.push(payload); return { messageId: 'launcher' }; },
    updateCard: async payload => updated.push(payload), openDm: async () => assert.fail('Files must not open a DM') };
  const controls = createTeamsControls({ connector, publicUrl });
  t.after(() => controls.stop());
  const invoke = (name, data) => controls.onInvoke({ type: 'invoke', name, id: `nav-${++sequence}`,
    from: { id: owner }, recipient: { id: connector.botId }, conversation: { id: nativeId },
    channelData: { tenant: { id: tenant } }, serviceUrl: 'https://smba.trafficmanager.net/teams/', value: { data } });
  const open = async (command = '/files') => {
    await controls.onCommand({ message: { text: command, trigger: 'message', userId: owner, conversationId: channelId,
      rawConversationId: nativeId, isDM: false, threadKey: 'source-thread', raw: { tenantId: tenant, activity: { recipient: { id: connector.botId } } } },
      entry, meta: { engine: 'claude' }, sessionKey: 'source-session', reply: async value => assert.fail(value) });
    return continued(await invoke('task/fetch', posted.at(-1).card.actions[0].data));
  };
  const click = async (card, title) => continued(await invoke('task/submit', action(card, title).data));
  return { owner, entry, root, connector, posted, updated, invoke, open, click };
}

test('Files window offers Parent folder and Refresh, and says when a folder has nothing to show', async t => {
  const f = await fixture(t);
  let card = await f.open('/files docs/nested');
  assert.equal(folderLine(card), 'Folder: /docs/nested — page 1/1');
  assert.match(JSON.stringify(card.body), /No visible files or folders on this page\./);
  assert.deepEqual(titles(card), ['Root', 'Parent folder', 'Refresh', 'Upload files']);
  card = await f.click(card, 'Parent folder');
  assert.equal(folderLine(card), 'Folder: /docs — page 1/1');
  assert.doesNotMatch(JSON.stringify(card.body), /No visible files/);
  card = await f.click(card, 'Parent folder');
  assert.equal(folderLine(card), 'Folder: / — page 1/1');
  assert.ok(!action(card, 'Parent folder'), 'the root has no parent');
  assert.deepEqual(titles(card), ['Root', 'Refresh', 'Upload files']);
  // Refresh rereads the folder: a file written after the window opened appears.
  writeFileSync(path.join(f.root, 'after-open.txt'), 'new');
  assert.ok(!action(card, '📄 after-open.txt'));
  card = await f.click(card, 'Refresh');
  assert.ok(action(card, '📄 after-open.txt'));
  assert.equal(f.posted.length, 1, 'navigation never posts to chat');
  assert.deepEqual(f.updated, []);
});

test('Refresh keeps the page; detail and upload pages return to the listing page they came from', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) writeFileSync(path.join(f.root, 'docs', `paged-${String(i).padStart(2, '0')}.txt`), 'page');
  let card = await f.open('/files docs');
  assert.equal(folderLine(card), 'Folder: /docs — page 1/3');
  card = await f.click(card, 'Next');
  assert.equal(folderLine(card), 'Folder: /docs — page 2/3');
  // A subfolder page with Previous, Next and write access is the busiest card: six actions,
  // the most Teams renders.
  assert.deepEqual(titles(card), ['Root', 'Parent folder', 'Refresh', 'Previous', 'Next', 'Upload files']);
  card = await f.click(card, 'Refresh');
  assert.equal(folderLine(card), 'Folder: /docs — page 2/3');
  const onPage = actions(card).find(item => item.title?.startsWith('📄 paged-'));
  const file = continued(await f.invoke('task/submit', onPage.data));
  assert.equal(file.body[0].text, 'File');
  assert.deepEqual(action(file, 'Back to files').data.page, 1);
  card = await f.click(file, 'Back to files');
  assert.equal(folderLine(card), 'Folder: /docs — page 2/3');
  const upload = await f.click(card, 'Upload files');
  assert.equal(action(upload, 'Back to files').data.relative, 'docs');
  card = await f.click(upload, 'Back to files');
  assert.equal(folderLine(card), 'Folder: /docs — page 2/3');
  // A launcher-opened file (no listing behind it) still returns to the first page of its folder.
  const sent = await f.open('/sendfile docs/hello.txt');
  assert.equal(action(sent, 'Back to files').data.page, 0);
  assert.equal(folderLine(await f.click(sent, 'Back to files')), 'Folder: /docs — page 1/3');
});

test('forged page values are clamped instead of failing or escaping the listing', async t => {
  const f = await fixture(t);
  const card = await f.open('/files docs');
  const back = action(continued(await f.invoke('task/submit', action(card, '📄 hello.txt').data)), 'Back to files').data;
  for (const page of [-3, 'abc', 1e12, 2.5, null, true]) {
    const file = continued(await f.invoke('task/submit', { ...action(card, '📄 hello.txt').data, page }));
    const value = action(file, 'Back to files').data.page;
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 100_000, `page ${JSON.stringify(page)} -> ${value}`);
    assert.equal(folderLine(continued(await f.invoke('task/submit', { ...back, page: value }))), 'Folder: /docs — page 1/1');
  }
  // Non-scalar card inputs are refused by the interaction parser before any workspace read.
  denied(await f.invoke('task/submit', { ...action(card, '📄 hello.txt').data, page: { nested: true } }));
});

test('the upload card names the folder chosen in the window and the uploader saves there', async t => {
  let f, authorizedGrant;
  const app = express();
  app.use('/file-upload', createFileUploadRouter({ authorize: async grant => {
    authorizedGrant = grant; return teamsWorkspaceContext(grant, { connector: f.connector });
  }, audit: async () => {} }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  f = await fixture(t, { publicUrl: () => base });
  const listing = await f.click(await f.open('/files docs'), '📁 nested');
  const upload = await f.click(listing, 'Upload files');
  assert.equal(upload.body[0].text, 'Upload files');
  assert.equal(upload.body[1].text, 'Destination: /docs/nested');
  assert.match(upload.body[2].text, /choose files or a folder.*Refresh/s);
  const opened = await fetch(action(upload, 'Open uploader').url, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  const cookie = opened.headers.get('set-cookie').split(';')[0], url = base + opened.headers.get('location');
  const html = await (await fetch(url, { headers: { cookie } })).text();
  assert.match(html, /Destination: \/docs\/nested/);
  const csrf = /const CSRF="([^"]+)"/.exec(html)[1];
  const saved = await fetch(`${url}/api/upload?path=window-upload.txt`, { method: 'POST',
    headers: { cookie, 'Content-Type': 'application/octet-stream', 'X-CG-CSRF': csrf }, body: 'window upload' });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(path.join(f.root, 'docs', 'nested', 'window-upload.txt'), 'utf8'), 'window upload');
  assert.equal(authorizedGrant.ownerId, f.owner); assert.equal(authorizedGrant.slug, f.entry.slug);
  assert.equal(authorizedGrant.relative, 'docs/nested'); assert.equal(authorizedGrant.threadTs, 'source-session');
  // Back in the window, Refresh shows the uploaded file.
  const refreshed = await f.click(await f.click(upload, 'Back to files'), 'Refresh');
  assert.ok(action(refreshed, '📄 window-upload.txt'));
  assert.doesNotMatch(JSON.stringify(f.posted), /window-upload|file-upload/);
  assert.deepEqual(f.updated, []);
});

test('an upload destination must be a real folder inside the workspace', async t => {
  const f = await fixture(t);
  const listing = await f.open('/files docs');
  const data = action(listing, 'Upload files').data;
  for (const relative of ['docs/hello.txt', 'docs/missing', '../outside', '/etc']) {
    denied(await f.invoke('task/submit', { ...data, relative }));
  }
});

test('read-only members keep Parent folder and Refresh without an upload control', async t => {
  const f = await fixture(t, { write: false });
  const card = await f.open('/files docs');
  assert.deepEqual(titles(card), ['Root', 'Parent folder', 'Refresh']);
  denied(await f.invoke('task/submit', { ...action(card, 'Refresh').data, cgAction: 'files.upload' }));
  await patchChannelMeta(f.entry.slug, { allowBash: true });
  assert.ok(action(await f.click(card, 'Refresh'), 'Upload files'), 'write access is read live on every click');
});
