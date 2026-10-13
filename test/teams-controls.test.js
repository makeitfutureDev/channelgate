import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createTeamsControls } = await import('../src/platforms/msteams/controls.js');
const { zip, documentXml } = await import('./fixtures/docx.js');
const { teamsHelpText } = await import('../src/platforms/msteams/help.js');
const { teamsWorkspaceContext } = await import('../src/platforms/msteams/workspace-access.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { sessionKeyForMessage } = await import('../src/platforms/reply-sessions.js');
const { upsertChannelEntry, saveChannelMeta, setUser, getUser } = await import('../src/config/store.js');
await setUser('29:owner', { approved: true, isAdmin: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'teams-controls-'));
await writeFile(path.join(root, 'hello.txt'), 'hello');
const message = text => ({ text, trigger: 'message', conversationId: 'teams:19:source@thread.v2', rawConversationId: '19:source@thread.v2', userId: '29:owner', isDM: false });
const invoke = (data, action = 'files.browse', actor = '29:owner', conversation = 'a:private') => ({ type: 'invoke', name: 'adaptiveCard/action', id: 'invoke-1', replyToId: 'card1', from: { id: actor }, conversation: { id: conversation, conversationType: 'personal' }, serviceUrl: 'https://smba.trafficmanager.net/teams/', value: { action: { type: 'Action.Execute', verb: action, data } } });
const task = (data, name = 'task/submit', actor = '29:owner', conversation = '19:source@thread.v2') => ({
  ...invoke({}, '', actor, conversation), name, value: { data },
});
const continued = result => { assert.equal(result.body.task?.type, 'continue'); return result.body.task.value.card.content; };
async function openFiles(f, command = '/files') {
  await f.controls.onCommand(f.args(command));
  return continued(await f.controls.onInvoke(task(f.sent.at(-1).card.actions[0].data, 'task/fetch')));
}
function fixture(extra = {}) {
  const sent = [], commands = [], replies = [];
  const connector = { api: { sendActivity: async () => ({ messageId: 'file-consent' }) }, updateCard: async value => sent.push(value), openDm: async () => assert.fail('Thread actions must not open a DM'), postCard: async value => { sent.push(value); return { messageId: 'card1' }; } };
  const controls = createTeamsControls({ connector, authorize: async () => ({ root, meta: { allowBash: true }, userIsAdmin: true }), publicUrl: () => 'https://gateway.example', ...extra });
  const args = text => ({ message: message(text), sessionKey: 'group:root', entry: { slug: 'source' }, meta: { engine: 'claude' }, authorIsAdmin: true, reply: async text => replies.push(text), controls: { command: async input => { commands.push(input.message.text); await input.reply(input.message.text.startsWith('/model') ? 'Session engine: claude' : 'Session effort: default'); return true; } } });
  return { controls, args, sent, commands, replies };
}
test('Teams /help returns the practical guide without opening controls or changing runtime', async () => {
  const f = fixture();
  assert.equal(await f.controls.onCommand(f.args('  /HELP  ')), true);
  assert.deepEqual(f.replies, [teamsHelpText(['hearteyesrobot', 'alien', 'like', 'smilerobot'])]);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.commands, []);
  const reaction = f.args('/help'); reaction.message.trigger = 'reaction';
  assert.equal(await f.controls.onCommand(reaction), false);
  assert.equal(f.replies.length, 1);
});
test('Teams ingest delivers help in personal, channel and quoted group sessions before any engine runs', async () => {
  const posted = [];
  const cards = [];
  const connector = { platform: 'msteams', api: {
    sendActivity: async () => assert.fail('/help must not send a file-consent card'),
  }, postCard: async value => {
    cards.push(value); return { messageId: `help-card-${cards.length}` };
  }, post: async value => {
    posted.push(value); return { messageId: `help-${posted.length}` };
  } };
  const native = createTeamsControls({ connector });
  const ingest = createIngest({ connector, onCommand: native.onCommand,
    run: async () => assert.fail('/help must not invoke an engine'), log: {} });
  for (const kind of ['dm', 'channel', 'group']) {
    const message = makeInbound({ platform: 'msteams', kind, text: '/help',
      conversationId: `19:help-${kind}`, userId: '29:owner', messageId: `root-${kind}`,
      mentionsBot: kind !== 'dm', threadKey: kind === 'channel' ? 'help-thread' : '',
      replyToId: kind === 'group' ? 'quoted-message' : '' });
    assert.deepEqual(await ingest(message), { command: true });
    assert.equal(cards.at(-1).conversationId, message.rawConversationId);
    assert.equal(cards.at(-1).threadKey, message.threadKey);
    assert.equal(cards.at(-1).card.body[0].text, 'How to use me');
    assert.match(JSON.stringify(cards.at(-1).card), /\/clear/);
    if (kind === 'group') {
      assert.equal(sessionKeyForMessage(makeInbound({ platform: 'msteams', kind: 'group',
        conversationId: message.rawConversationId, userId: '29:owner', messageId: 'quoted-help',
        replyToId: `help-card-${cards.length}`, text: '/status', mentionsBot: true })), sessionKeyForMessage(message));
    }
  }
  assert.equal(cards.length, 3);
  assert.equal(posted.length, 0);
  assert.deepEqual(await ingest(makeInbound({ platform: 'msteams', kind: 'channel',
    text: '/help', conversationId: '19:help-unmentioned', userId: '29:owner',
    messageId: 'unmentioned', mentionsBot: false })), { skipped: 'not-mentioned' });
  assert.deepEqual(await ingest(makeInbound({ platform: 'msteams', kind: 'dm',
    text: '/help', conversationId: 'a:help-unapproved', userId: '29:help-unapproved',
    messageId: 'unapproved' })), { skipped: 'unauthorized' });
  assert.equal(cards.length, 3);
  assert.equal(posted.length, 1);
  assert.doesNotMatch(posted.at(-1).text, /How to use me/);
});
test('failed native help delivery falls back to the complete spaced guide', async () => {
  const f = fixture(); const args = f.args('/help');
  args.replyCard = async () => { throw new Error('Card delivery unavailable'); };
  assert.equal(await f.controls.onCommand(args), true);
  assert.deepEqual(f.replies, [teamsHelpText(['hearteyesrobot', 'alien', 'like', 'smilerobot'])]);
  assert.match(f.replies[0], /\n\n`\/clear`/);
  assert.deepEqual(f.commands, []);
});
test('files open from the source thread and browser actions never publish grants into chat', async () => {
  const f = fixture(); const listing = await openFiles(f);
  assert.equal(f.sent[0].conversationId, '19:source@thread.v2');
  assert.doesNotMatch(JSON.stringify(f.sent), /hello\.txt|file-download/);
  const action = listing.body.find(item => item.type === 'ActionSet').actions[0];
  assert.equal(action.data.relative, 'hello.txt');
  const file = continued(await f.controls.onInvoke(task(action.data)));
  assert.equal(file.body[0].text, 'File');
  assert.match(file.actions[0].url, /\/file-download\/open\//);
  assert.ok(file.actions.some(item => item.title === 'Back to files'));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.replies, []);
});
test('foreign actor/conversation and expired controls cannot use file grants', async () => {
  let time = 0; const f = fixture({ now: () => time }); await f.controls.onCommand(f.args('/files'));
  const data = f.sent[0].card.actions[0].data;
  for (const [actor, conversation] of [['29:other', '19:source@thread.v2'], ['29:owner', 'a:other']]) {
    const result = await f.controls.onInvoke(task(data, 'task/fetch', actor, conversation));
    assert.equal(result.body.task.value.title, 'Action unavailable');
  }
  time = 16 * 60_000;
  const result = await f.controls.onInvoke(task(data, 'task/fetch')); assert.equal(result.body.task.value.title, 'Action unavailable');
});
test('reaction content never opens native commands; failed thread-card delivery never redirects to a DM', async () => {
  const f = fixture(); const args = f.args('/files'); args.message.trigger = 'reaction';
  assert.equal(await f.controls.onCommand(args), false); assert.equal(f.sent.length, 0);
  const failed = fixture({ connector: { api: { sendActivity: async () => ({}) }, openDm: async () => assert.fail('No DM fallback'), postCard: async () => { throw new Error('Card delivery unavailable'); } } });
  assert.equal(await failed.controls.onCommand(failed.args('/files')), true);
  assert.match(failed.replies[0], /Card delivery unavailable/);
});
test('model form uses existing controls and consumes its state on a successful submit', async () => {
  const f = fixture(); await f.controls.onCommand(f.args('/model'));
  const stateId = f.sent[0].card.actions[0].data.stateId;
  const payload = { stateId, engine: 'claude', model: 'default', effort: 'default' };
  const conversation = f.args('/settings').message.rawConversationId;
  // Refresh the chosen engine before applying the model form.
  await f.controls.onInvoke(invoke({ stateId, engine: 'claude' }, 'model.load', '29:owner', conversation));
  await f.controls.onInvoke(invoke(payload, 'model.save', '29:owner', conversation));
  assert.deepEqual(f.commands, ['/model claude default', '/effort default']);
  await f.controls.onInvoke(invoke(payload, 'model.save', '29:owner', f.args('/settings').message.rawConversationId)); assert.equal(f.commands.length, 2);
});
test('approval invocation trusts envelope identity over malicious card data', async () => {
  let received;
  const f = fixture({ approval: async input => { received = input; return { ok: true, outcome: 'approved' }; } });
  await f.controls.onInvoke(invoke({ id: 'approval', decision: 'approve', actorId: '29:admin', conversationId: 'teams:other', messageId: 'forged' }, 'approval.respond'));
  assert.equal(received.actorId, '29:owner'); assert.equal(received.conversationId, 'teams:a:private'); assert.equal(received.messageId, 'card1');
});
test('workspace access repeats live approval and roster membership', async () => {
  const channelId = 'teams:19:access@thread.v2', ownerId = '29:access-owner';
  const entry = await upsertChannelEntry(channelId, { name: 'access', platform: 'msteams', type: 'mpim' });
  await saveChannelMeta(entry.slug, { channelId, platform: 'msteams', workDir: root, access: 'approved' });
  await setUser(ownerId, { approved: true });
  const grant = { channelId, ownerId, slug: entry.slug };
  const connector = { api: { listMembers: async () => [{ id: ownerId }] } };
  assert.equal((await teamsWorkspaceContext(grant, { connector })).entry.slug, entry.slug);
  await assert.rejects(teamsWorkspaceContext(grant, { connector: { api: { listMembers: async () => [] } } }), /membership/);
  await setUser(ownerId, { approved: false }); await assert.rejects(teamsWorkspaceContext(grant, { connector }), /no longer allowed/);
});

