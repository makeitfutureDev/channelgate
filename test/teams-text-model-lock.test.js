import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createConversationControls } = await import('../src/platforms/conversation-controls.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { saveSettings } = await import('../src/config/settings.js');
const { getThreadEngine, getThreadModel, getThreadEffort, resolveThreadEngine, setThreadRuntimeOverrides } = await import('../src/gateway/thread-engine.js');
const { getDb } = await import('../src/db/index.js');

const snapshot = async slug => ({ engine: await getThreadEngine(slug, 'root'), model: await getThreadModel(slug, 'root'), effort: await getThreadEffort(slug, 'root') });
async function command(slug, text, meta, { kind = 'channel', controls = createConversationControls() } = {}) {
  const replies = [];
  const message = makeInbound({ platform: 'msteams', conversationId: `19:${slug}@thread.v2`, messageId: 'command', kind, userId: 'teams:model-admin', text, mentionsBot: true });
  const handled = await controls.command({ message, sessionKey: 'root', slug, meta, authorIsAdmin: true, reply: async value => replies.push(value) });
  assert.equal(handled, true);
  return replies.at(-1);
}
function settings(engineEnabled = { claude: true, codex: true }) {
  saveSettings({ engineEnabled, defaultClaudeModel: 'sonnet', defaultCodexModel: 'gpt-6-sol' });
}

for (const kind of ['channel', 'dm']) {
  test(`Teams ${kind} /model claude rejects a channel Codex login without changing any override`, async () => {
    settings();
    const slug = `teams-text-lock-${kind}`, before = { engine: 'codex', model: 'gpt-6-sol', effort: 'high' };
    setThreadRuntimeOverrides(slug, 'root', before);
    const meta = { engine: 'codex', codexAuthSource: 'channel', model: 'gpt-6-sol' };
    assert.match(await command(slug, '/model claude sonnet', meta, { kind }), /own Codex login.*Codex/);
    assert.deepEqual(await snapshot(slug), before);
    assert.equal(await resolveThreadEngine(slug, 'root', meta), 'codex');
  });
}

for (const selection of ['/model codex gpt-6-astra', '/model gpt-6-astra']) {
  test(`Teams channel Codex login accepts ${selection} and retains compatible effort`, async () => {
    settings();
    const slug = `teams-text-lock-valid-${selection.includes('codex ') ? 'explicit' : 'implicit'}`;
    setThreadRuntimeOverrides(slug, 'root', { engine: 'codex', model: 'gpt-6-sol', effort: 'high' });
    const meta = { engine: 'codex', codexAuthSource: 'channel' };
    assert.match(await command(slug, selection, meta), /Session engine: codex; model: gpt-6-astra/);
    assert.deepEqual(await snapshot(slug), { engine: 'codex', model: 'gpt-6-astra', effort: 'high' });
  });
}

for (const engine of ['claude', 'codex']) {
  const other = engine === 'claude' ? 'codex' : 'claude', model = engine === 'claude' ? 'sonnet' : 'gpt-6-sol';
  test(`Teams text /model switches an unlocked session to ${engine} and resets effort`, async () => {
    settings();
    const slug = `teams-text-switch-${engine}`;
    setThreadRuntimeOverrides(slug, 'root', { engine: other, model: other === 'claude' ? 'opus' : 'gpt-6-astra', effort: 'high' });
    assert.match(await command(slug, `/model ${engine} ${model}`, { engine: other }), new RegExp(`Session engine: ${engine}; model: ${model}`));
    assert.deepEqual(await snapshot(slug), { engine, model, effort: '' });
    assert.equal(await resolveThreadEngine(slug, 'root', { engine: other }), engine);
    assert.match(await command(slug, '/effort high', { engine: other }), /Session effort: high/);
    assert.equal((await snapshot(slug)).effort, 'high');
  });
  test(`Teams text /model rejects disabled ${engine} without changing any override`, async () => {
    settings({ claude: true, codex: true, [engine]: false });
    const slug = `teams-text-disabled-${engine}`, before = { engine: other, model: other === 'claude' ? 'opus' : 'gpt-6-astra', effort: 'high' };
    setThreadRuntimeOverrides(slug, 'root', before);
    assert.match(await command(slug, `/model ${engine} ${model}`, { engine: other }), /disabled/);
    assert.deepEqual(await snapshot(slug), before);
  });
}

test('Teams /status and /effort use the selected engine compatible model and effort', async () => {
  settings();
  const slug = 'teams-text-compatible-inheritance';
  setThreadRuntimeOverrides(slug, 'root', { engine: 'claude', model: '', effort: '' });
  const meta = { engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' };
  assert.match(await command(slug, '/status', meta), /Engine: claude; model: sonnet; effort: engine default/);
  assert.match(await command(slug, '/effort ultra', meta), /Choose an effort/);
  assert.equal((await snapshot(slug)).effort, '');
  assert.match(await command(slug, '/effort high', meta), /Session effort: high/);
  assert.match(await command(slug, '/status', meta), /Engine: claude; model: sonnet; effort: high/);
});

test('Teams /model default clears the model override and reports the compatible inherited model', async () => {
  settings();
  const slug = 'teams-text-default';
  setThreadRuntimeOverrides(slug, 'root', { engine: 'claude', model: 'opus', effort: 'high' });
  const meta = { engine: 'codex', model: 'gpt-6-sol' };
  assert.match(await command(slug, '/model claude default', meta), /Session engine: claude; model: inherited default/);
  assert.deepEqual(await snapshot(slug), { engine: 'claude', model: '', effort: 'high' });
  assert.match(await command(slug, '/status', meta), /Engine: claude; model: sonnet; effort: high/);
});

// Delay concurrent operations until admission, after the initial idle check. This deterministic
// scheduling seam avoids sleeps or replacing the real engine admission/store implementations.
function duringAdmission(callback) {
  let reads = 0;
  return { engine: 'claude', get codexAuthSource() {
    if (++reads === 2) queueMicrotask(callback);
    return '';
  } };
}
function storedTriple(slug) {
  const rows = getDb().prepare('SELECT kind, value FROM thread_overrides WHERE slug = ? AND thread_key = ? AND kind IN (\'engine\', \'model\', \'effort\')').all(slug, 'root');
  return { engine: '', model: '', effort: '', ...Object.fromEntries(rows.map(row => [row.kind, row.value])) };
}

test('Teams /model refuses work admitted after its initial idle check without changing runtime', async () => {
  settings();
  const slug = 'teams-model-admission-busy', controls = createConversationControls();
  const before = { engine: 'claude', model: 'sonnet', effort: 'high' };
  setThreadRuntimeOverrides(slug, 'root', before);
  let release, running;
  const blocked = new Promise(resolve => { release = resolve; });
  const meta = duringAdmission(() => {
    const message = makeInbound({ platform: 'msteams', conversationId: `19:${slug}@thread.v2`, messageId: 'concurrent-work', kind: 'channel', userId: 'teams:model-admin', text: 'work', mentionsBot: true });
    running = controls.execute({ message, sessionKey: 'root', queued: async () => {}, work: async () => blocked });
  });
  try {
    const reply = await command(slug, '/model codex gpt-6-sol', meta, { controls });
    assert.ok(running, 'work must enter the lane during engine admission');
    assert.match(reply, /Wait.*work|busy/i);
    assert.deepEqual(storedTriple(slug), before);
  } finally { release(); await running; }
});

test('Teams /model preserves a concurrent complete Settings runtime save instead of overwriting it', async () => {
  settings();
  const slug = 'teams-model-admission-stale';
  setThreadRuntimeOverrides(slug, 'root', { engine: 'claude', model: 'sonnet', effort: 'high' });
  const newer = { engine: 'claude', model: 'opus', effort: 'low' };
  let changed = false;
  const meta = duringAdmission(() => { setThreadRuntimeOverrides(slug, 'root', newer); changed = true; });
  const reply = await command(slug, '/model codex gpt-6-sol', meta);
  assert.ok(changed, 'Settings must save during engine admission');
  assert.match(reply, /changed|reopen|retry/i);
  assert.deepEqual(storedTriple(slug), newer);
});

test('Teams /model exposes only complete runtime triples to concurrent readers', async () => {
  settings();
  const slug = 'teams-model-atomic-triple';
  const before = { engine: 'claude', model: 'sonnet', effort: 'high' }, after = { engine: 'codex', model: 'gpt-6-sol', effort: '' };
  setThreadRuntimeOverrides(slug, 'root', before);
  const observed = [];
  let observer;
  const meta = duringAdmission(() => {
    observer = (async () => {
      for (let step = 0; step < 8; step += 1) { observed.push(storedTriple(slug)); await Promise.resolve(); }
    })();
  });
  assert.match(await command(slug, '/model codex gpt-6-sol', meta), /Session engine: codex/);
  await observer;
  assert.ok(observed.length, 'reader must run during admission/save');
  assert.deepEqual(storedTriple(slug), after);
  for (const value of observed) assert.ok(JSON.stringify(value) === JSON.stringify(before) || JSON.stringify(value) === JSON.stringify(after), `partial runtime observed: ${JSON.stringify(value)}`);
});

for (const targetEngine of ['claude', 'codex']) test(`Teams native /model Apply to ${targetEngine} respects authorized SQLite pending work through ingest`, async t => {
  const [{ startTeams }, { createTeamsControls }, { createIngest, ensureConversation }, { setUser }] = await Promise.all([
    import('../src/platforms/msteams/transport.js'), import('../src/platforms/msteams/controls.js'),
    import('../src/platforms/ingest.js'), import('../src/config/store.js'),
  ]);
  settings();
  const appId = `pending-model-${targetEngine}`, sent = [], actor = `29:${appId}-admin`;
  const initialEngine = targetEngine === 'claude' ? 'codex' : 'claude';
  const before = { engine: initialEngine, model: initialEngine === 'claude' ? 'sonnet' : 'gpt-6-astra', effort: 'high' };
  const connector = { platform: 'msteams',
    api: { sendActivity: async () => assert.fail('model picker must not send file consent') },
    post: async () => assert.fail('native picker must use cards'),
    postCard: async payload => { sent.push(payload); return { messageId: 'pending-model-card' }; },
    updateCard: async payload => { sent.push(payload); },
  };
  const transport = await startTeams({ appId, onMessage: async () => assert.fail('pending fixture must not execute'),
    log: {}, deps: { auth: { token: async () => 'fixture-token' }, api: {}, connector,
      // Hold accepted work without dispatching an engine. Production pending lookup still queries
      // the real scratch SQLite queue and uses ingest's current authorization predicate.
      createInbox: () => ({ start() {}, stop() {}, accept() { assert.fail('test uses a persisted queue fixture'); } }),
    } });
  t.after(async () => { await transport.stop(); });
  await setUser(actor, { isAdmin: true, approved: true });
  const message = makeInbound({ platform: 'msteams', conversationId: `19:${appId}@thread.v2`, kind: 'channel',
    threadKey: 'root', messageId: 'open-model', userId: actor, text: '/model', mentionsBot: true });
  const { entry, meta } = await ensureConversation(message, connector);
  setThreadRuntimeOverrides(entry.slug, 'root', before);
  let captured;
  const native = createTeamsControls({ connector, authorize: async () => ({ meta, userIsAdmin: true }) });
  t.after(() => native.stop());
  const ingest = createIngest({ connector, onCommand: async args => { captured = args; return native.onCommand(args); },
    run: async () => assert.fail('model picker must not invoke an engine'), log: {} });
  assert.deepEqual(await ingest(message), { command: true });
  assert.equal(captured.sessionKey, 'root');
  const queued = { ...message, text: 'queued work', messageId: 'waiting-work' };
  getDb().prepare('INSERT INTO inbound_events(namespace, event_id, conversation_id, status, created_ms, owner, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`msteams-bot:${appId}`, 'waiting-work', JSON.stringify([message.conversationId, 'root']), 'queued', Date.now(), '', JSON.stringify({ inbound: queued }));
  assert.equal((await connector.pendingForSession({ conversationId: message.conversationId, sessionKey: 'root' })).count, 1);
  const submit = async (verb, data) => {
    const shown = sent.at(-1).card;
    const action = [...shown.actions, ...shown.body.filter(item => item.type === 'ActionSet').flatMap(item => item.actions)].find(item => item.verb === verb);
    assert.ok(action, `${verb} must be offered by the picker`);
    return native.onInvoke({ type: 'invoke', name: 'adaptiveCard/action', from: { id: actor },
      serviceUrl: 'https://smba.trafficmanager.net/teams/', conversation: { id: message.rawConversationId },
      value: { action: { type: 'Action.Execute', verb, data: { ...action.data, ...data } } } });
  };
  await submit('model.load', { engine: targetEngine });
  const result = await submit('model.save', { engine: targetEngine, model: targetEngine === 'claude' ? 'opus' : 'gpt-6-sol', effort: 'low' });
  assert.equal(result.status, 200);
  assert.match(JSON.stringify(sent.at(-1).card), /Wait for this session.*work/);
  assert.deepEqual(storedTriple(entry.slug), before, 'pending work must preserve engine, model, and effort');
  assert.equal(getDb().prepare('SELECT status FROM inbound_events WHERE namespace = ? AND event_id = ?').get(`msteams-bot:${appId}`, 'waiting-work').status, 'queued');
});
