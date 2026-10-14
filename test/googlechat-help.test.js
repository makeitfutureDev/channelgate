import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { GOOGLE_CHAT_HELP_TEXT, createGoogleChatHelpCard } = await import('../src/platforms/googlechat/help.js');
const { createGoogleChatControls } = await import('../src/platforms/googlechat/controls.js');
const { createGoogleChatConnector } = await import('../src/platforms/googlechat/connector.js');
const { createChatApi } = await import('../src/platforms/googlechat/api.js');
const { startGoogleChat } = await import('../src/platforms/googlechat/transport.js');
const { createIngest } = await import('../src/platforms/ingest.js');
const { googleChatAdapter } = await import('../src/platforms/googlechat.js');
const { validateChatCard } = await import('../src/platforms/googlechat/cards.js');
const { setUser } = await import('../src/config/store.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { formatChatOutbound } = await import('../src/platforms/format/gchat.js');
await setUser('help-owner@example.com', { approved: true, isAdmin: true });

function apiFixture({ rejectCards = false } = {}) {
  const calls = [];
  const api = createChatApi({ auth: { token: async () => 'fake' }, fetchImpl: async (url, init) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body });
    if (rejectCards && body?.cardsV2?.length) return { ok: false, status: 400, text: async () => 'Cards unavailable' };
    const space = new URL(url).pathname.split('/messages')[0].replace(/^\/v1\//, '');
    return { ok: true, status: 200, json: async () => ({ name: `${space}/messages/help-${calls.length}`, thread: body?.thread }) };
  } });
  return { calls, api, connector: createGoogleChatConnector({ api, capabilities: googleChatAdapter.capabilities }) };
}

test('native Google Chat help starts compact and expands topics entirely in the client', () => {
  const card = createGoogleChatHelpCard();
  assert.equal(card.header.title, 'How to use me');
  assert.equal(card.sections.length, 8);
  assert.deepEqual(card.sections.slice(0, 2).map(s => s.header), ['🚀  Get started', '⚡  Useful commands']);
  assert.equal(card.sections[0].collapsible, undefined);
  const topics = card.sections.slice(2);
  assert.equal(topics.length, 6);
  assert.equal(topics.every(s => s.collapsible && s.uncollapsibleWidgetsCount === 0 && s.widgets.length), true);
  assert.equal(validateChatCard(card), card);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 28_000);
  assert.doesNotMatch(JSON.stringify(card), /onClick|textInput|Action\.ToggleVisibility|AdaptiveCard/);
  assert.match(JSON.stringify(card), /protected browser page/);
  assert.doesNotMatch(GOOGLE_CHAT_HELP_TEXT, /Teams|Microsoft|Accept\/Decline|reaction picker/);
  assert.match(GOOGLE_CHAT_HELP_TEXT, /configured start emoji \(🤖 by default\)/);
});