test('legacy Submit cannot publish a files dialog or its browser grants into chat', async () => {
  const f = fixture(); const listing = await openFiles(f);
  const action = listing.actions[0];
  const activity = invoke(action.data); activity.type = 'message'; delete activity.name; activity.value = { ...action.data, cgAction: 'files.browse' };
  activity.replyToId = 'forged-target'; activity.conversation.id = '19:source@thread.v2;messageid=another-target';
  const result = await f.controls.onInvoke(activity);
  assert.deepEqual(result, { status: 200, body: {} });
  assert.equal(f.sent.length, 1);
});

test('rejected legacy Submit cannot overwrite or post a private card', async () => {
  let time = 0; const f = fixture({ now: () => time }); await f.controls.onCommand(f.args('/files'));
  const action = f.sent[0].card.actions[0];
  for (const [stateId, actor, conversation] of [
    ['forged-state', '29:owner', 'a:private'],
    [action.data.stateId, '29:other', 'a:private'],
    [action.data.stateId, '29:owner', 'a:other'],
  ]) {
    const activity = invoke({}, 'files.browse', actor, conversation);
    activity.type = 'message'; delete activity.name;
    activity.value = { cgAction: 'files.browse', stateId }; activity.replyToId = 'forged-target';
    assert.deepEqual(await f.controls.onInvoke(activity), { status: 200, body: {} });
    assert.equal(f.sent.length, 1);
  }
  time = 16 * 60_000;
  const expired = invoke(action.data); expired.type = 'message'; delete expired.name;
  expired.value = { ...action.data, cgAction: 'files.browse' };
  assert.deepEqual(await f.controls.onInvoke(expired), { status: 200, body: {} });
  assert.equal(f.sent.length, 1);
});

