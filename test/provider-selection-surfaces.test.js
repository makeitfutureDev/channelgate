import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { saveSettings } = await import('../src/config/settings.js');
const { setUser, upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import('../src/config/store.js');
const { setThreadEngine, setThreadModel, getThreadEngine, getThreadModel } = await import('../src/gateway/thread-engine.js');
const { processMessageEvent } = await import('../src/slack/message-pipeline.js');
const { createAdminRouter } = await import('../src/web/routes/admin.js');
const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ connected: false }) } }));
const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const setup = () => saveSettings({ engine: 'claude', engineEnabled: { claude: true, codex: true, 'qwen-eu': true }, qwenApiKey: 'fixture-other-provider-key', qwenEuApiKey: '', qwenEuBaseUrl: '' });

test('admin channel and DM saves cannot replace a runtime with an unconfigured provider', async () => {
  setup();
  for (const isDM of [false, true]) {
    const id = isDM ? 'D_PROVIDER_SAVE' : 'C_PROVIDER_SAVE';
    const entry = await upsertChannelEntry(id, { name: id, isDM, type: isDM ? 'im' : 'channel' });
    await saveChannelMeta(entry.slug, { channelId: id, name: id, isDM, template: 'custom', engine: 'codex', model: 'gpt-6-sol' });
    const response = await fetch(`${base}/${isDM ? `dms/${id}` : `channels/${id}/meta`}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'qwen-eu' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /not configured/);
    assert.equal((await getChannelMeta(entry.slug)).engine, 'codex');
  }
});

test('a provider directive rejects missing credentials, keeps pins, and succeeds with its own configured account', async () => {
  setup();
  const user = 'U_PROVIDER_ADMIN', id = 'D_PROVIDER_DIRECTIVE', thread = '1800000000.112233';
  await setUser(user, { name: 'Fixture admin', isAdmin: true, approved: true });
  const entry = await upsertChannelEntry(id, { name: id, isDM: true, type: 'im' });
  await saveChannelMeta(entry.slug, { channelId: id, name: id, isDM: true, type: 'im', template: 'custom', engine: 'claude', access: 'approved' });
  await setThreadEngine(entry.slug, thread, 'codex');
  await setThreadModel(entry.slug, thread, 'gpt-6-sol');
  const posted = [], ok = async () => ({ ok: true });
  const client = { chat: { postMessage: async message => { posted.push(message); return { ok: true, ts: '1800000001.112233' }; }, postEphemeral: ok, update: ok },
    users: { info: async () => ({ user: { id: user, real_name: 'Fixture admin' } }) },
    conversations: { info: async () => ({ channel: { id, is_im: true } }), history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) }, apiCall: ok };
  const send = ts => processMessageEvent({ type: 'message', channel: id, channel_type: 'im', user, text: 'qwen-eu', ts, thread_ts: thread }, client, { botUserId: 'U_PROVIDER_BOT' });
  await send('1800000002.112233');
  assert.match(posted.at(-1).text, /not configured/);
  assert.equal(await getThreadEngine(entry.slug, thread), 'codex');
  assert.equal(await getThreadModel(entry.slug, thread), 'gpt-6-sol');
  saveSettings({ qwenEuApiKey: 'fixture-eu-provider-key', qwenEuBaseUrl: 'https://workspace.example/apps/anthropic' });
  await send('1800000003.112233');
  assert.match(posted.at(-1).text, /now uses.*Qwen EU/);
  assert.equal(await getThreadEngine(entry.slug, thread), 'qwen-eu');
  assert.equal(await getThreadModel(entry.slug, thread), '');
});