test('help card lays commands out as icon rows with bold commands and escaped descriptions', () => {
  const card = createGoogleChatHelpCard();
  const widgets = card.sections.flatMap(section => section.widgets);
  const rows = widgets.filter(widget => widget.decoratedText);
  assert.ok(rows.length >= 20, 'commands and quick-start entries render as decorated rows');
  assert.equal(rows.every(widget => widget.decoratedText.wrapText && widget.decoratedText.startIcon?.materialIcon?.name), true);
  const icon = command => rows.find(widget => widget.decoratedText.text.startsWith(`<b>${command}`))?.decoratedText.startIcon.materialIcon.name;
  assert.equal(icon('/model'), 'tune');
  assert.equal(icon('/stop'), 'stop_circle');
  assert.equal(icon('/settings'), 'settings');
  assert.match(rows.find(widget => widget.decoratedText.text.startsWith('<b>/stop</b>  ·  <b>/cancel</b>')).decoratedText.text, /<br>Stop this session/);
  assert.equal(card.sections[0].widgets.map(widget => widget.decoratedText.startIcon.materialIcon.name).join(), 'person,groups,forum');
  assert.equal(icon('list skills'), 'chat_bubble');
  // Markdown becomes Chat HTML; literal angle brackets stay escaped text.
  assert.doesNotMatch(JSON.stringify(card), /\*\*|`/);
  assert.match(JSON.stringify(card), /&lt;path&gt;/);
  assert.equal(card.sections.slice(2).map(s => s.header).join('|'),
    '⌨️  All commands|📎  Files & voice notes|⚙️  Settings, connections & access|🧠  Skills & memory|⏰  Reminders & background work|💬  Reply controls');
});

test('plain help fallback contains all commands and fits the Google formatter message budget', () => {
  for (const command of ['help', 'settings', 'secrets', 'files', 'sendfile', 'status', 'model', 'effort', 'stop', 'cancel', 'clear']) {
    assert.ok(GOOGLE_CHAT_HELP_TEXT.includes(`/${command}`));
    assert.ok(JSON.stringify(createGoogleChatHelpCard()).includes(`/${command}`));
  }
  const formatted = formatChatOutbound(GOOGLE_CHAT_HELP_TEXT, { capabilities: googleChatAdapter.capabilities });
  assert.ok(formatted.chunks.length > 1);
  for (const chunk of formatted.chunks) assert.ok(chunk.text.length <= googleChatAdapter.capabilities.maxMessageChars);
  assert.match(formatted.chunks.map(chunk => chunk.text).join('\n'), /Whisper|background/);
});

test('Google Chat Pub/Sub help dispatch reaches native REST cards before an engine in DM, group and space', async () => {
  const f = apiFixture();
  const controls = createGoogleChatControls({ connector: f.connector });
  const ingest = createIngest({ connector: f.connector, onCommand: controls.onCommand, run: async () => assert.fail('/help cannot invoke an engine'), log: {} });
  const transport = await startGoogleChat({ subscription: 'projects/cg-test/subscriptions/help-end-to-end',
    capabilities: googleChatAdapter.capabilities, onMessage: ingest, onCard: controls.onCard, log: {},
    deps: { auth: { token: async () => 'fake' }, api: f.api, connector: f.connector, puller: { start() {}, async stop() {} } },
  });
  try {
    for (const kind of ['dm', 'group', 'space']) {
      const space = { name: `spaces/help-${kind}`, spaceType: kind === 'dm' ? 'DIRECT_MESSAGE' : 'SPACE', ...(kind === 'space' ? { displayName: 'Help space' } : {}) };
      await transport.onEvent({ chat: { messagePayload: { space, message: {
        name: `${space.name}/messages/ask-help`, text: '/help', argumentText: '/help',
        sender: { name: 'users/help-owner', email: 'help-owner@example.com', type: 'HUMAN' },
        thread: { name: `${space.name}/threads/T` },
        annotations: kind === 'dm' ? [] : [{ type: 'USER_MENTION', userMention: { user: { name: 'users/bot', type: 'BOT' } } }],
      } } } });
      for (let ticks = 0; ticks < 100 && f.calls.filter(call => call.method === 'POST').length < ['dm', 'group', 'space'].indexOf(kind) + 1; ticks++) await new Promise(resolve => setTimeout(resolve, 10));
      const sent = f.calls.filter(call => call.method === 'POST').at(-1);
      assert.ok(sent, `${kind} help must arrive`);
      assert.equal(sent.method, 'POST');
      assert.ok(sent.url.includes(`${space.name}/messages`));
      assert.equal(sent.body.cardsV2[0].card.header.title, 'How to use me');
      assert.equal(sent.body.text, '', 'the card is the whole reply, with no duplicate text bubble');
      if (kind === 'dm') assert.equal(sent.body.thread, undefined);
      else assert.equal(sent.body.thread.name, `${space.name}/threads/T`);
    }
    const space = { name: 'spaces/help-registered', spaceType: 'SPACE', displayName: 'Registered commands' };
    await transport.onEvent({ chat: { user: { name: 'users/help-owner', email: 'help-owner@example.com', type: 'HUMAN' },
      appCommandPayload: { space, appCommandMetadata: { appCommandId: '142', appCommandType: 'SLASH_COMMAND' },
        message: { name: `${space.name}/messages/command`, text: '/help', annotations: [] } },
    } });
    for (let ticks = 0; ticks < 100 && f.calls.filter(call => call.method === 'POST').length < 4; ticks++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 4);
    assert.equal(f.calls.filter(call => call.method === 'POST').at(-1).body.cardsV2[0].card.header.title, 'How to use me');
  } finally { controls.stop(); await transport.stop(); }
});

test('unmentioned and unapproved requests do not receive native help', async () => {
  const f = apiFixture();
  const controls = createGoogleChatControls({ connector: f.connector });
  const ingest = createIngest({ connector: f.connector, onCommand: controls.onCommand, run: async () => assert.fail('/help cannot invoke an engine'), log: {} });
  assert.deepEqual(await ingest(makeInbound({ platform: 'googlechat', kind: 'channel', text: '/help',
    conversationId: 'spaces/unmentioned-help', messageId: 'spaces/unmentioned-help/messages/1', userId: 'help-owner@example.com' })), { skipped: 'not-mentioned' });
  assert.deepEqual(await ingest(makeInbound({ platform: 'googlechat', kind: 'dm', text: '/help',
    conversationId: 'spaces/unapproved-help', messageId: 'spaces/unapproved-help/messages/1', userId: 'unknown-help@example.com' })), { skipped: 'unauthorized' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.cardsV2.length, 0);
  assert.match(f.calls[0].body.text, /not approved/);
  controls.stop();
});

test('native help REST failure falls back to the complete guide in the same conversation', async () => {
  const f = apiFixture({ rejectCards: true });
  const controls = createGoogleChatControls({ connector: f.connector });
  const ingest = createIngest({ connector: f.connector, onCommand: controls.onCommand, run: async () => assert.fail('/help cannot invoke an engine'), log: {} });
  const message = makeInbound({ platform: 'googlechat', kind: 'channel', text: '/help', mentionsBot: true,
    conversationId: 'spaces/help-fallback', messageId: 'spaces/help-fallback/messages/1', threadKey: 'spaces/help-fallback/threads/T', userId: 'help-owner@example.com' });
  assert.deepEqual(await ingest(message), { command: true });
  assert.ok(f.calls[0].body.cardsV2.length);
  const fallback = f.calls.filter(call => call.method === 'POST').slice(1);
  assert.ok(fallback.length > 1);
  assert.equal(fallback.every(call => !call.body.cardsV2.length && call.body.thread.name === message.threadKey), true);
  assert.match(fallback.map(call => call.body.text).join('\n'), /\/clear/);
  assert.match(fallback.map(call => call.body.text).join('\n'), /configured start emoji \(🤖 by default\)/);
  controls.stop();
});