test('settings retain their source conversation, thread and actor without opening a DM', async () => {
  const f = fixture(); const args = f.args('/settings'); args.message.threadKey = 'root-message';
  await f.controls.onCommand(args);
  assert.equal(f.sent[0].conversationId, args.message.rawConversationId);
  assert.equal(f.sent[0].threadKey, 'root-message');
  assert.deepEqual(f.replies, []);
  const data = { ...f.sent[0].card.actions[0].data, engine: 'claude', model: 'default', effort: 'default' };
  for (const [actor, conversation] of [['29:other', args.message.rawConversationId], ['29:owner', 'a:private']]) {
    const result = await f.controls.onInvoke(invoke(data, 'model.save', actor, conversation));
    assert.equal(result.body.value.body[0].text, 'Action could not be completed');
  }
  assert.deepEqual(f.commands, []);
});

test('file dialogs keep upload/download navigation and sendfile in the original conversation', async () => {
  const f = fixture();
  const listing = await openFiles(f);
  const upload = listing.actions.find(action => action.title === 'Upload files');
  const uploader = continued(await f.controls.onInvoke(task(upload.data)));
  assert.match(uploader.actions[0].url, /\/file-upload\/open\//);
  const back = uploader.actions.find(action => action.title === 'Back to files');
  assert.equal(continued(await f.controls.onInvoke(task(back.data))).body[0].text, 'Conversation files');
  const file = await openFiles(f, '/sendfile hello.txt');
  assert.equal(file.body[0].text, 'File');
  assert.match(file.actions[0].url, /\/file-download\/open\//);
  assert.ok(file.actions.some(action => action.title === 'Back to files'));
  const fileBack = file.actions.find(action => action.title === 'Back to files');
  assert.equal(continued(await f.controls.onInvoke(task(fileBack.data))).body[0].text, 'Conversation files');
  assert.equal(f.sent.length, 2);
  assert.doesNotMatch(JSON.stringify(f.sent), /file-download|file-upload|hello\.txt/);
});

test('model cards cannot expose settings contents or accept personal token writes through forged actions', async () => {
  await setUser('29:owner', { composioToken: 'owned-token-unchanged-fixture' });
  const f = fixture(); await f.controls.onCommand(f.args('/model'));
  const stateId = f.sent[0].card.actions[0].data.stateId;
  for (const [cgAction, extra] of [
    ['settings.page', { page: 'secrets' }], ['settings.page', { page: 'mcp' }],
    ['settings.personal.save', { personalComposioToken: 'forged-personal-token' }],
  ]) {
    const data = { stateId, cgAction, ...extra };
    const execute = invoke(data, cgAction, '29:owner', '19:source@thread.v2');
    assert.equal((await f.controls.onInvoke(execute)).body.value.body[0].text, 'Action could not be completed');
    const legacy = { ...execute, type: 'message', name: undefined, value: data, replyToId: 'forged-target' };
    assert.deepEqual(await f.controls.onInvoke(legacy), { status: 200, body: {} });
    assert.equal(f.sent.length, 1, 'no private contents may update the public model card');
    assert.equal((await getUser('29:owner')).composioToken, 'owned-token-unchanged-fixture');
  }
});

test('files dialogs enforce tenant, actor, source, expiry and current access on every step', async () => {
  let clock = 0, allowed = true;
  const f = fixture({ now: () => clock, authorize: async () => {
    if (!allowed) throw new Error('Access revoked');
    return { root, meta: { allowBash: true }, userIsAdmin: true };
  } });
  const args = f.args('/files'); args.message.raw = { tenantId: 'tenant-original' };
  await f.controls.onCommand(args);
  const launch = f.sent[0].card.actions[0].data;
  const runTask = (data, name = 'task/submit', overrides = {}) => f.controls.onInvoke({
    ...task(data, name), channelData: { tenant: { id: 'tenant-original' } }, ...overrides,
  });
  assert.equal((await runTask(launch, 'task/fetch', { channelData: { tenant: { id: 'tenant-other' } } })).body.task.value.title, 'Action unavailable');
  const listing = continued(await runTask(launch, 'task/fetch'));
  const download = listing.body.find(item => item.type === 'ActionSet').actions[0].data;
  for (const overrides of [
    { from: { id: '29:other' } }, { conversation: { id: 'a:other' } }, { channelData: { tenant: { id: 'tenant-other' } } },
  ]) assert.equal((await runTask(download, 'task/submit', overrides)).body.task.type, 'message');
  assert.equal((await runTask({ ...download, cgAction: 'settings.page', page: 'mcp' })).body.task.type, 'message');
  assert.equal((await runTask({ ...download, relative: '../outside' })).body.task.type, 'message');
  allowed = false;
  assert.equal((await runTask(download)).body.task.type, 'message');
  allowed = true; clock = 16 * 60_000;
  assert.equal((await runTask(download)).body.task.type, 'message');
  assert.equal(f.sent.length, 1);
});

test('selected file windows show bounded literal text, complete downloads and binary guidance', async () => {
  await writeFile(path.join(root, 'preview.md'), '# Heading\n[link](https://example.test)\n' + 'A'.repeat(2800) + 'END-MARKER');
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'document.pdf'), '%PDF-1.7 ASCII PDF bytes must not render as a text preview');
  const f = fixture();
  const preview = await openFiles(f, '/sendfile preview.md');
  const literal = preview.body.find(item => item.type === 'RichTextBlock');
  assert.match(literal.inlines[0].text, /^# Heading\n\[link\]/);
  assert.equal(literal.inlines[0].fontType, 'Monospace');
  assert.equal(Buffer.byteLength(literal.inlines[0].text), 2600);
  assert.doesNotMatch(JSON.stringify(preview), /END-MARKER/);
  assert.match(JSON.stringify(preview), /complete file/);
  assert.ok(preview.actions.some(item => item.title === 'Download file'));
  assert.ok(preview.actions.some(item => item.title === 'Edit file'));
  const empty = await openFiles(f, '/sendfile empty.txt');
  assert.match(JSON.stringify(empty), /Empty file/);
  const binary = await openFiles(f, '/sendfile document.pdf');
  assert.match(JSON.stringify(binary), /no text preview/);
  assert.doesNotMatch(JSON.stringify(binary), /ASCII PDF bytes|Edit file/);
  assert.ok(binary.actions.some(item => item.title === 'Download file'));
  assert.doesNotMatch(JSON.stringify(f.sent), /Heading|file-download|file-editor/);
});

test('Word documents preview their text read-only and long text files keep browser editing', async () => {
  await writeFile(path.join(root, 'Readme.docx'), zip({ 'word/document.xml': documentXml(['Readme FIRST &amp; setup', 'Step two', 'W'.repeat(3000) + 'DOC-END']) }));
  await writeFile(path.join(root, 'broken.docx'), 'not a zip package');
  await writeFile(path.join(root, 'long.md'), '# Long\n' + 'L'.repeat(20_000));
  const f = fixture();
  const doc = await openFiles(f, '/sendfile Readme.docx');
  const docText = doc.body.find(item => item.type === 'RichTextBlock').inlines[0].text;
  assert.match(docText, /^Readme FIRST & setup\nStep two\nW/);
  assert.equal(Buffer.byteLength(docText) <= 2600, true);
  assert.doesNotMatch(JSON.stringify(doc), /DOC-END|Edit file/);
  assert.match(JSON.stringify(doc), /formatting, images and layout are not shown/);
  assert.match(JSON.stringify(doc), /complete document/);
  assert.ok(doc.actions.some(item => item.title === 'Download file'));
  const broken = await openFiles(f, '/sendfile broken.docx');
  assert.match(JSON.stringify(broken), /no text preview/);
  assert.ok(broken.actions.some(item => item.title === 'Download file'));
  const long = await openFiles(f, '/sendfile long.md');
  assert.ok(long.actions.some(item => item.title === 'Edit file'), 'files beyond the in-chat limit still get the browser editor');
  const readonly = fixture({ authorize: async () => ({ root, meta: { allowBash: false }, userIsAdmin: false }) });
  assert.ok(!(await openFiles(readonly, '/sendfile long.md')).actions.some(item => item.title === 'Edit file'));
});

test('read-only and no-Public-URL file windows still preview without edit grants', async () => {
  const f = fixture({ publicUrl: () => '', authorize: async () => ({ root, meta: { allowBash: false }, userIsAdmin: false }) });
  const preview = await openFiles(f, '/sendfile hello.txt');
  assert.match(JSON.stringify(preview), /hello|Set the gateway Public URL/);
  assert.doesNotMatch(JSON.stringify(preview), /file-download|file-editor/);
  assert.ok(preview.actions.some(item => item.title === 'Back to files'));
  const readonly = fixture({ authorize: async () => ({ root, meta: { allowBash: false }, userIsAdmin: false }) });
  const read = await openFiles(readonly, '/sendfile hello.txt');
  assert.ok(read.actions.some(item => item.title === 'Download file'));
  assert.ok(!read.actions.some(item => item.title === 'Edit file'));
});

test('a channel-thread card Teams posts without an activity id keeps a working Open files button', async () => {
  const sent = [];
  const f = fixture({ connector: { api: { sendActivity: async () => ({ messageId: '' }) }, postCard: async value => { sent.push(value); return { messageId: '' }; } } });
  assert.equal(await f.controls.onCommand(f.args('/files')), true);
  assert.deepEqual(f.replies, []);
  const listing = continued(await f.controls.onInvoke(task(sent[0].card.actions[0].data, 'task/fetch')));
  assert.match(JSON.stringify(listing), /hello\.txt/);
  const shared = await f.controls.shareFile({ channelId: 'teams:19:source@thread.v2', slug: 'source', authorId: '29:owner', threadKey: '123456', relative: 'hello.txt' });
  assert.equal(shared.messageId, '');
  assert.match(JSON.stringify(continued(await f.controls.onInvoke(task(sent[1].card.actions[0].data, 'task/fetch')))), /hello/);
  f.controls.stop();
});

test('agent file delivery opens the proven source workspace and refuses invalid or revoked files', async () => {
  let allowed = true;
  const seen = [];
  const f = fixture({ authorize: async grant => {
    seen.push(grant);
    if (!allowed) throw new Error('Access revoked');
    return { root, meta: { allowBash: true }, userIsAdmin: true };
  } });
  const input = { channelId: 'teams:19:source@thread.v2', slug: 'source', authorId: '29:owner', threadKey: '123456', relative: 'hello.txt' };
  const posted = await f.controls.shareFile(input);
  assert.equal(posted.messageId, 'card1');
  assert.equal(f.sent[0].conversationId, '19:source@thread.v2');
  assert.equal(f.sent[0].threadKey, input.threadKey);
  assert.deepEqual(seen[0], { channelId: input.channelId, slug: input.slug, ownerId: input.authorId });
  assert.doesNotMatch(JSON.stringify(f.sent), /hello\.txt|file-download/);
  const preview = continued(await f.controls.onInvoke(task(f.sent[0].card.actions[0].data, 'task/fetch')));
  assert.match(JSON.stringify(preview), /hello/);
  await assert.rejects(f.controls.shareFile({ ...input, relative: '../outside' }));
  await symlink(path.join(root, '..', 'outside-not-found'), path.join(root, 'outside-link'));
  await assert.rejects(f.controls.shareFile({ ...input, relative: 'outside-link' }));
  allowed = false;
  await assert.rejects(f.controls.shareFile(input), /Access revoked/);
  assert.equal(f.sent.length, 1);
});

test('failed launcher delivery retires its durable reference', async () => {
  const { inspectTeamsFileLauncher } = await import('../src/platforms/msteams/file-launchers.js');
  let reference;
  const f = fixture({ connector: { api: { sendActivity: async () => ({}) }, botId: '28:delivery-failure', postCard: async payload => {
    reference = payload.card.actions[0].data.stateId;
    assert.ok(inspectTeamsFileLauncher(reference, '28:delivery-failure').state, 'persist before delivery');
    throw new Error('Card delivery failed');
  } } });
  await f.controls.onCommand(f.args('/files'));
  assert.ok(reference);
  assert.equal(inspectTeamsFileLauncher(reference, '28:delivery-failure').reason, 'unknown');
  assert.match(f.replies[0], /Card delivery failed/);
});

test('file launchers evicted from the private-dialog memory cache still open their source workspace', async () => {
  const f = fixture(); await f.controls.onCommand(f.args('/files'));
  const launcher = f.sent[0].card.actions[0].data;
  for (let i = 0; i < 502; i++) await f.controls.onCommand(f.args('/files'));
  const listing = continued(await f.controls.onInvoke(task(launcher, 'task/fetch')));
  assert.equal(listing.body[0].text, 'Conversation files');
  assert.match(JSON.stringify(listing), /hello\.txt/);
});
