import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ensureTestEnv, testLicenseEnv } from './helpers.js';
ensureTestEnv();
testLicenseEnv();
process.env.MAX_CONCURRENT_RUNS = '1';
process.env.RESERVED_INTERACTIVE_RUNS = '0';
process.env.SESSION_KEEPALIVE = '0';
const { useFakeRuntime } = await import('./runtime-fake.js');
const backend = await useFakeRuntime();
const { getDb } = await import('../src/db/index.js');
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import('../src/config/store.js');
const { channelBudgetStatus, assertChannelBudget } = await import('../src/gateway/channel-budget.js');
const { monthlyChannelSpend: channelMonthSpend } = await import('../src/gateway/usage.js');
const { normalizeSpendingLimit: validateMonthlyBudget } = await import('../src/ee/channel-spending.js');
const { runMessage, acquireRunSlot, resetRunSlots } = await import('../src/gateway/run.js');
const { runMemoryReview } = await import('../src/gateway/memory-review.js');
const { createChannelsRouter } = await import('../src/web/routes/channels.js');
const { inheritedCodeChannelMeta } = await import('../src/gateway/code-channels.js');
const app = express();
app.use(express.json());
app.use(createChannelsRouter());
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const now = new Date('2026-12-15T00:00:00Z');
function row(channel, ts, cost, kind = 'interactive') {
  return Number(getDb().prepare('INSERT INTO usage(channel_id,ts,cost_usd,task_kind) VALUES(?,?,?,?)').run(channel, ts, cost, kind).lastInsertRowid);
}

test('default unlimited and canonical positive USD validation', () => {
  assert.equal(defaultChannelMeta({ channelId: 'B_DEFAULT' }).monthlySpendingLimitUSD, null);
  for (const value of [null, 0.01, 1.23, 100]) assert.equal(validateMonthlyBudget(value), value);
  for (const value of [undefined, 0, '10', -1, NaN, Infinity, true, {}]) assert.throws(() => validateMonthlyBudget(value));
  assert.equal(channelBudgetStatus('B_ZERO', {}, now).exhausted, false);
});

test('calendar UTC bounds, channel isolation, all task kinds and canonical component costs', () => {
  const c = 'B_SUM';
  row(c, '2026-11-30T23:59:59.999Z', 99);
  row(c, '2027-01-01T00:00:00.000Z', 99);
  row('B_OTHER', '2026-12-01T00:00:00.000Z', 99);
  row(c, '2026-12-01T00:00:00.000Z', 1, 'memory_review');
  row(c, '2026-12-31T23:59:59.999Z', 2, 'background-agent');
  row(c, '2026-12-20T00:00:00.000Z', null);
  const id = row(c, '2026-12-21T00:00:00.000Z', 100);
  getDb().prepare(`INSERT INTO usage_components(usage_id,source_key,model,cost_usd) VALUES(?, 'budget-root', 'fixture', 3)`).run(id);
  assert.deepEqual(channelMonthSpend(c, now), { month: '2026-12', spentUSD: 6, unpricedRuns: 1 });
  assert.equal(channelBudgetStatus(c, { monthlySpendingLimitUSD: 6 }, now).exhausted, true);
  assert.equal(channelBudgetStatus(c, { monthlySpendingLimitUSD: 6.01 }, now).exhausted, false);
  assert.equal(channelBudgetStatus(c, { monthlySpendingLimitUSD: 6.01 }, now).allowed, false, "unpriced usage fails closed");
  assert.equal(channelBudgetStatus(c, { monthlySpendingLimitUSD: 6 }, new Date('2027-02-01T00:00:00Z')).exhausted, false);
});

test('admin API persists, audits, rejects invalid input atomically, preserves unrelated saves and removes budget', async () => {
  const id = 'B_API';
  const entry = await upsertChannelEntry(id, { name: id });
  await saveChannelMeta(entry.slug, { channelId: id, name: id });
  const put = body => fetch(`${base}/channels/${id}/meta`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await put({ monthlySpendingLimitUSD: 12.34 })).status, 200);
  assert.equal((await getChannelMeta(entry.slug)).monthlySpendingLimitUSD, 12.34);
  assert.equal((await put({ monthlySpendingLimitUSD: -1, model: 'invalid' })).status, 400);
  assert.equal((await getChannelMeta(entry.slug)).monthlySpendingLimitUSD, 12.34);
  assert.equal((await put({ memory: false })).status, 200);
  assert.equal((await getChannelMeta(entry.slug)).monthlySpendingLimitUSD, 12.34);
  const unrelated = { ...(await getChannelMeta(entry.slug)), memory: true };
  delete unrelated.monthlySpendingLimitUSD;
  await saveChannelMeta(entry.slug, unrelated);
  assert.equal((await getChannelMeta(entry.slug)).monthlySpendingLimitUSD, 12.34);
  const status = await (await fetch(`${base}/channels/${id}/budget`)).json();
  assert.equal(status.limitUSD, 12.34);
  assert.equal((await put({ monthlySpendingLimitUSD: null })).status, 200);
  assert.equal((await getChannelMeta(entry.slug)).monthlySpendingLimitUSD, null);
  assert.ok(getDb().prepare("SELECT data FROM events WHERE event = 'channel_meta_changed'").all().some(r => r.data.includes('monthlySpendingLimitUSD')));
});

