import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { createConversationControls } = await import('../src/platforms/conversation-controls.js');
const { createIngest, createConversationProgress } = await import('../src/platforms/ingest.js');
const { makeInbound } = await import('../src/platforms/inbound.js');
const { setUser } = await import('../src/config/store.js');
const { saveSession, getSession, sessionGeneration } = await import('../src/gateway/sessions.js');
const { getThreadModel } = await import('../src/gateway/thread-engine.js');
const { platformOr } = await import('../src/platforms/registry.js');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const message = (text = 'hello', userId = 'controls-owner') => ({ conversationId: 'teams:controls', text, userId, isDM: false });
const args = (controls, text, extra = {}) => controls.command({ message: message(text), sessionKey: 'root', slug: 'controls', meta: { engine: 'claude' }, authorIsAdmin: true, reply: async () => {}, ...extra });

test('same-session work serializes; a different session runs immediately', async () => {
  const controls = createConversationControls();
  const started = deferred(); const release = deferred(); const seen = []; const notices = [];
  const first = controls.execute({ message: message(), sessionKey: 'root', queued: async (v) => notices.push(v), work: async () => { seen.push('first'); started.resolve(); await release.promise; } });
  await started.promise;
  const second = controls.execute({ message: message(), sessionKey: 'root', queued: async (v) => notices.push(v), work: async () => seen.push('second') });
  await controls.execute({ message: message(), sessionKey: 'other', queued: async () => {}, work: async () => seen.push('other') });
  assert.deepEqual(seen, ['first', 'other']); assert.match(notices[0], /position 1/);
  release.resolve(); await Promise.all([first, second]); assert.deepEqual(seen, ['first', 'other', 'second']);
});

test('only owner/admin can stop; cancellation prevents queued engine execution', async () => {
  const controls = createConversationControls(); const started = deferred(); const stopped = deferred(); const notices = [];
  let signal; let queuedRan = false;
  const first = controls.execute({ message: message(), sessionKey: 'root', queued: async () => {}, work: async (s) => { signal = s; started.resolve(); await new Promise((r) => s.addEventListener('abort', r, { once: true })); stopped.resolve(); } });
  await started.promise;
  const second = controls.execute({ message: message(), sessionKey: 'root', queued: async (v) => notices.push(v), work: async () => { queuedRan = true; } });
  await args(controls, '/stop', { message: message('/stop', 'another-user'), authorIsAdmin: false, reply: async (v) => notices.push(v) });
  assert.equal(signal.aborted, false); assert.match(notices.at(-1), /Only the run author/);
  await args(controls, '/stop', { authorIsAdmin: false }); await stopped.promise; await Promise.all([first, second]);
  assert.equal(queuedRan, false); assert.ok(notices.includes('Cancelled before starting.'));
});

test('clear waits for aborted work and fences late session saves', async () => {
  const controls = createConversationControls(); const started = deferred(); const finish = deferred(); const notices = [];
  const generation = sessionGeneration('controls', 'root');
  await saveSession('controls', 'root', 'before', 'claude', generation);
  const running = controls.execute({ message: message(), sessionKey: 'root', queued: async () => {}, work: async (signal) => { started.resolve(); await finish.promise; assert.equal(signal.aborted, true); await saveSession('controls', 'root', 'late', 'claude', generation); } });
  await started.promise;
  const clearing = args(controls, '/clear', { reply: async (v) => notices.push(v) });
  await new Promise((r) => setImmediate(r));
  assert.match(notices[0], /waiting/); assert.equal(notices.length, 1);
  const blocked = await controls.execute({ message: message(), sessionKey: 'root', queued: async () => {}, work: async () => assert.fail('must not run while clearing') });
  assert.equal(blocked.skipped, 'clearing');
  finish.resolve(); await Promise.all([running, clearing]);
  assert.equal(await getSession('controls', 'root'), ''); assert.match(notices.at(-1), /Session cleared/);
});

test('runtime policy is enforced and reactions never execute quoted slash commands', async () => {
  const controls = createConversationControls(); const replies = [];
  const reply = async (v) => replies.push(v);
  await args(controls, '/model sonnet', { authorIsAdmin: false, reply });
  assert.match(replies.at(-1), /restricted/);
  assert.equal(await args(controls, '/clear', { message: { ...message('/clear'), trigger: 'reaction' }, reply }), false);
  await args(controls, '/model sonnet', { message: { ...message('/model sonnet'), isDM: true }, authorIsAdmin: false, reply });
  assert.equal(await getThreadModel('controls', 'root'), 'sonnet');
  await args(controls, '/effort impossible', { reply }); assert.match(replies.at(-1), /Choose an effort/);
});

test('authorized ingest handles controls without invoking engine and preserves group quote root', async () => {
  await setUser('teams:controls-ingest-user', { approved: true, admin: true });
  const posts = []; let calls = 0;
  const connector = { platform: 'msteams', async post(p) { posts.push(p); return { messageId: `reply${posts.length}`, conversationId: p.conversationId }; }, async edit() {}, async directory() { return null; } };
  const ingest = createIngest({ connector, run: async () => { calls += 1; return { content: 'done' }; }, log: { info() {}, warn() {} } });
  const base = { platform: 'msteams', conversationId: '19:controls@thread.v2', kind: 'group', userId: 'teams:controls-ingest-user', mentionsBot: true };
  await ingest(makeInbound({ ...base, messageId: 'first', text: '/help' }));
  await ingest(makeInbound({ ...base, messageId: 'next', replyToId: 'reply1', text: '/status' }));
  assert.equal(calls, 0); assert.match(posts[0].text, /Commands/); assert.match(posts[1].text, /Idle/);
});

test('progress respects 30s budget and drains pending edit before stop', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
  const edits = []; const wait = deferred();
  const progress = createConversationProgress({ connector: { edit: async (v) => { edits.push(v); await wait.promise; } }, message: { rawConversationId: 'wire' }, placeholder: { messageId: 'p' }, adapter: platformOr('msteams') });
  t.mock.timers.tick(29999); await Promise.resolve(); assert.equal(edits.length, 0);
  progress.event({ kind: 'run_queued', position: 2 });
  t.mock.timers.tick(1); await Promise.resolve(); assert.equal(edits.length, 1); assert.match(edits[0].text, /position 2/);
  t.mock.timers.tick(60000); await Promise.resolve(); assert.equal(edits.length, 1, 'no overlapping edits');
  let stopped = false; const stop = progress.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  wait.resolve(); await stop; t.mock.timers.tick(60000); assert.equal(edits.length, 1);
});
