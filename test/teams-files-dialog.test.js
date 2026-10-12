import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
process.env.CG_FS_ROOT = os.tmpdir();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { upsertChannelEntry, saveChannelMeta, patchChannelMeta, setUser } = await import('../src/config/store.js');
const { createFileUploadRouter } = await import('../src/web/file-upload.js');
const { teamsWorkspaceContext } = await import('../src/platforms/msteams/workspace-access.js');
let sequence = 0;
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(nodes)];
const actions = card => nodes(card).filter(node => node.type?.startsWith('Action.'));
const action = (card, title) => actions(card).find(item => item.title === title);
const continued = result => {
  assert.equal(result.status, 200);
  assert.equal(result.body.task.type, 'continue');
  assert.equal(result.body.task.value.title, 'Conversation files');
  return result.body.task.value.card.content;
};
const denied = result => { assert.equal(result.status, 200); assert.equal(result.body.task.type, 'message'); };
async function fixture(t, kind = 'group', extra = {}) {
  const id = ++sequence, owner = `29:files-${id}`, tenant = `tenant-files-${id}`;
  const nativeId = `${kind === 'dm' ? 'a' : '19'}:files-${id}${kind === 'dm' ? '' : '@thread.v2'}`, channelId = `teams:${nativeId}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'teams-files-dialog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'hello.txt'), 'hello');
  await symlink(os.tmpdir(), path.join(root, 'escape'));
  const entry = await upsertChannelEntry(channelId, { name: 'Files fixture', platform: 'msteams', type: kind === 'dm' ? 'im' : kind === 'channel' ? 'channel' : 'mpim' });
  const meta = { channelId, platform: 'msteams', isDM: kind === 'dm', access: 'approved', allowBash: true, workDir: root };
  await saveChannelMeta(entry.slug, meta); await setUser(owner, { approved: true });
  let clock = 1_000_000, roster = [{ id: owner }], reads = 0;
  const posted = [], updated = [], replies = [];
  const connector = { botId: '28:files-bot', api: { sendActivity: async () => assert.fail('No consent activity'),
    listMembers: async () => { reads++; return roster; } },
    postCard: async payload => { posted.push(payload); return { messageId: 'launcher' }; },
    updateCard: async payload => updated.push(payload), openDm: async () => assert.fail('Files must not open a DM') };
  const controls = createTeamsControls({ connector, now: () => clock, publicUrl: () => 'https://gateway.example', ...extra });
  t.after(() => controls.stop());
  const command = async (text = '/files') => {
    await controls.onCommand({ message: { text, trigger: 'message', userId: owner, conversationId: channelId,
      rawConversationId: nativeId, isDM: kind === 'dm', threadKey: 'source-thread',
      raw: { tenantId: tenant, activity: { recipient: { id: connector.botId } } } },
      entry, meta, sessionKey: 'source-session', reply: async value => replies.push(value) });
    return posted.at(-1)?.card.actions[0].data;
  };
  const invoke = (name, data, overrides = {}) => controls.onInvoke({ type: 'invoke', name, id: `files-action-${++sequence}`,
    from: { id: owner }, recipient: { id: connector.botId }, conversation: { id: nativeId },
    channelData: { tenant: { id: tenant } }, serviceUrl: 'https://smba.trafficmanager.net/teams/', value: { data }, ...overrides });
  const open = async launcher => { const result = await invoke('task/fetch', launcher), card = continued(result);
    return { result, card, stateId: actions(card).find(item => item.data?.stateId).data.stateId }; };
  const submit = (stateId, cgAction, data = {}, overrides = {}) => invoke('task/submit', { ...data, stateId, cgAction }, overrides);
  return { owner, tenant, nativeId, channelId, entry, root, connector, controls, posted, updated, replies, command, invoke, open, submit,
    reads: () => reads, advance: ms => { clock += ms; }, removeMember: () => { roster = []; } };
}

test('Teams files popup opens in the source personal/group/channel session, keeping listings out of chat', async t => {
  for (const kind of ['dm', 'group', 'channel']) {
    const f = await fixture(t, kind), launcher = await f.command('/files docs'), popup = await f.open(launcher);
    assert.equal(f.posted[0].conversationId, f.nativeId); assert.equal(f.posted[0].threadKey, 'source-thread');
    assert.equal(f.posted[0].card.actions[0].title, 'Open files'); assert.equal(launcher.msteams.type, 'task/fetch');
    assert.doesNotMatch(JSON.stringify(f.posted[0].card), /hello.txt|nested|file-upload|file-download/);
    assert.notEqual(popup.stateId, launcher.stateId);
    assert.match(JSON.stringify(popup.card), /Folder: \/docs/);
    assert.ok(action(popup.card, '📄 hello.txt')); assert.ok(action(popup.card, '📁 nested'));
    assert.equal(popup.result.body.task.value.width, 'large'); assert.equal(popup.result.body.task.value.height, 'large');
    assert.ok(actions(popup.card).every(item => item.type === 'Action.Submit' && !item.fallback));
    assert.deepEqual(f.replies, []); assert.deepEqual(f.updated, []);
  }
});

test('files popup navigates parents, paginates, refreshes and returns from download to the same folder', async t => {
  const f = await fixture(t), popup = await f.open(await f.command('/files docs'));
  let card = continued(await f.submit(popup.stateId, 'files.browse', { relative: 'docs/nested' }));
  assert.match(JSON.stringify(card), /No visible files/);
  card = continued(await f.submit(popup.stateId, 'files.browse', action(card, 'Parent folder').data));
  assert.match(JSON.stringify(card), /Folder: \/docs/);
  card = continued(await f.submit(popup.stateId, 'files.download', action(card, '📄 hello.txt').data));
  assert.match(action(card, 'Download file').url, /\/file-download\/open\//);
  assert.match(action(card, 'Edit file').url, /\/file-editor\/open\//);
  assert.equal(action(card, 'Back to files').data.relative, 'docs');
  card = continued(await f.submit(popup.stateId, 'files.browse', action(card, 'Back to files').data));
  for (let i = 0; i < 25; i++) await writeFile(path.join(f.root, 'docs', `paged-${String(i).padStart(2, '0')}.txt`), 'page');
  card = continued(await f.submit(popup.stateId, 'files.browse', action(card, 'Refresh').data));
  assert.match(JSON.stringify(card), /page 1\/3/);
  card = continued(await f.submit(popup.stateId, 'files.browse', action(card, 'Next').data));
  assert.match(JSON.stringify(card), /page 2\/3/); assert.ok(action(card, 'Previous'));
  card = continued(await f.submit(popup.stateId, 'files.browse', action(card, 'Root').data));
  assert.match(JSON.stringify(card), /Folder: \/ —/); assert.ok(!action(card, 'Parent folder'));
  assert.ok(!actions(card).some(item => item.title === '📁 escape'));
  assert.equal(f.posted.length, 1); assert.deepEqual(f.updated, []);
});

test('upload link saves to the folder selected in the popup using the original owner/workspace grant', async t => {
  let f, authorizedGrant;
  const app = express();
  app.use('/file-upload', createFileUploadRouter({ authorize: async grant => {
    authorizedGrant = grant; return teamsWorkspaceContext(grant, { connector: f.connector });
  }, audit: async () => {} }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  f = await fixture(t, 'group', { publicUrl: () => base });
  const popup = await f.open(await f.command('/files docs'));
  const uploadCard = continued(await f.submit(popup.stateId, 'files.upload', { relative: 'docs/nested',
    channelId: 'teams:forged', slug: 'forged', ownerId: '29:forged', sessionKey: 'forged' }));
  assert.match(JSON.stringify(uploadCard), /Destination: \/docs\/nested/);
  const opened = await fetch(action(uploadCard, 'Open uploader').url, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  const cookie = opened.headers.get('set-cookie').split(';')[0], url = base + opened.headers.get('location');
  const html = await (await fetch(url, { headers: { cookie } })).text();
  const csrf = /const CSRF="([^"]+)"/.exec(html)[1];
  const saved = await fetch(`${url}/api/upload?path=popup-upload.txt`, { method: 'POST', headers: {
    cookie, 'Content-Type': 'application/octet-stream', 'X-CG-CSRF': csrf }, body: 'popup upload' });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(path.join(f.root, 'docs', 'nested', 'popup-upload.txt'), 'utf8'), 'popup upload');
  assert.equal(authorizedGrant.channelId, f.channelId); assert.equal(authorizedGrant.slug, f.entry.slug);
  assert.equal(authorizedGrant.ownerId, f.owner); assert.equal(authorizedGrant.threadTs, 'source-session');
  assert.equal(authorizedGrant.relative, 'docs/nested'); assert.deepEqual(f.updated, []);
});

test('file launcher and popup bind actor, source conversation, tenant and bot before workspace reads', async t => {
  const f = await fixture(t), launcher = await f.command(), popup = await f.open(launcher);
  for (const overrides of [{ from: { id: '29:foreign' } }, { conversation: { id: '19:foreign@thread.v2' } },
    { channelData: { tenant: { id: 'other-tenant' } } }, { channelData: {} }, { recipient: { id: '28:foreign' } }]) {
    const before = f.reads(); denied(await f.invoke('task/fetch', launcher, overrides));
    denied(await f.submit(popup.stateId, 'files.download', { relative: 'docs/hello.txt' }, overrides));
    assert.equal(f.reads(), before);
  }
  assert.equal(f.posted.length, 1); assert.deepEqual(f.updated, []);
});

test('files popup rechecks current approval, roster and write policy', async t => {
  for (const revocation of ['approval', 'membership', 'write']) {
    const f = await fixture(t), launcher = await f.command(), popup = await f.open(launcher);
    if (revocation === 'approval') await setUser(f.owner, { approved: false });
    else if (revocation === 'membership') f.removeMember();
    else await patchChannelMeta(f.entry.slug, { allowBash: false });
    denied(await f.submit(popup.stateId, 'files.upload', { relative: 'docs' }));
    if (revocation !== 'write') { denied(await f.invoke('task/fetch', launcher)); denied(await f.submit(popup.stateId, 'files.browse')); }
    else {
      const card = continued(await f.submit(popup.stateId, 'files.browse', { relative: 'docs' }));
      assert.ok(!action(card, 'Upload files'));
      const download = continued(await f.submit(popup.stateId, 'files.download', { relative: 'docs/hello.txt' }));
      assert.ok(action(download, 'Download file')); assert.ok(!action(download, 'Edit file'));
    }
    assert.deepEqual(f.updated, []);
  }
});

test('file popup rejects traversal, escaping symlinks and settings/approval/model actions', async t => {
  const f = await fixture(t), popup = await f.open(await f.command());
  for (const relative of ['../outside', '/etc', 'escape']) denied(await f.submit(popup.stateId, 'files.browse', { relative }));
  for (const cgAction of ['settings.page', 'settings.open', 'model.save', 'approval.respond', 'files.open'])
    denied(await f.submit(popup.stateId, cgAction, { page: 'general' }));
  assert.equal(f.posted.length, 1); assert.deepEqual(f.updated, []);
});

test('file popup and launcher reject alternate transports and stale state without publishing a listing', async t => {
  const f = await fixture(t), launcher = await f.command(), popup = await f.open(launcher);
  for (const stateId of [launcher.stateId, popup.stateId]) {
    const data = { cgAction: 'files.browse', stateId, relative: 'docs' };
    for (const [name, overrides] of [
      ['adaptiveCard/action', { value: { action: { type: 'Action.Execute', verb: data.cgAction, data } } }],
      ['', { type: 'message', value: data }], ['composeExtension/submitAction', {}],
    ]) assert.notEqual((await f.invoke(name, data, overrides)).body.task?.type, 'continue');
  }
  denied(await f.submit(launcher.stateId, 'files.browse'));
  denied(await f.invoke('task/fetch', { stateId: popup.stateId, cgAction: 'files.browse' }));
  f.advance(16 * 60_000); denied(await f.invoke('task/fetch', launcher)); denied(await f.submit(popup.stateId, 'files.browse'));
  assert.equal(f.posted.length, 1); assert.deepEqual(f.updated, []);
});

test('separate file popup openings keep their return folders independent', async t => {
  const f = await fixture(t), launcher = await f.command();
  const first = await f.open(launcher), second = await f.open(launcher);
  assert.notEqual(first.stateId, second.stateId);
  continued(await f.submit(first.stateId, 'files.browse', { relative: 'docs' }));
  const download = continued(await f.submit(second.stateId, 'files.download', { relative: 'docs/hello.txt' }));
  assert.equal(action(download, 'Back to files').data.relative, '');
  const upload = continued(await f.submit(first.stateId, 'files.upload', { relative: 'docs' }));
  assert.equal(action(upload, 'Back to files').data.relative, 'docs');
});