test('budget blocks every run origin and both engines before provisioning, with no admin or override bypass', async () => {
  testLicenseEnv({ tier: 'enterprise', limits: { conversations: null, messagesPerConversationPerMonth: null } });
  const id = 'B_REFUSE';
  row(id, new Date().toISOString(), 1);
  const entry = await upsertChannelEntry(id, { name: id });
  for (const engine of ['claude', 'codex']) {
    await saveChannelMeta(entry.slug, { channelId: id, name: id, engine, monthlySpendingLimitUSD: 1, adminMode: true });
    for (const origin of ['slack_foreground', 'schedule', 'background_agent', 'api_foreground', 'googlechat_foreground', 'msteams_foreground', 'continuation', 'recovery', 'diagnosis']) {
      const result = await runMessage({ channelId: id, authorId: 'api', text: 'hello', threadKey: 'budget-test', origin, overrides: { monthlySpendingLimitUSD: null }, preferCold: true });
      assert.equal(result.budgetRefused, true, `${engine}/${origin}`);
      assert.match(result.content, /spending limit/);
      assert.equal(result.sessionId, null);
      assert.equal(result.costUSD, 0);
      assert.equal(result.cwd, '');
    }
  }
  let called = false;
  assert.deepEqual(await runMemoryReview({ channelId: id, slug: entry.slug, run: () => { called = true; } }), { skipped: 'channel-spending-limit', saved: 0 });
  assert.equal(called, false);
  await saveChannelMeta(entry.slug, { channelId: id, monthlySpendingLimitUSD: null });
  await assert.doesNotReject(assertChannelBudget(id, entry.slug));
});

test('budget policy is fetched anew for each attempt and code channels retain their own cap', async () => {
  const id = 'B_FRESH', entry = await upsertChannelEntry(id, { name: id });
  await saveChannelMeta(entry.slug, { channelId: id, monthlySpendingLimitUSD: 10 });
  await assert.doesNotReject(assertChannelBudget(id, entry.slug));
  row(id, new Date().toISOString(), 10);
  await saveChannelMeta(entry.slug, { channelId: id, monthlySpendingLimitUSD: 10 });
  await assert.rejects(assertChannelBudget(id, entry.slug), { code: 'channel_spending_limit' });
  assert.equal(inheritedCodeChannelMeta({ monthlySpendingLimitUSD: 10 }, {}).monthlySpendingLimitUSD, null);
  assert.equal(inheritedCodeChannelMeta({ monthlySpendingLimitUSD: 10 }, { monthlySpendingLimitUSD: 5 }).monthlySpendingLimitUSD, 5);
});


test('a queued run rechecks a budget changed while waiting and starts no engine', { timeout: 15000 }, async () => {
  const { setUser } = await import('../src/config/store.js');
  const { saveSettings } = await import('../src/config/settings.js');
  saveSettings({ engine: 'claude', codexFallback: false, composioMode: 'personal' });
  await setUser('U_B_QUEUE', { approved: true });
  const id = 'D_B_QUEUE', entry = await upsertChannelEntry(id, { name: id, type: 'im', isDM: true });
  await saveChannelMeta(entry.slug, { channelId: id, name: id, type: 'im', isDM: true, template: 'custom', engine: 'claude', cleanMode: true, monthlySpendingLimitUSD: 10 });
  resetRunSlots();
  const occupied = await acquireRunSlot({ origin: 'slack_foreground' });
  const queued = Promise.withResolvers();
  const running = runMessage({ channelId: id, authorId: 'U_B_QUEUE', text: 'test', threadKey: 'budget-queue', origin: 'slack_foreground', preferCold: true, onEvent: e => { if (e.kind === 'run_queued') queued.resolve(); } });
  try {
    await Promise.race([queued.promise, running.then(() => { throw new Error('Run did not queue'); })]);
    row(id, new Date().toISOString(), 10);
    await saveChannelMeta(entry.slug, { channelId: id, name: id, monthlySpendingLimitUSD: 10 });
  } finally { occupied(); }
  const spawned = backend.calls.spawn.length;
  const result = await running;
  assert.equal(result.budgetRefused, true);
  assert.equal(backend.calls.spawn.length, spawned, 'no engine starts after queued budget rejection');
  resetRunSlots();
});
