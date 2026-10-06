import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { getThreadSettings, setThreadSettings, threadSettingsFingerprint, resolveThreadSettingsMeta, resolveThreadSkillGrants } = await import('../src/gateway/thread-settings.js');
const { setThreadRuntimeOverrides, getThreadEngine } = await import('../src/gateway/thread-engine.js');
const { onConfigChange } = await import('../src/config/change-events.js');
const { resolveRunAccessGrants, userOnlySkillGrants } = await import('../src/gateway/access-grants.js');

test('sections commit atomically, reject stale cards and never change sibling thread or runtime', async () => {
  const slug = 'thread-settings-cas';
  setThreadRuntimeOverrides(slug, 'one', { engine: 'codex', model: 'model', effort: 'high' });
  const events = [];
  const unsubscribe = onConfigChange(event => events.push(event));
  try {
    const initial = threadSettingsFingerprint(getThreadSettings(slug, 'one', 'mcp'));
    setThreadSettings(slug, 'one', 'mcp', { toolboxToken: 'synthetic-token', allowedMcps: [] }, { expected: initial });
    assert.throws(() => setThreadSettings(slug, 'one', 'mcp', { toolboxToken: 'other-token' }, { expected: initial }), /settings changed/);
    assert.deepEqual(getThreadSettings(slug, 'one', 'mcp'), { toolboxToken: 'synthetic-token', allowedMcps: [] });
    assert.deepEqual(getThreadSettings(slug, 'two', 'mcp'), {});
    assert.deepEqual(getThreadSettings(slug, 'one', 'skills'), {});
    assert.equal(await getThreadEngine(slug, 'one'), 'codex');
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(events, [{ kind: 'thread-settings', slug, threadKey: 'one', section: 'mcp' }]);
    assert.equal(JSON.stringify(events).includes('synthetic-token'), false);
    const saved = getThreadSettings(slug, 'one', 'mcp');
    setThreadSettings(slug, 'one', 'mcp', {}, { expected: saved });
    assert.deepEqual(getThreadSettings(slug, 'one', 'mcp'), {});
  } finally { unsubscribe(); }
});

test('fingerprints ignore object key order and never reveal raw values', () => {
  assert.equal(threadSettingsFingerprint({ env: { B: { value: 'two' }, A: { value: 'one' } } }), threadSettingsFingerprint({ env: { A: { value: 'one' }, B: { value: 'two' } } }));
  assert.match(threadSettingsFingerprint({ toolboxToken: 'synthetic-token' }), /^[a-f0-9]{64}$/);
});

test('thread settings reject runtime posture escalation and reserved or malformed secrets', () => {
  for (const section of ['mcp', 'skills', 'secrets']) {
    assert.throws(() => setThreadSettings('validation', 'one', section, { adminMode: true }), /Unsupported/);
  }
  assert.throws(() => setThreadSettings('validation', 'one', 'secrets', { env: { NODE_OPTIONS: { value: 'require hook' } } }), /reserved/);
  assert.throws(() => setThreadSettings('validation', 'one', 'secrets', { env: { TEST_SECRET: { value: 'synthetic-token', hosts: ['http://wrong'] } } }), /host/i);
  assert.throws(() => setThreadSettings('validation', 'one', 'secrets', { env: { TEST_SECRET: { value: 'bad\nvalue' } } }), /line break/);
  assert.throws(() => setThreadSettings('validation', 'one', 'skills', { skills: ['../private'] }), /Invalid/);
  assert.throws(() => setThreadSettings('validation', 'one', 'mcp', { noDefaultTokens: 'true' }), /Invalid/);
  assert.deepEqual(getThreadSettings('validation', 'one', 'secrets'), {});
});

test('resolved meta keeps channel secrets and security posture distinct from thread overlays', () => {
  const channel = { env: { TEST_SECRET: { value: 'channel' } }, adminMode: false, allowNetwork: false, allowedMcps: ['channel'], toolboxToken: 'channel-token' };
  const meta = resolveThreadSettingsMeta(channel, { mcp: { toolboxToken: 'thread-token', allowedMcps: [] }, secrets: { env: { THREAD_SECRET: { value: 'thread' } }, removed: ['TEST_SECRET'] } }, { slug: 'channel', threadKey: 'one' });
  assert.equal(meta.toolboxToken, 'thread-token');
  assert.deepEqual(meta.allowedMcps, []);
  assert.equal(meta.adminMode, false);
  assert.equal(meta.allowNetwork, false);
  assert.deepEqual(meta.env, channel.env);
  assert.deepEqual(meta.threadEnvRemoved, ['TEST_SECRET']);
  assert.equal(meta.threadEnv.THREAD_SECRET.value, 'thread');
  assert.equal(meta.threadSettingsKey, 'one');
  assert.equal(channel.toolboxToken, 'channel-token');
});

test('thread skills include templates but refuse personal and foreign-channel dependencies', () => {
  const skills = { explicit: { slug: 'explicit', requires: ['dependency'] }, dependency: { slug: 'dependency' }, templated: { slug: 'templated' }, private: { slug: 'private', visibility: 'personal' }, foreign: { slug: 'foreign', channelScope: 'other' } };
  const deps = { channelId: 'same', lookupSkill: name => skills[name], lookupTemplate: name => name === 'template' ? { slug: name } : null, resolveTemplate: () => ({ skills: [skills.templated] }) };
  assert.deepEqual(resolveThreadSkillGrants({ skills: ['explicit'], skillTemplate: 'template' }, deps), ['explicit', 'templated']);
  skills.dependency.requires = ['explicit'];
  assert.doesNotThrow(() => resolveThreadSkillGrants({ skills: ['explicit'] }, deps));
  skills.dependency.requires = ['private'];
  assert.throws(() => resolveThreadSkillGrants({ skills: ['explicit'] }, deps), /no longer available/);
  assert.throws(() => resolveThreadSkillGrants({ skills: ['foreign'] }, deps), /no longer available/);
  assert.throws(() => resolveThreadSkillGrants({ skillTemplate: 'missing' }, deps), /template is no longer/);
});

test('thread MCP selections override selectable channel tier; shared skills and org/user MCP remain inherited', async () => {
  const shared = { skills: ['shared'], allowedMcps: ['channel'] };
  const grants = await resolveRunAccessGrants({ organization: { skills: ['org'], allowedMcps: ['org'] }, channel: shared, thread: { skills: ['thread'], allowedMcps: [] }, authorId: 'author', loadUser: async () => ({ skills: ['personal'], allowedMcps: ['personal'] }) });
  assert.deepEqual(grants.shared.skills, ['org', 'shared']);
  assert.deepEqual(grants.shared.allowedMcps, ['org', 'channel']);
  assert.deepEqual(grants.effective.skills, ['org', 'shared', 'thread', 'personal']);
  assert.deepEqual(grants.effective.allowedMcps, ['org', 'personal']);
  assert.deepEqual(userOnlySkillGrants(grants), ['thread', 'personal']);
  const untrusted = await resolveRunAccessGrants({ channel: shared, thread: { skills: ['thread'] }, untrustedPrincipal: true, loadUser: () => { throw new Error('no principal lookup'); } });
  assert.deepEqual(untrusted.effective.skills, ['shared', 'thread']);
  assert.deepEqual(shared, { skills: ['shared'], allowedMcps: ['channel'] });
});
